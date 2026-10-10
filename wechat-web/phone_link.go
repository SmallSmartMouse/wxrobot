package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/gin-gonic/gin"
)

type linkMessage struct {
	Type           string          `json:"type"`
	ID             string          `json:"id,omitempty"`
	DeviceID       string          `json:"device_id,omitempty"`
	Name           string          `json:"name,omitempty"`
	DiscoveryNonce string          `json:"discovery_nonce,omitempty"`
	Commit         string          `json:"commit,omitempty"`
	Secret         string          `json:"secret,omitempty"`
	Proof          string          `json:"proof,omitempty"`
	Port           int             `json:"api_port,omitempty"`
	Approved       bool            `json:"approved,omitempty"`
	Status         int             `json:"status,omitempty"`
	Body           json.RawMessage `json:"body,omitempty"`
}

type phoneLink struct {
	ws      *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	pending map[string]chan linkMessage
}

type phonePairing struct {
	ID, DeviceID, Name, URL, Code string
	Expires                       time.Time
	WebApproved, PhoneApproved    bool
	Attempts                      int
	Changed                       chan struct{}
	Cancel                        context.CancelFunc
}

// 长期证书固定电脑身份；手机授权后固定此指纹，IP 变化不改变身份。
func loadPhoneCertificate(dir string) (tls.Certificate, string, error) {
	path := filepath.Join(dir, "phone-link.pem")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if e != nil {
			return tls.Certificate{}, "", e
		}
		serial, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
		if e != nil {
			return tls.Certificate{}, "", e
		}
		template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "WeChat phone link"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(20, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
		der, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
		if e != nil {
			return tls.Certificate{}, "", e
		}
		private, e := x509.MarshalPKCS8PrivateKey(key)
		if e != nil {
			return tls.Certificate{}, "", e
		}
		b = append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})...)
		if e = os.WriteFile(path, b, 0600); e != nil {
			return tls.Certificate{}, "", e
		}
	} else if err != nil {
		return tls.Certificate{}, "", err
	}
	cert, err := tls.X509KeyPair(b, b)
	if err != nil {
		return cert, "", err
	}
	digest := sha256.Sum256(cert.Certificate[0])
	return cert, hex.EncodeToString(digest[:]), nil
}

func (a *App) startPhoneListener(ctx context.Context, address string) error {
	cert, fingerprint, err := loadPhoneCertificate(filepath.Dir(a.path))
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		return fmt.Errorf("手机接入端口不可用：%w", err)
	}
	a.linkFingerprint = fingerprint
	a.linkPort = listener.Addr().(*net.TCPAddr).Port
	mux := http.NewServeMux()
	mux.HandleFunc("/link", a.acceptPhoneLink)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}}
	go func() {
		<-ctx.Done()
		server.Close()
		a.mu.Lock()
		for _, l := range a.links {
			l.cancel()
		}
		for _, p := range a.pairings {
			p.Cancel()
		}
		a.mu.Unlock()
	}()
	go func() { _ = server.Serve(tls.NewListener(listener, server.TLSConfig)) }()
	return nil
}

func linkProof(token, server, session, nonce, device string) string {
	mac := hmac.New(sha256.New, []byte(token))
	fmt.Fprintf(mac, "wxrobot-auth-v2\n%s\n%s\n%s\n%s", server, session, nonce, device)
	return hex.EncodeToString(mac.Sum(nil))
}

// 手机先承诺随机秘密，电脑再提供新的随机挑战，最后揭示秘密。
// 验证码绑定此连接的证书身份和完整会话；代码本身不在网络上发送。
func pairingCode(server, session, device, secret, nonce string) string {
	digest := sha256.Sum256([]byte(strings.Join([]string{"wxrobot-pair-v2", server, session, device, secret, nonce}, "\n")))
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(digest[:4])%1000000)
}

func (l *phoneLink) send(value any) error {
	ctx, cancel := context.WithTimeout(l.ctx, 15*time.Second)
	defer cancel()
	return wsjson.Write(ctx, l.ws, value)
}

