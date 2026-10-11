package main

// 多台手机和多个账号。
//
// 一台手机运行一个微信桥，上报它当前登录的微信号（账号）。会话属于某个账号，不同账号的聊天记录互不混用。
// 每台手机各有一个事件循环和一个任务执行线（eventLoop、worker），互不阻塞；
// 任务交给当前登录着该会话账号的手机执行，并把预期的微信号发给手机核对，账号不一致时手机拒绝执行。

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

// maxPhoneNameRunes 设备名称最多的字数。
const maxPhoneNameRunes = 40

// 网页上显示的手机连接状态
const (
	connConnecting    = "连接中"
	connOnline        = "在线"
	connBridgeOffline = "手机桥离线"
	connNotReady      = "手机未就绪"
	connFailed        = "连接失败"
	connWaitingLink   = "等待手机重连"
)

// PhoneConfig 是一台已授权的手机（微信桥）。
type PhoneConfig struct {
	ID       string `json:"id"`
	Name     string `json:"name,omitempty"`    // 网页上起的设备名称
	DeviceID string `json:"device_id"`         // 手机桥的稳定设备编号
	Address  string `json:"address,omitempty"` // 手机最近一次连接的 IP，只用于显示
	Token    string `json:"token"`             // 配对时生成的连接凭证，手机每次连接用它证明身份
	Account  string `json:"account,omitempty"` // 手机最近一次上报的微信号
	Cursor   int64  `json:"cursor"`            // 已处理的手机事件序号
}

// phoneRuntime 是一台手机只在内存中的状态。
type phoneRuntime struct {
	connection string          // 连接状态文字
	err        string          // 最近一次连接错误
	device     json.RawMessage // 手机最近一次上报的状态
	wake       chan struct{}   // 有新任务时唤醒这台手机的 worker
	cancel     context.CancelFunc
}

