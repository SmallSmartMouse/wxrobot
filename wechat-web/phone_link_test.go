package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestDiscoveryRangeLimitsAndPersistence(t *testing.T) {
	s := defaultDiscoverySettings()
	s.Networks = []string{"172.25.145.68/24"}
	got, _, count, err := validateDiscoverySettings(s)
	if err != nil || count != 256 || got.Networks[0] != "172.25.145.0/24" {
		t.Fatalf("normalize: %+v %d %v", got, count, err)
	}
	for _, networks := range [][]string{{"10.0.0.0/21"}, {"0.0.0.0/0"}, {"8.8.8.0/24"}, {"127.0.0.1/32"}, {"172.25.144.0/22", "172.25.145.0/24"}, {"10.0.0.0/22", "10.0.4.0/22", "10.0.8.0/22", "10.0.12.0/22", "10.0.16.0/22"}} {
		s.Networks = networks
		if _, _, _, err := validateDiscoverySettings(s); err == nil {
			t.Fatalf("accepted invalid range %v", networks)
		}
	}
	s.LocalBroadcast = false
	s.Networks = []string{"192.168.1.0/30", "192.168.2.4/31", "192.168.3.8/32"}
	targets, err := configuredDiscoveryTargets(s, 39000)
	if err != nil || len(targets) != 5 {
		t.Fatalf("targets %v %v", targets, err)
	}
	a := testApp(t)
	body, _ := json.Marshal(s)
	if w := call(a, "POST", "/api/discovery?preview=1", string(body), ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if len(a.state.Discovery.Networks) != 0 {
		t.Fatal("preview changed saved settings")
	}
	if w := call(a, "POST", "/api/discovery", string(body), ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var saved string
	if err = a.store.db.QueryRow("SELECT data FROM settings WHERE id='discovery'").Scan(&saved); err != nil || !strings.Contains(saved, "192.168.3.8/32") {
		t.Fatalf("settings not persisted: %s %v", saved, err)
	}
	s.Networks = []string{"10.0.0.0/8"}
	bad, _ := json.Marshal(s)
	if w := call(a, "POST", "/api/discovery", string(bad), ""); w.Code != 400 {
		t.Fatal("oversize request accepted")
	}
	if len(a.state.Discovery.Networks) != 3 {
		t.Fatal("invalid save changed settings")
	}
}

type testLinkClient struct {
	ws                     *websocket.Conn
	ctx                    context.Context
	session, nonce, server string
}

func newTestLinkServer(t *testing.T) (*App, string, string) {
	t.Helper()
	a := testApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	a.ctx = ctx
	if err := a.startPhoneListener(ctx, "127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cancel)
	nonce := randomID()
	a.discoveryNonces[nonce] = time.Now().Add(time.Minute)
	return a, fmt.Sprintf("wss://127.0.0.1:%d/link", a.linkPort), nonce
}

func dialTestPhone(t *testing.T, a *App, address, discovery, secret string) *testLinkClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	t.Cleanup(cancel)
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}} // 测试自签证书；生产 Android 固定完整指纹。
	ws, _, err := websocket.Dial(ctx, address, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	c := &testLinkClient{ws: ws, ctx: ctx, server: a.linkFingerprint}
	digest := sha256.Sum256([]byte(secret))
	c.send(t, map[string]any{"type": "hello", "device_id": "test-phone", "name": "测试手机", "api_port": 8766, "discovery_nonce": discovery, "commit": hex.EncodeToString(digest[:])})
	m := c.read(t)
	if m["type"] != "challenge" {
		t.Fatal(m)
	}
	c.session = m["session_id"].(string)
	c.nonce = m["nonce"].(string)
	return c
}
func (c *testLinkClient) send(t *testing.T, v any) {
	t.Helper()
	if err := wsjson.Write(c.ctx, c.ws, v); err != nil {
		t.Fatal(err)
	}
}
func (c *testLinkClient) read(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := wsjson.Read(c.ctx, c.ws, &m); err != nil {
		t.Fatal(err)
	}
	return m
}
func waitLink(t *testing.T, a *App, check func() bool) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		a.mu.Lock()
		ok := check()
		a.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("link state did not arrive")
}

