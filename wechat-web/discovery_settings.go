package main

// 搜索设置：是否定时搜索、搜索间隔、是否广播本地网络，以及跨网段单播的私有网段。

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	maxDiscoveryAddresses = 4096 // 所有网段合计的地址上限
	maxNetworkAddresses   = 1024 // 单个网段的地址上限（/22）
	maxDiscoveryNetworks  = 8
)

type DiscoverySettings struct {
	Enabled         bool     `json:"enabled"`
	LocalBroadcast  bool     `json:"local_broadcast"`
	Networks        []string `json:"networks"`
	IntervalSeconds int      `json:"interval_seconds"`
}

// discoveryProgress 一轮搜索的进度，网页上显示。
type discoveryProgress struct {
	Searching bool   `json:"searching"`
	Sent      int    `json:"sent"`
	Total     int    `json:"total"`
	LastScan  string `json:"last_scan"`
}

func defaultDiscoverySettings() DiscoverySettings {
	return DiscoverySettings{Enabled: true, LocalBroadcast: true, Networks: []string{}, IntervalSeconds: 30}
}

// discoveryEnabledLocked 服务配置开启了发现端口，且网页设置里开启了自动搜索。
func (a *App) discoveryEnabledLocked() bool { return a.discoveryPort != 0 && a.state.Discovery.Enabled }

// validateDiscoverySettings 校验并规范化搜索设置，返回规范化后的设置、网段和地址总数。
// 网段限制在私有 IPv4 地址；先核算上限，再展开地址，避免超大网段分配内存。
func validateDiscoverySettings(s DiscoverySettings) (DiscoverySettings, []netip.Prefix, int, error) {
	if s.IntervalSeconds < 10 || s.IntervalSeconds > 300 {
		return s, nil, 0, errors.New("搜索间隔请设置为 10～300 秒")
	}
	if len(s.Networks) > maxDiscoveryNetworks {
		return s, nil, 0, fmt.Errorf("最多添加 %d 个网段", maxDiscoveryNetworks)
	}
	var prefixes []netip.Prefix
	count := 0
	canonical := []string{}
	for _, raw := range s.Networks {
		p, err := parseNetwork(raw)
		if err != nil {
			return s, nil, 0, err
		}
		for _, old := range prefixes {
			if old.Overlaps(p) {
				return s, nil, 0, fmt.Errorf("%s 与 %s 重复或重叠", p, old)
			}
		}
		count += networkSize(p)
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

// parseNetwork 解析一个网段：IPv4、不超过 /22、首尾地址都是私有地址。
func parseNetwork(raw string) (netip.Prefix, error) {
	p, err := netip.ParsePrefix(strings.TrimSpace(raw))
	if err != nil || !p.Addr().Is4() {
		return p, fmt.Errorf("%q 不是有效的 IPv4 网段，例如 192.168.1.0/24", raw)
	}
	p = p.Masked()
	if networkSize(p) > maxNetworkAddresses {
		return p, fmt.Errorf("%s 范围过大：每个网段最多 1,024 个地址（/22 或更小范围）", raw)
	}
	last := p.Addr()
	for i := 1; i < networkSize(p); i++ {
		last = last.Next()
	}
	if !p.Addr().IsPrivate() || !last.IsPrivate() {
		return p, errors.New("搜索范围只支持局域网私有地址（10.x、172.16～31.x、192.168.x）")
	}
	return p, nil
}

// networkSize 网段包含的地址数。
func networkSize(p netip.Prefix) int { return 1 << (32 - p.Bits()) }

// configuredDiscoveryTargets 按设置算出发送目标：本地广播地址，加上各网段内的可用地址
// （/31 和 /32 的地址均可用；其余跳过网络地址与定向广播地址）。
func configuredDiscoveryTargets(s DiscoverySettings, port int) ([]*net.UDPAddr, error) {
	_, prefixes, _, err := validateDiscoverySettings(s)
	if err != nil {
		return nil, err
	}
	var targets []*net.UDPAddr
	if s.LocalBroadcast {
		targets, err = localBroadcastTargets(port)
	}
	for _, p := range prefixes {
		for ip := p.Addr(); p.Contains(ip); ip = ip.Next() {
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

// discoverySettingsViewLocked 网页上的搜索设置、上限、进度和接入端口状态。
func (a *App) discoverySettingsViewLocked() gin.H {
	_, _, count, _ := validateDiscoverySettings(a.state.Discovery)
	return gin.H{"config": a.state.Discovery, "address_count": count, "max_addresses": maxDiscoveryAddresses, "max_per_network": maxNetworkAddresses,
		"max_networks": maxDiscoveryNetworks, "progress": a.discoveryProgress, "link_port": a.linkPort, "link_error": a.linkError}
}

// previewDiscoverySettings 校验搜索设置并返回规范化结果，不保存（网页添加网段时先校验）。
func (a *App) previewDiscoverySettings(c *gin.Context) {
	var settings DiscoverySettings
	if !bind(c, &settings) {
		return
	}
	settings, _, count, err := validateDiscoverySettings(settings)
	if err != nil {
		fail(c, 400, err.Error())
		return
	}
	c.JSON(200, gin.H{"config": settings, "address_count": count})
}
