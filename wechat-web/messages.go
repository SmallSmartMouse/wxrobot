package main

// 消息合并：微信界面没有消息编号，手机每次上报的是屏幕上看到的一段消息（窗口）。
// 合并时在已有记录的末尾与新窗口之间找衔接点，只追加衔接点之后的消息。
//
// 两种读取模式（State.NewMessagesOnly）衔接的对象不同：
//   - 历史模式：和最近 100 条已记录的消息衔接，接不上时可以加深读取（向上翻更多页）。
//   - 仅新增模式（live_messages.go）：和上次观察到的窗口衔接，不向上翻页补漏。

import (
	"encoding/json"
	"fmt"
	"sort"
)

// 消息方向
const (
	dirIncoming = "incoming"
	dirOutgoing = "outgoing"
	dirUnknown  = "unknown"
)

// 消息类型（普通文字为空）
const (
	msgImage   = "image"   // 图片
	msgSticker = "sticker" // 表情包
	msgSystem  = "system"  // 系统提示（没有发送人）
)

// Message 是从手机界面观察到的一条消息。Seq 是本地按观察顺序分配的。
type Message struct {
	ID         string `json:"id"`
	Seq        int64  `json:"seq"`
	Text       string `json:"text"`
	Direction  string `json:"direction"`            // incoming | outgoing | unknown
	Sender     string `json:"sender,omitempty"`     // 发送人名称（来自头像描述或群昵称），没识别出来为空
	Kind       string `json:"kind,omitempty"`       // image | sticker | system，文字为空
	ImageHash  string `json:"image_hash,omitempty"` // 聊天页面的缩略图（表情包也是）
	ImageError string `json:"image_error,omitempty"`
	// 原图：手机点开大图后保存的文件。取失败会重试，最多 2 次。
	OriginalHash  string `json:"original_hash,omitempty"`
	OriginalError string `json:"original_error,omitempty"`
	OriginalTries int    `json:"original_tries,omitempty"`
	OriginalNote  string `json:"original_note,omitempty"` // 例如：没有权限，用大图截图代替
	Time          string `json:"time"`                    // 观察时间，不是微信发送时间
	Gap           bool   `json:"gap,omitempty"`           // 与之前的记录没能衔接，前面可能有遗漏或重复
}

// observedMessage 是手机上报的一条消息（来自读取结果或屏幕快照）。
type observedMessage struct {
	Text          string `json:"text"`
	Direction     string `json:"direction"`
	Sender        string `json:"sender"`
	Avatar        string `json:"avatar"` // 发送人头像（JPEG Base64），每次读取每个发送人只带一次
	Kind          string `json:"kind"`
	Thumbnail     string `json:"thumbnail"`
	ImageError    string `json:"image_error"`
	OriginalHash  string `json:"original_hash"`  // 电脑已从手机下载并保存的原图
	OriginalError string `json:"original_error"` // 手机取原图失败的原因
	// 手机没有尝试取原图的原因（例如没能在屏幕上定位这张图片）：没点开过大图，不计入失败次数
	OriginalSkipped string `json:"original_skipped"`
	OriginalNote    string `json:"original_note"`
}

// snapshot 是手机上报的一屏消息，或一次读取向上翻页拼出的多屏消息。
type snapshot struct {
	Messages   []observedMessage `json:"messages"`
	CapturedAt string            `json:"captured_at"`
	ChatType   string            `json:"chat_type"` // 手机识别出的会话类型（只在要求识别时有）
	AtLatest   bool              `json:"at_latest"` // 停在聊天底部；用户翻到历史位置时的被动快照为 false
}

// window 把上报的消息转成待比对的消息，时间统一用这次的观察时间。
func (s snapshot) window() []Message {
	window := make([]Message, len(s.Messages))
	for i, m := range s.Messages {
		window[i] = Message{Text: m.Text, Direction: m.Direction, Sender: m.Sender, Kind: m.Kind, ImageError: m.ImageError, Time: s.CapturedAt}
	}
	return window
}

// isMedia 图片和表情包：文字是固定的“[图片]”“[表情]”，内容在缩略图里。
func isMedia(m Message) bool { return m.Kind == msgImage || m.Kind == msgSticker }

// unanchored 不能用来定位的消息：图片、表情的文字是固定的，系统提示常常重复出现。
// 手机端 afterTexts 跳过同样的类型，两边必须一致。
func unanchored(m Message) bool { return isMedia(m) || m.Kind == msgSystem }

// ---------- 合并入口 ----------

// mergeLocked 并入一屏消息，返回是否与已有记录衔接上；接不上时什么都不做，由调用方决定（例如加深读取）。
// 是否停在聊天底部以快照自己的标记为准。
func (a *App) mergeLocked(c *Conversation, raw json.RawMessage) bool {
	snap, ok := a.observeLocked(c, raw)
	if !ok {
		return true
	}
	if a.state.NewMessagesOnly {
		return a.mergeLiveLocked(c, snap, snap.AtLatest)
	}
	return a.mergeHistoryLocked(c, snap)
}

