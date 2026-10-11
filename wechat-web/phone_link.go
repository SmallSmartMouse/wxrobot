package main

// 手机主动连接：手机收到电脑的发现请求后，向电脑的接入端口建立 WSS 加密连接，电脑的任务请求都经这条连接发送。
//
//   - 已授权的手机：用配对时保存的凭证对电脑的随机挑战签名，验证通过即可使用，重连不需要发现请求。
//   - 新手机配对：必须由近期的发现请求引来。手机先承诺随机秘密，电脑再提供新的随机挑战，最后手机揭示秘密；
//     双方据此算出同一个 6 位验证码（绑定电脑证书和本次会话，不在网络上发送）。网页输入验证码、
//     手机点击允许，两边都确认后电脑保存新凭证并发给手机。

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
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/gin-gonic/gin"
)

const (
	pairingTTL          = 3 * time.Minute  // 验证码有效期：够人在手机和网页之间操作，又不让验证码长期有效
	maxPairingAttempts  = 5                // 网页最多尝试验证码的次数：6 位验证码，5 次猜中的概率可以忽略
	maxPairings         = 8                // 同时等待确认的配对上限
	maxLinkSessions     = 32               // 进行中的连接和配对合计上限，防止局域网里的设备占满服务
	maxPendingRequests  = 32               // 一条连接上同时等待响应的请求上限
	linkAttemptGap      = time.Second      // 同一来源两次连接的最短间隔
	linkAttemptMemory   = 5 * time.Minute  // 连接来源记录的保留时间
	maxLinkMessageBytes = 16 << 20         // 一条连接消息的上限：发送图片时最大
	helloTimeout        = 10 * time.Second // 连上后等手机第一条消息的上限
	replyTimeout        = 15 * time.Second // 握手中等手机回应（认证、确认凭证）的上限
	linkWriteTimeout    = 15 * time.Second // 写一条消息的上限
	maxDeviceIDLength   = 128              // 设备编号和名称的长度上限
	pairingSecretBytes  = 32               // 手机配对时承诺的随机秘密长度
	certValidYears      = 20               // 电脑证书的有效期：证书指纹就是电脑身份，不希望过期后要重新配对所有手机
	certSerialBits      = 128              // 证书序列号的随机位数
)

// linkMessage 是连接上收发的一条消息（握手、配对、请求的响应共用）。
type linkMessage struct {
	Type           string          `json:"type"`
	ID             string          `json:"id,omitempty"`
	DeviceID       string          `json:"device_id,omitempty"`
	Name           string          `json:"name,omitempty"`
	DiscoveryNonce string          `json:"discovery_nonce,omitempty"`
	Commit         string          `json:"commit,omitempty"`
	Secret         string          `json:"secret,omitempty"`
	Proof          string          `json:"proof,omitempty"`
	Approved       bool            `json:"approved,omitempty"`
	Status         int             `json:"status,omitempty"`
	Body           json.RawMessage `json:"body,omitempty"`
}

// phoneLink 是认证通过的手机连接，实现 phoneConn：请求带编号发出，手机的响应按编号交回等待的请求。
type phoneLink struct {
	ws      *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	pending map[string]chan linkMessage
}

// phonePairing 是一次等待确认的新手机配对。
type phonePairing struct {
	ID, DeviceID, Name, Address, Code string
	Expires                           time.Time
	WebApproved, PhoneApproved        bool
	Attempts                          int
	Changed                           chan struct{}
	Cancel                            context.CancelFunc
}

// ---------- 接入端口 ----------

