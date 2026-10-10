package main

// 局域网发现：定时向本地网络广播、向用户配置的网段单播 UDP 发现请求。
// 请求带电脑证书指纹、接入端口和随机挑战；手机收到后主动向电脑的接入端口建立加密连接（phone_link.go），
// 新手机配对时要带上近期的挑战。

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	defaultDiscoveryPort = 39000
	discoveryRequestType = "wxrobot-discover-v2"
	discoveryNonceTTL    = 2 * time.Minute // 发现请求的挑战有效期：手机须在这之内连过来才能配对
)

// discoveryLoop 按设置定时搜索；关闭自动搜索时只等网页点“搜索设备”唤醒。
func (a *App) discoveryLoop(ctx context.Context) {
	for ctx.Err() == nil {
		settings := a.discoverySettings()
		if settings.Enabled {
			a.searchPhones(ctx, settings)
		}
		timer := time.NewTimer(time.Duration(settings.IntervalSeconds) * time.Second)
		select {
		case <-ctx.Done():
		case <-a.discoveryWake:
		case <-timer.C:
		}
		timer.Stop()
	}
}

// discoverySettings 当前的搜索设置。
func (a *App) discoverySettings() DiscoverySettings {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state.Discovery
}

// searchPhones 搜索一轮：算出发送目标，限速发送发现请求，网页上显示进度和结果。
func (a *App) searchPhones(ctx context.Context, settings DiscoverySettings) {
	targets, err := configuredDiscoveryTargets(settings, a.discoveryPort)
	a.setDiscoveryProgress(func(p *discoveryProgress) {
		*p = discoveryProgress{Searching: true, Total: len(targets), LastScan: p.LastScan}
	})
	if err == nil {
		err = a.sendDiscovery(ctx, targets)
	}
	if ctx.Err() != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.discoveryError = ""
	if err != nil {
		a.discoveryError = err.Error()
	}
	a.discoveryProgress.Searching, a.discoveryProgress.LastScan = false, now()
	a.notifyLocked()
}

// sendDiscovery 向 targets 发送发现请求：每 32 个暂停 125 毫秒（约 256 包/秒），并更新进度。
func (a *App) sendDiscovery(ctx context.Context, targets []*net.UDPAddr) error {
	packet, err := a.discoveryPacket()
	if err != nil {
		return err
	}
	conn, release, err := openDiscoverySocket(ctx)
	if err != nil {
		return err
	}
	defer release()
	sent := 0
	for i, target := range targets {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
		if _, err = conn.WriteToUDP(packet, target); err == nil {
			sent++
		}
		if i%32 == 31 {
			a.setDiscoveryProgress(func(p *discoveryProgress) { p.Sent = sent })
			if !pause(ctx, 125*time.Millisecond) {
				return ctx.Err()
			}
		}
	}
	a.setDiscoveryProgress(func(p *discoveryProgress) { p.Sent = sent })
	if sent == 0 {
		return errors.New("未能发送发现请求，请检查网卡或防火墙")
	}
	return nil
}

// discoveryPacket 生成这一轮的发现请求，并在发送前登记挑战：只有近期发现请求引来的手机才能配对。
func (a *App) discoveryPacket() ([]byte, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.linkCert == "" || a.linkPort == 0 {
		return nil, errors.New("手机接入端口没有启动，无法搜索手机")
	}
	nonce := randomID()
	a.discoveryNonces[nonce] = time.Now().Add(discoveryNonceTTL)
	for n, expiry := range a.discoveryNonces {
		if time.Now().After(expiry) {
			delete(a.discoveryNonces, n)
		}
	}
	return json.Marshal(gin.H{"type": discoveryRequestType, "nonce": nonce, "server_id": a.linkCert, "link_port": a.linkPort})
}

// setDiscoveryProgress 修改搜索进度并通知网页。
func (a *App) setDiscoveryProgress(change func(*discoveryProgress)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	change(&a.discoveryProgress)
	a.notifyLocked()
}

// localBroadcastTargets 每张启用的 IPv4 网卡的定向广播地址，再加一个有限广播地址。
func localBroadcastTargets(port int) ([]*net.UDPAddr, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	targets := []*net.UDPAddr{}
	seen := map[string]bool{}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagBroadcast == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			if broadcast := broadcastAddress(address); broadcast != nil && !seen[broadcast.String()] {
				targets = append(targets, &net.UDPAddr{IP: broadcast, Port: port})
				seen[broadcast.String()] = true
			}
		}
	}
	if len(targets) == 0 {
		return nil, errors.New("没有可用的局域网网卡，请连接 Wi-Fi 或有线网络")
	}
	return append(targets, &net.UDPAddr{IP: net.IPv4bcast, Port: port}), nil
}

// broadcastAddress 网卡地址所在网段的定向广播地址；不是 IPv4、或网段太小（/31、/32）时返回 nil。
func broadcastAddress(address net.Addr) net.IP {
	ip, network, err := net.ParseCIDR(address.String())
	if err != nil || ip.To4() == nil {
		return nil
	}
	if ones, bits := network.Mask.Size(); bits != 32 || ones > 30 {
		return nil
	}
	broadcast := append(net.IP(nil), ip.To4()...)
	for i := range broadcast {
		broadcast[i] |= ^network.Mask[i]
	}
	return broadcast
}

// openDiscoverySocket 打开一个允许广播的临时 UDP 端口（多份网页服务可以同时搜索），ctx 取消时关闭。
// 调用方用完后调用 release。
func openDiscoverySocket(ctx context.Context) (conn *net.UDPConn, release func(), err error) {
	conn, err = net.ListenUDP("udp4", &net.UDPAddr{})
	if err != nil {
		return nil, nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	release = func() { stop(); _ = conn.Close() }
	raw, err := conn.SyscallConn()
	if err != nil {
		release()
		return nil, nil, err
	}
	var optionErr error
	if err = raw.Control(func(fd uintptr) {
		optionErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
	}); err == nil {
		err = optionErr
	}
	if err != nil {
		release()
		return nil, nil, err
	}
	return conn, release, nil
}

// discoverPhones 网页点“搜索设备”：立即开始一轮搜索。
func (a *App) discoverPhones(c *gin.Context) {
	a.mu.Lock()
	enabled := a.discoveryEnabledLocked()
	a.mu.Unlock()
	if !enabled {
		fail(c, 409, "自动发现已关闭")
		return
	}
	wake(a.discoveryWake)
	c.JSON(202, gin.H{"ok": true})
}
