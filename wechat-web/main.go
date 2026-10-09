// 微信消息台：电脑端网页服务。
//
// 手机上的 wechat-bridge 负责操作微信；本服务：
//   - 长轮询手机事件，把聊天内容并入本地会话（phone.go、messages.go）
//   - 串行执行读取和发送任务（phone.go）
//   - 按规则生成 AI 回复（ai.go）
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
	"encoding/json"
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
	Phone         PhoneConfig              `json:"config"`
	Cursor        int64                    `json:"cursor"` // 已处理的手机事件序号
	Conversations map[string]*Conversation `json:"conversations"`
	Operations    map[string]*Operation    `json:"operations"`
	AI            AIConfig                 `json:"ai_config"`
	AIRules       []AIRule                 `json:"ai_matches"`
	AIJobs        map[string]*AIJob        `json:"ai_jobs"`
}

type App struct {
	mu        sync.Mutex
	state     State
	path      string // 数据库文件；图片和日志放在同一目录
	store     *store
	ctx       context.Context
	client    *http.Client
	wake      chan struct{}          // 有新任务时唤醒 worker
	listeners map[chan struct{}]bool // 网页 SSE 连接

	// 以下只在内存中
	connection  string               // 手机连接状态文字
	lastError   string               // 最近一次需要提示的错误
	allowRemote bool                 // 允许非回环来源地址（容器内运行时使用）
	device      json.RawMessage      // 手机最近一次上报的状态
	aiCursor    map[string]int64     // 会话 → AI 已检查到的消息序号
	aiLastRun   map[string]time.Time // 会话 → 上次自动生成时间
}

// now 返回当前 UTC 时间的 RFC3339 字符串（带纳秒，按字符串比较即可排序）。
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

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
		path:       path,
		store:      db,
		ctx:        context.Background(),
		client:     &http.Client{Timeout: 35 * time.Second, Transport: &http.Transport{Proxy: nil}},
		wake:       make(chan struct{}, 1),
		listeners:  map[chan struct{}]bool{},
		connection: "未配置",
		aiCursor:   map[string]int64{},
		aiLastRun:  map[string]time.Time{},
		state: State{
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
	return a, a.saveLocked()
}

// normalizeLocked 整理旧版本数据，并把上次服务退出时未完成的 AI 生成标记为失败。
func (a *App) normalizeLocked() {
	if a.state.Conversations == nil {
		a.state.Conversations = map[string]*Conversation{}
	}
	if a.state.Operations == nil {
		a.state.Operations = map[string]*Operation{}
	}
	if a.state.AIJobs == nil {
		a.state.AIJobs = map[string]*AIJob{}
	}
	// 删除旧版本的非正文记录，补上列表预览
	for _, c := range a.state.Conversations {
		c.migrate()
	}
	// 草稿模式已移除，旧数据中的草稿视为关闭。
	for i := range a.state.AIRules {
		if a.state.AIRules[i].Mode == "draft" {
			a.state.AIRules[i].Mode = "off"
		}
	}
	// 上次退出时正在生成的 AI 回复不会自动重试
	for _, j := range a.state.AIJobs {
		if j.Status == "running" {
			j.Status, j.Error = "failed", "服务重启中断，未自动重试"
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

// notifyLocked 通知所有网页重新拉取数据。
func (a *App) notifyLocked() {
	// 每个 SSE 连接一个容量为 1 的通道；已有未处理的通知时跳过，避免阻塞
	for ch := range a.listeners {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
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

// conversationLocked 按名称查找会话，不存在时新建。
func (a *App) conversationLocked(title string) *Conversation {
	// 会话编号由名称的哈希得出，同名会话总是同一个编号
	h := sha256.Sum256([]byte(title))
	id := hex.EncodeToString(h[:12])
	c := a.state.Conversations[id]
	if c == nil {
		c = &Conversation{ID: id, Title: title, Kind: "unknown", Updated: now(), Messages: []Message{}}
		a.state.Conversations[id] = c
	}
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

// main 加载配置、加锁防止重复启动，然后启动后台循环和网页服务。
func main() {
	config, err := loadServerConfig("config.json")
	if err != nil {
		log.Fatal(err)
	}
	const dbPath = ".state/wechat.db"
	const legacy = ".state/state.json"

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
	// 三个后台循环：拉取手机事件、执行读写任务、AI 自动回复
	go a.eventLoop(ctx)
	go a.worker(ctx)
	go a.aiLoop(ctx)

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
