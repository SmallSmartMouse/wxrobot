// 微信消息台：电脑端网页服务。
//
// 手机上的 wechat-bridge 负责操作微信；本服务：
//   - 长轮询手机事件，把聊天内容并入本地会话（phone.go、messages.go）
//   - 串行执行读取和发送任务（phone.go）
//   - 按规则生成 AI 回复（ai.go）、转发消息（forward.go）
//   - 提供本机网页和接口（router.go）
//
// 数据保存在 SQLite（store.go），运行时全部在内存中，每次修改后只写入变化的部分。
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"time"
)

//go:embed static/*
var assets embed.FS

const (
	maxFinishedOperations = 200
	maxAIJobs             = 100
)

type State struct {
	AccountAI       map[string]AccountAIConfig `json:"account_ai,omitempty"`
	AccountNames    map[string]string          `json:"account_names"`     // 微信号为键，昵称仅用于展示
	NewMessagesOnly bool                       `json:"new_messages_only"` // 默认关闭，兼容已有历史读取行为
	Phones          []*PhoneConfig             `json:"phones"`
	Phone           PhoneConfig                `json:"config"` // 单手机版本的手机连接，启动时迁移到 Phones
	Cursor          int64                      `json:"cursor"` // 单手机版本的事件序号，迁移到 Phones
	Conversations   map[string]*Conversation   `json:"conversations"`
	Operations      map[string]*Operation      `json:"operations"`
	AI              AIConfig                   `json:"ai_config"`
	AIRules         []AIRule                   `json:"ai_matches"`
	AIJobs          map[string]*AIJob          `json:"ai_jobs"`
	ForwardRules    []ForwardRule              `json:"forward_rules"`
	Discovery       DiscoverySettings          `json:"discovery"`
}

type App struct {
	mu        sync.Mutex
	state     State
	path      string // 数据库文件；图片和日志放在同一目录
	store     *store
	ctx       context.Context
	client    *http.Client
	listeners map[chan struct{}]bool // 网页 SSE 连接

	// 以下只在内存中
	phones            map[string]*phoneRuntime   // 手机编号 → 连接状态、上报的状态、事件循环
	discovered        map[string]discoveredPhone // 当前局域网发现的设备，按地址存放，不写入数据库
	discoveryWake     chan struct{}
	discoveryPort     int
	discoveryError    string
	discoveryProgress discoveryProgress
	discoveryNonces   map[string]time.Time
	linkFingerprint   string
	linkPort          int
	linkError         string
	pairings          map[string]*phonePairing
	links             map[string]*phoneLink
	linkAttempts      map[string]time.Time
	linkSlots         chan struct{}
	running           bool                 // 服务已启动：新添加的手机立即启动事件循环和 worker
	lastError         string               // 最近一次需要提示的错误（例如本地数据保存失败）
	allowRemote       bool                 // 允许非回环来源地址（容器内运行时使用）
	aiCursor          map[string]int64     // 会话 → AI 已检查到的消息序号
	aiLastRun         map[string]time.Time // 会话 → 上次自动生成时间
	// 转发（forward.go）
	forwardCursor map[string]int64         // 会话 → 转发已检查到的消息序号
	forwardSeen   map[string]time.Time     // 规则 + 原文 → 上次转发时间，用于去重
	forwardStatus map[string]forwardStatus // 规则 → 最近一次没能转发的原因
	forwardLast   time.Time                // 最近一个转发任务的创建时间
}

// now 返回当前时间的 stamp 字符串。
func now() string { return stamp(time.Now()) }

// stamp 把时间格式化为 UTC RFC3339 字符串，固定 9 位小数：长度相同，按字符串比较就是按时间先后
// （RFC3339Nano 会去掉末尾的 0，“05.1Z”比“05.12Z”大）。
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000000000Z07:00") }

