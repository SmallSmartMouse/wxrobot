package main

// 会话：一个微信号下的一个联系人或群聊，以及它的聊天记录和读取、AI 回复等设置。

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// 会话类型
const (
	kindUnknown = "unknown"
	kindPerson  = "person"
	kindGroup   = "group"
)

type Conversation struct {
	ID        string `json:"id"`
	Account   string `json:"account"` // 所属微信号
	Title     string `json:"title"`
	Kind      string `json:"kind"` // unknown | person | group
	Unread    int    `json:"unread"`
	Updated   string `json:"updated"`
	Preview   string `json:"preview,omitempty"`
	NeedsRead bool   `json:"dirty,omitempty"` // 收到新消息提示，等待自动读取
	// 还有图片没取原图，等待补读。比新消息提示优先级低，同一会话至少间隔 originalsReadGap，避免手机被反复读取占满。
	OriginalsDue bool      `json:"originals_due,omitempty"`
	LastRead     string    `json:"last_read,omitempty"`
	ReadEvery    int       `json:"read_every_seconds,omitempty"` // 定时读取间隔，0 为关闭
	Originals    string    `json:"originals,omitempty"`          // 收到图片是否取原图：on | off；空为取
	AI           AISetting `json:"ai"`                           // Mode 为空表示跟随名称规则
	LastSeq      int64     `json:"body_cursor"`
	// 发送人名称 → 头像（聊天页截取的图片哈希）。手机每次读取只为每个发送人截一次头像，所以按人保存，不放在每条消息上。
	Members map[string]string `json:"members,omitempty"`
	// 仅新增模式（live_messages.go）的读取状态
	LiveSignal     bool      `json:"live_signal,omitempty"` // 有新消息提示，不能把首次读取整屏吞作基准
	LiveUnread     int       `json:"live_unread,omitempty"`
	LiveNotices    []string  `json:"live_notices,omitempty"`
	LiveSignalAt   string    `json:"live_signal_at,omitempty"`
	LiveObservedAt string    `json:"live_observed_at,omitempty"`
	LiveReady      bool      `json:"live_ready,omitempty"`  // 空聊天也可以完成基准初始化
	LiveAnchor     []Message `json:"live_anchor,omitempty"` // 最近观察窗口；未导入的基准消息 Seq 为 0
	ReadRetryAt    string    `json:"read_retry_at,omitempty"`
	ReadFailures   int       `json:"read_failures,omitempty"` // 连续没能读到内容的自动读取次数，决定重读的等待时间
	ReadWarning    string    `json:"read_warning,omitempty"`
	// 网页上删除聊天记录时留下的最后几条消息：不显示，只用来和之后读到的屏幕衔接，
	// 避免手机屏幕上还在的旧消息又被当作新消息导入。
	Anchor   []Message `json:"anchor,omitempty"`
	Messages []Message `json:"messages"`
}

// 收到图片是否取原图
const (
	originalsOn  = "on"
	originalsOff = "off"
)

// unsupportedChats 不处理的会话：公众号（旧版微信叫“订阅号消息”）是文章推送的汇总入口，不是聊天。
var unsupportedChats = map[string]bool{"公众号": true, "订阅号消息": true}

// wechatSystemTitle 微信自己的系统通知（“你有1条消息未发送”等）的标题，不是会话名称。
const wechatSystemTitle = "微信"

// anchorSize 删除聊天记录时留作衔接点的消息条数。
const anchorSize = 5

// validKind 检查会话类型是否合法。
func validKind(kind string) bool {
	return kind == kindPerson || kind == kindGroup || kind == kindUnknown
}

// classified 会话类型已经确定（联系人或群聊）。
func (c *Conversation) classified() bool { return c.Kind == kindPerson || c.Kind == kindGroup }

// wantsOriginals 表示收到的图片是否需要取原图（默认取；聊天页的缩略图只有屏幕上显示的大小，不清晰）。
func (c *Conversation) wantsOriginals() bool { return c.Originals != originalsOff }

// withAnchor 在 messages 前面接上删除记录时留下的衔接点（返回新切片，不修改原数据）。
func (c *Conversation) withAnchor(messages []Message) []Message {
	return append(append([]Message{}, c.Anchor...), messages...)
}

// clearHistory 清空聊天记录，留下最后几条作为衔接点，返回被删除的消息。
func (c *Conversation) clearHistory() []Message {
	removed := c.Messages
	all := c.withAnchor(removed)
	c.Anchor = nil
	for _, m := range all[max(0, len(all)-anchorSize):] {
		c.Anchor = append(c.Anchor, Message{Text: m.Text, Direction: m.Direction, Sender: m.Sender, Kind: m.Kind})
	}
	c.Messages = []Message{}
	c.Unread, c.Preview = 0, ""
	c.NeedsRead, c.OriginalsDue = false, false
	return removed
}

