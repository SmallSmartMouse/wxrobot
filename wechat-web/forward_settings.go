package main

// 转发规则的网页接口：列出规则和转发情况，逐条保存、删除（不整体替换，避免覆盖别处同时修改的其他规则）。

import "github.com/gin-gonic/gin"

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
	c.JSON(200, gin.H{"rules": a.forwardViewsLocked()})
}

// forwardViewsLocked 每条规则加上统计：按保留的转发任务计数成功、失败、进行中，以及最近一次转发时间。
func (a *App) forwardViewsLocked() []forwardRuleView {
	views := make([]forwardRuleView, len(a.state.ForwardRules))
	index := map[string]*forwardRuleView{}
	for i, r := range a.state.ForwardRules {
		views[i] = forwardRuleView{ForwardRule: r, forwardStatus: a.forwardStatus[r.ID]}
		index[r.ID] = &views[i]
	}
	for _, op := range a.state.Operations {
		v := index[op.ForwardRule]
		if v == nil {
			continue
		}
		switch {
		case op.active():
			v.Queued++
		case op.Status == opSucceeded:
			v.Forwarded++
		default:
			v.Failed++
		}
		v.LastAt = max(v.LastAt, op.Created)
	}
	return views
}

// saveForwardRule 校验并保存一条规则：没有编号的是新规则；指定的执行设备必须登录着目标会话的微信号。
func (a *App) saveForwardRule(c *gin.Context) {
	var rule ForwardRule
	if !bind(c, &rule) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := rule.validate(a.state.Conversations); err != nil {
		fail(c, 400, err.Error())
		return
	}
	if !a.targetPhonesMatchLocked(rule) {
		fail(c, 400, "指定设备与目标微信号不匹配")
		return
	}
	index := a.forwardRuleIndexLocked(rule.ID)
	switch {
	case rule.ID != "" && index < 0:
		fail(c, 404, "规则已删除，请刷新")
		return
	case index < 0 && len(a.state.ForwardRules) >= maxForwardRules:
		fail(c, 400, "最多 50 条规则")
		return
	}
	old := append([]ForwardRule(nil), a.state.ForwardRules...)
	if index < 0 {
		rule.ID = randomID()[:12]
		a.state.ForwardRules = append(a.state.ForwardRules, rule)
	} else {
		a.state.ForwardRules[index] = rule
	}
	if err := a.commitLocked(); err != nil {
		a.state.ForwardRules = old
		fail(c, 500, "保存失败")
		return
	}
	c.JSON(200, gin.H{"ok": true, "id": rule.ID})
}

// targetPhonesMatchLocked 规则指定的执行设备都存在，且登录着对应目标会话的微信号。
func (a *App) targetPhonesMatchLocked(rule ForwardRule) bool {
	for target, phoneID := range rule.TargetPhones {
		conv, p := a.state.Conversations[target], a.phoneLocked(phoneID)
		if conv == nil || p == nil || !p.owns(conv) {
			return false
		}
	}
	return true
}

// forwardRuleIndexLocked 规则在列表中的位置，没有（或编号为空）返回 -1。
func (a *App) forwardRuleIndexLocked(id string) int {
	for i, r := range a.state.ForwardRules {
		if id != "" && r.ID == id {
			return i
		}
	}
	return -1
}

// deleteForwardRule 删除一条规则。
func (a *App) deleteForwardRule(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	index := a.forwardRuleIndexLocked(c.Param("id"))
	if index < 0 {
		fail(c, 404, "规则不存在")
		return
	}
	old := a.state.ForwardRules
	a.state.ForwardRules = append(append([]ForwardRule{}, old[:index]...), old[index+1:]...)
	if err := a.commitLocked(); err != nil {
		a.state.ForwardRules = old
		fail(c, 500, "删除失败")
		return
	}
	c.JSON(200, gin.H{"ok": true})
}
