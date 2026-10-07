package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type PhoneConfig struct {
	URL   string `json:"phone_url"`
	Token string `json:"token"`
}

// Operation 是一次读取或发送任务。ID 由网页生成，同时作为手机任务的 Idempotency-Key，
// 因此服务重启后重新提交也不会让手机重复执行。
type Operation struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversation_id"`
	Kind           string          `json:"kind"` // read | send
	Text           string          `json:"text,omitempty"`
	ImageHash      string          `json:"image_hash,omitempty"`
	Limit          int             `json:"limit,omitempty"`
	Auto           bool            `json:"auto,omitempty"`   // 自动发起的读取
	Reason         string          `json:"reason,omitempty"` // 自动读取原因：notification | schedule | deep
	Status         string          `json:"status"`           // queued | running | succeeded | failed | unknown
	Error          string          `json:"error,omitempty"`
	PhoneTaskID    string          `json:"phone_task_id,omitempty"`
	Created        string          `json:"created"`
	Diagnostics    json.RawMessage `json:"diagnostics,omitempty"` // 手机上报的阶段、耗时和异常，不保存图片正文
}

func (op *Operation) active() bool { return op.Status == "queued" || op.Status == "running" }

// PhoneEvent 是手机推送的消息事件：
//   - notification：微信通知（只有预览文字）
//   - unread_chat：首页出现新的未读会话
//   - visible_snapshot：当前打开的聊天内容有变化
type PhoneEvent struct {
	Seq      int64           `json:"seq"`
	Kind     string          `json:"kind"`
	Chat     string          `json:"chat"`
	Text     string          `json:"text"`
	Snapshot json.RawMessage `json:"snapshot"`
}

// phoneError 表示手机返回了 HTTP 错误（请求已送达，但被拒绝）。
type phoneError struct {
	Status  int
	Message string
}

func (e *phoneError) Error() string { return e.Message }

func (a *App) phoneRequest(ctx context.Context, cfg PhoneConfig, method, path string, body any, key string, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, cfg.URL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return errors.New("无法连接手机，请检查 IP、同一网络及手机服务")
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return errors.New("手机响应中断")
	}
	if resp.StatusCode >= 300 {
		var fault struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.Unmarshal(b, &fault)
		if fault.Error.Message == "" {
			fault.Error.Message = fmt.Sprintf("手机返回 HTTP %d", resp.StatusCode)
		}
		return &phoneError{resp.StatusCode, fault.Error.Message}
	}
	if out != nil && json.Unmarshal(b, out) != nil {
		return errors.New("手机返回的数据格式无效")
	}
	return nil
}

// normalizePhone 接受“IP”或“http://IP:端口”，默认端口 8766。
func normalizePhone(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	invalid := err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") ||
		u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/")
	if invalid {
		return "", errors.New("请输入手机 IP 或 http://手机IP:8766")
	}
	if u.Port() == "" {
		u.Host = net.JoinHostPort(u.Hostname(), "8766")
	} else if p, err := strconv.Atoi(u.Port()); err != nil || p < 1 || p > 65535 {
		return "", errors.New("端口无效")
	}
	u.Path = ""
	return u.String(), nil
}

// importPhoneConfig 首次启动时从 bridge 的凭证文件导入 Token。
func (a *App) importPhoneConfig(phone, credentials string) error {
	address, err := normalizePhone(phone)
	if err != nil {
		return err
	}
	var keys struct {
		Token string `json:"phone_api_token"`
	}
	if b, err := os.ReadFile(credentials); err == nil {
		_ = json.Unmarshal(b, &keys)
	}
	if keys.Token == "" {
		return nil
	}
	a.state.Phone = PhoneConfig{URL: address, Token: keys.Token}
	return a.saveLocked()
}

func (a *App) setConnection(status string, device json.RawMessage, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.connection = status
	if device != nil {
		a.device = device
	}
	if err != nil {
		a.lastError = err.Error()
	} else if status == "在线" {
		a.lastError = "" // 连接恢复后清掉之前的连接错误
	}
	a.notifyLocked()
}

// ---------- 事件同步 ----------

