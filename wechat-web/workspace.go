package main

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

// AccountAIConfig only stores explicit overrides. Nil values inherit the global configuration.
type AccountAIConfig struct {
	InheritModel bool     `json:"inherit_model"`
	Model        AIConfig `json:"model_config"`
	Prompt       *string  `json:"prompt,omitempty"`
	Vision       *bool    `json:"vision,omitempty"`
	Rules        []AIRule `json:"rules"`
}

func (a *App) effectiveAIConfigLocked(account string) AIConfig {
	cfg := a.state.AI
	if override, ok := a.state.AccountAI[account]; ok {
		if !override.InheritModel {
			cfg.URL, cfg.Model, cfg.Key = override.Model.URL, override.Model.Model, override.Model.Key
		}
		if override.Prompt != nil {
			cfg.Prompt = *override.Prompt
		}
		if override.Vision != nil {
			cfg.Vision = *override.Vision
		}
	}
	return cfg
}

func (a *App) knownAccountLocked(account string) bool {
	for _, v := range a.accountsLocked() {
		if v.WechatID == account {
			return true
		}
	}
	return false
}

func (a *App) getAccountAI(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	account := c.Param("account")
	if !a.knownAccountLocked(account) {
		fail(c, 404, "微信号不存在")
		return
	}
	cfg, ok := a.state.AccountAI[account]
	if !ok {
		cfg.InheritModel = true
	}
	effective := a.effectiveAIConfigLocked(account)
	keySet := effective.Key != ""
	cfg.Model.Key = ""
	effective.Key = ""
	if cfg.Rules == nil {
		cfg.Rules = []AIRule{}
	}
	c.JSON(200, gin.H{"config": cfg, "effective": effective, "key_set": keySet})
}

func validateModel(cfg *AIConfig) error {
	cfg.URL = strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(cfg.URL), "/"), "/chat/completions")
	u, err := url.Parse(cfg.URL)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || strings.TrimSpace(cfg.Model) == "" {
		return errors.New("请输入有效的接口地址和模型名称")
	}
	return nil
}

func validateAIRules(rules []AIRule) error {
	if len(rules) > 100 {
		return errors.New("最多 100 条名称规则")
	}
	for _, rule := range rules {
		if err := rule.validate(rule.Kind); err != nil {
			return err
		}
		if (rule.Kind != "person" && rule.Kind != "group") || rule.Pattern == "" {
			return errors.New("请选择会话类型并填写名称表达式")
		}
		if rule.Matcher != "wildcard" && rule.Matcher != "regex" {
			return errors.New("请选择通配符或正则")
		}
		if _, err := regexp.Compile(rule.Pattern); rule.Matcher == "regex" && err != nil {
			return errors.New("正则表达式无效")
		}
	}
	return nil
}