// linkSession 是一次手机接入：连接本身、手机发来的消息，以及握手过程中确定的信息。
type linkSession struct {
	*phoneLink
	incoming       chan linkMessage
	hello          linkMessage
	address        string // 手机 HTTP 接口地址：连接来源 IP + hello 里的端口
	server         string // 电脑证书指纹
	session, nonce string // 电脑下发的挑战
}

// read 等手机的下一条消息；超时或连接断开返回 false。
func (s *linkSession) read(timeout time.Duration) (linkMessage, bool) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case m := <-s.incoming:
		return m, true
	case <-s.ctx.Done():
	case <-timer.C:
	}
	return linkMessage{}, false
}

// proofMatches 手机用 token 对这次挑战的签名是否正确。
func (s *linkSession) proofMatches(token, proof string) bool {
	return subtle.ConstantTimeCompare([]byte(proof), []byte(linkProof(token, s.server, s.session, s.nonce, s.hello.DeviceID))) == 1
}

// validHello 检查手机的第一条消息：设备编号、名称和接口端口。
func validHello(m linkMessage) bool {
	return m.Type == "hello" && m.DeviceID != "" && len(m.DeviceID) <= 128 && !strings.ContainsAny(m.DeviceID, "\r\n") &&
		len(m.Name) <= 128 && m.Port >= 1 && m.Port <= 65535
}

// acceptPhoneLink 接受手机主动建立的 WSS 连接：限流、握手（已授权的认证，新手机配对），然后转发任务请求。
func (a *App) acceptPhoneLink(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" || r.Header.Get("Origin") != "" {
		http.Error(w, "phone client required", 403)
		return
	}
	select {
	case a.linkSlots <- struct{}{}:
		defer func() { <-a.linkSlots }()
	default:
		http.Error(w, "busy", 429)
		return
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return
	}
	if !a.admitLinkAttempt(ip) {
		http.Error(w, "retry later", 429)
		return
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(16 << 20)
	s := a.startLinkSession(ws, ip)
	defer s.cancel()
	if phoneID, ok := a.handshakeLink(s); ok {
		a.serveLink(s, phoneID)
	}
}

// admitLinkAttempt 限制连接数量和频率：同一来源每秒最多一次，进行中的连接和配对合计最多 32 个。
func (a *App) admitLinkAttempt(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.links)+len(a.pairings) >= 32 || time.Since(a.linkAttempts[ip]) < time.Second {
		return false
	}
	a.linkAttempts[ip] = time.Now()
	for peer, t := range a.linkAttempts {
		if time.Since(t) > 5*time.Minute {
			delete(a.linkAttempts, peer)
		}
	}
	return true
}

// startLinkSession 开始读取手机消息；连接断开或服务退出时取消会话并关闭连接。
func (a *App) startLinkSession(ws *websocket.Conn, ip string) *linkSession {
	ctx, cancel := context.WithCancel(a.ctx)
	context.AfterFunc(ctx, func() { ws.CloseNow() })
	s := &linkSession{
		phoneLink: &phoneLink{ws: ws, ctx: ctx, cancel: cancel, pending: map[string]chan linkMessage{}},
		incoming:  make(chan linkMessage, 4),
		server:    a.linkFingerprint,
		address:   ip, // 收到 hello 后补上端口
	}
	go func() {
		defer cancel()
		for {
			var m linkMessage
			if wsjson.Read(ctx, ws, &m) != nil {
				return
			}
			select {
			case s.incoming <- m:
			case <-ctx.Done():
				return
			}
		}
	}()
	return s
}

