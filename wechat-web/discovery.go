package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	defaultDiscoveryPort  = 39000
	discoveryRequestType  = "wxrobot-discover-v1"
	discoveryResponseType = "wxrobot-phone-v1"
	discoveryTTL          = 35 * time.Second
	discoveryReplyWindow  = 2 * time.Second // 发完请求后等待手机回复的时间
)

// 广播只携带随机挑战；手机回复签名，不把 Token 发到局域网。
type discoveryReply struct {
	Type      string `json:"type"`
	Nonce     string `json:"nonce"`
	DeviceID  string `json:"device_id"`
	IP        string `json:"ip"`
	Port      int    `json:"api_port"`
	Signature string `json:"signature"`
}

type discoveredPhone struct {
	discoveryReply
	URL  string
	Seen time.Time
}

// fresh 设备最近一次回复还在有效期内（手机关闭或换了地址后很快失效）。
func (d discoveredPhone) fresh() bool { return time.Since(d.Seen) < discoveryTTL }

// discoveryEnabledLocked 服务配置开启了发现端口，且网页设置里开启了自动搜索。
func (a *App) discoveryEnabledLocked() bool { return a.discoveryPort != 0 && a.state.Discovery.Enabled }

// verifiedDeviceLocked 返回 address 上刚发现、且用 token 验签通过的设备编号，没有返回空字符串。
// 手动添加的手机据此绑定设备编号；签名不匹配的广播不能取得信任。
func (a *App) verifiedDeviceLocked(address, token string) string {
	if d, ok := a.discovered[address]; ok && d.fresh() && d.matches(token) {
		return d.DeviceID
	}
	return ""
}

func (d discoveredPhone) matches(token string) bool {
	got, err := hex.DecodeString(d.Signature)
	if err != nil || len(got) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, []byte(token))
	fmt.Fprintf(mac, "%s\n%s\n%s\n%s\n%d", d.Type, d.Nonce, d.DeviceID, d.IP, d.Port)
	return hmac.Equal(got, mac.Sum(nil))
}

// 地址取自 UDP 来源并与签名中的 IP 一致，拒绝把凭证发给广播里指定的另一台机器。
func parseDiscoveryReply(data []byte, source *net.UDPAddr, nonce string) (discoveredPhone, bool) {
	var d discoveredPhone
	if json.Unmarshal(data, &d.discoveryReply) != nil || d.Type != discoveryResponseType || d.Nonce != nonce ||
		d.DeviceID == "" || len(d.DeviceID) > 128 || strings.ContainsAny(d.DeviceID, "\r\n") ||
		d.Port < 1 || d.Port > 65535 || source == nil || source.IP.To4() == nil ||
		source.IP.IsUnspecified() || source.IP.IsMulticast() || d.IP != source.IP.String() {
		return d, false
	}
	if signature, err := hex.DecodeString(d.Signature); err != nil || len(signature) != sha256.Size {
		return d, false
	}
	d.URL = "http://" + net.JoinHostPort(source.IP.String(), strconv.Itoa(d.Port))
	d.Seen = time.Now()
	return d, true
}

// 每张启用的 IPv4 网卡都发送定向广播，也发送一次有限广播。
func discoveryTargets(port int) ([]*net.UDPAddr, error) {
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
			ip, network, err := net.ParseCIDR(address.String())
			if err != nil || ip.To4() == nil {
				continue
			}
			ones, bits := network.Mask.Size()
			if bits != 32 || ones > 30 {
				continue
			}
			broadcast := append(net.IP(nil), ip.To4()...)
			for i := range broadcast {
				broadcast[i] |= ^network.Mask[i]
			}
			if !seen[broadcast.String()] {
				targets = append(targets, &net.UDPAddr{IP: broadcast, Port: port})
				seen[broadcast.String()] = true
			}
		}
	}
	if len(targets) == 0 {
		return nil, errors.New("没有可用的局域网网卡，请连接 Wi-Fi 或有线网络")
	}
	targets = append(targets, &net.UDPAddr{IP: net.IPv4bcast, Port: port})
	return targets, nil
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

// readDiscoveryReplies 在 window 内收集签名格式有效、回应这次 nonce 的手机回复（同一地址只留一条，最多 128 台）。
func readDiscoveryReplies(ctx context.Context, conn *net.UDPConn, nonce string, window time.Duration) ([]discoveredPhone, error) {
	_ = conn.SetReadDeadline(time.Now().Add(window))
	results := []discoveredPhone{}
	seen := map[string]bool{}
	buffer := make([]byte, 2048)
	for {
		n, source, err := conn.ReadFromUDP(buffer)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				return results, nil
			}
			return results, err
		}
		if d, ok := parseDiscoveryReply(buffer[:n], source, nonce); ok && !seen[d.URL] && len(results) < 128 {
			results = append(results, d)
			seen[d.URL] = true
		}
	}
}

