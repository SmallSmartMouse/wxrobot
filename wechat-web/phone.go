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
	"strconv"
	"strings"
	"time"
)

// Operation 是一次读取或发送任务。ID 由网页生成，同时作为手机任务的 Idempotency-Key，
// 因此服务重启后重新提交也不会让手机重复执行。
type Operation struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id"`
	Kind           string `json:"kind"` // read | send
	Text           string `json:"text,omitempty"`
	ImageHash      string `json:"image_hash,omitempty"`
	Limit          int    `json:"limit,omitempty"`
	Auto           bool   `json:"auto,omitempty"`   // 自动发起的读取
	Reason         string `json:"reason,omitempty"` // 自动读取原因：notification | schedule | originals | deep
	Status         string `json:"status"`           // queued | running | succeeded | failed | unknown
	Error          string `json:"error,omitempty"`
	PhoneTaskID    string `json:"phone_task_id,omitempty"`
	PhoneID        string `json:"phone_id,omitempty"` // 执行这个任务的手机：开始执行时确定，服务重启后仍向同一台手机查询
	Created        string `json:"created"`
	// 手机上报的执行记录：耗时、步骤，以及降级（操作完成了但用了不太可靠的办法，例如标题改用 OCR 核对）。
	DurationMS int64         `json:"duration_ms,omitempty"`
	Steps      []TaskStep    `json:"steps,omitempty"`
	Warnings   []TaskWarning `json:"warnings,omitempty"`
}

type TaskStep struct {
	MS     int64  `json:"ms"` // 距任务开始的毫秒数
	Step   string `json:"step"`
	Detail string `json:"detail,omitempty"`
	Image  string `json:"image,omitempty"` // 截图（例如出错时的屏幕画面）：手机上报 Base64，保存后换成图片哈希
}

type TaskWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// active 表示任务还没结束（排队中或执行中）。
func (op *Operation) active() bool { return op.Status == "queued" || op.Status == "running" }

// PhoneEvent 是手机推送的消息事件：
//   - notification：微信通知（只有预览文字）
//   - unread_chat：首页出现新的未读会话
//   - visible_snapshot：当前打开的聊天内容有变化
type PhoneEvent struct {
	Seq      int64           `json:"seq"`
	Kind     string          `json:"kind"`
	Account  string          `json:"account"` // 事件发生时手机登录的微信号（旧版手机桥没有）
	Chat     string          `json:"chat"`
	Text     string          `json:"text"`
	Snapshot json.RawMessage `json:"snapshot"`
}

// phoneError 表示手机返回了 HTTP 错误（请求已送达，但被拒绝）。
type phoneError struct {
	Status  int
	Message string
}

// Error 返回手机给出的错误说明。
func (e *phoneError) Error() string { return e.Message }

// phoneRequest 调用手机桥接口：body 不为空时以 JSON 发送，key 不为空时作为 Idempotency-Key，
// 成功时把响应解析到 out。网络不通返回普通错误；手机返回 HTTP 错误时返回 *phoneError。
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
	// 手机接口用 Bearer Token 鉴权
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
	// 响应最多读 16 MB（读取结果可能带几张缩略图）
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return errors.New("手机响应中断")
	}
	// 手机拒绝了请求：取出手机给的错误说明，没有就用状态码
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
	// 只填了 IP 时补上 http://
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	invalid := err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") ||
		u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/")
	if invalid {
		return "", errors.New("请输入手机 IP 或 http://手机IP:8766")
	}
	// 没写端口用默认 8766，写了就检查范围
	if u.Port() == "" {
		u.Host = net.JoinHostPort(u.Hostname(), "8766")
	} else if p, err := strconv.Atoi(u.Port()); err != nil || p < 1 || p > 65535 {
		return "", errors.New("端口无效")
	}
	u.Path = ""
	return u.String(), nil
}

// ---------- 事件同步 ----------

