package main

// 自动读取：worker 空闲时挑一个需要读取的会话建立读取任务。
//   - 收到通知或未读提示：距上次读取满 5 秒即读（优先）
//   - 开启了定时读取：距上次读取满设定间隔
//   - 还有图片没取原图：距上次读取满 1 分钟（只补最近 originalWindow 条消息里的图片）
//
// 同类会话中先读最久没读的。自动读取失败或没读到内容时按退避稍后重读。

import "time"

const (
	triggerReadGap   = 5 * time.Second  // 收到提示后，同一会话两次读取的最短间隔
	originalsReadGap = 60 * time.Second // 只为补取原图时，同一会话两次读取的最短间隔
	shallowRead      = 30               // 没有已记录的文字可作停止点时，自动读取的条数
	deepRead         = 100              // 有停止点时自动读取的条数（读到已记录的消息就停）；也是接不上时加深读取的条数
	readRetryBase    = 30 * time.Second // 自动读取失败后第一次重读的等待时间，之后每次加倍
	readRetryMax     = 10 * time.Minute // 退避的上限：手机脚本过旧这类不会自己恢复的错误，最慢 10 分钟试一次
	stopTextCount    = 3                // 历史模式的停止点条数：3 条文字连续相同才认定读到了已有记录，减少误判
	liveStopTexts    = 1                // 仅新增模式的停止点条数：只为翻回上次读到的位置，1 条即可衔接，少翻页
	originalsPerRead = 2                // 一次自动读取最多取几张原图：点开大图很慢，多了会长时间占住手机
	maxOriginalTries = 2                // 一张图片取原图失败几次后不再尝试
)

// 自动读取的原因，按优先级从高到低
const (
	readForNotice    = "notification"
	readForSchedule  = "schedule"
	readForOriginals = "originals"
	readDeeper       = "deep" // 接不上已有记录时加深读取（不由 scheduleAutoRead 选出）
)

// readPriority 自动读取原因的优先级，数字小的先读。
var readPriority = map[string]int{readForNotice: 0, readForSchedule: 1, readForOriginals: 2}

// originalWindow 只为最近这么多条消息里的图片补取原图。
// 停止点会挪到最早一张待取原图的图片之前，回看太远时手机要翻很多页（长消息的群一条就占一屏）。
const originalWindow = 10

// scheduleAutoRead 为这台手机选出一个需要读取的会话并建立读取任务，返回是否建立了任务。
// 手机不在线时不安排，免得产生一堆失败的读取。
func (a *App) scheduleAutoRead(phoneID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.phoneLocked(phoneID)
	if p == nil || !a.onlineLocked(phoneID) {
		return false
	}
	pick, reason := a.pickAutoReadLocked(p)
	if pick == nil {
		return false
	}
	a.queueReadLocked(pick, a.autoReadLimitLocked(pick), reason)
	return true
}

// pickAutoReadLocked 在手机 p 负责的会话中，按原因的优先级、其次最久没读，挑出一个需要读取的会话。
func (a *App) pickAutoReadLocked(p *PhoneConfig) (*Conversation, string) {
	var pick *Conversation
	var pickReason string
	var pickLast time.Time
	for _, c := range a.state.Conversations {
		if !p.owns(c) {
			continue
		}
		reason, last := a.autoReadReasonLocked(c)
		if reason == "" {
			continue
		}
		if pick == nil || readPriority[reason] < readPriority[pickReason] || (reason == pickReason && last.Before(pickLast)) {
			pick, pickReason, pickLast = c, reason, last
		}
	}
	return pick, pickReason
}

// autoReadReasonLocked 会话现在需要自动读取的原因（不需要为空），以及上次读取的时间。
func (a *App) autoReadReasonLocked(c *Conversation) (string, time.Time) {
	last := parseStamp(c.LastRead)
	if retryAt := parseStamp(c.ReadRetryAt); time.Now().Before(retryAt) {
		return "", last // 退避中
	}
	since := time.Since(last)
	switch {
	case c.NeedsRead && since >= triggerReadGap:
		return readForNotice, last
	case c.ReadEvery > 0 && since >= time.Duration(c.ReadEvery)*time.Second:
		return readForSchedule, last
	case c.OriginalsDue && since >= originalsReadGap:
		return readForOriginals, last
	}
	return "", last
}

// autoReadLimitLocked 自动读取的条数。有已记录的文字作停止点时直接按 100 条读：手机读到它们就停，
// 新消息少时不会多翻页；新消息多时一次读完，不必先读 30 条接不上、再从头读 100 条。
func (a *App) autoReadLimitLocked(c *Conversation) int {
	if !a.state.NewMessagesOnly && len(autoReadUntil(c)) > 0 {
		return deepRead
	}
	return shallowRead
}

// queueReadLocked 为会话建立一个自动读取任务，清除“需要读取”标记并记下读取时间，然后唤醒 worker。
func (a *App) queueReadLocked(c *Conversation, limit int, reason string) {
	c.NeedsRead, c.OriginalsDue = false, false
	c.LastRead = now()
	op := &Operation{ID: "auto-" + randomID(), ConversationID: c.ID, Kind: opRead, Limit: limit, Auto: true, Reason: reason, Status: opQueued, Created: now()}
	a.state.Operations[op.ID] = op
	_ = a.commitLocked()
	a.wakeWorker()
}

// retryReadLocked 安排稍后重读：自动读取失败，或有新消息提示却没读到内容。
// 连续失败时等待时间加倍（30 秒到 10 分钟），手机脚本过旧这类不会自己恢复的错误不会每 30 秒失败一次。
func (a *App) retryReadLocked(c *Conversation) {
	c.ReadFailures++
	c.NeedsRead = true
	// 加倍最多 6 次（30 秒 × 64 已超过上限），防止移位溢出；结果再受 readRetryMax 限制
	c.ReadRetryAt = stamp(time.Now().Add(min(readRetryBase<<min(c.ReadFailures-1, 6), readRetryMax)))
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
	return lastTexts(c.withAnchor(known), stopTextCount)
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

// liveOriginalsUntil 仅新增模式补取原图时的停止点：最早一张待取原图的图片之前的最后 1 条文字，
// 手机向上翻回那里（最多 NEW_ONLY_MAX_PAGES 页），这张图片就落在“新消息”范围里，由手机点开取原图。
func liveOriginalsUntil(c *Conversation) []string {
	i := c.firstPendingOriginal()
	if i < 0 {
		return lastTexts(c.LiveAnchor, liveStopTexts)
	}
	return lastTexts(c.withAnchor(c.Messages[:i]), liveStopTexts)
}

// noteOriginalsProgress 合并后还有图片没取原图、且最早待取的位置变了（新到了图片，或上一张已取到）时，
// 安排稍后补取。位置没变（例如图片没能在屏幕上定位）不再安排，等有新进展时再取，避免每分钟重复读取同一处。
func (c *Conversation) noteOriginalsProgress(pendingBefore int) {
	if pending := c.firstPendingOriginal(); c.wantsOriginals() && pending >= 0 && pending != pendingBefore {
		c.OriginalsDue = true
	}
}

// firstPendingOriginal 返回最近 originalWindow 条消息中最早一张还需要取原图的图片位置，没有返回 -1。
func (c *Conversation) firstPendingOriginal() int {
	for i := max(0, len(c.Messages)-originalWindow); i < len(c.Messages); i++ {
		m := c.Messages[i]
		if m.Kind == msgImage && m.OriginalHash == "" && m.OriginalTries < maxOriginalTries {
			return i
		}
	}
	return -1
}
