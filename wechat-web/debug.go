package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	maxLogBytes     = 64 << 10 // 诊断页显示的服务日志长度（最后这么多字节）：够看最近的问题，又不拖慢页面
	debugOperations = 100      // 诊断页列出的最近任务数（含执行步骤）
	debugAIJobs     = 50       // 诊断页列出的最近 AI 记录数
)

// getDebug 只读诊断：返回最近的任务（含执行步骤）和 AI 记录、手机上报的状态，以及服务日志的末尾。
// 沿用本机访问限制；不返回凭证，也不开放任意文件读取。
func (a *App) getDebug(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	logText, logError := a.serverLogTail()
	c.JSON(200, gin.H{
		"phones":        a.phoneViewsLocked(),
		"error":         a.lastError,
		"conversations": a.conversationTitlesLocked(),
		"operations":    a.recentOperationsLocked(debugOperations),
		"ai_jobs":       newest(mapValues(a.state.AIJobs), func(j *AIJob) string { return j.Created }, debugAIJobs),
		"log":           a.hideSecretsLocked(logText),
		"log_error":     logError,
	})
}

// serverLogTail 读取数据目录中 server.log 的末尾 maxLogBytes 字节；不可用时返回说明。
func (a *App) serverLogTail() (text, problem string) {
	file, err := os.Open(filepath.Join(filepath.Dir(a.path), "server.log"))
	if err != nil {
		return "", "日志文件不可用；服务需将日志输出到数据目录的 server.log"
	}
	defer file.Close()
	if info, err := file.Stat(); err == nil {
		if _, err = file.Seek(max(0, info.Size()-maxLogBytes), io.SeekStart); err == nil {
			data, _ := io.ReadAll(io.LimitReader(file, maxLogBytes))
			return string(data), ""
		}
	}
	return "", ""
}

// hideSecretsLocked 日志里如果出现手机凭证或 AI 密钥，替换掉再返回。
func (a *App) hideSecretsLocked(text string) string {
	secrets := []string{a.state.AI.Key}
	for _, cfg := range a.state.AccountAI {
		secrets = append(secrets, cfg.Model.Key)
	}
	for _, p := range a.state.Phones {
		secrets = append(secrets, p.Token)
	}
	for _, secret := range secrets {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "[已隐藏凭证]")
		}
	}
	return text
}

// conversationTitlesLocked 会话编号 → 名称，诊断页用来显示是哪个会话；有多个账号时名称后面注明账号。
func (a *App) conversationTitlesLocked() map[string]string {
	titles := map[string]string{}
	multiple := len(a.accountsLocked()) > 1
	for id, conv := range a.state.Conversations {
		titles[id] = conv.Title
		if multiple {
			titles[id] += "（" + conv.Account + "）"
		}
	}
	return titles
}