func TestPhonePairingRequiresBothSidesAndReconnects(t *testing.T) {
	a, address, nonce := newTestLinkServer(t)
	secret := strings.Repeat("ab", 32)
	c := dialTestPhone(t, a, address, nonce, secret)
	c.send(t, map[string]string{"type": "reveal", "secret": secret})
	if m := c.read(t); m["type"] != "pairing" {
		t.Fatal(m)
	}
	code := pairingCode(c.server, c.session, "test-phone", secret, c.nonce)
	if w := call(a, "POST", "/api/pairings/"+c.session+"/verify", `{"code":"wrong"}`, ""); w.Code != 400 {
		t.Fatal("wrong code accepted")
	}
	if w := call(a, "POST", "/api/pairings/"+c.session+"/verify", `{"code":"`+code+`"}`, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	a.mu.Lock()
	if len(a.state.Phones) != 0 || len(a.links) != 0 {
		t.Fatal("web verification alone authorized phone")
	}
	a.mu.Unlock()
	state := call(a, "GET", "/api/state", "", "").Body.String()
	if strings.Contains(state, code) {
		t.Fatal("state leaked verification code")
	}
	c.send(t, map[string]any{"type": "approve", "approved": true})
	paired := c.read(t)
	if paired["type"] != "paired" {
		t.Fatal(paired)
	}
	token := paired["token"].(string)
	c.send(t, map[string]string{"type": "auth", "proof": linkProof(token, c.server, c.session, c.nonce, "test-phone")})
	if m := c.read(t); m["type"] != "ready" {
		t.Fatal(m)
	}
	a.mu.Lock()
	cfg := *a.state.Phones[0]
	a.mu.Unlock()
	if cfg.Transport != "reverse" || cfg.Token != token {
		t.Fatal("pairing not persisted")
	}
	state = call(a, "GET", "/api/state", "", "").Body.String()
	if strings.Contains(state, token) {
		t.Fatal("state leaked credential")
	}
	// 业务请求经手机主动建立的连接返回，ID 保证并发响应归属。
	result := make(chan error, 1)
	go func() {
		var out struct{ Online bool }
		err := a.phoneRequest(context.Background(), cfg, "GET", "/v1/device", nil, "", &out)
		if err == nil && !out.Online {
			err = fmt.Errorf("missing response")
		}
		result <- err
	}()
	request := c.read(t)
	if request["type"] != "request" || request["path"] != "/v1/device" {
		t.Fatal(request)
	}
	c.send(t, map[string]any{"type": "response", "id": request["id"], "status": 200, "body": map[string]bool{"online": true}})
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	c.ws.CloseNow()
	waitLink(t, a, func() bool { return len(a.links) == 0 })
	a.mu.Lock()
	a.linkAttempts = map[string]time.Time{}
	a.mu.Unlock()
	// 已授权的手机重连不需要发现口令：电脑关闭了自动搜索、服务重启后口令都会失效
	reconnect := dialTestPhone(t, a, address, "", strings.Repeat("cd", 32))
	reconnect.send(t, map[string]string{"type": "auth", "proof": linkProof(token, reconnect.server, reconnect.session, reconnect.nonce, "test-phone")})
	if m := reconnect.read(t); m["type"] != "ready" {
		t.Fatalf("reconnect asked for pairing: %v", m)
	}
	a.mu.Lock()
	if len(a.pairings) != 0 || len(a.state.Phones) != 1 || a.state.Phones[0].ID != cfg.ID {
		t.Fatal("reconnection duplicated identity")
	}
	a.mu.Unlock()
	if w := call(a, "POST", "/api/phones/"+cfg.ID+"/delete", `{}`, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	waitLink(t, a, func() bool { return len(a.links) == 0 && len(a.state.Phones) == 0 })
}

func TestPairingWrongCodeLimitAndCommitment(t *testing.T) {
	a, address, nonce := newTestLinkServer(t)
	secret := strings.Repeat("ab", 32)
	c := dialTestPhone(t, a, address, nonce, secret)
	c.send(t, map[string]string{"type": "reveal", "secret": secret})
	c.read(t)
	c.send(t, map[string]any{"type": "approve", "approved": true})
	waitLink(t, a, func() bool { return a.pairings[c.session].PhoneApproved })
	for i := 0; i < 5; i++ {
		w := call(a, "POST", "/api/pairings/"+c.session+"/verify", `{"code":"incorrect"}`, "")
		if w.Code != 400 {
			t.Fatalf("attempt %d: %d", i, w.Code)
		}
	}
	waitLink(t, a, func() bool { return len(a.pairings) == 0 })
	a.mu.Lock()
	if len(a.state.Phones) != 0 {
		t.Fatal("phone confirmation authorized wrong code")
	}
	a.linkAttempts = map[string]time.Time{}
	a.mu.Unlock()
	c2 := dialTestPhone(t, a, address, nonce, secret)
	c2.send(t, map[string]string{"type": "reveal", "secret": strings.Repeat("ef", 32)})
	var m any
	if err := wsjson.Read(c2.ctx, c2.ws, &m); err == nil {
		t.Fatal("accepted changed commitment")
	}
}

func TestPairingCodeBoundToSessionAndCertificate(t *testing.T) {
	code := pairingCode("server", "session", "phone", "secret", "nonce")
	if code == pairingCode("other", "session", "phone", "secret", "nonce") || code == pairingCode("server", "other", "phone", "secret", "nonce") {
		t.Fatal("code not bound to transcript")
	}
}

func TestPairingCancellationAndExpiredVerification(t *testing.T) {
	a, address, nonce := newTestLinkServer(t)
	secret := strings.Repeat("ab", 32)
	c := dialTestPhone(t, a, address, nonce, secret)
	c.send(t, map[string]string{"type": "reveal", "secret": secret})
	c.read(t)
	expiredApp := testApp(t)
	expiredApp.pairings["expired"] = &phonePairing{ID: "expired", Code: "123456", Expires: time.Now().Add(-time.Second)}
	if w := call(expiredApp, "POST", "/api/pairings/expired/verify", `{"code":"123456"}`, ""); w.Code != 409 {
		t.Fatal("expired verification accepted")
	}
	if w := call(a, "POST", "/api/pairings/"+c.session+"/cancel", `{}`, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var message any
	if err := wsjson.Read(c.ctx, c.ws, &message); err == nil {
		t.Fatal("cancelled connection still active")
	}
	waitLink(t, a, func() bool { return len(a.pairings) == 0 && len(a.state.Phones) == 0 })
}

func TestPhoneAuthRejectsReplayedProof(t *testing.T) {
	a, address, nonce := newTestLinkServer(t)
	token := strings.Repeat("ef", 32)
	a.mu.Lock()
	a.state.Phones = append(a.state.Phones, &PhoneConfig{ID: "saved", DeviceID: "test-phone", Transport: "reverse", Token: token})
	a.syncPhonesLocked()
	a.mu.Unlock()
	c := dialTestPhone(t, a, address, nonce, strings.Repeat("ab", 32))
	c.send(t, map[string]string{"type": "auth", "proof": linkProof(token, c.server, "previous-session", c.nonce, "test-phone")})
	if m := c.read(t); m["type"] != "revoked" {
		t.Fatal("replayed proof accepted", m)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.links) != 0 {
		t.Fatal("unauthenticated phone attached")
	}
}

func TestUnknownPhoneNeedsDiscoveryNonce(t *testing.T) {
	a, address, _ := newTestLinkServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	ws, _, err := websocket.Dial(ctx, address, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	digest := sha256.Sum256([]byte(strings.Repeat("ab", 32)))
	if err := wsjson.Write(ctx, ws, map[string]any{"type": "hello", "device_id": "stranger", "api_port": 8766, "discovery_nonce": randomID(), "commit": hex.EncodeToString(digest[:])}); err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := wsjson.Read(ctx, ws, &m); err == nil {
		t.Fatalf("unknown phone without a valid nonce must be dropped, got %v", m)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.pairings) != 0 {
		t.Fatal("pairing started without discovery")
	}
}

func TestPairingDoesNotReuseAnotherDevicesRecord(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	other := &PhoneConfig{ID: "a", URL: "http://192.168.0.2:8766", DeviceID: "phone-a", Account: "acc-a", Cursor: 50}
	manual := &PhoneConfig{ID: "m", URL: "http://192.168.0.3:8766"}
	a.state.Phones = []*PhoneConfig{other, manual}
	if got := a.findPairingPhoneLocked(&phonePairing{DeviceID: "phone-b", URL: other.URL}); got != nil {
		t.Fatalf("another device at the same address must get a new record: %+v", got)
	}
	if got := a.findPairingPhoneLocked(&phonePairing{DeviceID: "phone-c", URL: manual.URL}); got != manual {
		t.Fatal("manually added phone without device id should be upgraded")
	}
	if got := a.findPairingPhoneLocked(&phonePairing{DeviceID: "phone-a", URL: "http://192.168.0.9:8766"}); got != other {
		t.Fatal("same device with a new address should keep its record")
	}
}