// randomID 生成 32 位十六进制随机编号，用于任务、AI 记录等。
func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// newApp 打开数据库、读入全部数据并整理旧版本数据，返回可用的 App。
func newApp(path string) (*App, error) {
	// 打开（或新建）SQLite 数据库
	db, err := openStore(path)
	if err != nil {
		return nil, err
	}
	a := &App{
		path:            path,
		store:           db,
		ctx:             context.Background(),
		client:          &http.Client{Timeout: 35 * time.Second, Transport: &http.Transport{Proxy: nil}},
		listeners:       map[chan struct{}]bool{},
		phones:          map[string]*phoneRuntime{},
		discovered:      map[string]discoveredPhone{},
		discoveryWake:   make(chan struct{}, 1),
		discoveryPort:   defaultDiscoveryPort,
		discoveryNonces: map[string]time.Time{},
		pairings:        map[string]*phonePairing{},
		links:           map[string]*phoneLink{},
		linkAttempts:    map[string]time.Time{},
		linkSlots:       make(chan struct{}, 32),
		aiCursor:        map[string]int64{},
		aiLastRun:       map[string]time.Time{},

		forwardCursor: map[string]int64{},
		forwardSeen:   map[string]time.Time{},
		forwardStatus: map[string]forwardStatus{},
		state: State{
			Discovery:     defaultDiscoverySettings(),
			Conversations: map[string]*Conversation{},
			Operations:    map[string]*Operation{},
			AIJobs:        map[string]*AIJob{},
		},
	}
	// 把数据库内容读进内存，之后的读写都在内存中进行
	if _, err = a.loadLocked(); err != nil {
		return nil, fmt.Errorf("数据库读取失败：%w", err)
	}
	// 整理旧数据后写回，确保数据库与内存一致
	a.normalizeLocked()
	a.syncPhonesLocked()
	return a, a.saveLocked()
}

// normalizeLocked 整理旧版本数据，并把上次服务退出时未完成的 AI 生成标记为失败。
func (a *App) normalizeLocked() {
	if a.state.Discovery.IntervalSeconds == 0 {
		a.state.Discovery = defaultDiscoverySettings()
	}
	if a.state.Conversations == nil {
		a.state.Conversations = map[string]*Conversation{}
	}
	if a.state.Operations == nil {
		a.state.Operations = map[string]*Operation{}
	}
	if a.state.AIJobs == nil {
		a.state.AIJobs = map[string]*AIJob{}
	}
	// 单手机版本的连接迁移为第一台手机；旧会话等它第一次上报微信号时归到那个账号
	if len(a.state.Phones) == 0 && a.state.Phone.URL != "" {
		p := a.state.Phone
		p.ID, p.Cursor, p.Legacy = randomID()[:12], a.state.Cursor, true
		a.state.Phones = []*PhoneConfig{&p}
	}
	a.state.Phone, a.state.Cursor = PhoneConfig{}, 0
	// 删除旧版本的非正文记录，补上列表预览
	for id, c := range a.state.Conversations {
		c.migrate()
		for _, seq := range c.markLegacyNotices() {
			a.markMessage(id, seq)
		}
	}
	a.removeUnsupportedChatsLocked()
	a.recoverLiveBaselinesLocked()
	// 草稿模式已移除，旧数据中的草稿视为关闭。
	for i := range a.state.AIRules {
		if a.state.AIRules[i].Mode == "draft" {
			a.state.AIRules[i].Mode = "off"
		}
	}
	// 转发规则的正则在内存中编译
	for i := range a.state.ForwardRules {
		_ = a.state.ForwardRules[i].compile()
	}
	// 上次退出时正在生成的 AI 回复不会自动重试
	for _, j := range a.state.AIJobs {
		if j.Status == "running" {
			j.Status, j.Error = "failed", "服务重启中断，未自动重试"
		}
	}
}

// removeUnsupportedChatsLocked 删除旧版本建立的不支持的会话：公众号，以及把微信系统通知（标题“微信”）
// 当成会话建立的空会话（只删没有消息、没有手动设置过类型的）。有进行中任务的先不删，下次启动再删。
func (a *App) removeUnsupportedChatsLocked() {
	for id, c := range a.state.Conversations {
		junk := c.Title == wechatSystemTitle && len(c.Messages) == 0 && c.Kind == "unknown"
		if (unsupportedChats[c.Title] || junk) && !a.busyLocked(id) {
			a.deleteConversationLocked(id)
		}
	}
}