// eventLoop 查询手机状态，再长轮询新事件（手机有事件时立即返回，否则最多等 20 秒）。
func (a *App) eventLoop(ctx context.Context) {
	for ctx.Err() == nil {
		a.mu.Lock()
		cfg, cursor := a.state.Phone, a.state.Cursor
		a.mu.Unlock()
		if cfg.URL == "" || cfg.Token == "" {
			pause(ctx, time.Second)
			continue
		}
		var device struct {
			Online bool `json:"online"`
			Info   struct {
				Ready bool `json:"ready"`
			} `json:"info"`
		}
		var raw json.RawMessage
		err := a.phoneRequest(ctx, cfg, "GET", "/v1/device", nil, "", &raw)
		if err == nil {
			_ = json.Unmarshal(raw, &device)
			status := "在线"
			if !device.Online {
				status = "手机桥离线"
			} else if !device.Info.Ready {
				status = "手机未就绪"
			}
			a.setConnection(status, raw, nil)
		}
		var batch struct {
			Events []PhoneEvent `json:"events"`
			Cursor int64        `json:"cursor"`
			Latest int64        `json:"latest_cursor"`
		}
		if err == nil {
			err = a.phoneRequest(ctx, cfg, "GET", fmt.Sprintf("/v1/events?after=%d&limit=100&wait=20", cursor), nil, "", &batch)
		}
		if err != nil {
			if ctx.Err() == nil {
				a.setConnection("连接失败", nil, err)
			}
			pause(ctx, 3*time.Second)
			continue
		}

		a.mu.Lock()
		if a.state.Phone == cfg && len(batch.Events) > 0 {
			for _, e := range batch.Events {
				a.ingestLocked(e)
			}
			a.state.Cursor = batch.Cursor
			_ = a.commitLocked()
			a.wakeWorker() // 通知类事件需要尽快读取
		} else if batch.Latest < cursor {
			// 手机事件序号比本地游标还小，说明换了手机或手机时钟回拨，从头同步。
			a.state.Cursor = 0
			_ = a.commitLocked()
		}
		a.mu.Unlock()
	}
}

func (a *App) ingestLocked(e PhoneEvent) {
	if strings.TrimSpace(e.Chat) == "" {
		return
	}
	c := a.conversationLocked(e.Chat)
	switch e.Kind {
	case "notification":
		c.Preview = e.Text
		c.Updated = now()
		c.NeedsRead = true
	case "unread_chat":
		c.NeedsRead = true
	case "visible_snapshot":
		a.mergeLocked(c, e.Snapshot, false)
		if c.wantsOriginals() && c.firstPendingOriginal() >= 0 {
			c.NeedsRead = true // 监测不点开图片，由读取任务去取原图
		}
	}
}

// ---------- 读写任务 ----------

// worker 串行执行任务：同一时刻只有一个任务在操作手机。没有任务时安排自动读取。
// 状态为 running 的任务是上次服务退出时未完成的，会接着查询结果而不是重新执行。
func (a *App) worker(ctx context.Context) {
	for ctx.Err() == nil {
		if id := a.nextOperation(); id != "" {
			a.runOperation(ctx, id)
			continue
		}
		if a.scheduleAutoRead() {
			continue
		}
		select {
		case <-ctx.Done():
		case <-a.wake:
		case <-time.After(time.Second):
		}
	}
}

func (a *App) wakeWorker() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

func (a *App) nextOperation() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var next *Operation
	for _, op := range a.state.Operations {
		if op.active() && (next == nil || op.Created < next.Created) {
			next = op
		}
	}
	if next == nil {
		return ""
	}
	return next.ID
}

const (
	triggerReadGap = 5 * time.Second // 收到提示后，同一会话两次读取的最短间隔
	shallowRead    = 30              // 自动读取的条数
	deepRead       = 100             // 接不上已有记录时加深读取的条数
)

// scheduleAutoRead 选出一个需要读取的会话并建立读取任务，返回是否建立了任务。
//   - 收到通知或未读提示：距上次读取满 5 秒即读（优先）
//   - 开启了定时读取：距上次读取满设定间隔
//
// 同类会话中先读最久没读的。
func (a *App) scheduleAutoRead() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.connection != "在线" {
		return false
	}
	var pick *Conversation
	var pickReason string
	var pickLast time.Time
	for _, c := range a.state.Conversations {
		last, _ := time.Parse(time.RFC3339Nano, c.LastRead)
		reason := ""
		if c.NeedsRead && time.Since(last) >= triggerReadGap {
			reason = "notification"
		} else if c.ReadEvery > 0 && time.Since(last) >= time.Duration(c.ReadEvery)*time.Second {
			reason = "schedule"
		}
		better := pick == nil ||
			(reason == "notification" && pickReason == "schedule") ||
			(reason == pickReason && last.Before(pickLast))
		if reason != "" && better {
			pick, pickReason, pickLast = c, reason, last
		}
	}
	if pick == nil {
		return false
	}
	a.queueReadLocked(pick, shallowRead, pickReason)
	return true
}

