package main

// 事件同步：每台手机一个 eventLoop，查询手机状态，再长轮询手机推送的消息事件并入会话。

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	reconnectDelay   = 3 * time.Second // 连不上手机时，等这么久再试
	eventBatchSize   = 100             // 一次长轮询最多取的事件数
	eventWaitSeconds = 20              // 长轮询最多等的秒数，须小于 phoneCallTimeout
	maxLiveNotices   = 20              // 每个会话保留的最近通知正文条数，用来定位新增消息
)

// PhoneEvent 是手机推送的消息事件：
//   - notification：微信通知（只有预览文字）
//   - unread_chat：首页出现新的未读会话
//   - visible_snapshot：当前打开的聊天内容有变化
type PhoneEvent struct {
	Seq         int64           `json:"seq"`
	UnreadCount int             `json:"unread_count"`
	ReceivedAt  string          `json:"received_at"`
	Kind        string          `json:"kind"`
	Account     string          `json:"account"` // 事件发生时手机登录的微信号
	Chat        string          `json:"chat"`
	Text        string          `json:"text"`
	Snapshot    json.RawMessage `json:"snapshot"`
}

// eventBatch 是一次长轮询拿到的事件，以及手机端的事件游标。
type eventBatch struct {
	Events []PhoneEvent `json:"events"`
	Cursor int64        `json:"cursor"`
	Latest int64        `json:"latest_cursor"`
}

// eventLoop 循环同步一台手机：查询手机状态，再长轮询新事件并入会话。手机被删除时退出。
func (a *App) eventLoop(ctx context.Context, phoneID string) {
	for ctx.Err() == nil {
		cfg, ok := a.phoneConfig(phoneID)
		if !ok {
			return
		}
		err := a.refreshDeviceStatus(ctx, phoneID)
		var batch eventBatch
		if err == nil {
			batch, err = a.pollEvents(ctx, phoneID, cfg.Cursor)
		}
		if err != nil {
			if ctx.Err() == nil { // 服务退出导致的失败不算连接失败
				a.setPhoneStatus(phoneID, connFailed, nil, err)
			}
			pause(ctx, reconnectDelay)
			continue
		}
		a.applyEvents(phoneID, cfg, batch)
	}
}

// refreshDeviceStatus 查询手机状态，换算成网页上显示的连接状态并记录。
func (a *App) refreshDeviceStatus(ctx context.Context, phoneID string) error {
	var raw json.RawMessage
	if err := a.phoneRequest(ctx, phoneID, "GET", "/v1/device", nil, "", &raw); err != nil {
		return err
	}
	a.setPhoneStatus(phoneID, connectionStatus(raw), raw, nil)
	return nil
}

// connectionStatus 把手机上报的状态换算成网页上显示的连接状态。
func connectionStatus(device json.RawMessage) string {
	var d struct {
		Online bool `json:"online"`
		Info   struct {
			Ready bool `json:"ready"`
		} `json:"info"`
	}
	_ = json.Unmarshal(device, &d)
	switch {
	case !d.Online:
		return connBridgeOffline
	case !d.Info.Ready:
		return connNotReady
	}
	return connOnline
}

// pollEvents 长轮询游标之后的新事件：手机有事件时立即返回，否则最多等 eventWaitSeconds 秒。
func (a *App) pollEvents(ctx context.Context, phoneID string, cursor int64) (eventBatch, error) {
	var batch eventBatch
	err := a.phoneRequest(ctx, phoneID, "GET", fmt.Sprintf("/v1/events?after=%d&limit=%d&wait=%d", cursor, eventBatchSize, eventWaitSeconds), nil, "", &batch)
	return batch, err
}

// applyEvents 把一批事件并入会话并推进事件游标。polled 是发起轮询时的手机配置。
func (a *App) applyEvents(phoneID string, polled PhoneConfig, batch eventBatch) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.phoneLocked(phoneID)
	switch {
	case p == nil:
		return
	// 等待期间重新配对过（凭证变了），这批事件来自之前的连接，丢弃
	case p.Token == polled.Token && len(batch.Events) > 0:
		for _, e := range batch.Events {
			a.ingestLocked(e)
		}
		p.Cursor = batch.Cursor
		_ = a.commitLocked()
		a.wakeWorker() // 通知类事件需要尽快读取
	// 手机事件序号比本地游标还小，说明换了手机或手机时钟回拨，从头同步。
	case batch.Latest < polled.Cursor:
		p.Cursor = 0
		_ = a.commitLocked()
	}
}

// ingestLocked 处理一条事件：通知和未读提示只标记会话需要读取（通知文字作为列表预览），
// 当前聊天的屏幕快照直接并入正文。会话归到事件发生时手机登录的账号；手机还没识别出账号时丢弃，之后的读取会补上。
func (a *App) ingestLocked(e PhoneEvent) {
	if e.Account == "" || !chatEvent(e) {
		return
	}
	c := a.conversationLocked(e.Account, e.Chat)
	switch e.Kind {
	case "notification":
		c.noteNotification(e)
	case "unread_chat":
		c.noteUnread(e)
	case "visible_snapshot":
		// 监测不点开图片，由读取任务去取原图
		pendingBefore := c.firstPendingOriginal()
		a.mergeLocked(c, e.Snapshot)
		c.noteOriginalsProgress(pendingBefore)
	}
}

// chatEvent 事件是否属于一个要处理的聊天：不是公众号，也不是微信自己的系统通知。
func chatEvent(e PhoneEvent) bool {
	return strings.TrimSpace(e.Chat) != "" && !unsupportedChats[e.Chat] && !(e.Kind == "notification" && e.Chat == wechatSystemTitle)
}

// noteNotification 记下微信通知：新消息提示（最近的通知正文用于定位新增部分）、列表预览，并等待读取。
func (c *Conversation) noteNotification(e PhoneEvent) {
	c.LiveSignal, c.LiveSignalAt = true, e.ReceivedAt
	if e.Text != "" {
		c.LiveNotices = append(c.LiveNotices, e.Text)
		c.LiveNotices = c.LiveNotices[max(0, len(c.LiveNotices)-maxLiveNotices):]
	}
	c.Preview, c.Updated = e.Text, now()
	c.NeedsRead = true
}

// noteUnread 记下首页的未读标记：新消息提示和未读条数（用于定位新增部分），并等待读取。
func (c *Conversation) noteUnread(e PhoneEvent) {
	c.LiveSignal, c.LiveSignalAt = true, e.ReceivedAt
	if e.UnreadCount > 0 {
		c.LiveUnread = max(c.LiveUnread, e.UnreadCount)
	}
	c.NeedsRead = true
}
