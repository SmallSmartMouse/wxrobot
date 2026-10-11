package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"
)

const (
	maxFinishedOperations = 200
	maxAIJobs             = 100
)

// State 是需要保存的全部数据。运行时都在内存中，修改后由 commitLocked 写入数据库。
type State struct {
	AccountAI       map[string]AccountAIConfig `json:"account_ai,omitempty"`
	AccountNames    map[string]string          `json:"account_names"`     // 微信号为键，昵称仅用于展示
	NewMessagesOnly bool                       `json:"new_messages_only"` // 仅新增模式：读取不向上翻页
	Phones          []*PhoneConfig             `json:"phones"`
	Conversations   map[string]*Conversation   `json:"conversations"`
	Operations      map[string]*Operation      `json:"operations"`
	AI              AIConfig                   `json:"ai_config"`
	AIRules         []AIRule                   `json:"ai_matches"`
	AIJobs          map[string]*AIJob          `json:"ai_jobs"`
	ForwardRules    []ForwardRule              `json:"forward_rules"`
	Discovery       DiscoverySettings          `json:"discovery"`
}

// App 是整个服务：保存的数据、各后台循环的内存状态和网页连接。所有字段都在 mu 内读写。
type App struct {
	mu        sync.Mutex
	state     State
	path      string // 数据库文件；图片和证书放在同一目录
	store     *store
	ctx       context.Context
	aiHTTP    http.RoundTripper      // 调用 AI 接口用的传输层（不走系统代理）
	listeners map[chan struct{}]bool // 网页 SSE 连接

	// 以下只在内存中
	running     bool   // 服务已启动：新添加的手机立即启动事件循环和 worker
	lastError   string // 最近一次需要提示的错误（例如本地数据保存失败）
	allowRemote bool   // 允许非回环来源地址（容器内运行时使用）

	// 手机（phones.go、phone_link.go）
	phones       map[string]*phoneRuntime // 手机编号 → 连接状态、上报的状态、事件循环
	links        map[string]phoneConn     // 手机编号 → 手机主动建立的连接
	pairings     map[string]*phonePairing
	linkAttempts map[string]time.Time
	linkSlots    chan struct{}
	linkCert     string // 电脑证书指纹，手机据此认出这台电脑
	linkPort     int
	linkError    string

	// 局域网发现（discovery.go）
	discoveryWake     chan struct{}
	discoveryPort     int
	discoveryError    string
	discoveryProgress discoveryProgress
	discoveryNonces   map[string]time.Time

	// AI 回复（ai.go）
	aiCursor  map[string]int64     // 会话 → AI 已检查到的消息序号
	aiLastRun map[string]time.Time // 会话 → 上次自动生成时间

	// 转发（forward.go）
	forwardCursor map[string]int64         // 会话 → 转发已检查到的消息序号
	forwardSeen   map[string]time.Time     // 规则 + 原文 → 上次转发时间，用于去重
	forwardStatus map[string]forwardStatus // 规则 → 最近一次没能转发的原因
	forwardLast   time.Time                // 最近一个转发任务的创建时间
}

// newApp 打开数据库、读入全部数据并恢复运行时状态，返回可用的 App。
func newApp(path string) (*App, error) {
	db, err := openStore(path)
	if err != nil {
		return nil, err
	}
	a := &App{
		path:            path,
		store:           db,
		ctx:             context.Background(),
		aiHTTP:          &http.Transport{Proxy: nil},
		listeners:       map[chan struct{}]bool{},
		phones:          map[string]*phoneRuntime{},
		links:           map[string]phoneConn{},
		pairings:        map[string]*phonePairing{},
		linkAttempts:    map[string]time.Time{},
		linkSlots:       make(chan struct{}, maxLinkSessions),
		discoveryWake:   make(chan struct{}, 1),
		discoveryPort:   defaultDiscoveryPort,
		discoveryNonces: map[string]time.Time{},
		aiCursor:        map[string]int64{},
		aiLastRun:       map[string]time.Time{},
		forwardCursor:   map[string]int64{},
		forwardSeen:     map[string]time.Time{},
		forwardStatus:   map[string]forwardStatus{},
		state: State{
			Discovery:     defaultDiscoverySettings(),
			Conversations: map[string]*Conversation{},
			Operations:    map[string]*Operation{},
			AIJobs:        map[string]*AIJob{},
		},
	}
	if err = a.loadLocked(); err != nil {
		return nil, fmt.Errorf("数据库读取失败：%w", err)
	}
	a.restoreRuntimeLocked()
	a.syncPhonesLocked()
	return a, a.saveLocked()
}

// restoreRuntimeLocked 恢复读入数据后只在内存中的部分：编译转发规则的正则；
// 上次退出时正在生成的 AI 回复不会自动重试，记为失败。
func (a *App) restoreRuntimeLocked() {
	for i := range a.state.ForwardRules {
		_ = a.state.ForwardRules[i].compile()
	}
	for _, j := range a.state.AIJobs {
		if j.Status == aiRunning {
			j.Status, j.Error = aiFailed, "服务重启中断，未自动重试"
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

// pruneLocked 只保留最近的已结束任务和 AI 记录，防止数据无限增长。保存前调用。
func (a *App) pruneLocked() {
	a.pruneOperationsLocked()
	a.pruneAIJobsLocked()
}

// ---------- 通用工具 ----------

// now 返回当前时间的 stamp 字符串。
func now() string { return stamp(time.Now()) }

// stamp 把时间格式化为 UTC RFC3339 字符串，固定 9 位小数：长度相同，按字符串比较就是按时间先后
// （RFC3339Nano 会去掉末尾的 0，“05.1Z”比“05.12Z”大）。
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000000000Z07:00") }

// parseStamp 解析 stamp 或手机上报的 RFC3339 时间，格式无效时返回零值。
func parseStamp(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}

// shortIDLength 手机、转发规则等少量记录的编号长度（十六进制位数）：数量少，12 位不会重复，网页上也便于辨认。
const shortIDLength = 12

// shortID 生成 12 位十六进制随机编号。
func shortID() string { return randomID()[:shortIDLength] }

// randomID 生成 32 位十六进制随机编号，用于任务、AI 记录等。
func randomID() string {
	b := make([]byte, 16) // 128 位随机数：全局不会重复
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
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