// mergeOrAppendLocked 同 mergeLocked，但接不上时整窗追加并标记缺口（读取已经够深，不会再加深）。
func (a *App) mergeOrAppendLocked(c *Conversation, raw json.RawMessage) bool {
	snap, ok := a.observeLocked(c, raw)
	if !ok {
		return true
	}
	if a.state.NewMessagesOnly {
		return a.mergeLiveLocked(c, snap, snap.AtLatest)
	}
	if a.mergeHistoryLocked(c, snap) {
		return true
	}
	a.takeWindowWithGapLocked(c, snap.Messages, snap.window())
	return false
}

// mergeLatestLocked 并入主动读取到的聊天底部一屏（仅新增模式据此确认已读边界、清除新消息提示）。
func (a *App) mergeLatestLocked(c *Conversation, raw json.RawMessage) bool {
	snap, ok := a.observeLocked(c, raw)
	if !ok {
		return true
	}
	if a.state.NewMessagesOnly {
		return a.mergeLiveLocked(c, snap, true)
	}
	return a.mergeHistoryLocked(c, snap)
}

// mergeStaleReadLocked 并入切换到仅新增模式之前发起的读取结果：当作不在底部的一屏，只保留能衔接的部分。
func (a *App) mergeStaleReadLocked(c *Conversation, raw json.RawMessage) {
	if snap, ok := a.observeLocked(c, raw); ok {
		a.mergeLiveLocked(c, snap, false)
	}
}

// observeLocked 解析上报的消息，并顺带补齐会话类型。格式无效时返回 false（视为没有消息）。
func (a *App) observeLocked(c *Conversation, raw json.RawMessage) (snapshot, bool) {
	var snap snapshot
	if json.Unmarshal(raw, &snap) != nil {
		return snap, false
	}
	// 只补齐未分类会话，不覆盖用户已设置的类型；空聊天也能识别。
	if !c.classified() && (snap.ChatType == kindPerson || snap.ChatType == kindGroup) {
		c.Kind = snap.ChatType
	}
	return snap, true
}

// ---------- 历史模式 ----------

// mergeHistoryLocked 和最近已记录的消息衔接，只追加衔接点之后的消息；接不上时什么都不做，返回 false。
func (a *App) mergeHistoryLocked(c *Conversation, snap snapshot) bool {
	if len(snap.Messages) == 0 {
		return true
	}
	window, known := snap.window(), c.recentKnown()
	start, base, aligned := newMessagesStart(known, window)
	if aligned {
		a.takeWindowLocked(c, snap.Messages, window, known, start, base)
	}
	return aligned
}

// alignWindow 衔接时比对的已有记录条数：与手机一次最多读取的条数一致，读回来的窗口都能落在里面。
const alignWindow = 100

// recentKnown 用来衔接的已有记录：最近 alignWindow 条；记录被删除过且不足 100 条时，前面接上删除时留下的衔接点。
func (c *Conversation) recentKnown() []Message {
	recent := c.Messages[max(0, len(c.Messages)-alignWindow):]
	if len(recent) < alignWindow {
		return c.withAnchor(recent)
	}
	return recent
}

// ---------- 并入窗口 ----------

// takeWindowLocked 把已衔接的窗口并入会话：window[:start] 对应 known[base:] 中已记录的消息，补上之前没取到的信息；
// window[start:] 作为新消息追加。
func (a *App) takeWindowLocked(c *Conversation, observed []observedMessage, window, known []Message, start, base int) {
	a.rememberAvatarsLocked(c, observed)
	a.attachKnownLocked(c, observed, window, known, start, base)
	a.appendNewLocked(c, window, observed, start)
}

// takeWindowWithGapLocked 接不上已有记录时整窗追加，第一条标记缺口。
// 缺口批次可能包含已经回复、转发过的消息，不触发 AI 和转发。
func (a *App) takeWindowWithGapLocked(c *Conversation, observed []observedMessage, window []Message) {
	a.rememberAvatarsLocked(c, observed)
	a.appendNewLocked(c, window, observed, 0)
	c.messageBySeq(window[0].Seq).Gap = true
	a.skipNewMessagesLocked(c)
}

// attachKnownLocked 衔接上的部分对应已有消息：补上之前没取到的发送人、缩略图和原图。
// 窗口里的这些条目换成已记录的消息（带序号），仅新增模式用它作观察窗口。
func (a *App) attachKnownLocked(c *Conversation, observed []observedMessage, window, known []Message, start, base int) {
	for i := 0; i < start; i++ {
		k := base + i
		if k < 0 || k >= len(known) {
			continue
		}
		window[i] = known[k]
		// 衔接点（删除记录时留下的）和仅新增模式没导入过的基准消息序号为 0，找不到对应的消息
		if m := c.messageBySeq(known[k].Seq); m != nil && a.attachObserved(m, observed[i]) {
			a.markMessage(c.ID, m.Seq)
		}
	}
}