// conversationLocked 按账号和名称查找会话，不存在时新建。不同账号的同名会话是不同的会话。
func (a *App) conversationLocked(account, title string) *Conversation {
	for _, c := range a.state.Conversations {
		if c.Account == account && c.Title == title {
			return c
		}
	}
	// 会话编号由账号和名称的哈希得出
	h := sha256.Sum256([]byte(account + "\x00" + title))
	c := &Conversation{ID: hex.EncodeToString(h[:12]), Account: account, Title: title, Kind: kindUnknown, Updated: now(), Messages: []Message{}}
	a.state.Conversations[c.ID] = c
	return c
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
	for hash := range a.mediaInUseLocked() {
		delete(candidates, hash)
	}
	for hash := range candidates {
		if path, ok := a.mediaPath(hash); ok {
			_ = os.Remove(path)
		}
	}
}

// mediaInUseLocked 当前所有会话、任务引用的图片哈希。
func (a *App) mediaInUseLocked() map[string]bool {
	inUse := map[string]bool{}
	for _, c := range a.state.Conversations {
		for _, m := range c.Messages {
			inUse[m.ImageHash], inUse[m.OriginalHash] = true, true
		}
		for _, hash := range c.Members {
			inUse[hash] = true
		}
	}
	for _, op := range a.state.Operations {
		inUse[op.ImageHash] = true
		for _, s := range op.Steps {
			inUse[s.Image] = true
		}
	}
	return inUse
}

// ---------- 网页接口 ----------

// createConversation 手动添加会话（名称必须与手机上显示的完整名称一致）。已存在时更新类型。
func (a *App) createConversation(c *gin.Context) {
	var body struct {
		Account string `json:"account"`
		Title   string `json:"title"`
		Kind    string `json:"kind"`
	}
	if !bind(c, &body) {
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" || len([]rune(title)) > 128 || strings.ContainsAny(title, "\r\n\x00") || !validKind(body.Kind) {
		fail(c, 400, "请输入完整微信昵称或群名称，并选择会话类型")
		return
	}
	if unsupportedChats[title] {
		fail(c, 400, "不支持公众号消息")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.knownAccountLocked(body.Account) {
		fail(c, 400, "请先选择账号；没有账号时先连接手机，等手机识别出微信号")
		return
	}
	conv := a.conversationLocked(body.Account, title)
	conv.Kind = body.Kind
	a.saved(c, conv)
}

// getConversation 返回会话详情和全部消息，附带实际生效的 AI 回复方式（页面用来显示设置摘要）。
func (a *App) getConversation(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if conv := a.conversation(c); conv != nil {
		c.JSON(200, struct {
			*Conversation
			AIEffective AISetting `json:"ai_effective"`
		}{conv, a.aiSettingLocked(conv)})
	}
}

// clearConversation 删除会话在本地的聊天记录，只删电脑上的，手机上的微信不受影响。
// 有读写任务在执行时也可以删：任务结果回来时和删除时留下的衔接点比对，屏幕上的旧消息不会再导入。
func (a *App) clearConversation(c *gin.Context) {
	a.updateConversation(c, a.clearHistoryLocked)
}

// markSeen 清除会话的未读数。
func (a *App) markSeen(c *gin.Context) {
	a.updateConversation(c, func(conv *Conversation) { conv.Unread = 0 })
}

// setKind 设置会话类型（联系人 / 群聊 / 待分类）。
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
	a.updateConversation(c, func(conv *Conversation) { conv.Kind = body.Kind })
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
	a.updateConversation(c, func(conv *Conversation) { conv.ReadEvery = body.Seconds })
}

// setOriginals 设置收到图片时是否取原图：on | off。
func (a *App) setOriginals(c *gin.Context) {
	var body struct {
		Mode string `json:"originals"`
	}
	if !bind(c, &body) {
		return
	}
	if body.Mode != originalsOn && body.Mode != originalsOff {
		fail(c, 400, "originals 必须为 on 或 off")
		return
	}
	a.updateConversation(c, func(conv *Conversation) { conv.Originals = body.Mode })
}

// updateConversation 对路径中的会话执行 change 并保存；会话不存在时返回 404。
func (a *App) updateConversation(c *gin.Context, change func(*Conversation)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if conv := a.conversation(c); conv != nil {
		change(conv)
		a.saved(c, gin.H{"ok": true})
	}
}
