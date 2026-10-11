package main

// AI 回复设置：全局模型和名称规则、按微信号的覆盖设置、单个会话的回复方式。
// 优先级：会话设置 > 微信号规则 > 全局规则；微信号的模型、提示词和看图可以分别跟随全局。

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	minReplyInterval = 5     // 秒：同一会话两次生成的最短间隔下限，避免对方连发时连续回复刷屏
	maxReplyInterval = 86400 // 秒：最长一天
	maxAIRules       = 100   // 名称规则上限：每个会话每秒都要逐条匹配，规则过多会拖慢检查
)

// AccountAIConfig 是一个微信号的覆盖设置，只保存明确覆盖的部分：Prompt、Vision 为 nil 时跟随全局。
type AccountAIConfig struct {
	InheritModel bool     `json:"inherit_model"`
	Model        AIConfig `json:"model_config"`
	Prompt       *string  `json:"prompt,omitempty"`
	Vision       *bool    `json:"vision,omitempty"`
	Rules        []AIRule `json:"rules"`
}

// effectiveAIConfigLocked 微信号实际生效的模型设置：全局设置叠加微信号的覆盖。
func (a *App) effectiveAIConfigLocked(account string) AIConfig {
	cfg := a.state.AI
	override, ok := a.state.AccountAI[account]
	if !ok {
		return cfg
	}
	if !override.InheritModel {
		cfg.URL, cfg.Model, cfg.Key = override.Model.URL, override.Model.Model, override.Model.Key
	}
	if override.Prompt != nil {
		cfg.Prompt = *override.Prompt
	}
	if override.Vision != nil {
		cfg.Vision = *override.Vision
	}
	return cfg
}

// validate 检查回复方式、间隔和触发词；kind 是会话类型（群聊自动回复必须设置触发词）。
func (s AISetting) validate(kind string) error {
	if s.Mode != aiOff && s.Mode != aiAuto {
		return errors.New("回复方式必须为 off 或 auto")
	}
	if s.IntervalSeconds < minReplyInterval || s.IntervalSeconds > maxReplyInterval {
		return fmt.Errorf("回复周期必须为 %d–%d 秒", minReplyInterval, maxReplyInterval)
	}
	if s.Mode == aiAuto && kind == kindUnknown {
		return errors.New("自动回复前请先设置会话类型")
	}
	if s.Mode == aiAuto && kind == kindGroup && strings.TrimSpace(s.Keyword) == "" {
		return errors.New("群聊自动回复必须设置触发词")
	}
	return nil
}

// normalizeModel 把接口地址统一为根地址（去掉末尾的 / 和 /chat/completions），并检查地址和模型名称。
func normalizeModel(cfg *AIConfig) error {
	cfg.URL = strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(cfg.URL), "/"), "/chat/completions")
	u, err := url.Parse(cfg.URL)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || strings.TrimSpace(cfg.Model) == "" {
		return errors.New("请输入有效的接口地址和模型名称")
	}
	return nil
}

// validateAIRules 检查名称规则：最多 100 条；类型、表达式必填，回复方式和间隔合法，正则能编译。
func validateAIRules(rules []AIRule) error {
	if len(rules) > maxAIRules {
		return fmt.Errorf("最多 %d 条名称规则", maxAIRules)
	}
	for _, rule := range rules {
		if err := rule.validate(rule.Kind); err != nil {
			return err
		}
		if (rule.Kind != kindPerson && rule.Kind != kindGroup) || rule.Pattern == "" {
			return errors.New("请选择会话类型并填写名称表达式")
		}
		if rule.Matcher != "wildcard" && rule.Matcher != "regex" {
			return errors.New("请选择通配符或正则")
		}
		if _, err := regexp.Compile(rule.Pattern); rule.Matcher == "regex" && err != nil {
			return errors.New("正则表达式无效：" + rule.Pattern)
		}
	}
	return nil
}

// ---------- 网页接口 ----------

// getAIConfig 返回全局 AI 设置和名称规则；不返回密钥本身，只返回是否已设置。
func (a *App) getAIConfig(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg, rules := a.state.AI, a.state.AIRules
	if rules == nil {
		rules = []AIRule{}
	}
	c.JSON(200, gin.H{"url": cfg.URL, "model": cfg.Model, "prompt": cfg.Prompt, "vision": cfg.Vision, "key_set": cfg.Key != "", "rules": rules})
}

// setAIConfig 校验并保存全局 AI 设置和名称规则；密钥留空表示保留原密钥。
func (a *App) setAIConfig(c *gin.Context) {
	var body struct {
		AIConfig
		Rules []AIRule `json:"rules"`
	}
	if !bind(c, &body) {
		return
	}
	cfg := body.AIConfig
	err := normalizeModel(&cfg)
	if err == nil {
		err = validateAIRules(body.Rules)
	}
	if err != nil {
		fail(c, 400, err.Error())
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if cfg.Key == "" {
		cfg.Key = a.state.AI.Key
	}
	oldConfig, oldRules := a.state.AI, a.state.AIRules
	a.state.AI, a.state.AIRules = cfg, body.Rules
	if err := a.commitLocked(); err != nil {
		a.state.AI, a.state.AIRules = oldConfig, oldRules
		fail(c, 500, "保存失败")
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// getAccountAI 返回微信号的覆盖设置和实际生效的设置（都不含密钥）。
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
	cfg.Model.Key, effective.Key = "", ""
	if cfg.Rules == nil {
		cfg.Rules = []AIRule{}
	}
	c.JSON(200, gin.H{"config": cfg, "effective": effective, "key_set": keySet})
}

// setAccountAI 校验并保存微信号的覆盖设置；密钥留空表示保留原密钥。
func (a *App) setAccountAI(c *gin.Context) {
	var body AccountAIConfig
	if !bind(c, &body) {
		return
	}
	err := validateAIRules(body.Rules)
	if err == nil && !body.InheritModel {
		err = normalizeModel(&body.Model)
	}
	if err != nil {
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

// setConversationAI 设置单个会话的回复方式；mode 为 inherit 时改回跟随名称规则。
func (a *App) setConversationAI(c *gin.Context) {
	var setting AISetting
	if !bind(c, &setting) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	conv := a.conversation(c)
	if conv == nil {
		return
	}
	if setting.Mode == "inherit" {
		setting = AISetting{}
	} else if err := setting.validate(conv.Kind); err != nil {
		fail(c, 400, err.Error())
		return
	}
	conv.AI = setting
	a.saved(c, conv.AI)
}