// startPhoneListener 启动手机接入端口（TLS，只提供 /link）。服务退出时关闭端口，断开所有连接和配对。
func (a *App) startPhoneListener(ctx context.Context, address string) error {
	cert, fingerprint, err := loadPhoneCertificate(filepath.Dir(a.path))
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		return fmt.Errorf("手机接入端口不可用：%w", err)
	}
	a.linkCert = fingerprint
	a.linkPort = listener.Addr().(*net.TCPAddr).Port
	mux := http.NewServeMux()
	mux.HandleFunc("/link", a.acceptPhoneLink)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: readHeaderTimeout, TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}}
	go func() {
		<-ctx.Done()
		server.Close()
		a.closeAllLinks()
	}()
	go func() { _ = server.Serve(tls.NewListener(listener, server.TLSConfig)) }()
	return nil
}

// closeAllLinks 断开所有手机连接，取消所有配对。
func (a *App) closeAllLinks() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, l := range a.links {
		l.close()
	}
	for _, p := range a.pairings {
		p.Cancel()
	}
}

// loadPhoneCertificate 读取电脑的长期证书，没有就生成一张。手机授权后固定此指纹，IP 变化不改变电脑身份。
func loadPhoneCertificate(dir string) (tls.Certificate, string, error) {
	path := filepath.Join(dir, "phone-link.pem")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if b, err = newCertificatePEM(); err == nil {
			err = os.WriteFile(path, b, 0600)
		}
	}
	if err != nil {
		return tls.Certificate{}, "", err
	}
	cert, err := tls.X509KeyPair(b, b)
	if err != nil {
		return cert, "", err
	}
	digest := sha256.Sum256(cert.Certificate[0])
	return cert, hex.EncodeToString(digest[:]), nil
}

// newCertificatePEM 生成长期有效的自签证书（P-256），返回证书和私钥的 PEM。
func newCertificatePEM() ([]byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), certSerialBits))
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "WeChat phone link"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().AddDate(certValidYears, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})...), nil
}

// acceptPhoneLink 接受手机主动建立的 WSS 连接：限流、握手（已授权的认证，新手机配对），然后作为手机的请求通道。
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
	ws.SetReadLimit(maxLinkMessageBytes)
	s := a.startLinkSession(ws, ip)
	defer s.cancel()
	if phoneID, ok := a.handshakeLink(s); ok {
		a.serveLink(s, phoneID)
	}
}

// admitLinkAttempt 限制连接数量和频率：同一来源的间隔、进行中的连接和配对合计数量。
func (a *App) admitLinkAttempt(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.links)+len(a.pairings) >= maxLinkSessions || time.Since(a.linkAttempts[ip]) < linkAttemptGap {
		return false
	}
	a.linkAttempts[ip] = time.Now()
	for peer, t := range a.linkAttempts {
		if time.Since(t) > linkAttemptMemory {
			delete(a.linkAttempts, peer)
		}
	}
	return true
}

// ---------- 握手 ----------

// linkSession 是一次手机接入：连接本身、手机发来的消息，以及握手过程中确定的信息。
type linkSession struct {
	*phoneLink
	incoming       chan linkMessage
	hello          linkMessage
	address        string // 手机的 IP
	server         string // 电脑证书指纹
	session, nonce string // 电脑下发的挑战
}

