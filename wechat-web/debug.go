package main

import (
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"
)

// getDebug 只读诊断：返回最近任务、手机上报的执行结果和有限长度的服务日志。
// 沿用本机访问限制；不返回配置凭证，也不开放任意文件读取。
func (a *App) getDebug(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	// 最近 100 个任务（含执行步骤）和 50 条 AI 记录，新的在前
	operations := a.recentOperationsLocked(100)
	jobs := newest(slices.Collect(maps.Values(a.state.AIJobs)), func(j *AIJob) string { return j.Created }, 50)
	logText := ""
	logError := ""
	// 服务日志只读最后 64 KB
	file, err := os.Open(filepath.Join(filepath.Dir(a.path), "server.log"))
	if err != nil {
		logError = "日志文件不可用；服务需将日志输出到数据目录的 server.log"
	} else {
		defer file.Close()
		if info, err := file.Stat(); err == nil {
			_, err = file.Seek(max(0, info.Size()-65536), io.SeekStart)
			if err == nil {
				data, readErr := io.ReadAll(io.LimitReader(file, 65536))
				if readErr == nil {
					logText = string(data)
				}
			}
		}
	}
	// 日志里如果出现 Token 或密钥，替换掉再返回
	secrets := []string{a.state.AI.Key}
	for _, cfg := range a.state.AccountAI {
		secrets = append(secrets, cfg.Model.Key)
	}
	for _, p := range a.state.Phones {
		secrets = append(secrets, p.Token)
	}
	for _, secret := range secrets {
		if secret != "" {
			logText = strings.ReplaceAll(logText, secret, "[已隐藏凭证]")
		}
	}
	// 会话编号 → 名称，诊断页用来显示是哪个会话；有多个账号时名称后面注明账号
	titles := map[string]string{}
	multiple := len(a.accountsLocked()) > 1
	for id, conv := range a.state.Conversations {
		titles[id] = conv.Title
		if multiple && conv.Account != "" {
			titles[id] += "（" + conv.Account + "）"
		}
	}
	c.JSON(200, gin.H{"phones": a.phoneViewsLocked(), "error": a.lastError, "conversations": titles,
		"operations": operations, "ai_jobs": jobs, "log": logText, "log_error": logError})
}
