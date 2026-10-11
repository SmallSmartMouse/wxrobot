package main

// 系统设置：搜索设置和读取模式在设备页一起保存，要么都生效，要么都不生效。

import "github.com/gin-gonic/gin"

// setSystemSettings 校验并保存搜索设置和读取模式；保存失败时全部恢复原状。
func (a *App) setSystemSettings(c *gin.Context) {
	var body struct {
		Discovery   DiscoverySettings `json:"discovery"`
		ReadHistory bool              `json:"read_history"`
	}
	if !bind(c, &body) {
		return
	}
	settings, _, _, err := validateDiscoverySettings(body.Discovery)
	if err != nil {
		fail(c, 400, err.Error())
		return
	}
	if !a.saveSystemSettings(settings, !body.ReadHistory) {
		fail(c, 500, "保存失败")
		return
	}
	wake(a.discoveryWake)
	c.JSON(200, gin.H{"ok": true, "config": settings, "read_history": body.ReadHistory})
}

// saveSystemSettings 应用并保存设置，返回是否保存成功。
func (a *App) saveSystemSettings(discovery DiscoverySettings, newMessagesOnly bool) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	oldDiscovery := a.state.Discovery
	a.state.Discovery = discovery
	undoReadMode := a.switchReadModeLocked(newMessagesOnly)
	if err := a.commitLocked(); err != nil {
		a.state.Discovery = oldDiscovery
		undoReadMode()
		return false
	}
	a.wakeWorker()
	return true
}

// switchReadModeLocked 切换读取模式，返回撤销切换的函数。
//
// 切换到仅新增模式时，各会话沿用已读到的末尾作为观察窗口；没有待读的会话，之前留下的未读条数和通知已经过时，
// 清掉，不能在第一次读取时当作新增导入。不为所有会话安排读取（会话多时手机会被连续读取占满），等新消息提示再读；
// 切换时正在执行的读取由 mergeReadLocked 按新模式合并并补读当前屏。两种模式都取消待补的原图。
func (a *App) switchReadModeLocked(newMessagesOnly bool) (undo func()) {
	previous := a.state.NewMessagesOnly
	if previous == newMessagesOnly {
		return func() {}
	}
	saved := map[string]Conversation{}
	for id, c := range a.state.Conversations {
		saved[id] = *c
		if newMessagesOnly {
			c.resetLiveAnchor()
			if !c.NeedsRead {
				c.clearLiveSignal()
			}
		}
		c.OriginalsDue = false
	}
	a.state.NewMessagesOnly = newMessagesOnly
	return func() {
		a.state.NewMessagesOnly = previous
		for id, old := range saved {
			*a.state.Conversations[id] = old
		}
	}
}
