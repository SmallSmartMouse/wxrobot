package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const maxDiscoveryAddresses = 4096

type DiscoverySettings struct {
	Enabled         bool     `json:"enabled"`
	LocalBroadcast  bool     `json:"local_broadcast"`
	Networks        []string `json:"networks"`
	IntervalSeconds int      `json:"interval_seconds"`
}

type discoveryProgress struct {
	Searching bool   `json:"searching"`
	Sent      int    `json:"sent"`
	Total     int    `json:"total"`
	LastScan  string `json:"last_scan"`
}

func defaultDiscoverySettings() DiscoverySettings {
	return DiscoverySettings{Enabled: true, LocalBroadcast: true, Networks: []string{}, IntervalSeconds: 30}
}

// 限制在私有 IPv4 地址；先核算上限，再展开地址，避免超大网段分配内存。
func validateDiscoverySettings(s DiscoverySettings) (DiscoverySettings, []netip.Prefix, int, error) {
	if s.IntervalSeconds < 10 || s.IntervalSeconds > 300 {
		return s, nil, 0, errors.New("搜索间隔请设置为 10～300 秒")
	}
	if len(s.Networks) > 8 {
		return s, nil, 0, errors.New("最多添加 8 个网段")
	}
	var prefixes []netip.Prefix
	count := 0
	canonical := []string{}
	for _, raw := range s.Networks {
		p, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil || !p.Addr().Is4() {
			return s, nil, 0, fmt.Errorf("%q 不是有效的 IPv4 网段，例如 192.168.1.0/24", raw)
		}
		p = p.Masked()
		if p.Bits() < 22 {
			return s, nil, 0, fmt.Errorf("%s 范围过大：每个网段最多 1,024 个地址（/22 或更小范围）", raw)
		}
		size := 1 << (32 - p.Bits())
		last := p.Addr()
		for i := 1; i < size; i++ {
			last = last.Next()
		}
		if !p.Addr().IsPrivate() || !last.IsPrivate() {
			return s, nil, 0, errors.New("搜索范围只支持局域网私有地址（10.x、172.16～31.x、192.168.x）")
		}
		for _, old := range prefixes {
			if old.Overlaps(p) {
				return s, nil, 0, fmt.Errorf("%s 与 %s 重复或重叠", p, old)
			}
		}
		count += size
		if count > maxDiscoveryAddresses {
			return s, nil, 0, errors.New("所有网段合计最多 4,096 个地址，请缩小搜索范围")
		}
		prefixes = append(prefixes, p)
		canonical = append(canonical, p.String())
	}
	if s.Enabled && !s.LocalBroadcast && len(prefixes) == 0 {
		return s, nil, 0, errors.New("请开启本地广播，或至少添加一个搜索网段")
	}
	s.Networks = canonical
	return s, prefixes, count, nil
}

func configuredDiscoveryTargets(s DiscoverySettings, port int) ([]*net.UDPAddr, error) {
	_, prefixes, _, err := validateDiscoverySettings(s)
	if err != nil {
		return nil, err
	}
	var targets []*net.UDPAddr
	if s.LocalBroadcast {
		targets, err = discoveryTargets(port)
	}
	for _, p := range prefixes {
		for ip := p.Addr(); p.Contains(ip); ip = ip.Next() {
			// /31 和 /32 的地址均可用；其余跳过网络地址与定向广播地址。
			if p.Bits() < 31 && (ip == p.Addr() || !p.Contains(ip.Next())) {
				continue
			}
			targets = append(targets, &net.UDPAddr{IP: net.IP(ip.AsSlice()), Port: port})
		}
	}
	if len(targets) == 0 {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("没有可用的搜索目标")
	}
	return targets, nil
}

func (a *App) discoverySettingsViewLocked() gin.H {
	_, _, count, _ := validateDiscoverySettings(a.state.Discovery)
	return gin.H{"config": a.state.Discovery, "address_count": count, "max_addresses": 4096, "max_per_network": 1024, "max_networks": 8,
		"progress": a.discoveryProgress, "link_port": a.linkPort, "link_error": a.linkError}
}

func (a *App) getDiscoverySettings(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	c.JSON(200, a.discoverySettingsViewLocked())
}

func (a *App) setDiscoverySettings(c *gin.Context) {
	var settings DiscoverySettings
	if !bind(c, &settings) {
		return
	}
	settings, _, count, err := validateDiscoverySettings(settings)
	if err != nil {
		fail(c, 400, err.Error())
		return
	}
	if c.Query("preview") == "1" {
		c.JSON(200, gin.H{"config": settings, "address_count": count})
		return
	}
	a.mu.Lock()
	old := a.state.Discovery
	a.state.Discovery = settings
	if err = a.commitLocked(); err != nil {
		a.state.Discovery = old
		a.mu.Unlock()
		fail(c, 500, "保存搜索范围失败")
		return
	}
	a.mu.Unlock()
	wake(a.discoveryWake)
	c.JSON(200, gin.H{"ok": true, "config": settings, "address_count": count})
}

// 本地广播 + 显式网段的限速 UDP 单播，发完后等 window 收集回复。v2 请求让手机主动连接独立的 WSS 接入端口。
func (a *App) scanConfiguredPhones(ctx context.Context, targets []*net.UDPAddr, window time.Duration) ([]discoveredPhone, error) {
	conn, release, err := openDiscoverySocket(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	nonce := randomID()
	a.mu.Lock()
	fingerprint, port := a.linkFingerprint, a.linkPort
	a.mu.Unlock()
	packet, _ := json.Marshal(gin.H{"type": "wxrobot-discover-v2", "nonce": nonce, "server_id": fingerprint, "link_port": port})
	// 在首次发送之前记录挑战，只有近期发现请求引来的手机才进入配对队列。
	a.mu.Lock()
	a.discoveryNonces[nonce] = time.Now().Add(2 * time.Minute)
	for n, expiry := range a.discoveryNonces {
		if time.Now().After(expiry) {
			delete(a.discoveryNonces, n)
		}
	}
	a.mu.Unlock()
	if fingerprint == "" || port == 0 {
		packet, _ = json.Marshal(gin.H{"type": discoveryRequestType, "nonce": nonce})
	}
	sent := 0
	for i, target := range targets {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
		if _, err = conn.WriteToUDP(packet, target); err == nil {
			sent++
		}
		if i%32 == 31 {
			a.mu.Lock()
			a.discoveryProgress.Sent = sent
			a.notifyLocked()
			a.mu.Unlock()
			if !pause(ctx, 125*time.Millisecond) {
				return nil, ctx.Err()
			}
		}
	}
	a.mu.Lock()
	a.discoveryProgress.Sent = sent
	a.mu.Unlock()
	if sent == 0 {
		return nil, errors.New("未能发送发现请求，请检查网卡或防火墙")
	}
	return readDiscoveryReplies(ctx, conn, nonce, window)
}