// owns 判断会话是否由这台手机负责：会话的账号就是手机当前登录的账号。
func (p *PhoneConfig) owns(c *Conversation) bool {
	return c.Account != "" && c.Account == p.Account
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

// phoneConfig 返回手机当前配置（含事件游标）的副本；手机已删除时返回 false。
func (a *App) phoneConfig(id string) (PhoneConfig, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p := a.phoneLocked(id); p != nil {
		return *p, true
	}
	return PhoneConfig{}, false
}

// onlineLocked 判断手机当前是否在线并就绪。
func (a *App) onlineLocked(id string) bool {
	rt := a.phones[id]
	return rt != nil && rt.connection == connOnline
}

// phoneBusyLocked 手机是否有已交给它、还没结束的任务。
func (a *App) phoneBusyLocked(id string) bool {
	return a.deviceTaskCountLocked(id) > 0
}

// syncPhonesLocked 让每台手机都有内存状态；服务运行中时为新手机启动事件循环和 worker，停掉已删除手机的。
func (a *App) syncPhonesLocked() {
	ids := map[string]bool{}
	for _, p := range a.state.Phones {
		ids[p.ID] = true
		rt := a.phones[p.ID]
		if rt == nil {
			rt = &phoneRuntime{connection: connConnecting, wake: make(chan struct{}, 1)}
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
		if ids[id] {
			continue
		}
		if l := a.links[id]; l != nil {
			l.close()
			delete(a.links, id)
		}
		if rt.cancel != nil {
			rt.cancel()
		}
		delete(a.phones, id)
	}
}

// ---------- 手机上报的状态 ----------

// setPhoneStatus 更新手机的连接状态和上报的状态（不写数据库），并记下手机当前登录的微信号和昵称。
// 微信号或昵称变了才保存，并唤醒 worker：等着这个账号的任务可以执行了。
func (a *App) setPhoneStatus(id, status string, device json.RawMessage, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	rt, p := a.phones[id], a.phoneLocked(id)
	if rt == nil || p == nil {
		return
	}
	rt.setConnection(status, device, err)
	account, nickname := deviceAccountProfile(device)
	if a.rememberAccountLocked(p, account, nickname) {
		_ = a.commitLocked()
		a.wakeWorker()
		return
	}
	a.notifyLocked()
}

// setConnection 记下连接状态；连接恢复后清掉之前的连接错误。
func (rt *phoneRuntime) setConnection(status string, device json.RawMessage, err error) {
	rt.connection = status
	if device != nil {
		rt.device = device
	}
	if err != nil {
		rt.err = err.Error()
	} else if device != nil || status == connOnline {
		rt.err = ""
	}
}

// rememberAccountLocked 记下手机当前登录的微信号和它的昵称，返回是否有变化。
func (a *App) rememberAccountLocked(p *PhoneConfig, account, nickname string) bool {
	if account == "" {
		return false
	}
	changed := false
	if nickname != "" && a.state.AccountNames[account] != nickname {
		if a.state.AccountNames == nil {
			a.state.AccountNames = map[string]string{}
		}
		a.state.AccountNames[account] = nickname
		changed = true
	}
	if account != p.Account {
		log.Printf("手机 %s 当前账号 %s（之前 %q）", p.ID, account, p.Account)
		p.Account = account
		changed = true
	}
	return changed
}

// deviceAccountProfile 从手机上报的状态里取当前微信号和昵称，没有返回空字符串。
func deviceAccountProfile(device json.RawMessage) (wechatID, nickname string) {
	var d struct {
		Info struct {
			Account struct {
				WechatID string `json:"wechat_id"`
				Nickname string `json:"nickname"`
			} `json:"account"`
		} `json:"info"`
	}
	_ = json.Unmarshal(device, &d)
	return d.Info.Account.WechatID, strings.TrimSpace(d.Info.Account.Nickname)
}

// ---------- 账号与设备选择 ----------

// accountView 是网页上的一个账号：微信号，以及当前登录着它的手机。
type accountView struct {
	Nickname   string `json:"nickname,omitempty"`
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
		v.Nickname = a.state.AccountNames[v.WechatID]
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].WechatID < out[j].WechatID })
	return out
}

// knownAccountLocked 是否为已知的账号（有手机登录过，或已有会话）。
func (a *App) knownAccountLocked(account string) bool {
	for _, v := range a.accountsLocked() {
		if v.WechatID == account {
			return true
		}
	}
	return false
}

// deviceTaskCountLocked 已交给这台手机、还没结束的任务数。
func (a *App) deviceTaskCountLocked(id string) int {
	count := 0
	for _, op := range a.state.Operations {
		if op.PhoneID == id && op.active() {
			count++
		}
	}
	return count
}

// deviceAvailableLocked 手机能否接任务：在线，手机桥在运行、已就绪，且识别账号没有出错。
func (a *App) deviceAvailableLocked(p *PhoneConfig) bool {
	if !a.onlineLocked(p.ID) {
		return false
	}
	var d struct {
		Online *bool `json:"online"`
		Info   struct {
			Ready   *bool `json:"ready"`
			Account struct {
				Error json.RawMessage `json:"error"`
			} `json:"account"`
		} `json:"info"`
	}
	_ = json.Unmarshal(a.phones[p.ID].device, &d)
	return (d.Online == nil || *d.Online) && (d.Info.Ready == nil || *d.Info.Ready) &&
		(len(d.Info.Account.Error) == 0 || string(d.Info.Account.Error) == "null")
}

// selectDeviceLocked 为会话选择执行设备：指定了设备就只用它（不会偷偷换到另一台），
// 否则在登录着会话账号、可用的手机中选排队任务最少的。没有可用的返回 nil。
func (a *App) selectDeviceLocked(conv *Conversation, requested string) *PhoneConfig {
	var best *PhoneConfig
	for _, p := range a.state.Phones {
		if !p.owns(conv) || !a.deviceAvailableLocked(p) || (requested != "" && requested != p.ID) {
			continue
		}
		if best == nil || a.deviceTaskCountLocked(p.ID) < a.deviceTaskCountLocked(best.ID) {
			best = p
		}
	}
	return best
}

