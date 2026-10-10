package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
)

// AIConfig 是全局模型设置，接口需兼容 OpenAI Chat Completions。
type AIConfig struct {
	URL    string `json:"url"` // 接口根地址，例如 https://host/v1
	Key    string `json:"key"`
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Vision bool   `json:"vision"` // 把聊天图片缩略图一并发给模型
}

// AISetting 是一套回复方式。
type AISetting struct {
	Mode            string `json:"mode"`             // off | auto（自动生成并发送）
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
	pattern := r.Pattern
	// 通配符转成正则：先转义，再把 * 换成 .*、? 换成 .，并锚定首尾
	if r.Matcher == "wildcard" {
		pattern = regexp.QuoteMeta(pattern)
		pattern = "^" + strings.NewReplacer(`\*`, ".*", `\?`, ".").Replace(pattern) + "$"
	}
	re, err := regexp.Compile(pattern)
	return err == nil && re.MatchString(c.Title)
}

// validate 检查回复方式、间隔和触发词；kind 是会话类型（群聊自动回复必须设置触发词）。
func (s AISetting) validate(kind string) error {
	if s.Mode != "off" && s.Mode != "auto" {
		return errors.New("回复方式必须为 off 或 auto")
	}
	if s.IntervalSeconds < 5 || s.IntervalSeconds > 86400 {
		return errors.New("回复周期必须为 5–86400 秒")
	}
	if s.Mode == "auto" && kind == "unknown" {
		return errors.New("自动回复前请先设置会话类型")
	}
	if s.Mode == "auto" && kind == "group" && strings.TrimSpace(s.Keyword) == "" {
		return errors.New("群聊自动回复必须设置触发词")
	}
	return nil
}

// aiSettingLocked 返回会话实际生效的回复方式：会话自己的设置 > 第一条匹配的名称规则 > 关闭。
func (a *App) aiSettingLocked(c *Conversation) AISetting {
	// 会话自己设置过就用自己的
	if c.AI.Mode != "" {
		return c.AI
	}
	for _, r := range a.state.AIRules {
		if r.matches(c) {
			return r.AISetting
		}
	}
	return AISetting{Mode: "off"}
}

// aiLoop 每秒检查一次：开启了回复的会话有新来信（且满足触发词和周期）时生成回复。
func (a *App) aiLoop(ctx context.Context) {
	for pause(ctx, time.Second) {
		a.mu.Lock()
		// 没有手机能执行的排队任务直接失败（没有手机时不会有 worker 来处理它们）
		a.failOrphansLocked()
		// 加锁挑出一个需要回复的会话并建好记录，解锁后再调用模型（耗时操作不持锁）
		jobID := a.nextAutoJobLocked()
		a.mu.Unlock()
		if jobID != "" {
			a.generateReply(ctx, jobID)
		}
	}
}

// nextAutoJobLocked 找出一个需要自动回复的会话并建立 AI 记录，返回记录编号；没有返回空字符串。
// aiCursor 记录每个会话已检查到的消息序号，只看之后的新来信。
func (a *App) nextAutoJobLocked() string {
	// 没有配置 AI 接口时不处理
	if a.state.AI.URL == "" {
		return ""
	}
	for _, c := range a.state.Conversations {
		setting := a.aiSettingLocked(c)
		cursor, seen := a.aiCursor[c.ID]
		// 首次见到的会话和关闭回复的会话只跟上最新位置：开启后只回复之后的新消息。
		if !seen || setting.Mode != "auto" {
			a.aiCursor[c.ID] = c.LastSeq
			continue
		}
		// 没有新消息，或距上次生成不足最短间隔：先不处理（游标不动，下次再看）
		interval := time.Duration(setting.IntervalSeconds) * time.Second
		if cursor >= c.LastSeq || time.Since(a.aiLastRun[c.ID]) < interval {
			continue
		}
		// 推进游标；新消息里没有满足触发词的来信就不回复
		a.aiCursor[c.ID] = c.LastSeq
		if !hasTrigger(c.Messages, cursor, setting.Keyword) {
			continue
		}
		a.aiLastRun[c.ID] = time.Now()
		return a.newAIJobLocked(c.ID).ID
	}
	return ""
}

// hasTrigger 判断序号 after 之后是否有来信包含触发词（触发词为空时任何来信都算）。
func hasTrigger(messages []Message, after int64, keyword string) bool {
	for _, m := range messages {
		if m.Seq > after && m.Direction == "incoming" && strings.Contains(m.Text, keyword) {
			return true
		}
	}
	return false
}

// newAIJobLocked 建立一条“生成中”的 AI 记录并保存。
func (a *App) newAIJobLocked(conversationID string) *AIJob {
	j := &AIJob{ID: randomID(), ConversationID: conversationID, Status: "running", Created: now()}
	a.state.AIJobs[j.ID] = j
	_ = a.commitLocked()
	return j
}

