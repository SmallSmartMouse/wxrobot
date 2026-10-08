package main

import (
	"encoding/json"
	"fmt"
)

type Conversation struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Kind      string    `json:"kind"` // unknown | person | group
	Unread    int       `json:"unread"`
	Updated   string    `json:"updated"`
	Preview   string    `json:"preview,omitempty"`
	NeedsRead bool      `json:"dirty,omitempty"` // 收到新消息提示，等待自动读取
	LastRead  string    `json:"last_read,omitempty"`
	ReadEvery int       `json:"read_every_seconds,omitempty"` // 定时读取间隔，0 为关闭
	Originals string    `json:"originals,omitempty"`          // 收到图片是否取原图：on | off；空为联系人取、群聊不取
	AI        AISetting `json:"ai"`                           // Mode 为空表示跟随名称规则
	LastSeq   int64     `json:"body_cursor"`
	Messages  []Message `json:"messages"`
}

// Message 是从手机界面观察到的一条消息。微信界面没有消息编号，Seq 是本地按观察顺序分配的。
type Message struct {
	ID         string `json:"id"`
	Seq        int64  `json:"seq"`
	Text       string `json:"text"`
	Direction  string `json:"direction"`            // incoming | outgoing | unknown
	Kind       string `json:"kind,omitempty"`       // image 表示图片
	ImageHash  string `json:"image_hash,omitempty"` // 聊天页面的缩略图
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

// wantsOriginals 表示收到的图片是否需要取原图。
func (c *Conversation) wantsOriginals() bool {
	return c.Originals == "on" || (c.Originals == "" && c.Kind == "person")
}

// firstPendingOriginal 返回最近 30 条消息中最早一张还需要取原图的图片位置，没有返回 -1。
func (c *Conversation) firstPendingOriginal() int {
	for i := max(0, len(c.Messages)-30); i < len(c.Messages); i++ {
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
	Kind          string `json:"kind"`
	Thumbnail     string `json:"thumbnail"`
	ImageError    string `json:"image_error"`
	OriginalHash  string `json:"original_hash"`  // 电脑已从手机下载并保存的原图
	OriginalError string `json:"original_error"` // 手机取原图失败的原因
	OriginalNote  string `json:"original_note"`
}

// attachImage 把这次观察到的缩略图和原图补到消息上（已有的不覆盖）。
func (a *App) attachImage(m *Message, seen observedMessage) {
	if m.Kind != "image" {
		return
	}
	// 缩略图：之前没有才保存
	if m.ImageHash == "" && seen.Thumbnail != "" {
		m.ImageHash, m.ImageError = a.saveThumbnail(seen.Thumbnail)
	}
	// 原图：已有就不动；这次取到了就记下；这次取失败就记下原因并累计次数（满 2 次不再尝试）
	switch {
	case m.OriginalHash != "":
	case seen.OriginalHash != "":
		m.OriginalHash, m.OriginalError, m.OriginalNote = seen.OriginalHash, "", seen.OriginalNote
	case seen.OriginalError != "":
		m.OriginalError = seen.OriginalError
		m.OriginalTries++
	}
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
		window[i] = Message{Text: m.Text, Direction: m.Direction, Kind: m.Kind, ImageError: m.ImageError, Time: snapshot.CapturedAt}
	}
	// 只和最近 100 条已记录消息比对
	known := c.Messages[max(0, len(c.Messages)-100):]
	start, base, aligned := newMessagesStart(known, window)
	// 接不上且不允许整批追加：什么都不做，由调用方决定（例如加深读取）
	if !aligned && !appendOnGap {
		return false
	}
	// 衔接上的部分对应已有消息：补上之前没取到的缩略图和原图。
	for i := 0; aligned && i < start; i++ {
		if k := base + i; k >= 0 && k < len(known) {
			m := &c.Messages[len(c.Messages)-len(known)+k]
			if m.Kind == "image" {
				a.attachImage(m, snapshot.Messages[i])
				a.markMessage(c.ID, m.Seq)
			}
		}
	}
	// 衔接点之后都是新消息：分配序号、计入未读、更新列表预览，并标记待写入数据库
	for i := start; i < len(window); i++ {
		m := window[i]
		a.attachImage(&m, snapshot.Messages[i])
		c.LastSeq++
		m.Seq = c.LastSeq
		m.ID = fmt.Sprintf("%s:%d", c.ID, m.Seq)
		m.Gap = !aligned && i == start
		if m.Direction == "incoming" {
			c.Unread++
		}
		c.Messages = append(c.Messages, m)
		a.markMessage(c.ID, m.Seq)
		c.Preview = m.Text
		c.Updated = now()
	}
	if !aligned {
		// 缺口批次可能包含已经回复过的消息，不触发 AI。
		a.aiCursor[c.ID] = c.LastSeq
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

// sameMessage 比较文字和类型；方向未识别时视为相同。
// 图片只比较类型和方向：同一张图每次截图的字节可能不同。
func sameMessage(a, b Message) bool {
	if a.Text != b.Text || a.Kind != b.Kind {
		return false
	}
	return a.Direction == b.Direction || a.Direction == "unknown" || b.Direction == "unknown"
}