// eventLoop 查询一台手机的状态，再长轮询新事件（手机有事件时立即返回，否则最多等 20 秒）。手机被删除时退出。
func (a *App) eventLoop(ctx context.Context, phoneID string) {
	for ctx.Err() == nil {
		// 每轮取一次当前配置和事件游标
		a.mu.Lock()
		p := a.phoneLocked(phoneID)
		var cfg PhoneConfig
		if p != nil {
			cfg = *p
		}
		a.mu.Unlock()
		if p == nil {
			return
		}
		cursor := cfg.Cursor
		var device struct {
			Online bool `json:"online"`
			Info   struct {
				Ready bool `json:"ready"`
			} `json:"info"`
		}
		var raw json.RawMessage
		// 第一步：查询手机状态，换算成网页上显示的连接状态
		err := a.phoneRequest(ctx, cfg, "GET", "/v1/device", nil, "", &raw)
		if err == nil {
			_ = json.Unmarshal(raw, &device)
			status := "在线"
			if !device.Online {
				status = "手机桥离线"
			} else if !device.Info.Ready {
				status = "手机未就绪"
			}
			a.setPhoneStatus(phoneID, status, raw, nil)
		}
		var batch struct {
			Events []PhoneEvent `json:"events"`
			Cursor int64        `json:"cursor"`
			Latest int64        `json:"latest_cursor"`
		}
		// 第二步：长轮询游标之后的新事件
		if err == nil {
			err = a.phoneRequest(ctx, cfg, "GET", fmt.Sprintf("/v1/events?after=%d&limit=100&wait=20", cursor), nil, "", &batch)
		}
		if err != nil {
			if ctx.Err() == nil {
				a.setPhoneStatus(phoneID, "连接失败", nil, err)
			}
			pause(ctx, 3*time.Second)
			continue
		}

		a.mu.Lock()
		// 等待期间如果改了手机地址或删除了手机，这批事件来自旧手机，丢弃
		p = a.phoneLocked(phoneID)
		if p != nil && p.URL == cfg.URL && p.Token == cfg.Token && len(batch.Events) > 0 {
			for _, e := range batch.Events {
				a.ingestLocked(p, e)
			}
			p.Cursor = batch.Cursor
			_ = a.commitLocked()
			a.wakeWorker() // 通知类事件需要尽快读取
		} else if p != nil && batch.Latest < cursor {
			// 手机事件序号比本地游标还小，说明换了手机或手机时钟回拨，从头同步。
			p.Cursor = 0
			_ = a.commitLocked()
		}
		a.mu.Unlock()
	}
}

// wechatSystemTitle 微信自己的系统通知（“你有1条消息未发送”等）的标题，不是会话名称。
const wechatSystemTitle = "微信"

// ingestLocked 处理手机 p 的一条事件：通知和未读提示只标记会话需要读取（通知文字作为列表预览），
// 当前聊天的屏幕快照直接并入正文。会话归到事件发生时手机登录的账号；手机还没识别出账号时丢弃，之后的读取会补上。
func (a *App) ingestLocked(p *PhoneConfig, e PhoneEvent) {
	if strings.TrimSpace(e.Chat) == "" || unsupportedChats[e.Chat] || (e.Kind == "notification" && e.Chat == wechatSystemTitle) {
		return
	}
	account := e.Account
	if account == "" {
		account = p.Account // 旧版手机桥的事件不带账号
	}
	if account == "" {
		return
	}
	c := a.conversationLocked(account, e.Chat)
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
			c.OriginalsDue = true // 监测不点开图片，由读取任务去取原图
		}
	}
}

// ---------- 读写任务 ----------