// handshakeLink 完成握手，返回手机编号。已授权的手机用凭证认证，重连不需要发现口令（关闭自动搜索、服务重启后也能连回来）；
// 新配对必须由近期的发现请求引来，局域网里的其他设备不能凭空发起配对。
func (a *App) handshakeLink(s *linkSession) (string, bool) {
	hello, ok := s.read(10 * time.Second)
	if !ok || !validHello(hello) {
		return "", false
	}
	s.hello = hello
	s.address = "http://" + net.JoinHostPort(s.address, strconv.Itoa(hello.Port))
	a.mu.Lock()
	validNonce := time.Now().Before(a.discoveryNonces[hello.DiscoveryNonce])
	var known *PhoneConfig
	for _, p := range a.state.Phones {
		if p.DeviceID == hello.DeviceID && p.Transport == "reverse" {
			cp := *p
			known = &cp
			break
		}
	}
	a.mu.Unlock()
	if known == nil && !validNonce {
		return "", false
	}
	s.session, s.nonce = randomID(), randomID()+randomID()
	if s.send(gin.H{"type": "challenge", "session_id": s.session, "nonce": s.nonce, "server_id": s.server}) != nil {
		return "", false
	}
	response, ok := s.read(15 * time.Second)
	switch {
	case !ok:
		return "", false
	case response.Type == "auth":
		if known == nil || !s.proofMatches(known.Token, response.Proof) {
			_ = s.send(gin.H{"type": "revoked", "message": "此电脑上的授权已失效，请重新配对"})
			return "", false
		}
		return known.ID, true
	case response.Type == "reveal" && validNonce:
		return a.pairLink(s, response.Secret)
	}
	return "", false
}

// pairLink 新手机配对：核对手机先承诺的秘密，显示验证码，等网页验证和手机允许都完成后保存授权，
// 再等手机用新凭证认证。返回新的（或沿用的）手机编号。
func (a *App) pairLink(s *linkSession, secret string) (string, bool) {
	secretBytes, err := hex.DecodeString(secret)
	digest := sha256.Sum256([]byte(secret))
	if err != nil || len(secretBytes) != 32 || subtle.ConstantTimeCompare([]byte(s.hello.Commit), []byte(hex.EncodeToString(digest[:]))) != 1 {
		return "", false
	}
	p := &phonePairing{
		ID: s.session, DeviceID: s.hello.DeviceID, Name: s.hello.Name, URL: s.address,
		Code:    pairingCode(s.server, s.session, s.hello.DeviceID, secret, s.nonce),
		Expires: time.Now().Add(3 * time.Minute), Changed: make(chan struct{}, 1), Cancel: s.cancel,
	}
	if !a.addPairing(p) {
		return "", false
	}
	defer func() { a.mu.Lock(); delete(a.pairings, p.ID); a.notifyLocked(); a.mu.Unlock() }()
	if s.send(gin.H{"type": "pairing", "expires_in": 180}) != nil {
		return "", false
	}
	timer := time.NewTimer(time.Until(p.Expires))
	defer timer.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return "", false
		case <-timer.C:
			_ = s.send(gin.H{"type": "expired"})
			return "", false
		case m := <-s.incoming:
			if m.Type != "approve" || !m.Approved {
				return "", false
			}
			a.mu.Lock()
			p.PhoneApproved = true
			a.notifyLocked()
			a.mu.Unlock()
		case <-p.Changed:
		}
		a.mu.Lock()
		if !p.WebApproved || !p.PhoneApproved {
			a.mu.Unlock()
			continue
		}
		cfg, err := a.authorizePairingLocked(p)
		a.mu.Unlock()
		if err != nil {
			_ = s.send(gin.H{"type": "error", "message": err.Error()})
			return "", false
		}
		if s.send(gin.H{"type": "paired", "token": cfg.Token}) != nil {
			return "", false
		}
		ack, ok := s.read(15 * time.Second)
		if !ok || ack.Type != "auth" || !s.proofMatches(cfg.Token, ack.Proof) {
			return "", false
		}
		return cfg.ID, true
	}
}

// addPairing 登记待确认的配对，网页上显示验证码输入框。同一设备同时只能有一个配对，最多 8 个。
func (a *App) addPairing(p *phonePairing) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, other := range a.pairings {
		if other.DeviceID == p.DeviceID {
			return false
		}
	}
	if len(a.pairings) >= 8 {
		return false
	}
	a.pairings[p.ID] = p
	a.notifyLocked()
	return true
}