// aiClient 按配置创建 OpenAI 兼容客户端：不自动重试，不跟随重定向。
func (a *App) aiClient(cfg AIConfig) *openai.Client {
	// 不跟随重定向，避免密钥被转发到其他地址。
	httpClient := &http.Client{
		Transport:     a.client.Transport,
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

// chatHistoryLocked 把最近 20 条消息转成模型上下文：来信为 user，发出的为 assistant。
func (a *App) chatHistoryLocked(cfg AIConfig, c *Conversation) []openai.ChatCompletionMessageParamUnion {
	var history []openai.ChatCompletionMessageParamUnion
	// 格式限制独立于用户提示词，避免输出不能直接发送到微信的附件或矢量代码。
	history = append(history, openai.SystemMessage("回复仅支持纯文字和普通位图。文字回复请使用纯文本，不要输出 SVG、HTML、矢量图代码、文件附件、音视频或其他格式。需要图片时应使用平台绘图功能，图片仅支持 PNG/JPEG，不要用代码或链接冒充图片。"))
	if cfg.Prompt != "" {
		history = append(history, openai.SystemMessage(cfg.Prompt))
	}
	// 逐条转换：过长的文字截到 4000 字；开启看图时，来信图片以 Base64 一并发送
	for _, m := range c.Messages[max(0, len(c.Messages)-20):] {
		if m.Kind == "system" {
			continue // 系统提示不是对话内容
		}
		text := m.Text
		if r := []rune(text); len(r) > 4000 {
			text = string(r[:4000])
		}
		if m.Direction == "outgoing" {
			history = append(history, openai.AssistantMessage(text))
			continue
		}
		// 群聊里注明是谁说的
		if c.Kind == "group" && m.Sender != "" {
			text = m.Sender + "：" + text
		}
		if cfg.Vision && m.ImageHash != "" {
			if data, err := a.readImage(m.ImageHash); err == nil {
				image := openai.ChatCompletionContentPartImageImageURLParam{URL: "data:image/jpeg;base64," + data}
				parts := []openai.ChatCompletionContentPartUnionParam{openai.TextContentPart(text), openai.ImageContentPart(image)}
				history = append(history, openai.UserMessage(parts))
				continue
			}
		}
		history = append(history, openai.UserMessage(text))
	}
	return history
}

// generateReply 调用模型生成回复，生成后会话仍是自动回复时排队发送。
// aiLoop 逐个调用，同一时刻只有一个生成任务。
func (a *App) generateReply(ctx context.Context, jobID string) {
	log.Printf("AI 任务 %s 开始", jobID)
	// 加锁取出会话和配置，组装上下文后立即解锁
	a.mu.Lock()
	job := a.state.AIJobs[jobID]
	c := a.state.Conversations[job.ConversationID]
	cfg := a.state.AI
	history := a.chatHistoryLocked(cfg, c)
	a.mu.Unlock()

	// 调用模型，最多等 30 秒，回复最多 600 token
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := a.aiClient(cfg).Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
		Model:     cfg.Model,
		Messages:  history,
		MaxTokens: openai.Int(600),
	})
	reply := ""
	if err == nil && len(resp.Choices) > 0 {
		reply = strings.TrimSpace(resp.Choices[0].Message.Content)
	}

	// 根据结果记录状态；生成期间自动回复被关掉就不发送，否则建立发送任务交给 worker
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case err != nil:
		job.Status, job.Error = "failed", "AI 接口请求失败或超时，请检查地址、模型、密钥和额度"
	case reply == "" || len([]rune(reply)) > 2000:
		job.Status, job.Error = "failed", "AI 回复为空或超过 2000 字"
	case strings.Contains(strings.ToLower(reply), "<svg") || strings.Contains(strings.ToLower(reply), "data:image/svg") || strings.Contains(strings.ToLower(reply), "```svg"):
		job.Status, job.Error = "failed", "AI 返回了矢量图内容，无法作为文字发送"
	case a.aiSettingLocked(c).Mode != "auto":
		job.Status, job.Error = "failed", "生成期间自动回复已关闭，未发送"
	case a.phoneForLocked(c) == nil:
		job.Status, job.Error = "failed", "会话的账号当前没有连接的手机，未发送"
	default:
		op := &Operation{ID: "ai-" + job.ID, ConversationID: c.ID, Kind: "send", Text: reply, Status: "queued", Created: now()}
		a.state.Operations[op.ID] = op
		job.Status, job.Reply, job.OperationID = "sent", reply, op.ID
		a.wakeWorker()
	}
	log.Printf("AI 任务 %s 结束 状态=%s 错误=%s", jobID, job.Status, job.Error)
	_ = a.commitLocked()
}