// startLinkSession 开始读取手机消息；连接断开或服务退出时取消会话并关闭连接。
func (a *App) startLinkSession(ws *websocket.Conn, ip string) *linkSession {
	ctx, cancel := context.WithCancel(a.ctx)
	context.AfterFunc(ctx, func() { ws.CloseNow() })
	s := &linkSession{
		phoneLink: &phoneLink{ws: ws, ctx: ctx, cancel: cancel, pending: map[string]chan linkMessage{}},
		incoming:  make(chan linkMessage, 4), // 握手期间消息很少，留一点余量即可
		server:    a.linkCert,
		address:   ip,
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
	hello, ok := s.read(helloTimeout)
	if !ok || !validHello(hello) {
		return "", false
	}
	s.hello = hello
	known, invited := a.linkCandidate(hello)
	if known == nil && !invited {
		return "", false
	}
	s.session, s.nonce = randomID(), randomID()+randomID()
	if s.send(gin.H{"type": "challenge", "session_id": s.session, "nonce": s.nonce, "server_id": s.server}) != nil {
		return "", false
	}
	response, ok := s.read(replyTimeout)
	switch {
	case !ok:
		return "", false
	case response.Type == "auth":
		if known == nil || !s.proofMatches(known.Token, response.Proof) {
			_ = s.send(gin.H{"type": "revoked", "message": "此电脑上的授权已失效，请重新配对"})
			return "", false
		}
		return known.ID, true
	case response.Type == "reveal" && invited:
		return a.pairLink(s, response.Secret)
	}
	return "", false
}

// linkCandidate 认出接入的手机：已授权的手机记录（副本），以及它是否由近期的发现请求引来。
func (a *App) linkCandidate(hello linkMessage) (*PhoneConfig, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	invited := time.Now().Before(a.discoveryNonces[hello.DiscoveryNonce])
	if p := a.phoneByDeviceLocked(hello.DeviceID); p != nil {
		known := *p
		return &known, invited
	}
	return nil, invited
}

// phoneByDeviceLocked 按设备编号找已授权的手机，没有返回 nil。
func (a *App) phoneByDeviceLocked(deviceID string) *PhoneConfig {
	for _, p := range a.state.Phones {
		if p.DeviceID == deviceID {
			return p
		}
	}
	return nil
}

// validHello 检查手机的第一条消息：设备编号和名称。
func validHello(m linkMessage) bool {
	return m.Type == "hello" && m.DeviceID != "" && len(m.DeviceID) <= maxDeviceIDLength && !strings.ContainsAny(m.DeviceID, "\r\n") && len(m.Name) <= maxDeviceIDLength
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

// linkProof 用凭证对挑战签名：电脑身份、会话、随机数和设备编号都在签名范围内，不能重放到别的会话。
func linkProof(token, server, session, nonce, device string) string {
	mac := hmac.New(sha256.New, []byte(token))
	fmt.Fprintf(mac, "wxrobot-auth-v2\n%s\n%s\n%s\n%s", server, session, nonce, device)
	return hex.EncodeToString(mac.Sum(nil))
}

// ---------- 配对 ----------

// pairLink 新手机配对：核对手机先承诺的秘密，显示验证码，等网页验证和手机允许都完成后保存授权，
// 再等手机用新凭证认证。返回新的（或沿用的）手机编号。
func (a *App) pairLink(s *linkSession, secret string) (string, bool) {
	if !s.revealMatchesCommit(secret) {
		return "", false
	}
	p := &phonePairing{
		ID: s.session, DeviceID: s.hello.DeviceID, Name: s.hello.Name, Address: s.address,
		Code:    pairingCode(s.server, s.session, s.hello.DeviceID, secret, s.nonce),
		Expires: time.Now().Add(pairingTTL), Changed: make(chan struct{}, 1), Cancel: s.cancel,
	}
	if !a.addPairing(p) {
		return "", false
	}
	defer a.removePairing(p)
	if s.send(gin.H{"type": "pairing", "expires_in": int(pairingTTL.Seconds())}) != nil || !a.awaitPairingApproval(s, p) {
		return "", false
	}
	cfg, err := a.authorizePairing(p)
	if err != nil {
		_ = s.send(gin.H{"type": "error", "message": err.Error()})
		return "", false
	}
	if s.send(gin.H{"type": "paired", "token": cfg.Token}) != nil {
		return "", false
	}
	ack, ok := s.read(replyTimeout)
	if !ok || ack.Type != "auth" || !s.proofMatches(cfg.Token, ack.Proof) {
		return "", false
	}
	return cfg.ID, true
}

// revealMatchesCommit 手机揭示的秘密长度正确，且和它在 hello 里的承诺（秘密的 SHA-256）一致。
func (s *linkSession) revealMatchesCommit(secret string) bool {
	secretBytes, err := hex.DecodeString(secret)
	digest := sha256.Sum256([]byte(secret))
	return err == nil && len(secretBytes) == pairingSecretBytes && subtle.ConstantTimeCompare([]byte(s.hello.Commit), []byte(hex.EncodeToString(digest[:]))) == 1
}

// pairingCode 双方各自算出的 6 位验证码：绑定电脑证书、会话、设备、手机秘密和电脑挑战。
func pairingCode(server, session, device, secret, nonce string) string {
	digest := sha256.Sum256([]byte(strings.Join([]string{"wxrobot-pair-v2", server, session, device, secret, nonce}, "\n")))
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(digest[:4])%1000000)
}

// awaitPairingApproval 等网页验证和手机允许都完成；手机拒绝、断开或验证码过期时返回 false。
func (a *App) awaitPairingApproval(s *linkSession, p *phonePairing) bool {
	timer := time.NewTimer(time.Until(p.Expires))
	defer timer.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return false
		case <-timer.C:
			_ = s.send(gin.H{"type": "expired"})
			return false
		case m := <-s.incoming:
			if m.Type != "approve" || !m.Approved {
				return false
			}
			a.approveOnPhone(p)
		case <-p.Changed:
		}
		if a.pairingApproved(p) {
			return true
		}
	}
}

