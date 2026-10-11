package main

// 读写任务：网页手动提交、自动读取、AI 回复和转发都建成任务，由每台手机的 worker 串行执行。
//
// 执行顺序：核对并标记执行中 → 提交给手机（或续查已提交的）→ 每秒查询直到结束 → 记录结果并合并消息。
// 发送请求可能已经到达手机，出错时无法确定是否执行过，只能记为“结果未知”，不会自动重发。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// 任务类型
const (
	opRead = "read"
	opSend = "send"
)

// 任务状态
const (
	opQueued    = "queued"
	opRunning   = "running"
	opSucceeded = "succeeded"
	opFailed    = "failed"
	opUnknown   = "unknown" // 发送可能已执行，结果无法确认
)

const (
	operationTimeout = 4 * time.Minute // 一个任务从提交到手机返回结果的上限：读取时可能要点开大图取原图
	maxReadLimit     = 100             // 一次读取最多的条数：与手机桥的限制一致
	maxTaskSteps     = 60              // 每个任务保留的执行步骤条数：够看清出错前后，不让记录无限增长
)

// Operation 是一次读取或发送任务。ID 同时作为手机任务的 Idempotency-Key，
// 因此服务重启后重新提交也不会让手机重复执行。
type Operation struct {
	RequestedPhoneID string `json:"requested_phone_id,omitempty"`
	Account          string `json:"account,omitempty"`
	NewMessagesOnly  bool   `json:"new_messages_only,omitempty"` // 实际提交给手机的读取模式
	ID               string `json:"id"`
	ConversationID   string `json:"conversation_id"`
	Kind             string `json:"kind"` // read | send
	Text             string `json:"text,omitempty"`
	ImageHash        string `json:"image_hash,omitempty"`
	Limit            int    `json:"limit,omitempty"`
	Auto             bool   `json:"auto,omitempty"`         // 自动发起的读取
	Reason           string `json:"reason,omitempty"`       // 自动读取原因：notification | schedule | originals | deep
	ForwardRule      string `json:"forward_rule,omitempty"` // 转发任务：规则编号
	ForwardFrom      string `json:"forward_from,omitempty"` // 转发任务：源会话编号
	Status           string `json:"status"`                 // queued | running | succeeded | failed | unknown
	Error            string `json:"error,omitempty"`
	PhoneTaskID      string `json:"phone_task_id,omitempty"`
	PhoneID          string `json:"phone_id,omitempty"` // 执行这个任务的手机：开始执行时确定，服务重启后仍向同一台手机查询
	Created          string `json:"created"`
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
func (op *Operation) active() bool { return op.Status == opQueued || op.Status == opRunning }

// recentOperationsLocked 最近的 limit 个任务，新的在前。
func (a *App) recentOperationsLocked(limit int) []*Operation {
	return newest(mapValues(a.state.Operations), func(op *Operation) string { return op.Created }, limit)
}

// addOperationLocked 保存新任务并唤醒 worker。保存失败时撤销：未保存的任务不执行，
// 避免网页以为失败而重试，导致重复发送。
func (a *App) addOperationLocked(op *Operation) error {
	a.state.Operations[op.ID] = op
	if err := a.commitLocked(); err != nil {
		delete(a.state.Operations, op.ID)
		return err
	}
	a.wakeWorker()
	return nil
}

// pruneOperationsLocked 已结束的任务超过上限时，按创建时间删除最早的，以及它们不再被引用的步骤截图。
func (a *App) pruneOperationsLocked() {
	var finished []*Operation
	for _, op := range a.state.Operations {
		if !op.active() {
			finished = append(finished, op)
		}
	}
	if len(finished) <= maxFinishedOperations {
		return
	}
	sort.Slice(finished, func(i, j int) bool { return finished[i].Created < finished[j].Created })
	removed := finished[:len(finished)-maxFinishedOperations]
	for _, op := range removed {
		delete(a.state.Operations, op.ID)
	}
	inUse := a.mediaInUseLocked()
	for _, op := range removed {
		for _, s := range op.Steps {
			if path, ok := a.mediaPath(s.Image); ok && !inUse[s.Image] {
				_ = os.Remove(path)
			}
		}
	}
}

// ---------- 网页提交 ----------

// idempotencyKey 请求编号的格式：与手机桥接受的 Idempotency-Key 一致。
var idempotencyKey = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// operationRequest 是网页提交读取或发送的请求。
type operationRequest struct {
	PhoneID   string `json:"phone_id"`
	Text      string `json:"text"`
	ImageHash string `json:"image_hash"`
	Limit     int    `json:"limit"`
}

// problem 检查请求编号、读取条数和发送内容（图片和文字二选一），没问题返回空字符串。
func (r operationRequest) problem(kind, key string) string {
	switch {
	case !idempotencyKey.MatchString(key):
		return "缺少有效的 Idempotency-Key"
	case kind == opRead && (r.Limit < 1 || r.Limit > maxReadLimit):
		return fmt.Sprintf("读取数量必须为 1–%d", maxReadLimit)
	case kind == opSend && r.ImageHash != "" && r.Text != "":
		return "图片与文字请分别发送"
	case kind == opSend && r.ImageHash == "" && (strings.TrimSpace(r.Text) == "" || len([]rune(r.Text)) > maxMessageRunes):
		return fmt.Sprintf("消息必须为 1–%d 字符", maxMessageRunes)
	}
	return ""
}

// sameRequest 同一请求编号再次提交时，内容是否和原任务一致。
func (op *Operation) sameRequest(other *Operation) bool {
	return op.ConversationID == other.ConversationID && op.Kind == other.Kind && op.Text == other.Text &&
		op.ImageHash == other.ImageHash && op.Limit == other.Limit && op.RequestedPhoneID == other.RequestedPhoneID
}

// createOperation 返回建立 kind（read 或 send）任务的接口。
func (a *App) createOperation(kind string) gin.HandlerFunc {
	return func(c *gin.Context) { a.addOperation(c, kind) }
}

// addOperation 校验参数并建立任务，交给所选设备执行。请求头 Idempotency-Key 作为任务编号：
// 同一编号重复提交相同内容返回原任务（网页重试不会重复发送），内容不同则拒绝。
func (a *App) addOperation(c *gin.Context, kind string) {
	var body operationRequest
	if !bind(c, &body) {
		return
	}
	key := c.GetHeader("Idempotency-Key")
	if problem := body.problem(kind, key); problem != "" {
		fail(c, 400, problem)
		return
	}
	if body.ImageHash != "" && !a.imageExists(body.ImageHash) {
		fail(c, 400, "图片不存在")
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	conv := a.conversation(c)
	if conv == nil {
		return
	}
	op := &Operation{RequestedPhoneID: body.PhoneID, Account: conv.Account, ID: key, ConversationID: conv.ID, Kind: kind,
		Text: body.Text, ImageHash: body.ImageHash, Limit: body.Limit, Status: opQueued, Created: now()}
	if old := a.state.Operations[key]; old != nil {
		if !old.sameRequest(op) {
			fail(c, 409, "请求编号已用于不同内容")
			return
		}
		c.JSON(202, old)
		return
	}
	device := a.selectDeviceLocked(conv, body.PhoneID)
	if device == nil {
		fail(c, 409, "所选设备不可用或微信号不匹配，请检查连接")
		return
	}
	op.PhoneID = device.ID
	if err := a.addOperationLocked(op); err != nil {
		fail(c, 500, "任务保存失败，未发送到手机")
		return
	}
	c.JSON(202, op)
}

// ---------- 执行 ----------

// worker 串行执行一台手机的任务：同一时刻这台手机上只有一个任务。没有任务时安排自动读取。手机被删除时退出。
// 状态为 running 的任务是上次服务退出时未完成的，会接着查询结果而不是重新执行。
func (a *App) worker(ctx context.Context, phoneID string) {
	for ctx.Err() == nil {
		if id := a.nextOperation(phoneID); id != "" {
			a.runOperation(ctx, phoneID, id)
			continue
		}
		if a.scheduleAutoRead(phoneID) {
			continue
		}
		wakeup := a.workerWakeup(phoneID)
		if wakeup == nil {
			return
		}
		// 都没有就等：有新任务时被唤醒，否则每秒检查一次（定时读取靠这个触发）
		select {
		case <-ctx.Done():
		case <-wakeup:
		case <-time.After(time.Second):
		}
	}
}

// workerWakeup 唤醒这台手机 worker 的通道；手机已删除时返回 nil。
func (a *App) workerWakeup(phoneID string) chan struct{} {
	a.mu.Lock()
	defer a.mu.Unlock()
	if rt := a.phones[phoneID]; rt != nil {
		return rt.wake
	}
	return nil
}

// wakeWorker 唤醒所有手机的 worker 立即检查任务；已有未处理的唤醒时不重复发送。调用前须持有锁。
func (a *App) wakeWorker() {
	for _, rt := range a.phones {
		wake(rt.wake)
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
	if c := a.state.Conversations[next.ConversationID]; c != nil && next.Account == "" {
		next.Account = c.Account
	}
	return next.ID
}

// runOperation 执行一个任务：核对并标记执行中 → 提交给手机（或续查已提交的）→ 等手机执行完 → 记录结果。
func (a *App) runOperation(ctx context.Context, phoneID, id string) {
	run, ok := a.startOperation(phoneID, id)
	if !ok {
		return
	}
	taskCtx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()

	task, err := a.submitOrResume(taskCtx, run)
	if err == nil {
		task, err = a.waitPhoneTask(taskCtx, phoneID, task)
	}
	switch {
	case ctx.Err() != nil:
		return // 服务正在退出：任务保持 running，下次启动续查或用同一 ID 重新提交
	case rejectedByPhone(err):
		a.finish(id, opFailed, nil, err.Error()) // 手机明确拒绝，没有执行
	case err != nil:
		// 请求可能已经到达手机，无法确定是否执行过：读取记为失败可以再读；发送只能记为“结果未知”，不会自动重发
		a.finish(id, unsettledStatus(run.kind), nil, err.Error())
	default:
		// 读取成功时，先把手机取到的原图文件下载下来，再合并消息
		if run.kind == opRead && task.Status == opSucceeded {
			task.Result = a.downloadOriginals(taskCtx, phoneID, task.Result)
		}
		a.finish(id, task.Status, task.Result, "")
	}
}

// operationRun 是开始执行时确定下来的任务信息，执行期间不再读共享状态。
type operationRun struct {
	op          *Operation
	id, kind    string
	phoneID     string
	phoneTaskID string // 已提交过时是手机任务编号（服务重启后续查）
	body        map[string]any
}

// phoneTask 是手机上的任务及其结果。
type phoneTask struct {
	ID     string          `json:"id"`
	Status string          `json:"status"`
	Result json.RawMessage `json:"result"`
}

// startOperation 核对任务能否在这台手机上执行、组装请求，再标记为执行中并保存（服务中途退出后能识别出未完成的任务）。
// 不能执行时直接记为失败，返回 false。
func (a *App) startOperation(phoneID, id string) (operationRun, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	op := a.state.Operations[id]
	c := a.state.Conversations[op.ConversationID]
	p := a.phoneLocked(phoneID)
	if reason := operationBlocker(op, c, p); reason != "" {
		a.finishLocked(op, opFailed, nil, reason)
		return operationRun{}, false
	}
	op.PhoneID = phoneID
	body, err := a.taskBodyLocked(op, c)
	if err != nil {
		a.finishLocked(op, opFailed, nil, err.Error())
		return operationRun{}, false
	}
	op.Status = opRunning
	log.Printf("任务 %s 开始 类型=%s 手机任务=%s", op.ID, op.Kind, op.PhoneTaskID)
	_ = a.commitLocked()
	return operationRun{op: op, id: id, kind: op.Kind, phoneID: phoneID, phoneTaskID: op.PhoneTaskID, body: body}, true
}

// operationBlocker 返回任务不能在手机 p 上执行的原因，可以执行时返回空字符串。
// 已提交过的任务（服务重启后续查）不再核对账号。
func operationBlocker(op *Operation, c *Conversation, p *PhoneConfig) string {
	switch {
	case p == nil || c == nil:
		return "手机或会话已删除，任务未执行"
	case op.PhoneTaskID == "" && (!p.owns(c) || (op.Account != "" && op.Account != c.Account)):
		return "设备当前微信号不匹配，任务未执行"
	}
	return ""
}

// taskBodyLocked 组装提交给手机的任务参数：聊天名称、群聊标记、预期的微信号（手机核对，不一致时拒绝执行），
// 再按读取 / 发图 / 发文字补充。返回错误时任务不能执行，不会提交给手机。
func (a *App) taskBodyLocked(op *Operation, c *Conversation) (map[string]any, error) {
	body := map[string]any{"chat": c.Title, "account": c.Account}
	if c.Kind == kindGroup {
		body["chat_type"] = kindGroup
	}
	switch {
	case op.Kind == opRead:
		a.addReadOptionsLocked(body, op, c)
	case op.ImageHash != "":
		data, err := a.readImage(op.ImageHash)
		if err != nil {
			return nil, errors.New("图片文件不存在")
		}
		body["image_base64"] = data
	default:
		body["text"] = op.Text
	}
	return body, nil
}

// addReadOptionsLocked 补充读取参数：读取模式（第一次提交时确定，服务重启后续查时沿用）、条数、
// 是否识别会话类型；自动读取还带上停止点和要取的原图数，读完回到首页便于继续发现其他未读会话。
func (a *App) addReadOptionsLocked(body map[string]any, op *Operation, c *Conversation) {
	if op.PhoneTaskID == "" {
		op.NewMessagesOnly = a.state.NewMessagesOnly
	}
	body["identify_kind"] = !c.classified()
	body["read_history"] = !op.NewMessagesOnly
	body["limit"] = op.Limit
	body["return_list"] = op.Auto
	if !op.Auto {
		return
	}
	if c.wantsOriginals() && (!op.NewMessagesOnly || len(c.LiveAnchor) > 0) {
		body["originals"] = originalsPerRead
	}
	switch {
	case op.NewMessagesOnly && op.Reason == readForOriginals:
		body["until"] = liveOriginalsUntil(c)
	case op.NewMessagesOnly:
		// 仅新增模式只为翻回上次读到的位置：停在最后 1 条文字即可衔接，
		// 要求 3 条会多翻回 2 条旧文字，在手机的翻页上限内能接住的新消息更少
		body["until"] = lastTexts(c.LiveAnchor, liveStopTexts)
	default:
		body["until"] = autoReadUntil(c)
	}
}

// submitOrResume 把任务提交给手机并保存手机任务编号；已提交过的（服务重启后）直接按原编号续查，不重新提交。
func (a *App) submitOrResume(ctx context.Context, run operationRun) (phoneTask, error) {
	if run.phoneTaskID != "" {
		return phoneTask{ID: run.phoneTaskID, Status: opRunning}, nil
	}
	var task phoneTask
	// 任务 ID 作为 Idempotency-Key：同一任务重复提交，手机也只执行一次
	if err := a.phoneRequest(ctx, run.phoneID, "POST", "/v1/messages/"+run.kind, run.body, run.id, &task); err != nil {
		return task, err
	}
	a.savePhoneTaskID(run.op, task)
	return task, nil
}

// savePhoneTaskID 保存手机任务编号，服务重启后据此继续查询，而不是重新提交。
func (a *App) savePhoneTaskID(op *Operation, task phoneTask) {
	a.mu.Lock()
	defer a.mu.Unlock()
	op.PhoneTaskID = task.ID
	log.Printf("任务 %s 手机已受理 手机任务=%s 状态=%s", op.ID, task.ID, task.Status)
	_ = a.commitLocked()
}

// waitPhoneTask 每秒查询一次手机任务，直到结束。超时或手机桥重启（查不到任务）时返回错误；
// 其他查询失败（网络抖动等）继续等。
func (a *App) waitPhoneTask(ctx context.Context, phoneID string, task phoneTask) (phoneTask, error) {
	for task.Status == opQueued || task.Status == opRunning {
		if !pause(ctx, time.Second) {
			return task, errors.New("等待手机超时，结果未知；不会自动重发")
		}
		err := a.phoneRequest(ctx, phoneID, "GET", "/v1/tasks/"+url.PathEscape(task.ID), nil, "", &task)
		var rejected *phoneError
		if errors.As(err, &rejected) && rejected.Status == http.StatusNotFound {
			return task, errors.New("手机桥已重启，任务结果未知；不会自动重发")
		}
	}
	return task, nil
}

// unsettledStatus 出错时无法确定手机是否执行过的任务状态：读取记为失败；发送记为结果未知，避免重复发送。
func unsettledStatus(kind string) string {
	if kind == opSend {
		return opUnknown
	}
	return opFailed
}

// ---------- 记录结果 ----------

// taskResult 是手机上报的任务结果中电脑关心的部分。
type taskResult struct {
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

// finish 加锁后调用 finishLocked。
func (a *App) finish(id, status string, result json.RawMessage, message string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.finishLocked(a.state.Operations[id], status, result, message)
}

// finishLocked 记录任务结果和手机上报的执行记录，然后按结果处理：失败记下原因，读取合并消息，发送合并补读的屏幕。
func (a *App) finishLocked(op *Operation, status string, result json.RawMessage, message string) {
	var r taskResult
	_ = json.Unmarshal(result, &r)
	c := a.state.Conversations[op.ConversationID]
	op.Status, op.Error = status, message
	// 手机核对过账号；这里再防一次：执行时的账号与会话不一致，读到的内容不属于这个会话，不保存
	// （只用于读取：发送已经成功就是已经发出去了，不能改成失败）
	if op.Kind == opRead && op.Status == opSucceeded && c != nil && r.Account != "" && r.Account != c.Account {
		op.Status, op.Error = opFailed, "执行时手机上的微信账号是 "+r.Account+"，与会话的账号 "+c.Account+" 不一致，结果未保存"
	}
	a.recordExecutionLocked(op, r)
	log.Printf("任务 %s 类型=%s 状态=%s 代码=%s", op.ID, op.Kind, op.Status, r.Code)
	switch {
	case op.Status != opSucceeded:
		a.noteFailureLocked(op, c, r)
	case op.Kind == opRead:
		a.mergeReadLocked(op, c, result, r.StopReason)
	default:
		a.mergeSentScreenLocked(c, r)
	}
	if err := a.commitLocked(); err != nil {
		log.Printf("任务 %s 结果保存失败", op.ID)
	}
}

// recordExecutionLocked 保存手机上报的执行记录：步骤只留最后 maxTaskSteps 条，截图另存为图片文件、记录里只留哈希；
// 发送后补读失败也算一处降级。
func (a *App) recordExecutionLocked(op *Operation, r taskResult) {
	d := r.Diagnostics
	op.DurationMS, op.Steps, op.Warnings = d.DurationMS, d.Steps[max(0, len(d.Steps)-maxTaskSteps):], d.Warnings
	for i := range op.Steps {
		if img := op.Steps[i].Image; img != "" {
			op.Steps[i].Image, _ = a.saveThumbnail(img)
		}
	}
	if r.SyncError != "" {
		op.Warnings = append(op.Warnings, TaskWarning{Code: "SYNC_AFTER_SEND", Message: r.SyncError})
	}
}

// noteFailureLocked 记下失败原因；自动读取失败时稍后重读，手动读取失败由用户自己决定是否重试。
func (a *App) noteFailureLocked(op *Operation, c *Conversation, r taskResult) {
	if op.Kind == opRead && op.Auto && c != nil {
		a.retryReadLocked(c)
	}
	if op.Error == "" {
		op.Error = r.Message
	}
	if op.Error == "" {
		op.Error = r.Code
	}
}

// mergeSentScreenLocked 合并发送后补读的屏幕；接不上（发送前有没读到的消息）或补读失败时，再安排一次读取。
func (a *App) mergeSentScreenLocked(c *Conversation, r taskResult) {
	if r.SyncError != "" || len(r.Snapshot) == 0 || !a.mergeLocked(c, r.Snapshot) {
		c.NeedsRead = true
	}
}

// mergeReadLocked 把读取成功的结果并入会话，并按结果安排后续读取（加深读取、补取原图、稍后重读）。
// stopReason 是手机停止翻页的原因。
func (a *App) mergeReadLocked(op *Operation, c *Conversation, result json.RawMessage, stopReason string) {
	switch {
	case !op.NewMessagesOnly && a.state.NewMessagesOnly:
		// 历史读取完成时已切换到仅新增模式：只合并能衔接的部分，再补读底部当前屏。
		a.mergeStaleReadLocked(c, result)
		c.NeedsRead = true
		op.Warnings = append(op.Warnings, TaskWarning{Code: "READ_MODE_CHANGED", Message: "读取模式已改变，已保留可衔接消息并安排当前屏补读"})
	case op.NewMessagesOnly:
		a.mergeLiveReadLocked(op, c, result)
	default:
		a.mergeHistoryReadLocked(op, c, result, stopReason)
	}
}

// mergeLiveReadLocked 合并仅新增模式的读取结果。没读到内容、需要稍后再读时合并过程会重新安排；
// 否则这次读取有效，退避从头计算。衔接有缺口时记一条降级。还有图片没取原图且有进展时，过一会儿补取。
func (a *App) mergeLiveReadLocked(op *Operation, c *Conversation, result json.RawMessage) {
	c.ReadRetryAt = ""
	pendingBefore := c.firstPendingOriginal()
	if a.mergeLiveResultLocked(c, result) {
		c.noteOriginalsProgress(pendingBefore)
	}
	if c.ReadRetryAt == "" {
		c.ReadFailures = 0
	}
	if c.ReadWarning != "" {
		op.Warnings = append(op.Warnings, TaskWarning{Code: "LIVE_READ_GAP", Message: c.ReadWarning})
	}
}

// mergeHistoryReadLocked 合并历史模式的读取结果。
// 自动读取的 30 条接不上已有记录，说明期间新消息较多：先加深到 100 条再读，仍接不上才整批追加并标记缺口。
// 手机不是因为读满条数而停止时（翻页上限、两屏比对不上、遇到无法识别的一屏等），加深读取会在同样的地方停下，不再重读。
func (a *App) mergeHistoryReadLocked(op *Operation, c *Conversation, result json.RawMessage, stopReason string) {
	c.ReadRetryAt, c.ReadFailures = "", 0
	// 历史模式的读取已读到最新位置，之前的新消息提示都处理过了：清掉，免得切换到仅新增模式后被当作新的未读
	c.clearLiveSignal()
	stoppedEarly := stopReason != "" && stopReason != "limit_reached"
	deepEnough := !op.Auto || op.Limit >= deepRead || stoppedEarly
	pendingBefore := c.firstPendingOriginal()
	var aligned bool
	if deepEnough {
		aligned = a.mergeOrAppendLocked(c, result)
	} else if aligned = a.mergeLocked(c, result); !aligned {
		a.queueReadLocked(c, deepRead, readDeeper)
		return
	}
	// 还有图片没取原图，且这次有进展：过一会儿接着读
	if aligned {
		c.noteOriginalsProgress(pendingBefore)
	}
}
