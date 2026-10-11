package main

// AI 自动回复：开启了自动回复的会话收到满足触发词的新来信时，调用模型生成回复并排队发送。
//
// aiLoop 每秒检查一次。每个会话一个游标（aiCursor），只看游标之后的新来信：
// 首次见到的会话、关闭回复的会话、与之前记录没能衔接的批次（可能有重复）都只跟上最新位置，不回复。

import (
	"context"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
)

// AI 记录状态
const (
	aiRunning = "running"
	aiSent    = "sent" // 已生成并排队发送
	aiFailed  = "failed"
)

// 回复方式
const (
	aiOff  = "off"
	aiAuto = "auto" // 自动生成并发送
)

const (
	aiTimeout       = 30 * time.Second
	aiMaxTokens     = 600
	aiHistorySize   = 20   // 作为上下文的最近消息条数
	aiMaxInputRunes = 4000 // 上下文中单条消息最多的字数
	maxMessageRunes = 2000 // 一条消息最多的字数：手机桥发送接口的上限
)

// replyFormatRule 格式限制独立于用户提示词，避免输出不能直接发送到微信的附件或矢量代码。
const replyFormatRule = "回复仅支持纯文字和普通位图。文字回复请使用纯文本，不要输出 SVG、HTML、矢量图代码、文件附件、音视频或其他格式。需要图片时应使用平台绘图功能，图片仅支持 PNG/JPEG，不要用代码或链接冒充图片。"

// AIConfig 是模型设置，接口需兼容 OpenAI Chat Completions。
type AIConfig struct {
	URL    string `json:"url"` // 接口根地址，例如 https://host/v1
	Key    string `json:"key"`
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Vision bool   `json:"vision"` // 把聊天图片缩略图一并发给模型
}

// AISetting 是一套回复方式。
type AISetting struct {
	Mode            string `json:"mode"`             // off | auto
	Keyword         string `json:"keyword"`          // 非空时只有包含该词的来信才触发
	IntervalSeconds int    `json:"interval_seconds"` // 同一会话两次生成的最短间隔
}

// AIRule 按会话名称批量套用回复方式，从上到下第一条匹配的生效。
type AIRule struct {
	Kind    string `json:"kind"`    // person | group
	Matcher string `json:"matcher"` // wildcard（* 和 ?）| regex（Go RE2）
	Pattern string `json:"pattern"`
	AISetting
}

// AIJob 是一次 AI 回复的记录。
type AIJob struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id"`
	Status         string `json:"status"` // running | sent | failed
	Reply          string `json:"reply,omitempty"`
	Error          string `json:"error,omitempty"`
	OperationID    string `json:"operation_id,omitempty"` // 自动发送对应的发送任务
	Created        string `json:"created"`
}

// matches 判断规则是否适用于会话：类型相同，且名称匹配通配符或正则（整名匹配）。
func (r AIRule) matches(c *Conversation) bool {
	if r.Kind != c.Kind {
		return false
	}
	re, err := regexp.Compile(r.regex())
	return err == nil && re.MatchString(c.Title)
}

// regex 规则对应的正则：通配符先转义，再把 * 换成 .*、? 换成 .，并锚定首尾。
func (r AIRule) regex() string {
	if r.Matcher != "wildcard" {
		return r.Pattern
	}
	return "^" + strings.NewReplacer(`\*`, ".*", `\?`, ".").Replace(regexp.QuoteMeta(r.Pattern)) + "$"
}

// aiSettingLocked 返回会话实际生效的回复方式：会话自己的设置 > 账号规则 > 全局规则 > 关闭。
func (a *App) aiSettingLocked(c *Conversation) AISetting {
	if c.AI.Mode != "" {
		return c.AI
	}
	rules := append(append([]AIRule{}, a.state.AccountAI[c.Account].Rules...), a.state.AIRules...)
	for _, r := range rules {
		if r.matches(c) {
			return r.AISetting
		}
	}
	return AISetting{Mode: aiOff}
}

// aiLoop 每秒检查一次：没有手机能执行的排队任务直接失败（没有手机时不会有 worker 来处理它们）；
// 有需要回复的会话就生成回复。同一时刻只有一个生成任务，调用模型时不持锁。
func (a *App) aiLoop(ctx context.Context) {
	for pause(ctx, time.Second) {
		if jobID := a.nextAIJob(); jobID != "" {
			a.generateReply(ctx, jobID)
		}
	}
}