// approveOnPhone 手机点了“允许这台电脑”，网页上显示已确认。
func (a *App) approveOnPhone(p *phonePairing) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p.PhoneApproved = true
	a.notifyLocked()
}

// pairingApproved 网页验证和手机允许是否都已完成。
func (a *App) pairingApproved(p *phonePairing) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return p.WebApproved && p.PhoneApproved
}

// addPairing 登记待确认的配对，网页上显示验证码输入框。同一设备同时只能有一个配对，总数有上限。
func (a *App) addPairing(p *phonePairing) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, other := range a.pairings {
		if other.DeviceID == p.DeviceID {
			return false
		}
	}
	if len(a.pairings) >= maxPairings {
		return false
	}
	a.pairings[p.ID] = p
	a.notifyLocked()
	return true
}

// removePairing 配对结束（成功或失败），网页上不再显示。
func (a *App) removePairing(p *phonePairing) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.pairings, p.ID)
	a.notifyLocked()
}

// authorizePairing 两边都确认后保存授权：同一设备沿用已有的手机记录（编号、账号和事件游标不变），否则新建；
// 生成新凭证。返回保存后的配置副本。
func (a *App) authorizePairing(p *phonePairing) (PhoneConfig, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg := a.phoneByDeviceLocked(p.DeviceID)
	if cfg != nil && a.phoneBusyLocked(cfg.ID) {
		return PhoneConfig{}, errors.New("手机仍有进行中的任务，请稍后配对")
	}
	created := cfg == nil
	if created {
		cfg = &PhoneConfig{ID: shortID()}
		a.state.Phones = append(a.state.Phones, cfg)
	}
	old := *cfg
	cfg.DeviceID, cfg.Address, cfg.Token = p.DeviceID, p.Address, randomID()+randomID()
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

// ---------- 认证后的连接 ----------

// serveLink 认证之后：记下手机地址，把这条连接作为手机的请求通道（替换旧连接），转交手机的响应直到断开。
func (a *App) serveLink(s *linkSession, phoneID string) {
	if !a.attachLink(s, phoneID) {
		return
	}
	defer a.detachLink(s.phoneLink, phoneID)
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

// attachLink 把认证通过的连接设为手机的请求通道，断开它之前的连接。手机已删除或保存失败时返回 false。
func (a *App) attachLink(s *linkSession, phoneID string) bool {
	old, ok := a.replaceLink(s, phoneID)
	if old != nil {
		old.close()
	}
	return ok
}

// replaceLink 记下手机的新地址，把连接设为手机的请求通道，返回被替换的旧连接。
func (a *App) replaceLink(s *linkSession, phoneID string) (phoneConn, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg := a.phoneLocked(phoneID)
	if cfg == nil {
		return nil, false
	}
	cfg.Address = s.address
	if a.commitLocked() != nil {
		return nil, false
	}
	old := a.links[phoneID]
	a.links[phoneID] = s.phoneLink
	a.phones[phoneID].connection, a.phones[phoneID].err = connConnecting, ""
	a.notifyLocked()
	return old, true
}

// detachLink 连接断开：仍是手机当前的连接时移除，等手机重连。
func (a *App) detachLink(l *phoneLink, phoneID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.links[phoneID] != phoneConn(l) {
		return
	}
	delete(a.links, phoneID)
	if rt := a.phones[phoneID]; rt != nil {
		rt.connection = connWaitingLink
	}
	a.notifyLocked()
}

// send 写一条消息，最多等 linkWriteTimeout。
func (l *phoneLink) send(value any) error {
	ctx, cancel := context.WithTimeout(l.ctx, linkWriteTimeout)
	defer cancel()
	return wsjson.Write(ctx, l.ws, value)
}

// call 发送一个请求并等待手机的响应。同时等待的请求数有上限。
func (l *phoneLink) call(ctx context.Context, req linkRequest) (linkMessage, error) {
	id := randomID()
	ch := make(chan linkMessage, 1)
	if !l.expect(id, ch) {
		return linkMessage{}, errors.New("手机请求过多，请稍后重试")
	}
	defer l.forget(id)
	if err := l.send(gin.H{"type": "request", "id": id, "method": req.Method, "path": req.Path, "body": req.Body, "key": req.Key}); err != nil {
		return linkMessage{}, errors.New("手机连接已中断")
	}
	select {
	case <-ctx.Done():
		return linkMessage{}, ctx.Err()
	case <-l.ctx.Done():
		return linkMessage{}, errors.New("手机连接已中断")
	case result := <-ch:
		return result, nil
	}
}

// close 断开连接。
func (l *phoneLink) close() { l.cancel() }

// expect 登记一个等待响应的请求；等待的请求已满时返回 false。
func (l *phoneLink) expect(id string, ch chan linkMessage) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.pending) >= maxPendingRequests {
		return false
	}
	l.pending[id] = ch
	return true
}