func (a *App) setAccountAI(c *gin.Context) {
	var body AccountAIConfig
	if !bind(c, &body) {
		return
	}
	if !body.InheritModel {
		if err := validateModel(&body.Model); err != nil {
			fail(c, 400, err.Error())
			return
		}
	}
	if err := validateAIRules(body.Rules); err != nil {
		fail(c, 400, err.Error())
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	account := c.Param("account")
	if !a.knownAccountLocked(account) {
		fail(c, 404, "微信号不存在")
		return
	}
	if a.state.AccountAI == nil {
		a.state.AccountAI = map[string]AccountAIConfig{}
	}
	old, existed := a.state.AccountAI[account]
	if body.Model.Key == "" {
		body.Model.Key = old.Model.Key
	}
	a.state.AccountAI[account] = body
	if err := a.commitLocked(); err != nil {
		if existed {
			a.state.AccountAI[account] = old
		} else {
			delete(a.state.AccountAI, account)
		}
		fail(c, 500, "保存失败")
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) deviceTaskCountLocked(id string) int {
	count := 0
	for _, op := range a.state.Operations {
		if op.PhoneID == id && op.active() {
			count++
		}
	}
	return count
}

func (a *App) deviceAvailableLocked(p *PhoneConfig) bool {
	if !a.onlineLocked(p.ID) {
		return false
	}
	var d struct {
		Online *bool `json:"online"`
		Info   struct {
			Ready   *bool `json:"ready"`
			Account struct {
				Error json.RawMessage `json:"error"`
			} `json:"account"`
		} `json:"info"`
	}
	_ = json.Unmarshal(a.phones[p.ID].device, &d)
	return (d.Online == nil || *d.Online) && (d.Info.Ready == nil || *d.Info.Ready) && (len(d.Info.Account.Error) == 0 || string(d.Info.Account.Error) == "null")
}

// A manual target never falls back. Automatic selection prefers the shortest available queue.
func (a *App) selectDeviceLocked(conv *Conversation, requested string) *PhoneConfig {
	var best *PhoneConfig
	for _, p := range a.state.Phones {
		if !p.owns(conv) || !a.deviceAvailableLocked(p) || (requested != "" && requested != p.ID) {
			continue
		}
		if best == nil || a.deviceTaskCountLocked(p.ID) < a.deviceTaskCountLocked(best.ID) {
			best = p
		}
	}
	return best
}

func (a *App) renamePhone(c *gin.Context) {
	var body struct {
		Name string `json:"name"`
	}
	if !bind(c, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if len([]rune(body.Name)) > 40 {
		fail(c, 400, "设备名称最多 40 字")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.phoneLocked(c.Param("id"))
	if p == nil {
		fail(c, 404, "设备不存在")
		return
	}
	old := p.Name
	p.Name = body.Name
	if err := a.commitLocked(); err != nil {
		p.Name = old
		fail(c, 500, "保存失败")
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// Per-rule writes avoid replacing concurrent edits to other rules.
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
	for target, phoneID := range rule.TargetPhones {
		conv := a.state.Conversations[target]
		p := a.phoneLocked(phoneID)
		if conv == nil || p == nil || !p.owns(conv) {
			fail(c, 400, "指定设备与目标微信号不匹配")
			return
		}
	}
	old := append([]ForwardRule(nil), a.state.ForwardRules...)
	index := -1
	for i, r := range a.state.ForwardRules {
		if r.ID == rule.ID {
			index = i
			break
		}
	}
	if rule.ID != "" && index < 0 {
		fail(c, 404, "规则已删除，请刷新")
		return
	}
	if index < 0 {
		if len(old) >= maxForwardRules {
			fail(c, 400, "最多 50 条规则")
			return
		}
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

func (a *App) deleteForwardRule(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	old := a.state.ForwardRules
	next := make([]ForwardRule, 0, len(old))
	for _, r := range old {
		if r.ID != c.Param("id") {
			next = append(next, r)
		}
	}
	if len(next) == len(old) {
		fail(c, 404, "规则不存在")
		return
	}
	a.state.ForwardRules = next
	if err := a.commitLocked(); err != nil {
		a.state.ForwardRules = old
		fail(c, 500, "删除失败")
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// Save discovery and reading as a single transaction for the system settings page.
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
	a.mu.Lock()
	old, oldReading := a.state.Discovery, a.state.NewMessagesOnly
	saved := map[string]Conversation{}
	if oldReading != !body.ReadHistory {
		for id, conv := range a.state.Conversations {
			saved[id] = *conv
			if !body.ReadHistory {
				conv.seedLiveAnchor(true)
				if !conv.NeedsRead {
					conv.LiveSignal, conv.LiveUnread, conv.LiveNotices = false, 0, nil
				}
			}
			conv.OriginalsDue = false
		}
	}
	a.state.Discovery, a.state.NewMessagesOnly = settings, !body.ReadHistory
	if err = a.commitLocked(); err != nil {
		a.state.Discovery, a.state.NewMessagesOnly = old, oldReading
		for id, previous := range saved {
			*a.state.Conversations[id] = previous
		}
		a.mu.Unlock()
		fail(c, 500, "保存失败")
		return
	}
	a.mu.Unlock()
	wake(a.discoveryWake)
	a.wakeWorker()
	c.JSON(200, gin.H{"ok": true, "config": settings, "read_history": body.ReadHistory})
}
