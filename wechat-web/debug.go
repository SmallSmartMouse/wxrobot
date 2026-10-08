package main

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

// getDebug 只读诊断：返回最近任务、手机上报的执行结果和有限长度的服务日志。
// 沿用本机访问限制；不返回配置凭证，也不开放任意文件读取。
func (a *App) getDebug(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	// 最近 100 个任务（含执行步骤），新的在前
	operations := make([]*Operation, 0, len(a.state.Operations))
	for _, op := range a.state.Operations {
		operations = append(operations, op)
	}
	sort.Slice(operations, func(i, j int) bool { return operations[i].Created > operations[j].Created })
	operations = operations[:min(100, len(operations))]
	// 最近 50 条 AI 记录
	jobs := make([]*AIJob, 0, len(a.state.AIJobs))
	for _, job := range a.state.AIJobs {
		jobs = append(jobs, job)
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].Created > jobs[j].Created })
	jobs = jobs[:min(50, len(jobs))]
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
	for _, secret := range []string{a.state.Phone.Token, a.state.AI.Key} {
		if secret != "" {
			logText = strings.ReplaceAll(logText, secret, "[已隐藏凭证]")
		}
	}
	// 会话编号 → 名称，诊断页用来显示是哪个会话
	titles := map[string]string{}
	for id, conv := range a.state.Conversations {
		titles[id] = conv.Title
	}
	c.JSON(200, gin.H{"connection": a.connection, "error": a.lastError, "device": a.device, "conversations": titles,
		"operations": operations, "ai_jobs": jobs, "log": logText, "log_error": logError})
}