// forget 请求结束，不再等它的响应。
func (l *phoneLink) forget(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.pending, id)
}

// deliver 把手机的响应交给等待它的请求；请求已超时放弃时丢弃。
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

// ---------- 网页接口 ----------

// pairingViewsLocked 网页上待确认的配对（不含验证码）。
func (a *App) pairingViewsLocked() []gin.H {
	result := []gin.H{}
	for _, p := range a.pairings {
		if time.Now().Before(p.Expires) {
			result = append(result, gin.H{"id": p.ID, "device_id": p.DeviceID, "name": p.Name, "address": p.Address, "expires_at": stamp(p.Expires),
				"web_confirmed": p.WebApproved, "phone_confirmed": p.PhoneApproved, "attempts_left": maxPairingAttempts - p.Attempts})
		}
	}
	return result
}

// verifyPhonePairing 网页输入手机显示的验证码；错误次数用完时取消配对。
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
	if p.Attempts >= maxPairingAttempts {
		fail(c, 429, "验证码错误次数过多，请重新配对")
		return
	}
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(body.Code)), []byte(p.Code)) != 1 {
		p.Attempts++
		if p.Attempts >= maxPairingAttempts {
			p.Cancel()
		}
		a.notifyLocked()
		fail(c, 400, fmt.Sprintf("验证码不正确，还可尝试 %d 次", maxPairingAttempts-p.Attempts))
		return
	}
	p.WebApproved = true
	wake(p.Changed)
	a.notifyLocked()
	c.JSON(200, gin.H{"ok": true, "phone_confirmed": p.PhoneApproved})
}

// cancelPhonePairing 网页取消配对。
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
