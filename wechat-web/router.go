package main

import (
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func (a *App) handler() http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), localOnly)

	api := r.Group("/api")
	api.GET("/state", a.getState)
	api.GET("/debug", a.getDebug)
	api.GET("/stream", a.stream)
	api.POST("/config", a.setPhoneConfig)

	api.POST("/conversations", a.createConversation)
	api.GET("/conversations/:id", a.getConversation)
	api.POST("/conversations/:id/seen", a.markSeen)
	api.POST("/conversations/:id/kind", a.setKind)
	api.POST("/conversations/:id/schedule", a.setReadSchedule)
	api.POST("/conversations/:id/originals", a.setOriginals)
	api.POST("/conversations/:id/read", a.createOperation("read"))
	api.POST("/conversations/:id/send", a.createOperation("send"))
	api.POST("/conversations/:id/ai", a.setConversationAI)

	api.GET("/ai/config", a.getAIConfig)
	api.POST("/ai/config", a.setAIConfig)

	api.POST("/media", a.uploadMedia)
	api.GET("/media/:hash", a.getMedia)

	static, _ := fs.Sub(assets, "static")
	files := http.FileServer(http.FS(static))
	r.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			fail(c, 404, "接口不存在")
			return
		}
		files.ServeHTTP(c.Writer, c.Request)
	})
	return r
}

// localOnly 只允许本机访问，并拒绝跨站请求和 DNS 重绑定（Host 必须是本机名）。
func localOnly(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
	remote, _, _ := net.SplitHostPort(c.Request.RemoteAddr)
	host, _, err := net.SplitHostPort(c.Request.Host)
	if err != nil {
		host = c.Request.Host
	}
	origin := c.GetHeader("Origin")
	sameOrigin := origin == ""
	if u, err := url.Parse(origin); err == nil && u.Host == c.Request.Host {
		sameOrigin = true
	}
	ip := net.ParseIP(remote)
	if ip == nil || !ip.IsLoopback() || (host != "localhost" && host != "127.0.0.1" && host != "::1") || !sameOrigin {
		fail(c, 403, "仅允许本机网页访问")
		c.Abort()
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<20)
}

func fail(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"error": message})
}

func bind(c *gin.Context, target any) bool {
	if err := c.ShouldBindJSON(target); err != nil {
		fail(c, 400, "请求格式无效")
		return false
	}
	return true
}

// conversation 取路径中的会话；不存在时已返回 404。调用前须持有锁。
func (a *App) conversation(c *gin.Context) *Conversation {
	conv := a.state.Conversations[c.Param("id")]
	if conv == nil {
		fail(c, 404, "会话不存在")
	}
	return conv
}

// saved 保存修改并按结果返回。调用前须持有锁。
func (a *App) saved(c *gin.Context, value any) {
	if err := a.commitLocked(); err != nil {
		fail(c, 500, "保存失败")
		return
	}
	c.JSON(200, value)
}

// ---------- 总览与连接 ----------

func (a *App) getState(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	conversations := make([]Conversation, 0, len(a.state.Conversations))
	for _, conv := range a.state.Conversations {
		summary := *conv
		summary.Messages = nil
		conversations = append(conversations, summary)
	}
	sort.Slice(conversations, func(i, j int) bool { return conversations[i].Updated > conversations[j].Updated })

	operations := make([]*Operation, 0, len(a.state.Operations))
	for _, op := range a.state.Operations {
		operations = append(operations, op)
	}
	sort.Slice(operations, func(i, j int) bool { return operations[i].Created > operations[j].Created })
	operations = operations[:min(len(operations), 50)]

	c.JSON(200, gin.H{
		"conversations": conversations,
		"operations":    operations,
		"connection":    a.connection,
		"error":         a.lastError,
		"device":        a.device,
		"phone_url":     a.state.Phone.URL,
		"token_set":     a.state.Phone.Token != "",
	})
}

// stream 是 SSE：数据有变化时推送 refresh，网页收到后重新拉取。
func (a *App) stream(c *gin.Context) {
	ch := make(chan struct{}, 1)
	a.mu.Lock()
	a.listeners[ch] = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.listeners, ch)
		a.mu.Unlock()
	}()
	c.Header("Content-Type", "text/event-stream")
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-a.ctx.Done():
			return
		case <-ch:
			fmt.Fprint(c.Writer, "data: refresh\n\n")
		case <-keepalive.C:
			fmt.Fprint(c.Writer, ": keepalive\n\n")
		}
		c.Writer.Flush()
	}
}