func (a *App) queueReadLocked(c *Conversation, limit int, reason string) {
	c.NeedsRead = false
	c.LastRead = now()
	op := &Operation{ID: "auto-" + randomID(), ConversationID: c.ID, Kind: "read", Limit: limit, Auto: true, Reason: reason, Status: "queued", Created: now()}
	a.state.Operations[op.ID] = op
	_ = a.commitLocked()
	a.wakeWorker()
}

func (a *App) runOperation(ctx context.Context, id string) {
	a.mu.Lock()
	op := a.state.Operations[id]
	c := a.state.Conversations[op.ConversationID]
	cfg := a.state.Phone
	kind, taskID := op.Kind, op.PhoneTaskID
	body := map[string]any{"chat": c.Title}
	if c.Kind == "group" {
		body["chat_type"] = "group"
	}
	switch {
	case kind == "read":
		body["limit"] = op.Limit
		body["return_list"] = op.Auto // 自动读取后回到首页，便于继续发现其他未读会话
		if op.Auto {
			// 手机向上翻页读到这几条已记录的消息就停，不必每次都读满 limit 条。
			// 需要取原图时，停在最早一张还没有原图的图片之前，让它落在“新消息”范围里，由手机点开取原图。
			known := c.Messages
			if c.wantsOriginals() {
				body["originals"] = 2
				if i := c.firstPendingOriginal(); i >= 0 {
					known = c.Messages[:i]
				}
			}
			body["until"] = lastTexts(known, 3)
		}
	case op.ImageHash != "":
		data, err := a.readImage(op.ImageHash)
		if err != nil {
			a.finishLocked(op, "failed", nil, "图片文件不存在")
			a.mu.Unlock()
			return
		}
		body["image_base64"] = data
	default:
		body["text"] = op.Text
	}
	op.Status = "running"
	log.Printf("任务 %s 开始 类型=%s 手机任务=%s", op.ID, op.Kind, op.PhoneTaskID)
	_ = a.commitLocked()
	a.mu.Unlock()

	// 发送请求可能已经到达手机，无法确定是否执行过，所以发送只能是“结果未知”。
	uncertain := "failed"
	if kind == "send" {
		uncertain = "unknown"
	}
	taskCtx, cancel := context.WithTimeout(ctx, 4*time.Minute) // 读取时可能要点开大图取原图
	defer cancel()
	var task struct {
		ID     string          `json:"id"`
		Status string          `json:"status"`
		Result json.RawMessage `json:"result"`
	}
	if taskID == "" {
		err := a.phoneRequest(taskCtx, cfg, "POST", "/v1/messages/"+kind, body, id, &task)
		var rejected *phoneError
		switch {
		case ctx.Err() != nil:
			return // 服务正在退出，任务保持 running，下次启动用同一 ID 重新提交
		case errors.As(err, &rejected):
			a.finish(id, "failed", nil, err.Error())
			return
		case err != nil:
			a.finish(id, uncertain, nil, err.Error())
			return
		}
		a.mu.Lock()
		op.PhoneTaskID = task.ID
		log.Printf("任务 %s 手机已受理 手机任务=%s 状态=%s", id, task.ID, task.Status)
		_ = a.commitLocked()
		a.mu.Unlock()
	} else {
		task.ID, task.Status = taskID, "running"
	}

	for task.Status == "queued" || task.Status == "running" {
		if !pause(taskCtx, time.Second) {
			if ctx.Err() == nil {
				a.finish(id, uncertain, nil, "等待手机超时，结果未知；不会自动重发")
			}
			return
		}
		err := a.phoneRequest(taskCtx, cfg, "GET", "/v1/tasks/"+url.PathEscape(task.ID), nil, "", &task)
		var rejected *phoneError
		if errors.As(err, &rejected) && rejected.Status == http.StatusNotFound {
			a.finish(id, uncertain, nil, "手机桥已重启，任务结果未知；不会自动重发")
			return
		}
	}
	if kind == "read" && task.Status == "succeeded" {
		task.Result = a.downloadOriginals(taskCtx, cfg, task.Result)
	}
	a.finish(id, task.Status, task.Result, "")
}