// busyLocked 会话是否有排队或执行中的任务。
func (a *App) busyLocked(conversationID string) bool {
	for _, op := range a.state.Operations {
		if op.ConversationID == conversationID && op.active() {
			return true
		}
	}
	return false
}

// deleteConversationLocked 删除会话和它的全部消息，以及不再被引用的图片。
func (a *App) deleteConversationLocked(id string) {
	c := a.state.Conversations[id]
	if c == nil {
		return
	}
	delete(a.state.Conversations, id)
	a.store.cleared[id] = true
	a.removeUnusedMediaLocked(c.Messages, c.Members)
}

// clearHistoryLocked 清空会话在本地的聊天记录（手机上的微信不受影响），并删除不再被引用的图片。
func (a *App) clearHistoryLocked(c *Conversation) {
	removed := c.clearHistory()
	a.store.cleared[c.ID] = true
	a.skipNewMessagesLocked(c) // 删掉的消息不再触发 AI 回复和转发
	a.removeUnusedMediaLocked(removed, nil)
}

// removeUnusedMediaLocked 删除 messages 和 members 引用、但其他地方都不再引用的图片文件
// （消息的缩略图和原图、群成员头像、待发送的图片、任务步骤截图）。
func (a *App) removeUnusedMediaLocked(messages []Message, members map[string]string) {
	candidates := map[string]bool{}
	for _, m := range messages {
		candidates[m.ImageHash], candidates[m.OriginalHash] = true, true
	}
	for _, hash := range members {
		candidates[hash] = true
	}
	delete(candidates, "")
	if len(candidates) == 0 {
		return
	}
	for _, c := range a.state.Conversations {
		for _, m := range c.Messages {
			delete(candidates, m.ImageHash)
			delete(candidates, m.OriginalHash)
		}
		for _, hash := range c.Members {
			delete(candidates, hash)
		}
	}
	for _, op := range a.state.Operations {
		delete(candidates, op.ImageHash)
		for _, s := range op.Steps {
			delete(candidates, s.Image)
		}
	}
	for hash := range candidates {
		if path, ok := a.mediaPath(hash); ok {
			_ = os.Remove(path)
		}
	}
}

// commitLocked 保存并通知网页刷新。保存失败时内存中的修改仍然有效，下次保存会一起写入。
func (a *App) commitLocked() error {
	err := a.saveLocked()
	if err != nil {
		a.lastError = "本地数据保存失败：" + err.Error()
		log.Print(a.lastError)
	}
	a.notifyLocked()
	return err
}

// notifyLocked 通知所有网页重新拉取数据（每个 SSE 连接一个通道）。
func (a *App) notifyLocked() {
	for ch := range a.listeners {
		wake(ch)
	}
}

