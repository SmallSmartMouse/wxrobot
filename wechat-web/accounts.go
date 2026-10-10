package main

// 多台手机和多个账号。
//
// 一台手机运行一个微信桥，上报它当前登录的微信号（账号）。会话属于某个账号，不同账号的聊天记录互不混用。
// 每台手机各有一个事件循环和一个任务执行线（eventLoop、worker），互不阻塞；
// 任务交给当前登录着该会话账号的手机执行，并把预期的微信号发给手机核对，账号不一致时手机拒绝执行。

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

// PhoneConfig 是一台手机（微信桥）的连接。
type PhoneConfig struct {
	ID      string `json:"id"`
	URL     string `json:"phone_url"`
	Token   string `json:"token"`
	Cursor  int64  `json:"cursor"`            // 已处理的手机事件序号
	Account string `json:"account,omitempty"` // 手机最近一次上报的微信号
	// 从单手机版本迁移来的手机：旧数据没有记录账号，这台手机第一次上报微信号时，旧会话都归到这个账号。
	Legacy bool `json:"legacy,omitempty"`
}

// phoneRuntime 是一台手机只在内存中的状态。
type phoneRuntime struct {
	connection string          // 连接状态文字
	err        string          // 最近一次连接错误
	device     json.RawMessage // 手机最近一次上报的状态
	wake       chan struct{}   // 有新任务时唤醒这台手机的 worker
	cancel     context.CancelFunc
}

// phoneLocked 按编号找手机，没有返回 nil。
func (a *App) phoneLocked(id string) *PhoneConfig {
	for _, p := range a.state.Phones {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// owns 判断会话是否由这台手机负责：会话的账号就是手机当前登录的账号；
// 还没归属账号的旧会话由迁移来的那台手机负责。
func (p *PhoneConfig) owns(c *Conversation) bool {
	if c.Account == "" {
		return p.Legacy
	}
	return c.Account == p.Account
}

// phoneForLocked 返回负责这个会话的手机，没有返回 nil。
func (a *App) phoneForLocked(c *Conversation) *PhoneConfig {
	for _, p := range a.state.Phones {
		if p.owns(c) {
			return p
		}
	}
	return nil
}

// online 判断手机当前是否在线并就绪。
func (a *App) onlineLocked(id string) bool {
	rt := a.phones[id]
	return rt != nil && rt.connection == "在线"
}

// syncPhonesLocked 让每台手机都有内存状态；服务运行中时为新手机启动事件循环和 worker，停掉已删除手机的。
func (a *App) syncPhonesLocked() {
	ids := map[string]bool{}
	for _, p := range a.state.Phones {
		ids[p.ID] = true
		rt := a.phones[p.ID]
		if rt == nil {
			rt = &phoneRuntime{connection: "连接中", wake: make(chan struct{}, 1)}
			a.phones[p.ID] = rt
		}
		if a.running && rt.cancel == nil {
			ctx, cancel := context.WithCancel(a.ctx)
			rt.cancel = cancel
			go a.eventLoop(ctx, p.ID)
			go a.worker(ctx, p.ID)
		}
	}
	for id, rt := range a.phones {
		if !ids[id] {
			if rt.cancel != nil {
				rt.cancel()
			}
			delete(a.phones, id)
		}
	}
}

// setPhoneStatus 更新手机的连接状态和上报的状态（不写数据库），并记下手机当前登录的微信号。
// 迁移来的手机第一次上报微信号时，把还没归属账号的旧会话归到这个账号。
func (a *App) setPhoneStatus(id, status string, device json.RawMessage, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	rt, p := a.phones[id], a.phoneLocked(id)
	if rt == nil || p == nil {
		return
	}
	rt.connection = status
	if device != nil {
		rt.device = device
	}
	if err != nil {
		rt.err = err.Error()
	} else if status == "在线" {
		rt.err = "" // 连接恢复后清掉之前的连接错误
	}
	if account := deviceAccount(device); account != "" && (account != p.Account || p.Legacy) {
		if account != p.Account {
			log.Printf("手机 %s 当前账号 %s（之前 %q）", p.ID, account, p.Account)
		}
		p.Account = account
		if p.Legacy {
			for _, c := range a.state.Conversations {
				if c.Account == "" {
					c.Account = account
				}
			}
			p.Legacy = false
		}
		_ = a.commitLocked()
		a.wakeWorker() // 账号变了，等着这个账号的任务可以执行了
		return
	}
	a.notifyLocked()
}

// deviceAccount 从手机上报的状态里取当前微信号，没有返回空字符串。
func deviceAccount(device json.RawMessage) string {
	var d struct {
		Info struct {
			Account struct {
				WechatID string `json:"wechat_id"`
			} `json:"account"`
		} `json:"info"`
	}
	_ = json.Unmarshal(device, &d)
	return d.Info.Account.WechatID
}

// failOrphansLocked 让没有手机可以执行的排队任务失败（未执行，可安全重试）：
// 会话的账号没有任何手机登录着，例如手机换了账号或被删除。
func (a *App) failOrphansLocked() {
	for _, op := range a.state.Operations {
		if op.Status != "queued" || op.PhoneID != "" {
			continue
		}
		c := a.state.Conversations[op.ConversationID]
		if c != nil && a.phoneForLocked(c) != nil {
			continue
		}
		account := "（未知账号）"
		if c != nil && c.Account != "" {
			account = c.Account
		}
		a.finishLocked(op, "failed", nil, "账号 "+account+" 当前没有连接的手机，任务未执行")
	}
}

// accountView 是网页上的一个账号：微信号，以及当前登录着它的手机。
type accountView struct {
	WechatID   string `json:"wechat_id"`
	PhoneID    string `json:"phone_id,omitempty"`
	Connection string `json:"connection"`
}

// accountsLocked 列出所有账号：手机当前登录的，以及已有会话的（手机换号后仍可查看记录）。
func (a *App) accountsLocked() []accountView {
	seen := map[string]*accountView{}
	for _, c := range a.state.Conversations {
		if c.Account != "" && seen[c.Account] == nil {
			seen[c.Account] = &accountView{WechatID: c.Account, Connection: "未连接"}
		}
	}
	for _, p := range a.state.Phones {
		if p.Account == "" {
			continue
		}
		v := seen[p.Account]
		if v == nil {
			v = &accountView{WechatID: p.Account}
			seen[p.Account] = v
		}
		if v.PhoneID == "" || a.onlineLocked(p.ID) {
			v.PhoneID, v.Connection = p.ID, a.phones[p.ID].connection
		}
	}
	out := make([]accountView, 0, len(seen))
	for _, v := range seen {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].WechatID < out[j].WechatID })
	return out
}

