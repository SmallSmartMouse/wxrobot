package main

import (
	"encoding/json"
	"fmt"
	"regexp"
)

type Conversation struct {
	ID        string `json:"id"`
	Account   string `json:"account,omitempty"` // 所属微信号；单手机版本的旧会话为空，等手机上报账号后补上
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
	// 网页上删除聊天记录时留下的最后几条消息：不显示，只用来和之后读到的屏幕衔接，
	// 避免手机屏幕上还在的旧消息又被当作新消息导入。
	Anchor   []Message `json:"anchor,omitempty"`
	Messages []Message `json:"messages"`
}

// anchorSize 删除聊天记录时留作衔接点的消息条数。
const anchorSize = 5

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

// unsupportedChats 不处理的会话：公众号（旧版微信叫“订阅号消息”）是文章推送的汇总入口，不是聊天。
var unsupportedChats = map[string]bool{"公众号": true, "订阅号消息": true}

// Message 是从手机界面观察到的一条消息。微信界面没有消息编号，Seq 是本地按观察顺序分配的。
type Message struct {
	ID         string `json:"id"`
	Seq        int64  `json:"seq"`
	Text       string `json:"text"`
	Direction  string `json:"direction"`            // incoming | outgoing | unknown
	Sender     string `json:"sender,omitempty"`     // 发送人名称（来自头像描述或群昵称），没识别出来为空
	Kind       string `json:"kind,omitempty"`       // image 图片 | sticker 表情包 | system 系统提示（没有发送人）
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

// migrate 删除旧版本保存的通知、快照等非正文记录（它们没有序号），并补上列表预览。
func (c *Conversation) migrate() {
	// 正文消息都有序号，没有序号的是旧版本存下的通知和快照
	kept := c.Messages[:0]
	for _, m := range c.Messages {
		if m.Seq > 0 {
			kept = append(kept, m)
		}
	}
	c.Messages = kept
	// 草稿模式已移除，视为关闭
	if c.AI.Mode == "draft" {
		c.AI.Mode = "off"
	}
	// 旧数据没有预览字段，用最后一条消息补上
	if c.Preview == "" && len(kept) > 0 {
		c.Preview = kept[len(kept)-1].Text
	}
}

// wantsOriginals 表示收到的图片是否需要取原图（默认取；聊天页的缩略图只有屏幕上显示的大小，不清晰）。
func (c *Conversation) wantsOriginals() bool {
	return c.Originals != "off"
}

// originalWindow 只为最近这么多条消息里的图片补取原图。
// 停止点会挪到最早一张待取原图的图片之前，回看太远时手机要翻很多页（长消息的群一条就占一屏）。
const originalWindow = 10

// firstPendingOriginal 返回最近 originalWindow 条消息中最早一张还需要取原图的图片位置，没有返回 -1。
func (c *Conversation) firstPendingOriginal() int {
	for i := max(0, len(c.Messages)-originalWindow); i < len(c.Messages); i++ {
		m := c.Messages[i]
		if m.Kind == "image" && m.OriginalHash == "" && m.OriginalTries < 2 {
			return i
		}
	}
	return -1
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
	OriginalNote  string `json:"original_note"`
}

// isMedia 图片和表情包：文字是固定的“[图片]”“[表情]”，内容在缩略图里。
func isMedia(m Message) bool { return m.Kind == "image" || m.Kind == "sticker" }

// unanchored 不能用来定位的消息：图片、表情的文字是固定的，系统提示常常重复出现。
// 手机端 afterTexts 跳过同样的类型，两边必须一致。
func unanchored(m Message) bool { return isMedia(m) || m.Kind == "system" }

// legacyNotice 旧版本没有区分系统提示，把它们存成了方向未识别的文字；按常见的提示文字认出来。
var legacyNotice = regexp.MustCompile(`^(你的账号被限制与对方聊天|.{0,40}撤回了一条消息|以上是打招呼的内容|你已添加了.{1,40}，现在可以开始聊天了|.{1,80}加入了群聊|.{1,40}修改群名为|.{1,40}拍了拍)`)

// markLegacyNotices 把旧记录里的系统提示改为 system 类型，返回改过的消息序号。
func (c *Conversation) markLegacyNotices() []int64 {
	var changed []int64
	for i := range c.Messages {
		m := &c.Messages[i]
		if m.Kind == "" && m.Direction == "unknown" && legacyNotice.MatchString(m.Text) {
			m.Kind = "system"
			changed = append(changed, m.Seq)
		}
	}
	return changed
}

// attachObserved 把这次观察到的发送人、缩略图和原图补到消息上（已有的不覆盖），返回消息是否有变化。
func (a *App) attachObserved(m *Message, seen observedMessage) bool {
	before := *m
	// 发送人：之前被屏幕边缘截断没识别出来的，这次补上
	if m.Sender == "" {
		m.Sender = seen.Sender
	}
	// 缩略图：之前没有才保存
	if isMedia(*m) && m.ImageHash == "" && seen.Thumbnail != "" {
		m.ImageHash, m.ImageError = a.saveThumbnail(seen.Thumbnail)
	}
	// 原图：已有就不动；这次取到了就记下；这次取失败就记下原因并累计次数（满 2 次不再尝试）
	if m.Kind == "image" {
		switch {
		case m.OriginalHash != "":
		case seen.OriginalHash != "":
			m.OriginalHash, m.OriginalError, m.OriginalNote = seen.OriginalHash, "", seen.OriginalNote
		case seen.OriginalError != "":
			m.OriginalError = seen.OriginalError
			m.OriginalTries++
		}
	}
	return *m != before
}

// rememberAvatar 保存发送人的头像（以最新一次截取的为准）。
func (a *App) rememberAvatar(c *Conversation, seen observedMessage) {
	if seen.Sender == "" || seen.Avatar == "" {
		return
	}
	hash, problem := a.saveThumbnail(seen.Avatar)
	if problem != "" {
		return
	}
	if c.Members == nil {
		c.Members = map[string]string{}
	}
	c.Members[seen.Sender] = hash
}

// mergeLocked 把手机读到的一屏（或多屏）消息并入会话，返回是否与已有记录衔接上。
//
// 在已记录消息的末尾与新窗口之间找唯一的衔接点，只追加衔接点之后的消息。
// 找不到衔接点时：appendOnGap 为 true 则整窗追加并标记缺口，否则什么都不做，由调用方决定是否加深读取。
func (a *App) mergeLocked(c *Conversation, raw json.RawMessage, appendOnGap bool) bool {
	var snapshot struct {
		Messages   []observedMessage `json:"messages"`
		CapturedAt string            `json:"captured_at"`
	}
	// 没有消息时视为已衔接，调用方不需要再处理
	if json.Unmarshal(raw, &snapshot) != nil || len(snapshot.Messages) == 0 {
		return true
	}
	// 把手机上报的消息转成待比对的窗口，时间统一用这次的观察时间
	window := make([]Message, len(snapshot.Messages))
	for i, m := range snapshot.Messages {
		window[i] = Message{Text: m.Text, Direction: m.Direction, Sender: m.Sender, Kind: m.Kind, ImageError: m.ImageError, Time: snapshot.CapturedAt}
	}
	// 只和最近 100 条已记录消息比对；记录被删除过且不足 100 条时，前面接上删除时留下的衔接点
	recent := c.Messages[max(0, len(c.Messages)-100):]
	known := recent
	if len(recent) < 100 {
		known = c.withAnchor(recent)
	}
	prefix := len(known) - len(recent) // known 开头这么多条是衔接点，不对应 c.Messages
	start, base, aligned := newMessagesStart(known, window)
	// 接不上且不允许整批追加：什么都不做，由调用方决定（例如加深读取）
	if !aligned && !appendOnGap {
		return false
	}
	for _, seen := range snapshot.Messages {
		a.rememberAvatar(c, seen)
	}
	// 衔接上的部分对应已有消息：补上之前没取到的发送人、缩略图和原图。
	for i := 0; aligned && i < start; i++ {
		if k := base + i - prefix; k >= 0 && k < len(recent) {
			m := &c.Messages[len(c.Messages)-len(recent)+k]
			if a.attachObserved(m, snapshot.Messages[i]) {
				a.markMessage(c.ID, m.Seq)
			}
		}
	}
	// 衔接点之后都是新消息：分配序号、计入未读、更新列表预览，并标记待写入数据库
	for i := start; i < len(window); i++ {
		m := window[i]
		a.attachObserved(&m, snapshot.Messages[i])
		c.LastSeq++
		m.Seq = c.LastSeq
		m.ID = fmt.Sprintf("%s:%d", c.ID, m.Seq)
		m.Gap = !aligned && i == start
		if m.Direction == "incoming" {
			c.Unread++
		}
		c.Messages = append(c.Messages, m)
		a.markMessage(c.ID, m.Seq)
		// 系统提示不作为列表预览
		if m.Kind != "system" {
			c.Preview = m.Text
			c.Updated = now()
		}
	}
	if !aligned {
		// 缺口批次可能包含已经回复、转发过的消息，不触发 AI 和转发。
		a.skipNewMessagesLocked(c)
	}
	return aligned
}

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
	// 逐个起点比较 needle 的每一条
	for i := 0; i+len(needle) <= len(hay); i++ {
		matched := true
		for j := range needle {
			if !sameMessage(hay[i+j], needle[j]) {
				matched = false
				break
			}
		}
		if matched {
			count, pos = count+1, i
		}
	}
	return count, pos
}

// sameMessage 比较文字、类型和发送人；方向未识别、发送人为空（被屏幕边缘截断、旧记录）时视为相同。
// 图片只比较类型和方向：同一张图每次截图的字节可能不同。
func sameMessage(a, b Message) bool {
	if a.Text != b.Text || a.Kind != b.Kind {
		return false
	}
	if a.Sender != "" && b.Sender != "" && a.Sender != b.Sender {
		return false
	}
	return a.Direction == b.Direction || a.Direction == "unknown" || b.Direction == "unknown"
}