func (a *App) discoveryLoop(ctx context.Context) {
	for ctx.Err() == nil {
		a.mu.Lock()
		settings := a.state.Discovery
		a.mu.Unlock()
		if settings.Enabled {
			targets, err := configuredDiscoveryTargets(settings, a.discoveryPort)
			a.mu.Lock()
			a.discoveryProgress.Searching = true
			a.discoveryProgress.Total = len(targets)
			a.discoveryProgress.Sent = 0
			a.notifyLocked()
			a.mu.Unlock()
			var found []discoveredPhone
			if err == nil {
				found, err = a.scanConfiguredPhones(ctx, targets, discoveryReplyWindow)
			}
			if ctx.Err() != nil {
				return
			}
			a.mu.Lock()
			a.discoveryError = ""
			if err != nil {
				a.discoveryError = err.Error()
			}
			a.discoveryProgress.Searching = false
			a.discoveryProgress.LastScan = now()
			for address, d := range a.discovered {
				if !d.fresh() {
					delete(a.discovered, address)
				}
			}
			for _, d := range found {
				if len(a.discovered) < 128 || a.discovered[d.URL].URL != "" {
					a.discovered[d.URL] = d
					a.reconnectDiscoveredLocked(d)
				}
			}
			a.notifyLocked()
			a.mu.Unlock()
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

// 只迁移同一台、签名有效的手机。保留编号、账号和事件游标，任务执行期间不切换地址。
func (a *App) reconnectDiscoveredLocked(d discoveredPhone) {
	var match *PhoneConfig
	for _, p := range a.state.Phones {
		if p.Transport != "reverse" && (p.DeviceID == "" || p.DeviceID == d.DeviceID) && d.matches(p.Token) {
			if match != nil { // 重复使用的 Token 无法唯一绑定旧连接
				return
			}
			match = p
		}
	}
	if match == nil || (match.DeviceID == d.DeviceID && match.URL == d.URL) {
		return
	}
	for _, p := range a.state.Phones {
		if p != match && p.URL == d.URL {
			return
		}
	}
	if match.URL != d.URL && a.phoneBusyLocked(match.ID) {
		return
	}
	match.DeviceID = d.DeviceID
	if match.URL != d.URL {
		match.URL = d.URL
		a.phones[match.ID].connection = "连接中"
	}
	_ = a.commitLocked()
}

func (a *App) discoveryViewsLocked() []gin.H {
	views := []gin.H{}
	for _, d := range a.discovered {
		if !d.fresh() {
			continue
		}
		phoneID := ""
		for _, p := range a.state.Phones {
			if p.DeviceID == d.DeviceID && d.matches(p.Token) {
				phoneID = p.ID
				break
			}
		}
		views = append(views, gin.H{"device_id": d.DeviceID, "phone_url": d.URL, "phone_id": phoneID})
	}
	sort.Slice(views, func(i, j int) bool { return views[i]["phone_url"].(string) < views[j]["phone_url"].(string) })
	return views
}

func (a *App) discoverPhones(c *gin.Context) {
	a.mu.Lock()
	enabled := a.discoveryEnabledLocked()
	a.mu.Unlock()
	if !enabled {
		fail(c, 409, "自动发现已在服务配置中关闭")
		return
	}
	wake(a.discoveryWake)
	c.JSON(202, gin.H{"ok": true})
}

// 首次连接只需输入 Token；地址来自刚收到的 UDP 回复，先验签再开启 HTTP 连接。
func (a *App) pairPhone(c *gin.Context) {
	var body struct {
		phoneBody
		DeviceID string `json:"device_id"`
	}
	if !bind(c, &body) {
		return
	}
	address, token, problem := validPhone(body.phoneBody, "")
	if problem != "" {
		fail(c, 400, problem)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	d, ok := a.discovered[address]
	if !ok || d.DeviceID != body.DeviceID || !d.fresh() {
		fail(c, 409, "设备已离线或地址已变化，请重新搜索")
		return
	}
	if !d.matches(token) {
		fail(c, 400, "Token 与这台手机不匹配，请检查手机配置")
		return
	}
	for _, p := range a.state.Phones {
		if p.URL == address || p.DeviceID == d.DeviceID {
			fail(c, 409, "这台手机已经添加过了")
			return
		}
	}
	p := &PhoneConfig{ID: randomID()[:12], URL: d.URL, Token: token, DeviceID: d.DeviceID}
	a.state.Phones = append(a.state.Phones, p)
	a.syncPhonesLocked()
	a.saved(c, gin.H{"id": p.ID})
}