// wake 不阻塞地发出一次通知：通道（容量 1）里已有未处理的通知时跳过。
func wake(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

// newest 按创建时间从新到旧排列，只保留前 limit 个。没有元素时返回空切片（接口返回 []，不是 null）。
func newest[T any](items []T, created func(T) string, limit int) []T {
	if items == nil {
		items = []T{}
	}
	sort.Slice(items, func(i, j int) bool { return created(items[i]) > created(items[j]) })
	return items[:min(limit, len(items))]
}

// pruneLocked 只保留最近的已结束任务和 AI 记录，防止数据文件无限增长。
func (a *App) pruneLocked() {
	// 已结束的任务超过上限时，按创建时间删除最早的
	var finished []*Operation
	for _, op := range a.state.Operations {
		if !op.active() {
			finished = append(finished, op)
		}
	}
	if len(finished) > maxFinishedOperations {
		sort.Slice(finished, func(i, j int) bool { return finished[i].Created < finished[j].Created })
		removed := finished[:len(finished)-maxFinishedOperations]
		for _, op := range removed {
			delete(a.state.Operations, op.ID)
		}
		a.removeStepImagesLocked(removed)
	}
	// AI 记录同样只保留最近的，正在生成的不删
	if len(a.state.AIJobs) > maxAIJobs {
		jobs := make([]*AIJob, 0, len(a.state.AIJobs))
		for _, j := range a.state.AIJobs {
			jobs = append(jobs, j)
		}
		sort.Slice(jobs, func(i, j int) bool { return jobs[i].Created < jobs[j].Created })
		for _, j := range jobs[:len(jobs)-maxAIJobs] {
			if j.Status != "running" {
				delete(a.state.AIJobs, j.ID)
			}
		}
	}
}

// removeStepImagesLocked 删除已清理任务的执行步骤截图（仍被其他任务引用的保留）。
func (a *App) removeStepImagesLocked(removed []*Operation) {
	inUse := map[string]bool{}
	for _, op := range a.state.Operations {
		for _, s := range op.Steps {
			inUse[s.Image] = true
		}
	}
	for _, op := range removed {
		for _, s := range op.Steps {
			if path, ok := a.mediaPath(s.Image); ok && !inUse[s.Image] {
				_ = os.Remove(path)
			}
		}
	}
}

// conversationLocked 按账号和名称查找会话，不存在时新建。不同账号的同名会话是不同的会话。
func (a *App) conversationLocked(account, title string) *Conversation {
	for _, c := range a.state.Conversations {
		if c.Account == account && c.Title == title {
			return c
		}
	}
	// 会话编号由账号和名称的哈希得出；单手机版本的会话编号只由名称得出，迁移后保持不变
	key := title
	if account != "" {
		key = account + "\x00" + title
	}
	h := sha256.Sum256([]byte(key))
	c := &Conversation{ID: hex.EncodeToString(h[:12]), Account: account, Title: title, Kind: "unknown", Updated: now(), Messages: []Message{}}
	a.state.Conversations[c.ID] = c
	return c
}

// pause 等待 d；服务退出（ctx 取消）时提前返回 false。
func pause(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

const dbPath = ".state/wechat.db"
const legacy = ".state/state.json"

// main 加载配置、加锁防止重复启动，然后启动后台循环和网页服务。
func main() {
	config, err := loadServerConfig("config.json")
	if err != nil {
		log.Fatal(err)
	}

	// 数据目录只允许当前用户访问
	if err := os.MkdirAll(filepath.Dir(dbPath), 0700); err != nil {
		log.Fatal(err)
	}
	// 文件锁：同一份数据只能有一个服务在用
	lockFile, err := os.OpenFile(dbPath+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		log.Fatal(err)
	}
	defer lockFile.Close()
	if err = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		log.Fatal("已有服务正在使用此数据文件，请勿重复启动")
	}

	a, err := newApp(dbPath)
	if err != nil {
		log.Fatal(err)
	}
	// 数据库为空：导入旧版 state.json（如果有）
	if len(a.state.Conversations) == 0 && len(a.state.Operations) == 0 {
		if err = a.importJSON(legacy); err != nil {
			log.Fatal(err)
		}
	}

	// 收到 Ctrl+C 或 SIGTERM 时取消 ctx，后台循环和网页服务依次退出
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	a.ctx = ctx
	a.allowRemote = config.AllowRemote
	a.discoveryPort = config.DiscoveryPort
	if config.LinkListen != "" {
		if err = a.startPhoneListener(ctx, config.LinkListen); err != nil {
			a.linkError = err.Error()
			log.Printf("手机主动连接服务启动失败：%v", err)
		}
	}
	// 后台循环：每台手机一个拉取事件的循环和一个执行读写任务的 worker（添加手机时随时启动），以及 AI 自动回复和转发
	a.mu.Lock()
	a.running = true
	a.syncPhonesLocked()
	a.mu.Unlock()
	go a.aiLoop(ctx)
	go a.forwardLoop(ctx)
	if a.discoveryPort != 0 {
		go a.discoveryLoop(ctx)
	}

	// 网页服务；退出时最多等 5 秒让进行中的请求完成
	server := &http.Server{Addr: config.Listen, Handler: a.handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("微信消息台已启动：http://%s", config.Listen)
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
