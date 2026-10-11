package main

// 仅新增模式：读取只看聊天底部当前一屏（必要时翻回上次读到的位置），不读更早的历史。
// 每个会话保存最近一次观察到的窗口（LiveAnchor），新的一屏和它衔接，只追加新出现的消息。
//
// 首次读取一个会话时还没有窗口：
//   - 没有新消息提示：这一屏都是已有消息，只作为基准，不导入；
//   - 有未读或通知提示：用未读条数或通知正文定位新增的部分；定位不了就整屏保留并标记缺口。

import (
	"encoding/json"
	"strings"
)

// liveAnchorSize 保存的观察窗口条数：只读底部一屏，比一屏多一些就足够衔接。
// 窗口随会话一起保存，每次保存都要序列化，不宜过大。
const liveAnchorSize = 40

// liveGapWarning 已读边界不在这一屏时给会话的提示。
const liveGapWarning = "消息衔接有缺口，已保留当前屏，可能重复或漏读。"

// mergeLiveLocked 和上次观察到的窗口衔接，只追加新出现的消息，返回是否衔接上。
// atLatest 为 false（用户翻到历史位置的被动快照，或模式切换前发起的历史读取）时，接不上就只标记稍后读取，
// 不能把这一屏当作基准或缺口追加。
func (a *App) mergeLiveLocked(c *Conversation, snap snapshot, atLatest bool) bool {
	if len(snap.Messages) == 0 {
		if atLatest {
			a.noteEmptyScreenLocked(c)
		}
		return true
	}
	window := snap.window()
	// 比已处理的快照更早、且内容都已记录：过期的结果，忽略
	stale := olderSnapshot(snap.CapturedAt, c.LiveObservedAt)
	if stale && c.recorded(window) {
		return true
	}
	c.ensureLiveAnchor()
	known := c.LiveAnchor
	start, base, aligned := newMessagesStart(known, window)
	if !c.LiveReady {
		if !atLatest {
			c.NeedsRead = true
			return true
		}
		if !c.LiveSignal {
			c.LiveAnchor, c.LiveReady, c.LiveObservedAt = liveAnchorOf(window), true, snap.CapturedAt
			return true
		}
		start, aligned = liveIncomingStart(c, window)
		base = -start
		c.LiveReady = true
	}
	if !aligned && !atLatest {
		c.NeedsRead = true
		return true
	}

	if aligned {
		a.takeWindowLocked(c, snap.Messages, window, known, start, base)
	} else {
		a.takeWindowWithGapLocked(c, snap.Messages, window)
	}
	c.noteLiveAlignment(aligned, atLatest && !stale)
	if !stale {
		c.advanceLiveWindow(window, start, snap.CapturedAt, atLatest)
	}
	return aligned
}

// mergeLiveResultLocked 并入仅新增模式读取到的聊天底部，返回是否衔接上；读取期间切回了历史模式也按发起时的模式衔接。
func (a *App) mergeLiveResultLocked(c *Conversation, raw json.RawMessage) bool {
	snap, ok := a.observeLocked(c, raw)
	return ok && a.mergeLiveLocked(c, snap, true)
}

// noteEmptyScreenLocked读到聊天底部却没有消息：有新消息提示时（聊天还没加载出来，或消息都无法识别）
// 按退避稍后重读，不能每 5 秒读一次；没有提示的空聊天直接完成基准初始化。
func (a *App) noteEmptyScreenLocked(c *Conversation) {
	if c.LiveSignal {
		a.retryReadLocked(c)
	} else if !c.LiveReady {
		c.LiveReady = true
	}
}

// recorded 窗口里的消息是否都已记录（在最近的记录中连续出现过）。
func (c *Conversation) recorded(window []Message) bool {
	count, _ := occurrences(c.recentKnown(), window)
	return count > 0
}

// noteLiveAlignment 更新缺口提示：接不上时提示缺口；底部这一屏已和记录衔接时，之前的提示不再适用。
func (c *Conversation) noteLiveAlignment(aligned, latest bool) {
	switch {
	case !aligned:
		c.ReadWarning = liveGapWarning
	case latest:
		c.ReadWarning = ""
	}
}