// nextAIJob 处理孤立的排队任务，再挑出下一个需要自动回复的会话。
func (a *App) nextAIJob() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.failOrphansLocked()
	return a.nextAIJobLocked()
}

// nextAIJobLocked 挑出一个需要自动回复的会话并建立 AI 记录，返回记录编号；没有返回空字符串。
func (a *App) nextAIJobLocked() string {
	for _, c := range a.state.Conversations {
		if a.replyDueLocked(c) {
			a.aiLastRun[c.ID] = time.Now()
			return a.newAIJobLocked(c.ID).ID
		}
	}
	return ""
}

// replyDueLocked 会话现在是否需要自动回复：配置了模型、开启了自动回复、距上次生成满最短间隔，
// 且游标之后有包含触发词的来信。检查过的新消息推进游标；间隔未到时游标不动，下次再看。
func (a *App) replyDueLocked(c *Conversation) bool {
	if a.effectiveAIConfigLocked(c.Account).URL == "" {
		return false
	}
	setting := a.aiSettingLocked(c)
	cursor, seen := a.aiCursor[c.ID]
	// 首次见到的会话和关闭回复的会话只跟上最新位置：开启后只回复之后的新消息。
	if !seen || setting.Mode != aiAuto {
		a.aiCursor[c.ID] = c.LastSeq
		return false
	}
	interval := time.Duration(setting.IntervalSeconds) * time.Second
	if cursor >= c.LastSeq || time.Since(a.aiLastRun[c.ID]) < interval {
		return false
	}
	a.aiCursor[c.ID] = c.LastSeq
	return hasTrigger(c.Messages, cursor, setting.Keyword)
}

// hasTrigger 判断序号 after 之后是否有来信包含触发词（触发词为空时任何来信都算）。
func hasTrigger(messages []Message, after int64, keyword string) bool {
	for _, m := range messages {
		if m.Seq > after && m.Direction == dirIncoming && strings.Contains(m.Text, keyword) {
			return true
		}
	}
	return false
}

// newAIJobLocked 建立一条“生成中”的 AI 记录并保存。
func (a *App) newAIJobLocked(conversationID string) *AIJob {
	j := &AIJob{ID: randomID(), ConversationID: conversationID, Status: aiRunning, Created: now()}
	a.state.AIJobs[j.ID] = j
	_ = a.commitLocked()
	return j
}

// pruneAIJobsLocked AI 记录只保留最近的，正在生成的不删。
func (a *App) pruneAIJobsLocked() {
	if len(a.state.AIJobs) <= maxAIJobs {
		return
	}
	jobs := newest(mapValues(a.state.AIJobs), func(j *AIJob) string { return j.Created }, len(a.state.AIJobs))
	for _, j := range jobs[maxAIJobs:] {
		if j.Status != aiRunning {
			delete(a.state.AIJobs, j.ID)
		}
	}
}

// ---------- 生成回复 ----------

// generateReply 取会话上下文 → 调用模型 → 记录结果；生成后会话仍是自动回复时排队发送。
func (a *App) generateReply(ctx context.Context, jobID string) {
	log.Printf("AI 任务 %s 开始", jobID)
	cfg, history := a.replyContext(jobID)
	reply, err := a.askModel(ctx, cfg, history)
	a.finishReply(jobID, reply, err)
}

// replyContext 取会话实际生效的模型设置，并把最近的消息组装成模型上下文。
func (a *App) replyContext(jobID string) (AIConfig, []openai.ChatCompletionMessageParamUnion) {
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.state.Conversations[a.state.AIJobs[jobID].ConversationID]
	cfg := a.effectiveAIConfigLocked(c.Account)
	return cfg, a.chatHistoryLocked(cfg, c)
}

// askModel 调用模型，最多等 30 秒；返回去掉首尾空白的回复。
func (a *App) askModel(ctx context.Context, cfg AIConfig, history []openai.ChatCompletionMessageParamUnion) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, aiTimeout)
	defer cancel()
	resp, err := a.aiClient(cfg).Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
		Model:     cfg.Model,
		Messages:  history,
		MaxTokens: openai.Int(aiMaxTokens),
	})
	if err != nil || len(resp.Choices) == 0 {
		return "", err
	}
	return strings.TrimSpace(resp.Choices[0].Message.Content), nil
}

