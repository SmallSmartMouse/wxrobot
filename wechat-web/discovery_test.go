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
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func signedDiscovery(id, ip string, port int, nonce, token string) discoveredPhone {
	d := discoveredPhone{discoveryReply: discoveryReply{
		Type: discoveryResponseType, Nonce: nonce, DeviceID: id, IP: ip, Port: port,
	}, URL: fmt.Sprintf("http://%s:%d", ip, port), Seen: time.Now()}
	mac := hmac.New(sha256.New, []byte(token))
	fmt.Fprintf(mac, "wxrobot-phone-v1\n%s\n%s\n%s\n%d", nonce, id, ip, port)
	d.Signature = hex.EncodeToString(mac.Sum(nil))
	return d
}

func TestScanPhonesUDP(t *testing.T) {
	phone, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close()
	token := strings.Repeat("s", 32)
	done := make(chan error, 1)
	go func() {
		_ = phone.SetReadDeadline(time.Now().Add(3 * time.Second))
		buffer := make([]byte, 2048)
		n, source, err := phone.ReadFromUDP(buffer)
		if err != nil {
			done <- err
			return
		}
		var request struct{ Type, Nonce string }
		if err = json.Unmarshal(buffer[:n], &request); err != nil || request.Type != discoveryRequestType || len(request.Nonce) != 32 || strings.Contains(string(buffer[:n]), token) {
			done <- fmt.Errorf("invalid discovery request")
			return
		}
		d := signedDiscovery("phone-a", "127.0.0.1", 8766, request.Nonce, token)
		for _, kind := range []string{"malformed", "wrong-nonce", "wrong-ip", "valid", "valid"} {
			reply := d.discoveryReply
			if kind == "wrong-nonce" {
				reply.Nonce = strings.Repeat("0", 32)
			}
			if kind == "wrong-ip" {
				reply.IP = "192.168.1.99"
			}
			data, _ := json.Marshal(reply)
			if kind == "malformed" {
				data = []byte("bad json")
			}
			if _, err = phone.WriteToUDP(data, source); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	// 等 2 秒：macOS 上新编译的测试程序收第一个 UDP 包可能要等近 1 秒（防火墙检查）
	found, err := testApp(t).scanConfiguredPhones(context.Background(), []*net.UDPAddr{phone.LocalAddr().(*net.UDPAddr)}, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(found) != 1 || found[0].DeviceID != "phone-a" || found[0].URL != "http://127.0.0.1:8766" || !found[0].matches(token) {
		t.Fatalf("expected one authenticated reply, got %+v", found)
	}
	// IP 和端口也必须受签名保护，防止凭证被转送到其他地址。
	d := found[0]
	d.IP = "192.168.1.99"
	if d.matches(token) {
		t.Fatal("changed IP must invalidate signature")
	}
	d = found[0]
	d.Port++
	if d.matches(token) {
		t.Fatal("changed port must invalidate signature")
	}
}

func TestScanPhonesCancellation(t *testing.T) {
	a := testApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := a.scanConfiguredPhones(ctx, []*net.UDPAddr{{IP: net.IPv4(127, 0, 0, 1), Port: 39000}}, time.Minute)
		done <- err
	}()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled scan should return an error")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled discovery socket did not close")
	}
}