func (a *App) setPhoneConfig(c *gin.Context) {
	var body struct {
		PhoneURL string `json:"phone_url"`
		Token    string `json:"token"`
	}
	if !bind(c, &body) {
		return
	}
	address, err := normalizePhone(body.PhoneURL)
	if err != nil {
		fail(c, 400, err.Error())
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	token := strings.TrimSpace(body.Token)
	if token == "" {
		token = a.state.Phone.Token // 留空表示保留原 Token
	}
	if len(token) < 32 || strings.ContainsAny(token, "\r\n") {
		fail(c, 400, "请输入有效的手机 Token（至少 32 字符）")
		return
	}
	for _, op := range a.state.Operations {
		if op.active() {
			fail(c, 409, "请等待当前读写任务完成后再更换手机配置")
			return
		}
	}
	a.state.Phone = PhoneConfig{URL: address, Token: token}
	a.connection = "连接中"
	a.saved(c, gin.H{"ok": true})
}

// ---------- 会话 ----------

func validKind(kind string) bool { return kind == "person" || kind == "group" || kind == "unknown" }

func (a *App) createConversation(c *gin.Context) {
	var body struct {
		Title string `json:"title"`
		Kind  string `json:"kind"`
	}
	if !bind(c, &body) {
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" || len([]rune(title)) > 128 || strings.ContainsAny(title, "\r\n\x00") || !validKind(body.Kind) {
		fail(c, 400, "请输入完整微信昵称或群名称，并选择会话类型")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	conv := a.conversationLocked(title)
	conv.Kind = body.Kind
	a.saved(c, conv)
}

func (a *App) getConversation(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if conv := a.conversation(c); conv != nil {
		c.JSON(200, conv)
	}
}

func (a *App) markSeen(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if conv := a.conversation(c); conv != nil {
		conv.Unread = 0
		a.saved(c, gin.H{"ok": true})
	}
}

func (a *App) setKind(c *gin.Context) {
	var body struct {
		Kind string `json:"kind"`
	}
	if !bind(c, &body) {
		return
	}
	if !validKind(body.Kind) {
		fail(c, 400, "会话类型无效")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if conv := a.conversation(c); conv != nil {
		conv.Kind = body.Kind
		a.saved(c, gin.H{"ok": true})
	}
}

// setReadSchedule 设置定时读取间隔（秒），0 为关闭。
func (a *App) setReadSchedule(c *gin.Context) {
	var body struct {
		Seconds int `json:"read_every_seconds"`
	}
	if !bind(c, &body) {
		return
	}
	if body.Seconds != 0 && (body.Seconds < 60 || body.Seconds > 86400) {
		fail(c, 400, "定时读取间隔为 60–86400 秒，0 为关闭")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if conv := a.conversation(c); conv != nil {
		conv.ReadEvery = body.Seconds
		a.saved(c, gin.H{"ok": true})
	}
}

// setOriginals 设置收到图片时是否取原图：on | off。
func (a *App) setOriginals(c *gin.Context) {
	var body struct {
		Mode string `json:"originals"`
	}
	if !bind(c, &body) {
		return
	}
	if body.Mode != "on" && body.Mode != "off" {
		fail(c, 400, "originals 必须为 on 或 off")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if conv := a.conversation(c); conv != nil {
		conv.Originals = body.Mode
		a.saved(c, gin.H{"ok": true})
	}
}

var idempotencyKey = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// createOperation 建立读取或发送任务。请求头 Idempotency-Key 作为任务编号：
// 同一编号重复提交相同内容返回原任务，内容不同则拒绝。
func (a *App) createOperation(kind string) gin.HandlerFunc {
	return func(c *gin.Context) { a.addOperation(c, kind) }
}

func (a *App) addOperation(c *gin.Context, kind string) {
	var body struct {
		Text      string `json:"text"`
		ImageHash string `json:"image_hash"`
		Limit     int    `json:"limit"`
	}
	if !bind(c, &body) {
		return
	}
	key := c.GetHeader("Idempotency-Key")
	switch {
	case !idempotencyKey.MatchString(key):
		fail(c, 400, "缺少有效的 Idempotency-Key")
		return
	case kind == "read" && (body.Limit < 1 || body.Limit > 100):
		fail(c, 400, "读取数量必须为 1–100")
		return
	case kind == "send" && body.ImageHash != "" && body.Text != "":
		fail(c, 400, "图片与文字请分别发送")
		return
	case kind == "send" && body.ImageHash == "" && (strings.TrimSpace(body.Text) == "" || len([]rune(body.Text)) > 2000):
		fail(c, 400, "消息必须为 1–2000 字符")
		return
	}
	if body.ImageHash != "" {
		if _, err := a.readImage(body.ImageHash); err != nil {
			fail(c, 400, "图片不存在")
			return
		}
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	conv := a.conversation(c)
	if conv == nil {
		return
	}
	op := &Operation{ID: key, ConversationID: conv.ID, Kind: kind, Text: body.Text, ImageHash: body.ImageHash, Limit: body.Limit, Status: "queued", Created: now()}
	if old := a.state.Operations[key]; old != nil {
		if old.ConversationID != op.ConversationID || old.Kind != op.Kind || old.Text != op.Text || old.ImageHash != op.ImageHash || old.Limit != op.Limit {
			fail(c, 409, "请求编号已用于不同内容")
			return
		}
		c.JSON(202, old)
		return
	}
	if a.state.Phone.URL == "" {
		fail(c, 409, "请先配置手机连接")
		return
	}
	a.state.Operations[key] = op
	if err := a.commitLocked(); err != nil {
		delete(a.state.Operations, key) // 未保存的任务不执行，避免网页以为失败后重试导致重复发送
		fail(c, 500, "任务保存失败，未发送到手机")
		return
	}
	a.wakeWorker()
	c.JSON(202, op)
}

// ---------- AI ----------

func (a *App) getAIConfig(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg := a.state.AI
	rules := a.state.AIRules
	if rules == nil {
		rules = []AIRule{}
	}
	c.JSON(200, gin.H{
		"url": cfg.URL, "model": cfg.Model, "prompt": cfg.Prompt, "vision": cfg.Vision,
		"key_set": cfg.Key != "", "rules": rules,
	})
}

func (a *App) setAIConfig(c *gin.Context) {
	var body struct {
		AIConfig
		Rules []AIRule `json:"rules"`
	}
	if !bind(c, &body) {
		return
	}
	cfg := body.AIConfig
	cfg.URL = strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(cfg.URL), "/"), "/chat/completions")
	u, err := url.Parse(cfg.URL)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || strings.TrimSpace(cfg.Model) == "" {
		fail(c, 400, "请输入有效的接口地址和模型名称")
		return
	}
	if len(body.Rules) > 100 {
		fail(c, 400, "最多 100 条名称规则")
		return
	}
	for _, rule := range body.Rules {
		if err := rule.validate(rule.Kind); err != nil || (rule.Kind != "person" && rule.Kind != "group") || rule.Pattern == "" {
			fail(c, 400, "名称规则无效：需要类型、表达式；群自动回复必须设置触发词；周期 5–86400 秒")
			return
		}
		if rule.Matcher != "wildcard" && rule.Matcher != "regex" {
			fail(c, 400, "匹配方式必须为通配符或正则")
			return
		}
		if _, err := regexp.Compile(rule.Pattern); rule.Matcher == "regex" && err != nil {
			fail(c, 400, "正则表达式无效："+rule.Pattern)
			return
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if cfg.Key == "" {
		cfg.Key = a.state.AI.Key // 留空表示保留原密钥
	}
	a.state.AI = cfg
	a.state.AIRules = body.Rules
	a.saved(c, gin.H{"ok": true})
}

// setConversationAI 设置单个会话的回复方式；mode 为 inherit 时改回跟随名称规则。
func (a *App) setConversationAI(c *gin.Context) {
	var setting AISetting
	if !bind(c, &setting) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	conv := a.conversation(c)
	if conv == nil {
		return
	}
	if setting.Mode == "inherit" {
		conv.AI = AISetting{}
	} else if err := setting.validate(conv.Kind); err != nil {
		fail(c, 400, err.Error())
		return
	} else {
		conv.AI = setting
	}
	a.saved(c, conv.AI)
}

// ---------- 图片 ----------

func (a *App) uploadMedia(c *gin.Context) {
	var body struct {
		Data string `json:"data"`
	}
	if !bind(c, &body) {
		return
	}
	hash, err := a.saveImage(body.Data)
	if err != nil {
		fail(c, 400, err.Error())
		return
	}
	c.JSON(200, gin.H{"image_hash": hash})
}

func (a *App) getMedia(c *gin.Context) {
	path, ok := a.mediaPath(c.Param("hash"))
	if !ok {
		fail(c, 404, "图片不存在")
		return
	}
	c.Header("Content-Type", "image/jpeg")
	// 文件名是内容哈希，内容不会变，允许浏览器长期缓存，避免刷新时重复加载图片。
	c.Header("Cache-Control", "private, max-age=31536000, immutable")
	c.File(path)
}
