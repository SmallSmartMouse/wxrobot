package main

import "github.com/gin-gonic/gin"

// setReadingSettings 全局控制消息和原图读取是否允许向上翻页。
func (a *App) setReadingSettings(ctx *gin.Context) {
	var req struct {
		ReadHistory *bool `json:"read_history"`
	}
	if !bind(ctx, &req) {
		return
	}
	if req.ReadHistory == nil {
		fail(ctx, 400, "请选择是否读取最近历史消息")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	previous := a.state.NewMessagesOnly
	next := !*req.ReadHistory
	if previous == next {
		ctx.JSON(200, gin.H{"read_history": !next})
		return
	}
	saved := map[string]Conversation{}
	for id, c := range a.state.Conversations {
		saved[id] = *c
		if next {
			c.seedLiveAnchor(true)
			// 没有待读的会话，之前留下的未读条数和通知已经过时，不能在第一次读取时当作新增导入
			if !c.NeedsRead {
				c.LiveSignal, c.LiveUnread, c.LiveNotices = false, 0, nil
			}
		}
		c.OriginalsDue = false
		// 不为所有会话安排读取（会话多时手机会被连续读取占满）：沿用已有边界，等新消息提示再读；
		// 切换时正在执行的读取由 finishLocked 按新模式合并并补读当前屏。
	}
	a.state.NewMessagesOnly = next
	if err := a.commitLocked(); err != nil {
		a.state.NewMessagesOnly = previous
		for id, old := range saved {
			*a.state.Conversations[id] = old
		}
		fail(ctx, 500, "保存失败，请重试")
		return
	}
	a.wakeWorker()
	ctx.JSON(200, gin.H{"read_history": !next})
}