// authorizePairingLocked 两边都确认后保存授权：沿用已有的手机记录或新建一条，生成新凭证。返回保存后的配置副本。
func (a *App) authorizePairingLocked(p *phonePairing) (PhoneConfig, error) {
	cfg := a.findPairingPhoneLocked(p)
	if cfg != nil && a.phoneBusyLocked(cfg.ID) {
		return PhoneConfig{}, errors.New("手机仍有进行中的任务，请稍后配对")
	}
	created := cfg == nil
	if created {
		cfg = &PhoneConfig{ID: randomID()[:12]}
		a.state.Phones = append(a.state.Phones, cfg)
	}
	old := *cfg
	cfg.DeviceID, cfg.URL, cfg.Transport, cfg.Token = p.DeviceID, p.URL, "reverse", randomID()+randomID()
	if a.commitLocked() != nil {
		*cfg = old
		if created {
			a.state.Phones = a.state.Phones[:len(a.state.Phones)-1]
		}
		return PhoneConfig{}, errors.New("授权保存失败，请重新配对")
	}
	a.syncPhonesLocked()
	return *cfg, nil
}

// serveLink 认证之后：更新手机地址，把这条连接作为手机的任务通道（替换旧连接），转发手机的响应直到断开。
func (a *App) serveLink(s *linkSession, phoneID string) {
	a.mu.Lock()
	cfg := a.phoneLocked(phoneID)
	if cfg == nil {
		a.mu.Unlock()
		return
	}
	cfg.URL = s.address
	if a.commitLocked() != nil {
		a.mu.Unlock()
		return
	}
	old := a.links[phoneID]
	a.links[phoneID] = s.phoneLink
	a.phones[phoneID].connection = "连接中"
	a.phones[phoneID].err = ""
	a.notifyLocked()
	a.mu.Unlock()
	if old != nil {
		old.cancel()
	}
	defer func() {
		a.mu.Lock()
		if a.links[phoneID] == s.phoneLink {
			delete(a.links, phoneID)
			if rt := a.phones[phoneID]; rt != nil {
				rt.connection = "等待手机重连"
			}
			a.notifyLocked()
		}
		a.mu.Unlock()
	}()
	if s.send(gin.H{"type": "ready"}) != nil {
		return
	}
	for {
		select {
		case <-s.ctx.Done():
			return
		case m := <-s.incoming:
			if m.Type == "response" {
				s.deliver(m)
			}
		}
	}
}

// deliver 把手机的响应交给等待它的请求（reverseRequest）；请求已超时放弃时丢弃。
func (l *phoneLink) deliver(m linkMessage) {
	l.mu.Lock()
	ch := l.pending[m.ID]
	l.mu.Unlock()
	if ch != nil {
		select {
		case ch <- m:
		default:
		}
	}
}

// findPairingPhoneLocked 找配对设备已有的手机记录：设备编号相同；或地址相同且那条记录还没有设备编号
// （手动添加的同一台手机升级为主动连接）。地址相同但设备编号不同的是另一台手机（例如 IP 被重新分配），
// 不能沿用它的账号和事件游标，返回 nil 新建记录。
func (a *App) findPairingPhoneLocked(p *phonePairing) *PhoneConfig {
	for _, cfg := range a.state.Phones {
		if cfg.DeviceID == p.DeviceID {
			return cfg
		}
	}
	for _, cfg := range a.state.Phones {
		if cfg.URL == p.URL && cfg.DeviceID == "" {
			return cfg
		}
	}
	return nil
}

func (a *App) pairingViewsLocked() []gin.H {
	result := []gin.H{}
	for _, p := range a.pairings {
		if time.Now().Before(p.Expires) {
			result = append(result, gin.H{"id": p.ID, "device_id": p.DeviceID, "name": p.Name, "phone_url": p.URL, "expires_at": stamp(p.Expires), "web_confirmed": p.WebApproved, "phone_confirmed": p.PhoneApproved, "attempts_left": 5 - p.Attempts})
		}
	}
	return result
}