// downloadOriginals 下载读取结果中手机保存的原图文件（手机发送后即删除），
// 把 original_file 换成本地的 original_hash。
func (a *App) downloadOriginals(ctx context.Context, cfg PhoneConfig, result json.RawMessage) json.RawMessage {
	var r map[string]any
	if json.Unmarshal(result, &r) != nil {
		return result
	}
	messages, _ := r["messages"].([]any)
	for _, item := range messages {
		m, _ := item.(map[string]any)
		name, _ := m["original_file"].(string)
		if name == "" {
			continue
		}
		delete(m, "original_file")
		data, err := a.phoneDownload(ctx, cfg, "/v1/files/"+url.PathEscape(name))
		var hash string
		if err == nil {
			hash, err = a.saveOriginal(data)
		}
		if err != nil {
			m["original_error"] = "原图下载或保存失败：" + err.Error()
		} else {
			m["original_hash"] = hash
		}
	}
	b, err := json.Marshal(r)
	if err != nil {
		return result
	}
	return b
}

func (a *App) phoneDownload(ctx context.Context, cfg PhoneConfig, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", cfg.URL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, errors.New("无法连接手机")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("手机返回 HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (40<<20)+1))
	if err != nil || len(data) > 40<<20 {
		return nil, errors.New("文件过大或传输中断")
	}
	return data, nil
}

// lastTexts 返回最后 n 条文字消息（跳过图片，图片的文字都是“[图片]”，无法区分）。
func lastTexts(messages []Message, n int) []string {
	texts := []string{}
	for i := len(messages) - 1; i >= 0 && len(texts) < n; i-- {
		if messages[i].Kind != "image" {
			texts = append([]string{messages[i].Text}, texts...)
		}
	}
	return texts
}

func (a *App) finish(id, status string, result json.RawMessage, message string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.finishLocked(a.state.Operations[id], status, result, message)
}

// finishLocked 记录任务结果，并把读到的消息并入会话。
func (a *App) finishLocked(op *Operation, status string, result json.RawMessage, message string) {
	op.Status, op.Error = status, message
	c := a.state.Conversations[op.ConversationID]
	var r struct {
		Code        string          `json:"code"`
		Message     string          `json:"message"`
		Snapshot    json.RawMessage `json:"snapshot"`   // 发送后补读的当前屏幕
		SyncError   string          `json:"sync_error"` // 发送成功但补读失败
		Diagnostics json.RawMessage `json:"diagnostics"`
	}
	_ = json.Unmarshal(result, &r)
	if len(r.Diagnostics) > 0 && len(r.Diagnostics) <= 8192 {
		op.Diagnostics = append(json.RawMessage(nil), r.Diagnostics...)
	}
	log.Printf("任务 %s 类型=%s 状态=%s 代码=%s", op.ID, op.Kind, status, r.Code)
	switch {
	case status != "succeeded":
		if op.Error == "" {
			op.Error = r.Message
		}
		if op.Error == "" {
			op.Error = r.Code
		}
	case op.Kind == "read":
		// 自动读取的 30 条接不上已有记录，说明期间新消息较多：先加深到 100 条再读，仍接不上才整批追加并标记缺口。
		deepEnough := !op.Auto || op.Limit >= deepRead
		pendingBefore := c.firstPendingOriginal()
		if !a.mergeLocked(c, result, deepEnough) {
			a.queueReadLocked(c, deepRead, "deep")
		} else if c.wantsOriginals() && c.firstPendingOriginal() >= 0 && c.firstPendingOriginal() != pendingBefore {
			c.NeedsRead = true // 还有图片没取原图，且这次有进展：接着读
		}
	default:
		// 发送后的屏幕快照接不上（发送前有没读到的消息）或补读失败时，再安排一次读取。
		if r.SyncError != "" || len(r.Snapshot) == 0 || !a.mergeLocked(c, r.Snapshot, false) {
			c.NeedsRead = true
		}
	}
	if err := a.commitLocked(); err != nil {
		log.Printf("任务 %s 结果保存失败", op.ID)
	}
}