// phoneView 是网页上的一台手机（不含 Token）。
func (a *App) phoneViewsLocked() []gin.H {
	out := []gin.H{}
	for _, p := range a.state.Phones {
		rt := a.phones[p.ID]
		out = append(out, gin.H{
			"id": p.ID, "phone_url": p.URL, "token_set": p.Token != "", "account": p.Account,
			"connection": rt.connection, "error": rt.err, "device": rt.device,
		})
	}
	return out
}

// ---------- 网页接口 ----------

// phoneBody 是添加或修改手机的请求。
type phoneBody struct {
	PhoneURL string `json:"phone_url"`
	Token    string `json:"token"`
}

// validPhone 校验地址和 Token；oldToken 不为空时 Token 留空表示保留原值。
func validPhone(body phoneBody, oldToken string) (string, string, string) {
	address, err := normalizePhone(body.PhoneURL)
	if err != nil {
		return "", "", err.Error()
	}
	token := strings.TrimSpace(body.Token)
	if token == "" {
		token = oldToken
	}
	if len(token) < 32 || strings.ContainsAny(token, "\r\n") {
		return "", "", "请输入有效的手机 Token（至少 32 字符）"
	}
	return address, token, ""
}

// phoneBusyLocked 手机是否有已交给它、还没结束的任务。
func (a *App) phoneBusyLocked(id string) bool {
	for _, op := range a.state.Operations {
		if op.PhoneID == id && op.active() {
			return true
		}
	}
	return false
}

// addPhone 添加一台手机；同一地址不能重复添加。
func (a *App) addPhone(c *gin.Context) {
	var body phoneBody
	if !bind(c, &body) {
		return
	}
	address, token, problem := validPhone(body, "")
	if problem != "" {
		fail(c, 400, problem)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, p := range a.state.Phones {
		if p.URL == address {
			fail(c, 409, "这台手机已经添加过了")
			return
		}
	}
	p := &PhoneConfig{ID: randomID()[:12], URL: address, Token: token}
	a.state.Phones = append(a.state.Phones, p)
	a.syncPhonesLocked()
	a.saved(c, gin.H{"id": p.ID})
}

// updatePhone 修改手机地址或 Token；有任务在执行时不允许修改，否则执行中的任务会去查询新地址。
func (a *App) updatePhone(c *gin.Context) {
	var body phoneBody
	if !bind(c, &body) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.phoneLocked(c.Param("id"))
	if p == nil {
		fail(c, 404, "手机不存在")
		return
	}
	address, token, problem := validPhone(body, p.Token)
	if problem != "" {
		fail(c, 400, problem)
		return
	}
	for _, other := range a.state.Phones {
		if other != p && other.URL == address {
			fail(c, 409, "这个地址已被另一台手机使用")
			return
		}
	}
	if a.phoneBusyLocked(p.ID) {
		fail(c, 409, "请等待这台手机的读写任务完成后再修改")
		return
	}
	if p.URL != address {
		p.Cursor = 0 // 换了手机，事件从头同步
	}
	p.URL, p.Token = address, token
	a.phones[p.ID].connection = "连接中"
	a.saved(c, gin.H{"ok": true})
}

// deletePhone 删除手机连接。会话和聊天记录仍保留在原账号下，之后有手机登录这个账号时继续使用。
func (a *App) deletePhone(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := c.Param("id")
	if a.phoneLocked(id) == nil {
		fail(c, 404, "手机不存在")
		return
	}
	if a.phoneBusyLocked(id) {
		fail(c, 409, "请等待这台手机的读写任务完成后再删除")
		return
	}
	kept := a.state.Phones[:0]
	for _, p := range a.state.Phones {
		if p.ID != id {
			kept = append(kept, p)
		}
	}
	a.state.Phones = kept
	a.syncPhonesLocked()
	a.saved(c, gin.H{"ok": true})
}

// refreshPhoneAccount 让手机重新识别当前登录的微信号（手机上切换了微信账号后使用）。
func (a *App) refreshPhoneAccount(c *gin.Context) {
	a.mu.Lock()
	p := a.phoneLocked(c.Param("id"))
	var cfg PhoneConfig
	if p != nil {
		cfg = *p
	}
	a.mu.Unlock()
	if p == nil {
		fail(c, 404, "手机不存在")
		return
	}
	if err := a.phoneRequest(c.Request.Context(), cfg, "POST", "/v1/account/refresh", map[string]any{}, "", nil); err != nil {
		fail(c, 502, err.Error())
		return
	}
	c.JSON(200, gin.H{"ok": true})
}
