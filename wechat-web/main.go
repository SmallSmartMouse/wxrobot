// 微信消息台：电脑端网页服务。
//
// 手机上的 wechat-bridge 负责操作微信，经手机主动建立的加密连接（phone_link.go）与本服务通信。本服务：
//   - 长轮询手机事件，把聊天内容并入本地会话（phone_events.go、messages.go）
//   - 串行执行读取和发送任务（operations.go），没有任务时安排自动读取（auto_read.go）
//   - 按规则生成 AI 回复（ai.go）、转发消息（forward.go）
//   - 提供本机网页和接口（router.go）
//
// 数据保存在 SQLite（store.go），运行时全部在内存中，每次修改后只写入变化的部分。
package main

import (
	"context"
	"embed"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

//go:embed static/*
var assets embed.FS

const dbPath = ".state/wechat.db"

// main 读取配置、锁定数据目录、载入数据，然后启动后台循环和网页服务，直到收到退出信号。
func main() {
	config, err := loadServerConfig("config.json")
	if err != nil {
		log.Fatal(err)
	}
	unlock, err := lockDataDir(dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer unlock()
	a, err := newApp(dbPath)
	if err != nil {
		log.Fatal(err)
	}

	// 收到 Ctrl+C 或 SIGTERM 时取消 ctx，后台循环和网页服务依次退出
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	a.start(ctx, config)
	if err = serveWeb(ctx, config.Listen, a.handler()); err != nil {
		log.Fatal(err)
	}
}

// lockDataDir 建立只有当前用户能访问的数据目录，并加文件锁：同一份数据只能有一个服务在用。返回释放锁的函数。
func lockDataDir(path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	lockFile, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lockFile.Close()
		return nil, errors.New("已有服务正在使用此数据文件，请勿重复启动")
	}
	return func() { lockFile.Close() }, nil
}

// start 启动后台工作：手机接入端口、每台手机的事件循环和 worker、AI 回复、转发和局域网发现。
func (a *App) start(ctx context.Context, config serverConfig) {
	a.ctx = ctx
	a.allowRemote = config.AllowRemote
	a.discoveryPort = config.DiscoveryPort
	if err := a.startPhoneListener(ctx, config.LinkListen); err != nil {
		a.linkError = err.Error()
		log.Printf("手机接入端口启动失败：%v", err)
	}
	a.mu.Lock()
	a.running = true
	a.syncPhonesLocked()
	a.mu.Unlock()
	go a.aiLoop(ctx)
	go a.forwardLoop(ctx)
	if a.discoveryPort != 0 {
		go a.discoveryLoop(ctx)
	}
}

// serveWeb 提供网页服务，直到 ctx 取消；退出时最多等 5 秒让进行中的请求完成。
func serveWeb(ctx context.Context, address string, handler http.Handler) error {
	server := &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("微信消息台已启动：http://%s", address)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