// advanceLiveWindow 记下这次观察到的窗口和时间；在底部读到了提示之后的内容时，新消息提示已经处理完。
func (c *Conversation) advanceLiveWindow(window []Message, start int, capturedAt string, atLatest bool) {
	if start < len(window) {
		c.LiveAnchor = liveAnchorOf(window)
	}
	if capturedAt != "" {
		c.LiveObservedAt = capturedAt
	}
	if atLatest && !olderSnapshot(capturedAt, c.LiveSignalAt) {
		c.clearLiveSignal()
	}
}

// clearLiveSignal 清除未处理的新消息提示（通知、未读条数）。
func (c *Conversation) clearLiveSignal() {
	c.LiveSignal, c.LiveUnread, c.LiveNotices = false, 0, nil
}

// liveAnchorOf 取最后 liveAnchorSize 条消息作为观察窗口，只留衔接比对需要的字段。
func liveAnchorOf(messages []Message) []Message {
	messages = messages[max(0, len(messages)-liveAnchorSize):]
	out := make([]Message, len(messages))
	for i, m := range messages {
		out[i] = Message{Seq: m.Seq, Text: m.Text, Direction: m.Direction, Sender: m.Sender, Kind: m.Kind, Time: m.Time}
	}
	return out
}

// ensureLiveAnchor 首次在仅新增模式下读取已有会话时，沿用已保存的末尾作为观察窗口，不能重新吃掉一屏新增。
func (c *Conversation) ensureLiveAnchor() {
	if !c.LiveReady {
		c.resetLiveAnchor()
	}
}

// resetLiveAnchor 用已保存的末尾重新作为观察窗口（切换到仅新增模式时）。还没有任何记录时保持未初始化。
func (c *Conversation) resetLiveAnchor() {
	if known := c.withAnchor(c.Messages); len(known) > 0 {
		c.LiveAnchor, c.LiveReady = liveAnchorOf(known), true
	}
}

// olderSnapshot candidate 是否比 previous 早（任一时间无效时返回 false）。
func olderSnapshot(candidate, previous string) bool {
	a, b := parseStamp(candidate), parseStamp(previous)
	return !a.IsZero() && !b.IsZero() && a.Before(b)
}

// liveIncomingStart 首次读取时定位新增部分：优先用手机打开聊天前记录的未读条数；
// 没有条数时用通知正文定位（只作定位，不伪造正文）。定位不了返回 false：保留当前屏并显示缺口，不静默丢弃。
func liveIncomingStart(c *Conversation, window []Message) (int, bool) {
	if c.LiveUnread > 0 {
		return startByUnreadCount(window, c.LiveUnread)
	}
	start := len(window)
	for _, notice := range c.LiveNotices {
		if pos, ok := uniqueNoticeMatch(window, notice); ok && pos < start {
			start = pos
		}
	}
	if start == len(window) {
		return 0, false
	}
	return start, true
}

// startByUnreadCount 从底部往上数 unread 条收到的消息（不含系统提示），返回最早一条的位置；不够数返回 false。
func startByUnreadCount(window []Message, unread int) (int, bool) {
	for i := len(window) - 1; i >= 0; i-- {
		if window[i].Direction == dirIncoming && window[i].Kind != msgSystem {
			unread--
			if unread == 0 {
				return i, true
			}
		}
	}
	return 0, false
}

// uniqueNoticeMatch 通知正文（群聊为“发送人: 正文”）在窗口的收到消息中唯一对应的位置。
func uniqueNoticeMatch(window []Message, notice string) (int, bool) {
	matches, pos := 0, 0
	for i, m := range window {
		body := strings.TrimSpace(notice)
		if m.Sender != "" {
			body = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(body, m.Sender+":"), m.Sender+"："))
		}
		if m.Direction == dirIncoming && body == strings.TrimSpace(m.Text) {
			matches++
			pos = i
		}
	}
	return pos, matches == 1
}