// worker 串行执行一台手机的任务：同一时刻这台手机上只有一个任务。没有任务时安排自动读取。手机被删除时退出。
// 状态为 running 的任务是上次服务退出时未完成的，会接着查询结果而不是重新执行。
func (a *App) worker(ctx context.Context, phoneID string) {
	for ctx.Err() == nil {
		// 有待执行的任务先执行，执行完马上看下一个
		if id := a.nextOperation(phoneID); id != "" {
			a.runOperation(ctx, phoneID, id)
			continue
		}
		// 没有任务时，看是否有会话需要自动读取
		if a.scheduleAutoRead(phoneID) {
			continue
		}
		a.mu.Lock()
		rt := a.phones[phoneID]
		a.mu.Unlock()
		if rt == nil {
			return
		}
		// 都没有就等：有新任务时被唤醒，否则每秒检查一次（定时读取靠这个触发）
		select {
		case <-ctx.Done():
		case <-rt.wake:
		case <-time.After(time.Second):
		}
	}
}

// wakeWorker 唤醒所有手机的 worker 立即检查任务；已有未处理的唤醒时不重复发送。调用前须持有锁。
func (a *App) wakeWorker() {
	for _, rt := range a.phones {
		select {
		case rt.wake <- struct{}{}:
		default:
		}
	}
}

// nextOperation 返回这台手机要执行的最早的未结束任务编号，没有返回空字符串：
// 已交给这台手机的任务，或者会话由这台手机负责、还没交给任何手机的任务。选中的任务即归这台手机。
func (a *App) nextOperation(phoneID string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.failOrphansLocked()
	p := a.phoneLocked(phoneID)
	if p == nil {
		return ""
	}
	var next *Operation
	for _, op := range a.state.Operations {
		if !op.active() || (next != nil && op.Created >= next.Created) {
			continue
		}
		c := a.state.Conversations[op.ConversationID]
		if op.PhoneID == phoneID || (op.PhoneID == "" && c != nil && p.owns(c)) {
			next = op
		}
	}
	if next == nil {
		return ""
	}
	next.PhoneID = phoneID
	return next.ID
}

const (
	triggerReadGap   = 5 * time.Second  // 收到提示后，同一会话两次读取的最短间隔
	originalsReadGap = 60 * time.Second // 只为补取原图时，同一会话两次读取的最短间隔
	shallowRead      = 30               // 没有已记录的文字可作停止点时，自动读取的条数
	deepRead         = 100              // 有停止点时自动读取的条数（读到已记录的消息就停）；也是接不上时加深读取的条数
)

// readPriority 自动读取原因的优先级，数字小的先读。
var readPriority = map[string]int{"notification": 0, "schedule": 1, "originals": 2}

// scheduleAutoRead 选出一个需要读取的会话并建立读取任务，返回是否建立了任务。
//   - 收到通知或未读提示：距上次读取满 5 秒即读（优先）
//   - 开启了定时读取：距上次读取满设定间隔
//   - 还有图片没取原图：距上次读取满 1 分钟
//
// 同类会话中先读最久没读的。
func (a *App) scheduleAutoRead(phoneID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	// 手机不在线时不安排，免得产生一堆失败的读取；只安排这台手机负责的会话
	p := a.phoneLocked(phoneID)
	if p == nil || !a.onlineLocked(phoneID) {
		return false
	}
	var pick *Conversation
	var pickReason string
	var pickLast time.Time
	// 逐个会话判断是否需要读取，按原因的优先级、其次最久没读挑出一个
	for _, c := range a.state.Conversations {
		if !p.owns(c) {
			continue
		}
		last, _ := time.Parse(time.RFC3339Nano, c.LastRead)
		reason := ""
		if c.NeedsRead && time.Since(last) >= triggerReadGap {
			reason = "notification"
		} else if c.ReadEvery > 0 && time.Since(last) >= time.Duration(c.ReadEvery)*time.Second {
			reason = "schedule"
		} else if c.OriginalsDue && time.Since(last) >= originalsReadGap {
			reason = "originals"
		}
		better := pick == nil ||
			readPriority[reason] < readPriority[pickReason] ||
			(reason == pickReason && last.Before(pickLast))
		if reason != "" && better {
			pick, pickReason, pickLast = c, reason, last
		}
	}
	if pick == nil {
		return false
	}
	// 有已记录的文字作停止点时直接按 100 条读：手机读到它们就停，新消息少时不会多翻页；
	// 新消息多时一次读完，不必先读 30 条接不上、再从头读 100 条。
	limit := shallowRead
	if len(autoReadUntil(pick)) > 0 {
		limit = deepRead
	}
	a.queueReadLocked(pick, limit, pickReason)
	return true
}