func TestPairDiscoveredPhone(t *testing.T) {
	a := testApp(t)
	token := strings.Repeat("s", 32)
	d := signedDiscovery("phone-a", "192.168.0.2", 8766, randomID(), token)
	a.discovered[d.URL] = d
	body := func(token string) string {
		b, _ := json.Marshal(map[string]string{"device_id": d.DeviceID, "phone_url": d.URL, "token": token})
		return string(b)
	}
	if w := call(a, "POST", "/api/phones/pair", body(strings.Repeat("x", 32)), ""); w.Code != 400 || len(a.state.Phones) != 0 {
		t.Fatalf("wrong token should not connect: %d %s", w.Code, w.Body)
	}
	d.Seen = time.Now().Add(-discoveryTTL)
	a.discovered[d.URL] = d
	if w := call(a, "POST", "/api/phones/pair", body(token), ""); w.Code != 409 {
		t.Fatalf("expired device: %d", w.Code)
	}
	d.Seen = time.Now()
	a.discovered[d.URL] = d
	if w := call(a, "POST", "/api/phones/pair", body(token), ""); w.Code != 200 {
		t.Fatalf("pair: %d %s", w.Code, w.Body)
	}
	p := a.state.Phones[0]
	if p.DeviceID != d.DeviceID || p.URL != d.URL || a.phones[p.ID] == nil {
		t.Fatal("pair should create a persistent connection")
	}
	if w := call(a, "POST", "/api/phones/pair", body(token), ""); w.Code != 409 {
		t.Fatalf("duplicate pair: %d", w.Code)
	}
	state := call(a, "GET", "/api/state", "", "").Body.String()
	for _, secret := range []string{token, d.Signature, d.Nonce} {
		if strings.Contains(state, secret) {
			t.Fatal("discovery state exposed authentication material")
		}
	}
	b, err := newApp(a.path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.store.db.Close()
	if b.state.Phones[0].DeviceID != d.DeviceID {
		t.Fatal("device identity was not saved")
	}
}

func TestDiscoveryUpdatesKnownPhoneSafely(t *testing.T) {
	a := testApp(t)
	token := strings.Repeat("s", 32)
	p := &PhoneConfig{ID: "saved", URL: "http://192.168.0.2:8766", Token: token, Account: "wx-a", Cursor: 123}
	a.state.Phones = []*PhoneConfig{p}
	a.syncPhonesLocked()
	d := signedDiscovery("phone-a", "192.168.0.3", 8766, randomID(), token)
	a.reconnectDiscoveredLocked(d)
	if p.ID != "saved" || p.Account != "wx-a" || p.Cursor != 123 || p.URL != d.URL || p.DeviceID != d.DeviceID {
		t.Fatalf("reconnect must preserve existing state: %+v", p)
	}
	spoof := signedDiscovery("phone-a", "192.168.0.99", 8766, randomID(), strings.Repeat("x", 32))
	a.reconnectDiscoveredLocked(spoof)
	if p.URL != d.URL {
		t.Fatal("spoofed response changed saved address")
	}
	other := signedDiscovery("phone-b", "192.168.0.98", 8766, randomID(), token)
	a.reconnectDiscoveredLocked(other)
	if p.URL != d.URL {
		t.Fatal("another identity hijacked a bound connection")
	}
	newAddress := signedDiscovery("phone-a", "192.168.0.4", 8766, randomID(), token)
	a.state.Operations["active"] = &Operation{ID: "active", PhoneID: p.ID, Kind: "send", Status: "running"}
	a.reconnectDiscoveredLocked(newAddress)
	if p.URL != d.URL {
		t.Fatal("address changed during an active operation")
	}
	a.state.Operations["active"].Status = "succeeded"
	a.reconnectDiscoveredLocked(newAddress)
	if p.URL != newAddress.URL {
		t.Fatal("address did not update after the operation ended")
	}
	a.state.Phones = nil
	a.syncPhonesLocked()
	a.reconnectDiscoveredLocked(newAddress)
	if len(a.state.Phones) != 0 {
		t.Fatal("deleted phone was automatically added again")
	}
}

func TestDiscoveredPhoneConnectsThroughExistingEventLoop(t *testing.T) {
	a := testApp(t)
	token := strings.Repeat("s", 32)
	phone := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/device" {
			fmt.Fprint(w, `{"online":true,"info":{"ready":true,"account":{"wechat_id":"wx-a"}}}`)
		} else {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
			fmt.Fprint(w, `{"events":[],"latest_cursor":123}`)
		}
	}))
	defer phone.Close()
	address, _ := net.ResolveTCPAddr("tcp4", strings.TrimPrefix(phone.URL, "http://"))
	d := signedDiscovery("phone-a", address.IP.String(), address.Port, randomID(), token)
	a.discovered[d.URL] = d
	body, _ := json.Marshal(map[string]string{"device_id": d.DeviceID, "phone_url": d.URL, "token": token})
	if w := call(a, "POST", "/api/phones/pair", string(body), ""); w.Code != 200 {
		t.Fatalf("pair: %s", w.Body)
	}
	id := a.state.Phones[0].ID
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.eventLoop(ctx, id) }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		online := a.onlineLocked(id) && a.phoneLocked(id).Account == "wx-a"
		a.mu.Unlock()
		if online {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("discovered phone did not connect and identify its account")
}

func TestReachableUnreadyPhoneClearsConnectionError(t *testing.T) {
	a := testApp(t)
	token := strings.Repeat("s", 32)
	if w := call(a, "POST", "/api/phones", `{"phone_url":"192.168.0.2","token":"`+token+`"}`, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	id := a.state.Phones[0].ID
	a.setPhoneStatus(id, "连接失败", nil, errors.New("无法连接手机"))
	a.setPhoneStatus(id, "手机未就绪", json.RawMessage(`{"online":true,"info":{"ready":false,"reasons":["SCREEN_LOCKED"]}}`), nil)
	if a.phones[id].err != "" || a.phones[id].connection != "手机未就绪" {
		t.Fatal("reachable phone kept an old connection error")
	}
}