// appendNewLocked 把 window[start:] 作为新消息追加：分配序号、计入未读、更新列表预览，并标记待写入数据库。
// 追加后 window 里对应的条目换成带序号的消息。
func (a *App) appendNewLocked(c *Conversation, window []Message, observed []observedMessage, start int) {
	for i := start; i < len(window); i++ {
		m := window[i]
		a.attachObserved(&m, observed[i])
		c.LastSeq++
		m.Seq = c.LastSeq
		m.ID = fmt.Sprintf("%s:%d", c.ID, m.Seq)
		if m.Direction == dirIncoming {
			c.Unread++
		}
		window[i] = m
		c.Messages = append(c.Messages, m)
		a.markMessage(c.ID, m.Seq)
		// 系统提示不作为列表预览
		if m.Kind != msgSystem {
			c.Preview = m.Text
			c.Updated = now()
		}
	}
}

// attachObserved 把这次观察到的方向、发送人、缩略图和原图补到消息上（已有的不覆盖），返回消息是否有变化。
func (a *App) attachObserved(m *Message, seen observedMessage) bool {
	before := *m
	// 方向和发送人：之前被屏幕边缘截断、没看到头像的，这次补上
	if m.Direction == dirUnknown && (seen.Direction == dirIncoming || seen.Direction == dirOutgoing) {
		m.Direction = seen.Direction
	}
	if m.Sender == "" {
		m.Sender = seen.Sender
	}
	// 缩略图：之前没有才保存
	if isMedia(*m) && m.ImageHash == "" && seen.Thumbnail != "" {
		m.ImageHash, m.ImageError = a.saveThumbnail(seen.Thumbnail)
	}
	// 原图：已有就不动；这次取到了就记下；这次取失败就记下原因并累计次数（满 maxOriginalTries 次不再尝试）；
	// 手机没有尝试（没能定位）只记下原因，下次读取还会再取
	if m.Kind == msgImage {
		switch {
		case m.OriginalHash != "":
		case seen.OriginalHash != "":
			m.OriginalHash, m.OriginalError, m.OriginalNote = seen.OriginalHash, "", seen.OriginalNote
		case seen.OriginalError != "":
			m.OriginalError = seen.OriginalError
			m.OriginalTries++
		case seen.OriginalSkipped != "":
			m.OriginalError = seen.OriginalSkipped
		}
	}
	return *m != before
}

// rememberAvatarsLocked 保存发送人的头像（以最新一次截取的为准）。
func (a *App) rememberAvatarsLocked(c *Conversation, observed []observedMessage) {
	for _, seen := range observed {
		if seen.Sender == "" || seen.Avatar == "" {
			continue
		}
		hash, problem := a.saveThumbnail(seen.Avatar)
		if problem != "" {
			continue
		}
		if c.Members == nil {
			c.Members = map[string]string{}
		}
		c.Members[seen.Sender] = hash
	}
}

// messageBySeq 按序号找消息（消息按序号递增保存），没有返回 nil。
func (c *Conversation) messageBySeq(seq int64) *Message {
	i := sort.Search(len(c.Messages), func(i int) bool { return c.Messages[i].Seq >= seq })
	if i == len(c.Messages) || c.Messages[i].Seq != seq {
		return nil
	}
	return &c.Messages[i]
}

// ---------- 衔接点 ----------

// newMessagesStart 返回 window 中第一条新消息的位置 start，以及 window[0] 对应 known 中的位置 base
// （window[i] 与 known[base+i] 是同一条消息，i < start）；aligned 为 false 表示无法确定衔接点。
func newMessagesStart(known, window []Message) (start, base int, aligned bool) {
	// 还没有任何记录：整个窗口都是新消息
	if len(known) == 0 {
		return 0, 0, true
	}
	if count, pos := occurrences(known, window); count > 0 {
		return len(window), pos, true // 整个窗口都已记录过
	}
	// 从最长的已知末尾开始，找它在新窗口中唯一出现的位置。
	for n := min(len(known), len(window)); n > 0; n-- {
		count, pos := occurrences(window, known[len(known)-n:])
		if count == 1 {
			return pos + n, len(known) - n - pos, true
		}
		if count > 1 {
			return 0, 0, false // 重复内容导致衔接点不唯一
		}
	}
	return 0, 0, false
}

// occurrences 统计 needle 在 hay 中连续出现的次数，并返回最后一次出现的位置。
func occurrences(hay, needle []Message) (count, pos int) {
	for i := 0; i+len(needle) <= len(hay); i++ {
		if sameRun(hay[i:i+len(needle)], needle) {
			count, pos = count+1, i
		}
	}
	return count, pos
}

// sameRun 两段消息逐条相同。
func sameRun(a, b []Message) bool {
	for i := range b {
		if !sameMessage(a[i], b[i]) {
			return false
		}
	}
	return true
}

// sameMessage 比较文字、类型和发送人；方向未识别、发送人为空（被屏幕边缘截断）时视为相同。
// 图片只比较类型和方向：同一张图每次截图的字节可能不同。
func sameMessage(a, b Message) bool {
	if a.Text != b.Text || a.Kind != b.Kind {
		return false
	}
	if a.Sender != "" && b.Sender != "" && a.Sender != b.Sender {
		return false
	}
	return a.Direction == b.Direction || a.Direction == dirUnknown || b.Direction == dirUnknown
}
