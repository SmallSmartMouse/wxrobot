package main

// 消息转发：源会话（一般是群聊）收到的来信，经过发送人、关键词、正则等过滤后，
// 由目标会话所属账号的手机发到另一个群或联系人。
//
// forwardLoop 每秒检查一次。每个会话一个转发游标（forwardCursor），只看游标之后的新来信，
// 与 AI 自动回复一样：首次见到的会话、与之前记录没能衔接的批次（可能有重复）都只跟上最新位置，不转发。
// 转发出去的消息在目标会话里是“发出的”，不会再被当作来信转发，所以不会循环。

import (
	"context"
	"errors"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

const (
	maxForwardRules   = 50
	maxForwardBacklog = 20              // 目标会话排队中的转发超过这么多条时，新的不再转发（手机一条条发，避免越积越多）
	imageWaitLimit    = 3 * time.Minute // 图片等原图最多等这么久，之后用已有的缩略图转发
)

// ForwardRule 是一条转发规则。过滤条件都为空时，源会话的所有来信（文字；开启图片时含图片）都转发。
type ForwardRule struct {
	TargetPhones map[string]string `json:"target_phones,omitempty"`
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Enabled      bool              `json:"enabled"`
	Sources      []string          `json:"sources"` // 源会话编号
	Targets      []string          `json:"targets"` // 目标会话编号：群聊或联系人
	// 过滤：发送人名单只对群聊有意义；关键词和正则只检查文字，图片只按发送人过滤
	Senders []string `json:"senders,omitempty"` // 只转发这些人发的（完整群昵称），空为不限
	Include []string `json:"include,omitempty"` // 包含任意一个才转发，空为不限
	Exclude []string `json:"exclude,omitempty"` // 包含任意一个就不转发
	Regex   string   `json:"regex,omitempty"`   // 还须匹配这个正则（Go RE2，部分匹配），空为不限
	Images  bool     `json:"images,omitempty"`  // 也转发图片（有原图时发原图）
	// 同一条规则里相同的文字在这么多分钟内只转发一次（多个源群转发同一条内容时常见），0 为不去重
	DedupMinutes int `json:"dedup_minutes,omitempty"`
	// 文字格式：{text} 原文、{sender} 发送人、{chat} 源会话名称；空为原文
	Template string `json:"template,omitempty"`

	re *regexp.Regexp // 编译好的 Regex：保存规则时和启动时（compile）设置
}

// compile 编译正则。启动时从数据库读出的规则也要调用。
func (r *ForwardRule) compile() error {
	r.re = nil
	if r.Regex == "" {
		return nil
	}
	re, err := regexp.Compile(r.Regex)
	r.re = re
	return err
}

// forwardStatus 规则只在内存中的状态：最近一次没能转发的原因，网页上显示。
type forwardStatus struct {
	Problem   string `json:"problem,omitempty"`
	ProblemAt string `json:"problem_at,omitempty"`
}

// splitList 把“逗号、顿号或换行分隔”的文字拆成去掉空白的列表。
func splitList(items []string) []string {
	var out []string
	for _, item := range items {
		for _, s := range strings.FieldsFunc(item, func(r rune) bool { return r == ',' || r == '，' || r == '、' || r == '\n' }) {
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

// validate 整理并检查规则：源和目标必须是已有的会话、不能相同，目标需设置过会话类型；正则能编译。
func (r *ForwardRule) validate(conversations map[string]*Conversation) error {
	r.Name = strings.TrimSpace(r.Name)
	if utf8.RuneCountInString(r.Name) > 40 {
		return errors.New("规则名称最多 40 字")
	}
	if len(r.Sources) == 0 || len(r.Targets) == 0 {
		return errors.New("请选择源会话和转发目标")
	}
	sources := map[string]bool{}
	for _, id := range r.Sources {
		if conversations[id] == nil {
			return errors.New("源会话不存在，请重新选择")
		}
		sources[id] = true
	}
	for _, id := range r.Targets {
		c := conversations[id]
		switch {
		case c == nil:
			return errors.New("转发目标不存在，请重新选择")
		case sources[id]:
			return errors.New("转发目标不能同时是源会话：" + c.Title)
		case c.Kind == "unknown":
			return errors.New("请先在会话设置里设置转发目标的类型（联系人或群聊）：" + c.Title)
		}
	}
	for target := range r.TargetPhones {
		if !slices.Contains(r.Targets, target) {
			return errors.New("设备策略必须属于已选择的目标会话")
		}
	}
	r.Senders, r.Include, r.Exclude = splitList(r.Senders), splitList(r.Include), splitList(r.Exclude)
	if len(r.Senders) > 100 || len(r.Include) > 100 || len(r.Exclude) > 100 {
		return errors.New("发送人和关键词各最多 100 个")
	}
	r.Regex = strings.TrimSpace(r.Regex)
	if r.compile() != nil {
		return errors.New("正则表达式无效：" + r.Regex)
	}
	if r.DedupMinutes < 0 || r.DedupMinutes > 1440 {
		return errors.New("去重时间为 0–1440 分钟")
	}
	r.Template = strings.TrimSpace(r.Template)
	if r.Template != "" && (!strings.Contains(r.Template, "{text}") || utf8.RuneCountInString(r.Template) > 200) {
		return errors.New("转发格式必须包含 {text}，最多 200 字")
	}
	return nil
}

// accepts 判断消息是否满足规则的过滤条件（只看内容，不看方向和类型）。
func (r *ForwardRule) accepts(m Message) bool {
	if len(r.Senders) > 0 && !slices.Contains(r.Senders, m.Sender) {
		return false
	}
	if m.Kind == "image" {
		return r.Images
	}
	if len(r.Include) > 0 && !containsAny(m.Text, r.Include) {
		return false
	}
	if containsAny(m.Text, r.Exclude) {
		return false
	}
	// 正则没能编译（不应发生）时不转发，而不是当作不限
	return r.Regex == "" || (r.re != nil && r.re.MatchString(m.Text))
}

// format 按转发格式生成要发送的文字，最多 2000 字（发送接口的上限）。
func (r *ForwardRule) format(c *Conversation, m Message) string {
	text := m.Text
	if r.Template != "" {
		// 一次替换完，原文里的 {sender} 等字样不会被再次替换
		text = strings.NewReplacer("{text}", m.Text, "{sender}", m.Sender, "{chat}", c.Title).Replace(r.Template)
	}
	if runes := []rune(text); len(runes) > 2000 {
		text = string(runes[:2000])
	}
	return text
}

func containsAny(text string, words []string) bool {
	for _, w := range words {
		if strings.Contains(text, w) {
			return true
		}
	}
	return false
}

// forwardable 只转发别人发来的文字和图片：表情包只有截图、系统提示不是聊天内容；
// 方向未识别的可能是自己发的，不转发，避免转发循环。
func forwardable(m Message) bool {
	return m.Direction == "incoming" && (m.Kind == "" || m.Kind == "image")
}

// imageReady 图片是否可以转发：已有原图，或不会再取原图（会话不取原图、已失败 2 次、
// 已不在补取范围内），或已经等了 imageWaitLimit。index 是消息在 c.Messages 中的位置。
func imageReady(c *Conversation, index int) bool {
	m := c.Messages[index]
	if m.OriginalHash != "" || !c.wantsOriginals() || m.OriginalTries >= 2 || index < len(c.Messages)-originalWindow {
		return true
	}
	observed, err := time.Parse(time.RFC3339Nano, m.Time)
	return err != nil || time.Since(observed) >= imageWaitLimit
}

// forwardLoop 每秒检查一次源会话的新来信，按规则建立转发任务。
func (a *App) forwardLoop(ctx context.Context) {
	for pause(ctx, time.Second) {
		a.mu.Lock()
		if a.forwardLocked() {
			_ = a.commitLocked()
			a.wakeWorker()
		}
		a.mu.Unlock()
	}
}

// forwardLocked 处理所有会话游标之后的新来信，返回是否建立了转发任务。
// 有启用的规则要转发图片、而图片还在等原图时，游标停在这张图片前，下次再看，保证转发顺序与原来一致。
func (a *App) forwardLocked() bool {
	// 源会话 → 以它为源的启用规则
	bySource := map[string][]*ForwardRule{}
	for i := range a.state.ForwardRules {
		r := &a.state.ForwardRules[i]
		if r.Enabled {
			for _, id := range r.Sources {
				bySource[id] = append(bySource[id], r)
			}
		}
	}
	a.pruneForwardSeenLocked()
	created := false
	for id, c := range a.state.Conversations {
		cursor, seen := a.forwardCursor[id]
		rules := bySource[id]
		// 首次见到的会话、没有规则的会话只跟上最新位置：规则启用后只转发之后的新来信
		if !seen || len(rules) == 0 {
			a.forwardCursor[id] = c.LastSeq
			continue
		}
		if cursor >= c.LastSeq {
			continue
		}
		waitImages := false
		for _, r := range rules {
			waitImages = waitImages || r.Images
		}
		// 消息按序号有序，从游标之后的第一条开始
		i := sort.Search(len(c.Messages), func(i int) bool { return c.Messages[i].Seq > cursor })
		for ; i < len(c.Messages); i++ {
			m := c.Messages[i]
			if m.Kind == "image" && forwardable(m) && waitImages && !imageReady(c, i) {
				break
			}
			cursor = m.Seq
			if !forwardable(m) {
				continue
			}
			for _, r := range rules {
				if r.accepts(m) && a.forwardMessageLocked(r, c, m) {
					created = true
				}
			}
		}
		// 全部看完就跟到 LastSeq（删除过聊天记录时，消息的序号可能都比 LastSeq 小）
		if i == len(c.Messages) {
			cursor = c.LastSeq
		}
		a.forwardCursor[id] = cursor
	}
	return created
}

// forwardMessageLocked 把一条消息按规则发到所有目标，返回是否建立了任务。
func (a *App) forwardMessageLocked(r *ForwardRule, c *Conversation, m Message) bool {
	op := Operation{Kind: "send", ForwardRule: r.ID, ForwardFrom: c.ID}
	if m.Kind == "image" {
		op.ImageHash = m.OriginalHash
		if op.ImageHash == "" {
			op.ImageHash = m.ImageHash
		}
		if op.ImageHash == "" {
			return false // 缩略图也没截到
		}
	} else {
		op.Text = r.format(c, m)
		if strings.TrimSpace(op.Text) == "" {
			return false
		}
	}
	// 去重：同一规则里相同的原文在设定时间内只转发一次（图片每次截图字节不同，不去重）
	dedupKey := ""
	if m.Kind != "image" && r.DedupMinutes > 0 {
		dedupKey = r.ID + "\x00" + m.Text
		if at, ok := a.forwardSeen[dedupKey]; ok && time.Since(at) < time.Duration(r.DedupMinutes)*time.Minute {
			return false
		}
	}
	created := false
	for _, targetID := range r.Targets {
		target := a.state.Conversations[targetID]
		switch {
		case target == nil:
			a.forwardProblemLocked(r, "转发目标已被删除")
		case a.phoneForLocked(target) == nil:
			a.forwardProblemLocked(r, "「"+target.Title+"」的账号当前没有连接的手机，未转发")
		case a.queuedForwardsLocked(targetID) >= maxForwardBacklog:
			a.forwardProblemLocked(r, "「"+target.Title+"」排队中的转发过多，新消息未转发")
		default:
			next := op
			next.PhoneID, next.Account = a.phoneForLocked(target).ID, target.Account
			if requested := r.TargetPhones[targetID]; requested != "" {
				p := a.selectDeviceLocked(target, requested)
				if p == nil {
					a.forwardProblemLocked(r, "指定设备不可用，未转发")
					continue
				}
				next.PhoneID, next.RequestedPhoneID, next.Account = p.ID, p.ID, target.Account
			}
			next.ID, next.ConversationID, next.Status, next.Created = "fwd-"+randomID(), targetID, "queued", a.forwardTimeLocked()
			a.state.Operations[next.ID] = &next
			created = true
		}
	}
	// 至少交给一个目标才算转发过；都没能转发（手机未连接、排队过多）时，之后相同的内容仍可以转发
	if created && dedupKey != "" {
		a.forwardSeen[dedupKey] = time.Now()
	}
	return created
}

// forwardTimeLocked 转发任务的创建时间：比上一个转发任务晚，worker 按创建时间执行，保证同一批消息按原顺序发出。
func (a *App) forwardTimeLocked() string {
	t := time.Now()
	if !t.After(a.forwardLast) {
		t = a.forwardLast.Add(time.Microsecond)
	}
	a.forwardLast = t
	return stamp(t)
}

// queuedForwardsLocked 目标会话里还没开始执行的转发任务数。
func (a *App) queuedForwardsLocked(conversationID string) int {
	n := 0
	for _, op := range a.state.Operations {
		if op.ConversationID == conversationID && op.ForwardRule != "" && op.Status == "queued" {
			n++
		}
	}
	return n
}

// forwardProblemLocked 记下规则最近一次没能转发的原因（只在内存中，网页上显示）。
func (a *App) forwardProblemLocked(r *ForwardRule, problem string) {
	a.forwardStatus[r.ID] = forwardStatus{Problem: problem, ProblemAt: now()}
}

// pruneForwardSeenLocked 删除超过最长去重时间的去重记录。
func (a *App) pruneForwardSeenLocked() {
	for key, at := range a.forwardSeen {
		if time.Since(at) > 24*time.Hour {
			delete(a.forwardSeen, key)
		}
	}
}

// skipNewMessagesLocked 会话现有的消息都不再触发 AI 回复和转发：与之前记录没能衔接的批次、删除的聊天记录。
func (a *App) skipNewMessagesLocked(c *Conversation) {
	a.aiCursor[c.ID] = c.LastSeq
	a.forwardCursor[c.ID] = c.LastSeq
}

// ---------- 网页接口 ----------

// forwardRuleView 网页上的一条规则：规则本身，加上最近的转发情况。
type forwardRuleView struct {
	ForwardRule
	forwardStatus
	Forwarded int    `json:"forwarded"`         // 保留的任务记录中转发成功的条数
	Failed    int    `json:"failed"`            // 失败或结果未知的条数
	Queued    int    `json:"queued"`            // 排队或发送中的条数
	LastAt    string `json:"last_at,omitempty"` // 最近一次转发时间
}

// getForward 返回转发规则和每条规则最近的转发情况。
func (a *App) getForward(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	views := make([]forwardRuleView, 0, len(a.state.ForwardRules))
	index := map[string]*forwardRuleView{}
	for _, r := range a.state.ForwardRules {
		views = append(views, forwardRuleView{ForwardRule: r, forwardStatus: a.forwardStatus[r.ID]})
	}
	for i := range views {
		index[views[i].ID] = &views[i]
	}
	for _, op := range a.state.Operations {
		v := index[op.ForwardRule]
		if v == nil {
			continue
		}
		switch {
		case op.active():
			v.Queued++
		case op.Status == "succeeded":
			v.Forwarded++
		default:
			v.Failed++
		}
		v.LastAt = max(v.LastAt, op.Created)
	}
	c.JSON(200, gin.H{"rules": views})
}

// setForward 校验并保存全部转发规则（整体替换）。没有编号的是新规则。
func (a *App) setForward(c *gin.Context) {
	var body struct {
		Rules []ForwardRule `json:"rules"`
	}
	if !bind(c, &body) {
		return
	}
	if len(body.Rules) > maxForwardRules {
		fail(c, 400, "最多 50 条转发规则")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := range body.Rules {
		r := &body.Rules[i]
		if err := r.validate(a.state.Conversations); err != nil {
			name := r.Name
			if name == "" {
				name = "第 " + strconv.Itoa(i+1) + " 条"
			}
			fail(c, 400, "规则「"+name+"」："+err.Error())
			return
		}
		if r.ID == "" {
			r.ID = randomID()[:12]
		}
	}
	if body.Rules == nil {
		body.Rules = []ForwardRule{}
	}
	a.state.ForwardRules = body.Rules
	a.saved(c, gin.H{"ok": true})
}