// finishReply 记录生成结果：回复可用、且生成期间自动回复没被关掉时，建立发送任务交给手机。
func (a *App) finishReply(jobID, reply string, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	job := a.state.AIJobs[jobID]
	c := a.state.Conversations[job.ConversationID]
	if problem := a.replyProblemLocked(c, reply, err); problem != "" {
		job.Status, job.Error = aiFailed, problem
	} else {
		op := &Operation{PhoneID: a.phoneForLocked(c).ID, Account: c.Account, ID: "ai-" + job.ID, ConversationID: c.ID, Kind: opSend, Text: reply, Status: opQueued, Created: now()}
		a.state.Operations[op.ID] = op
		job.Status, job.Reply, job.OperationID = aiSent, reply, op.ID
		a.wakeWorker()
	}
	log.Printf("AI 任务 %s 结束 状态=%s 错误=%s", jobID, job.Status, job.Error)
	_ = a.commitLocked()
}

// replyProblemLocked 回复不能发送的原因，可以发送时返回空字符串。
func (a *App) replyProblemLocked(c *Conversation, reply string, err error) string {
	lower := strings.ToLower(reply)
	switch {
	case err != nil:
		return "AI 接口请求失败或超时，请检查地址、模型、密钥和额度"
	case reply == "" || len([]rune(reply)) > maxMessageRunes:
		return "AI 回复为空或超过 2000 字"
	case strings.Contains(lower, "<svg") || strings.Contains(lower, "data:image/svg") || strings.Contains(lower, "```svg"):
		return "AI 返回了矢量图内容，无法作为文字发送"
	case a.aiSettingLocked(c).Mode != aiAuto:
		return "生成期间自动回复已关闭，未发送"
	case a.phoneForLocked(c) == nil:
		return "会话的账号当前没有连接的手机，未发送"
	}
	return ""
}

// aiClient 按配置创建 OpenAI 兼容客户端：不自动重试，不跟随重定向（避免密钥被转发到其他地址）。
func (a *App) aiClient(cfg AIConfig) *openai.Client {
	httpClient := &http.Client{
		Transport:     a.aiHTTP,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	client := openai.NewClient(
		option.WithBaseURL(cfg.URL),
		option.WithAPIKey(cfg.Key),
		option.WithMaxRetries(0),
		option.WithHTTPClient(httpClient),
	)
	return &client
}

// chatHistoryLocked 把最近 20 条消息转成模型上下文：来信为 user，发出的为 assistant；系统提示不是对话内容，跳过。
func (a *App) chatHistoryLocked(cfg AIConfig, c *Conversation) []openai.ChatCompletionMessageParamUnion {
	history := []openai.ChatCompletionMessageParamUnion{openai.SystemMessage(replyFormatRule)}
	if cfg.Prompt != "" {
		history = append(history, openai.SystemMessage(cfg.Prompt))
	}
	for _, m := range c.Messages[max(0, len(c.Messages)-aiHistorySize):] {
		if m.Kind == msgSystem {
			continue
		}
		text := truncateRunes(m.Text, aiMaxInputRunes)
		if m.Direction == dirOutgoing {
			history = append(history, openai.AssistantMessage(text))
			continue
		}
		if c.Kind == kindGroup && m.Sender != "" {
			text = m.Sender + "：" + text // 群聊里注明是谁说的
		}
		history = append(history, a.userMessage(cfg, m, text))
	}
	return history
}

// userMessage 一条来信；开启看图时，来信的图片以 Base64 一并发送。
func (a *App) userMessage(cfg AIConfig, m Message, text string) openai.ChatCompletionMessageParamUnion {
	if cfg.Vision && m.ImageHash != "" {
		if data, err := a.readImage(m.ImageHash); err == nil {
			image := openai.ChatCompletionContentPartImageImageURLParam{URL: "data:image/jpeg;base64," + data}
			return openai.UserMessage([]openai.ChatCompletionContentPartUnionParam{openai.TextContentPart(text), openai.ImageContentPart(image)})
		}
	}
	return openai.UserMessage(text)
}

// truncateRunes 截到最多 n 个字。
func truncateRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// mapValues 把 map 的值收集成切片。
func mapValues[K comparable, V any](m map[K]V) []V {
	out := make([]V, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}
