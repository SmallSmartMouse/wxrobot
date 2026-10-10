package main

import (
	"encoding/json"
	"strings"
	"time"
)

// liveAnchorSize 仅新增模式保存的观察窗口条数：只读底部一屏，比一屏多一些就足够衔接。
// 窗口随会话一起保存，每次保存都要序列化，不宜过大。
const liveAnchorSize = 40

// liveAnchorOf 取最后 liveAnchorSize 条消息作为观察窗口，只留衔接比对和恢复旧数据需要的字段。
func liveAnchorOf(messages []Message) []Message {
	messages = messages[max(0, len(messages)-liveAnchorSize):]
	out := make([]Message, len(messages))
	for i, m := range messages {
		out[i] = Message{Seq: m.Seq, Text: m.Text, Direction: m.Direction, Sender: m.Sender, Kind: m.Kind, Time: m.Time}
	}
	return out
}

// seedLiveAnchor 切换模式、首次进入已有会话时沿用已保存的末尾，不能重新吃掉一屏新增。
// force 为 true 时即使已初始化也重新取（切换到仅新增模式时）。
func (c *Conversation) seedLiveAnchor(force bool) {
	if c.LiveReady && !force {
		return
	}
	if known := c.withAnchor(c.Messages); len(known) > 0 {
		c.LiveAnchor, c.LiveReady = liveAnchorOf(known), true
	}
}

func olderSnapshot(candidate, previous string) bool {
	a, ea := time.Parse(time.RFC3339Nano, candidate)
	b, eb := time.Parse(time.RFC3339Nano, previous)
	return ea == nil && eb == nil && a.Before(b)
}

// 首次读取时，优先使用手机打开聊天前记录的未读数量；通知文本只作定位，不伪造正文。
func liveIncomingStart(c *Conversation, window []Message) (int, bool) {
	start := len(window)
	if c.LiveUnread > 0 {
		remaining := c.LiveUnread
		for i := len(window) - 1; i >= 0; i-- {
			if window[i].Direction == "incoming" && window[i].Kind != "system" {
				remaining--
				start = i
			}
			if remaining == 0 {
				break
			}
		}
		if remaining == 0 {
			return start, true
		}
		return 0, false
	}
	for _, notice := range c.LiveNotices {
		matches, pos := 0, 0
		for i, m := range window {
			body := strings.TrimSpace(notice)
			if m.Sender != "" {
				body = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(body, m.Sender+":"), m.Sender+"："))
			}
			if m.Direction == "incoming" && body == strings.TrimSpace(m.Text) {
				matches++
				pos = i
			}
		}
		if matches == 1 && pos < start {
			start = pos
		}
	}
	if start < len(window) {
		return start, true
	}
	// 无法确定边界：保留当前屏并显示缺口，不静默丢弃；不触发自动回复/转发。
	return 0, false
}

// 旧版本曾把通知触发的整屏读取仅存为基准。只恢复仍有缓存、从未进入正文的会话；
// 标记缺口并跳过自动回复/转发，已恢复的会话有正文，后续启动不会重复恢复。
func (a *App) recoverLiveBaselinesLocked() {
	if !a.state.NewMessagesOnly {
		return
	}
	for _, c := range a.state.Conversations {
		if c.Account == "" || !c.LiveReady || len(c.Messages) > 0 || len(c.Anchor) > 0 || len(c.LiveAnchor) == 0 {
			continue
		}
		onlyBaseline := true
		for _, m := range c.LiveAnchor {
			if m.Seq != 0 {
				onlyBaseline = false
				break
			}
		}
		if !onlyBaseline {
			continue
		}
		readAfterNotice := false
		for _, op := range a.state.Operations {
			if op.ConversationID == c.ID && op.Kind == "read" && op.Status == "succeeded" && op.NewMessagesOnly && op.Reason == "notification" {
				readAfterNotice = true
				break
			}
		}
		if !readAfterNotice {
			continue
		}
		raw, _ := json.Marshal(map[string]any{"messages": c.LiveAnchor, "captured_at": c.LiveAnchor[len(c.LiveAnchor)-1].Time})
		c.LiveReady, c.LiveSignal = false, true
		c.LiveUnread, c.LiveNotices, c.LiveObservedAt = 0, nil, ""
		a.mergeSnapshotLocked(c, raw, true, true, true)
		c.ReadWarning = "已恢复旧版本漏存的缓存消息，请核对。"
	}
}
