package main

// 网页接口：路由、本机访问检查、通用的请求和响应处理，以及页面总览和实时推送。
// 各功能的接口处理函数在各自的文件里。接口处理函数整体在锁内执行时，开头加锁、defer 解锁。

import (
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	maxRequestBytes = 16 << 20         // 请求体上限：最大的是上传图片（Base64）
	stateOperations = 50               // 总览里返回的最近任务数
	sseKeepalive    = 15 * time.Second // SSE 保活间隔：防止代理和浏览器把空闲连接断开
)

// handler 注册所有接口；不是接口的路径返回内嵌的网页文件。
func (a *App) handler() http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), a.localOnly)

	api := r.Group("/api")
	api.GET("/state", a.getState)
	api.GET("/stream", a.stream)
	api.GET("/debug", a.getDebug)
	api.POST("/system-settings", a.setSystemSettings)
	api.POST("/discovery/preview", a.previewDiscoverySettings)

	api.POST("/phones/discover", a.discoverPhones)
	api.POST("/phones/:id/delete", a.deletePhone)
	api.POST("/phones/:id/name", a.renamePhone)
	api.POST("/phones/:id/refresh-account", a.refreshPhoneAccount)
	api.POST("/pairings/:id/verify", a.verifyPhonePairing)
	api.POST("/pairings/:id/cancel", a.cancelPhonePairing)

	api.POST("/conversations", a.createConversation)
	api.GET("/conversations/:id", a.getConversation)
	api.POST("/conversations/:id/seen", a.markSeen)
	api.POST("/conversations/:id/kind", a.setKind)
	api.POST("/conversations/:id/schedule", a.setReadSchedule)
	api.POST("/conversations/:id/originals", a.setOriginals)
	api.POST("/conversations/:id/read", a.createOperation(opRead))
	api.POST("/conversations/:id/send", a.createOperation(opSend))
	api.POST("/conversations/:id/ai", a.setConversationAI)
	api.POST("/conversations/:id/clear", a.clearConversation)

	api.GET("/ai/config", a.getAIConfig)
	api.POST("/ai/config", a.setAIConfig)
	api.GET("/ai/accounts/:account", a.getAccountAI)
	api.POST("/ai/accounts/:account", a.setAccountAI)

	api.GET("/forward", a.getForward)
	api.POST("/forward/rule", a.saveForwardRule)
	api.POST("/forward/:id/delete", a.deleteForwardRule)

	api.POST("/media", a.uploadMedia)
	api.GET("/media/:hash", a.getMedia)

	// 其他路径：/api/ 开头的返回 404，其余当作网页静态文件
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
// 在 Docker 里运行时，浏览器请求经过网桥转发、来源地址不是回环地址，需在 config.json 中开启 allow_remote 放开来源检查；
// Host 和 Origin 检查仍然有效，端口应只映射到宿主机的 127.0.0.1。
func (a *App) localOnly(c *gin.Context) {
	// 安全相关的响应头：不缓存、不猜测内容类型、只加载本站资源、禁止被嵌入其他页面
	c.Header("Cache-Control", "no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
	if !a.fromLocal(c.Request) || !localHost(c.Request.Host) || !sameOrigin(c.Request) {
		fail(c, 403, "仅允许本机网页访问")
		c.Abort()
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxRequestBytes)
}

// fromLocal 请求来自本机（或已允许远程来源）。
func (a *App) fromLocal(r *http.Request) bool {
	remote, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(remote)
	return a.allowRemote || (ip != nil && ip.IsLoopback())
}

// localHost Host 是本机名。
func localHost(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// sameOrigin 没有 Origin（非跨站请求），或 Origin 与 Host 一致。
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host == r.Host
}

// fail 返回 {"error": message}。
func fail(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"error": message})
}

// bind 解析 JSON 请求体到 target；格式错误时已返回 400，调用方直接 return。
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

// ---------- 总览与实时推送 ----------

// getState 返回页面总览：会话列表（不含消息）、最近的任务、手机和账号、搜索与配对状态。
func (a *App) getState(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	c.JSON(200, gin.H{
		"read_history":      !a.state.NewMessagesOnly,
		"conversations":     a.conversationSummariesLocked(),
		"operations":        a.operationSummariesLocked(),
		"phones":            a.phoneViewsLocked(),
		"discovery_enabled": a.discoveryEnabledLocked(),
		"discovery_error":   a.discoveryError,
		"discovery":         a.discoverySettingsViewLocked(),
		"pairings":          a.pairingViewsLocked(),
		"accounts":          a.accountsLocked(),
		"error":             a.lastError,
	})
}

// conversationSummariesLocked 会话列表：按最近更新时间排序，去掉消息正文和只在服务端使用的读取状态。
func (a *App) conversationSummariesLocked() []Conversation {
	conversations := make([]Conversation, 0, len(a.state.Conversations))
	for _, conv := range a.state.Conversations {
		summary := *conv
		summary.Messages, summary.LiveAnchor, summary.LiveNotices = nil, nil, nil
		conversations = append(conversations, summary)
	}
	sort.Slice(conversations, func(i, j int) bool { return conversations[i].Updated > conversations[j].Updated })
	return conversations
}

// operationSummariesLocked 最近的任务（新的在前）加上更早但还没结束的；步骤明细只在诊断页显示。
func (a *App) operationSummariesLocked() []*Operation {
	operations := a.recentOperationsLocked(stateOperations)
	listed := map[string]bool{}
	for _, op := range operations {
		listed[op.ID] = true
	}
	for _, op := range a.state.Operations {
		if op.active() && !listed[op.ID] {
			operations = append(operations, op)
		}
	}
	for i, op := range operations {
		summary := *op
		summary.Steps = nil
		operations[i] = &summary
	}
	return operations
}

// stream 是 SSE：数据有变化时推送 refresh，网页收到后重新拉取；定时发保活。
func (a *App) stream(c *gin.Context) {
	ch := a.addListener()
	defer a.removeListener(ch)
	c.Header("Content-Type", "text/event-stream")
	keepalive := time.NewTicker(sseKeepalive)
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

// addListener 登记一个网页连接，数据变化时收到通知。
func (a *App) addListener() chan struct{} {
	ch := make(chan struct{}, 1)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.listeners[ch] = true
	return ch
}

// removeListener 网页连接断开。
func (a *App) removeListener(ch chan struct{}) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.listeners, ch)
}