// phoneForLocked 返回负责这个会话的手机：优先可用的，没有可用的就是登录着这个账号的任意一台；都没有返回 nil。
func (a *App) phoneForLocked(c *Conversation) *PhoneConfig {
	if selected := a.selectDeviceLocked(c, ""); selected != nil {
		return selected
	}
	for _, p := range a.state.Phones {
		if p.owns(c) {
			return p
		}
	}
	return nil
}

// failOrphansLocked 让没有手机可以执行的排队任务失败（未执行，可安全重试）：
// 指定的手机被删除或换了账号，或者会话的账号没有任何手机登录着。
func (a *App) failOrphansLocked() {
	for _, op := range a.state.Operations {
		if op.Status != opQueued {
			continue
		}
		if problem := a.orphanProblemLocked(op); problem != "" {
			a.finishLocked(op, opFailed, nil, problem)
		}
	}
}

// orphanProblemLocked 排队任务没有手机可以执行的原因；有手机可以执行时返回空字符串。
func (a *App) orphanProblemLocked(op *Operation) string {
	c := a.state.Conversations[op.ConversationID]
	if op.PhoneID != "" {
		if p := a.phoneLocked(op.PhoneID); p != nil && c != nil && p.owns(c) {
			return ""
		}
		return "指定设备已移除或微信号已变化，任务未执行"
	}
	if c != nil && a.phoneForLocked(c) != nil {
		return ""
	}
	account := "（未知账号）"
	if c != nil {
		account = c.Account
	}
	return "账号 " + account + " 当前没有连接的手机，任务未执行"
}

// ---------- 网页接口 ----------

// phoneViewsLocked 网页上的手机列表（不含凭证）。
func (a *App) phoneViewsLocked() []gin.H {
	out := []gin.H{}
	for _, p := range a.state.Phones {
		rt := a.phones[p.ID]
		out = append(out, gin.H{
			"id": p.ID, "name": p.Name, "device_id": p.DeviceID, "address": p.Address, "account": p.Account,
			"connection": rt.connection, "error": rt.err, "device": rt.device,
			"available": a.deviceAvailableLocked(p), "task_count": a.deviceTaskCountLocked(p.ID),
		})
	}
	return out
}

// deletePhone 撤销手机授权：删除连接和凭证，之后连接必须重新双端确认。
// 会话和聊天记录仍保留在原账号下，之后有手机登录这个账号时继续使用。
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

// renamePhone 设置设备名称（空为不设置）。
func (a *App) renamePhone(c *gin.Context) {
	var body struct {
		Name string `json:"name"`
	}
	if !bind(c, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	if len([]rune(name)) > maxPhoneNameRunes {
		fail(c, 400, fmt.Sprintf("设备名称最多 %d 字", maxPhoneNameRunes))
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.phoneLocked(c.Param("id"))
	if p == nil {
		fail(c, 404, "设备不存在")
		return
	}
	old := p.Name
	p.Name = name
	if err := a.commitLocked(); err != nil {
		p.Name = old
		fail(c, 500, "保存失败")
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// refreshPhoneAccount 让手机在空闲时打开微信、重新识别当前登录的微信号（手机上切换了微信账号后使用）。
func (a *App) refreshPhoneAccount(c *gin.Context) {
	if _, ok := a.phoneConfig(c.Param("id")); !ok {
		fail(c, 404, "手机不存在")
		return
	}
	if err := a.phoneRequest(c.Request.Context(), c.Param("id"), "POST", "/v1/account/refresh", map[string]any{}, "", nil); err != nil {
		fail(c, 502, err.Error())
		return
	}
	c.JSON(200, gin.H{"ok": true})
}