// queueReadLocked 为会话建立一个自动读取任务，清除“需要读取”标记并记下读取时间，然后唤醒 worker。
func (a *App) queueReadLocked(c *Conversation, limit int, reason string) {
	c.NeedsRead, c.OriginalsDue = false, false
	c.LastRead = now()
	op := &Operation{ID: "auto-" + randomID(), ConversationID: c.ID, Kind: "read", Limit: limit, Auto: true, Reason: reason, Status: "queued", Created: now()}
	a.state.Operations[op.ID] = op
	_ = a.commitLocked()
	a.wakeWorker()
}

// runOperation 执行一个任务：组装请求提交给手机，再每秒查询一次直到完成，最后记录结果。
// 任务编号同时作为 Idempotency-Key，重复提交不会让手机重复执行。
func (a *App) runOperation(ctx context.Context, phoneID, id string) {
	a.mu.Lock()
	op := a.state.Operations[id]
	c := a.state.Conversations[op.ConversationID]
	p := a.phoneLocked(phoneID)
	if p == nil || c == nil {
		a.finishLocked(op, "failed", nil, "手机或会话已删除，任务未执行")
		a.mu.Unlock()
		return
	}
	cfg := *p
	op.PhoneID = phoneID
	kind, taskID := op.Kind, op.PhoneTaskID
	// 组装手机任务参数：聊天名称、群聊标记、预期的微信号（手机核对，不一致时拒绝执行），再按读取 / 发图 / 发文字补充
	body := map[string]any{"chat": c.Title}
	if c.Account != "" {
		body["account"] = c.Account
	}
	if c.Kind == "group" {
		body["chat_type"] = "group"
	}
	switch {
	case kind == "read":
		body["limit"] = op.Limit
		body["return_list"] = op.Auto // 自动读取后回到首页，便于继续发现其他未读会话
		if op.Auto {
			if c.wantsOriginals() {
				body["originals"] = 2
			}
			body["until"] = autoReadUntil(c)
		}
	// 发图片：把本地保存的图片以 Base64 发给手机
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
	// 先标记为执行中并保存，服务中途退出后能识别出这是未完成的任务
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
	// 还没提交过：提交给手机，记下手机返回的任务编号；已提交过（服务重启后）直接继续查询
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
		// 保存手机任务编号，服务重启后据此继续查询，而不是重新提交
		a.mu.Lock()
		op.PhoneTaskID = task.ID
		log.Printf("任务 %s 手机已受理 手机任务=%s 状态=%s", id, task.ID, task.Status)
		_ = a.commitLocked()
		a.mu.Unlock()
	} else {
		task.ID, task.Status = taskID, "running"
	}

	// 每秒查询一次任务状态，直到结束或超时
	for task.Status == "queued" || task.Status == "running" {
		if !pause(taskCtx, time.Second) {
			if ctx.Err() == nil {
				a.finish(id, uncertain, nil, "等待手机超时，结果未知；不会自动重发")
			}
			return
		}
		err := a.phoneRequest(taskCtx, cfg, "GET", "/v1/tasks/"+url.PathEscape(task.ID), nil, "", &task)
		var rejected *phoneError
		// 手机查不到这个任务：手机桥重启过，任务结果已经丢失
		if errors.As(err, &rejected) && rejected.Status == http.StatusNotFound {
			a.finish(id, uncertain, nil, "手机桥已重启，任务结果未知；不会自动重发")
			return
		}
	}
	// 读取成功时，先把手机取到的原图文件下载下来，再合并消息
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
	// 逐条消息检查是否带了原图文件名；下载并保存后换成本地的哈希，失败则记下原因
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

// phoneDownload 从手机下载文件（原图），最多 40 MB。
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

// autoReadUntil 自动读取的停止点：已记录的最后 3 条文字，手机向上翻页读到它们就停，不必每次都读满 limit 条。
// 需要取原图时，停在最早一张还没有原图的图片之前，让它落在“新消息”范围里，由手机点开取原图。
func autoReadUntil(c *Conversation) []string {
	known := c.Messages
	if c.wantsOriginals() {
		if i := c.firstPendingOriginal(); i >= 0 {
			known = c.Messages[:i]
		}
	}
	return lastTexts(c.withAnchor(known), 3)
}

// lastTexts 返回最后 n 条文字消息（跳过图片、表情和系统提示，它们无法区分位置）。
func lastTexts(messages []Message, n int) []string {
	texts := []string{}
	for i := len(messages) - 1; i >= 0 && len(texts) < n; i-- {
		if !unanchored(messages[i]) {
			texts = append([]string{messages[i].Text}, texts...)
		}
	}
	return texts
}

// finish 加锁后调用 finishLocked。
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
		Account     string          `json:"account"`     // 执行时手机登录的微信号
		StopReason  string          `json:"stop_reason"` // 读取停止的原因
		Snapshot    json.RawMessage `json:"snapshot"`    // 发送后补读的当前屏幕
		SyncError   string          `json:"sync_error"`  // 发送成功但补读失败
		Diagnostics struct {
			DurationMS int64         `json:"duration_ms"`
			Steps      []TaskStep    `json:"steps"`
			Warnings   []TaskWarning `json:"warnings"`
		} `json:"diagnostics"`
	}
	_ = json.Unmarshal(result, &r)
	// 手机核对过账号；这里再防一次：执行时的账号与会话不一致，读到的内容不属于这个会话，不保存
	// （只用于读取：发送已经成功就是已经发出去了，不能改成失败）
	if op.Kind == "read" && status == "succeeded" && c != nil && c.Account != "" && r.Account != "" && r.Account != c.Account {
		status, message = "failed", "执行时手机上的微信账号是 "+r.Account+"，与会话的账号 "+c.Account+" 不一致，结果未保存"
		op.Status, op.Error = status, message
	}
	// 保存手机上报的执行记录（步骤只留最后 60 条），发送后补读失败也算一处降级
	d := r.Diagnostics
	op.DurationMS, op.Steps, op.Warnings = d.DurationMS, d.Steps[max(0, len(d.Steps)-60):], d.Warnings
	// 步骤里的截图保存为图片文件，记录里只留哈希
	for i := range op.Steps {
		if img := op.Steps[i].Image; img != "" {
			op.Steps[i].Image, _ = a.saveThumbnail(img)
		}
	}
	if r.SyncError != "" {
		op.Warnings = append(op.Warnings, TaskWarning{Code: "SYNC_AFTER_SEND", Message: r.SyncError})
	}
	log.Printf("任务 %s 类型=%s 状态=%s 代码=%s", op.ID, op.Kind, status, r.Code)
	// 按结果分别处理：失败记下原因；读取合并消息；发送合并发送后的屏幕快照
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
		// 手机不是因为读满条数而停止时（翻页上限、两屏比对不上、遇到无法识别的一屏等），加深读取会在同样的地方停下，不再重读。
		stoppedEarly := r.StopReason != "" && r.StopReason != "limit_reached"
		deepEnough := !op.Auto || op.Limit >= deepRead || stoppedEarly
		pendingBefore := c.firstPendingOriginal()
		// 接不上时 mergeLocked 返回 false；deepEnough 为 true 时它已整批追加并标记缺口，不再加深读取。
		if aligned := a.mergeLocked(c, result, deepEnough); !aligned && !deepEnough {
			a.queueReadLocked(c, deepRead, "deep")
		} else if aligned && c.wantsOriginals() && c.firstPendingOriginal() >= 0 && c.firstPendingOriginal() != pendingBefore {
			c.OriginalsDue = true // 还有图片没取原图，且这次有进展：过一会儿接着读
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