func (a *App) verifyPhonePairing(c *gin.Context) {
	var body struct {
		Code string `json:"code"`
	}
	if !bind(c, &body) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	p := a.pairings[c.Param("id")]
	if p == nil || time.Now().After(p.Expires) {
		fail(c, 409, "配对已过期，请在手机重新发起连接")
		return
	}
	if p.Attempts >= 5 {
		fail(c, 429, "验证码错误次数过多，请重新配对")
		return
	}
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(body.Code)), []byte(p.Code)) != 1 {
		p.Attempts++
		if p.Attempts >= 5 {
			p.Cancel()
		}
		a.notifyLocked()
		fail(c, 400, fmt.Sprintf("验证码不正确，还可尝试 %d 次", 5-p.Attempts))
		return
	}
	p.WebApproved = true
	wake(p.Changed)
	a.notifyLocked()
	c.JSON(200, gin.H{"ok": true, "phone_confirmed": p.PhoneApproved})
}

func (a *App) cancelPhonePairing(c *gin.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p := a.pairings[c.Param("id")]; p != nil {
		p.Cancel()
		delete(a.pairings, p.ID)
		a.notifyLocked()
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) reverseRequest(ctx context.Context, cfg PhoneConfig, method, path string, body any, key string) (linkMessage, error) {
	a.mu.Lock()
	l := a.links[cfg.ID]
	a.mu.Unlock()
	if l == nil {
		return linkMessage{}, errors.New("等待手机主动连接")
	}
	ctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	id := randomID()
	ch := make(chan linkMessage, 1)
	l.mu.Lock()
	if len(l.pending) >= 32 {
		l.mu.Unlock()
		return linkMessage{}, errors.New("手机请求过多，请稍后重试")
	}
	l.pending[id] = ch
	l.mu.Unlock()
	defer func() { l.mu.Lock(); delete(l.pending, id); l.mu.Unlock() }()
	if err := l.send(gin.H{"type": "request", "id": id, "method": method, "path": path, "body": body, "key": key}); err != nil {
		return linkMessage{}, errors.New("手机连接已中断")
	}
	select {
	case <-ctx.Done():
		return linkMessage{}, ctx.Err()
	case <-l.ctx.Done():
		return linkMessage{}, errors.New("手机连接已中断")
	case result := <-ch:
		if result.Status < 200 || result.Status >= 300 {
			var fault struct {
				Error struct{ Message string } `json:"error"`
			}
			_ = json.Unmarshal(result.Body, &fault)
			if fault.Error.Message == "" {
				fault.Error.Message = "手机请求失败"
			}
			return result, &phoneError{result.Status, fault.Error.Message}
		}
		return result, nil
	}
}

func (a *App) reverseDownload(ctx context.Context, cfg PhoneConfig, path string) ([]byte, error) {
	var data []byte
	for offset := 0; ; {
		m, err := a.reverseRequest(ctx, cfg, "GET", fmt.Sprintf("%s?offset=%d", path, offset), nil, "")
		if err != nil {
			return nil, err
		}
		var part struct {
			Data string `json:"data"`
			Size int    `json:"size"`
		}
		if json.Unmarshal(m.Body, &part) != nil || part.Size < 0 || part.Size > 40<<20 {
			return nil, errors.New("原图大小无效")
		}
		chunk, err := base64.StdEncoding.DecodeString(part.Data)
		if err != nil || len(chunk) > 256<<10 || offset+len(chunk) > part.Size {
			return nil, errors.New("原图分块无效")
		}
		data = append(data, chunk...)
		offset += len(chunk)
		if offset == part.Size {
			_, _ = a.reverseRequest(ctx, cfg, "GET", path+"?done=1", nil, "")
			return data, nil
		}
		if len(chunk) == 0 {
			return nil, errors.New("原图传输中断")
		}
	}
}
