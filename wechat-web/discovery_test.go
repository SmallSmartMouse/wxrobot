package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestDiscoverySendsChallengeAndLinkAddress(t *testing.T) {
	phone, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer phone.Close()
	a := testApp(t)
	a.linkCert, a.linkPort = strings.Repeat("f", 64), 18788
	if err = a.sendDiscovery(context.Background(), []*net.UDPAddr{phone.LocalAddr().(*net.UDPAddr)}); err != nil {
		t.Fatal(err)
	}
	// 等 2 秒：macOS 上新编译的测试程序收第一个 UDP 包可能要等近 1 秒（防火墙检查）
	_ = phone.SetReadDeadline(time.Now().Add(2 * time.Second))
	buffer := make([]byte, 2048)
	n, _, err := phone.ReadFromUDP(buffer)
	if err != nil {
		t.Fatal(err)
	}
	var request struct {
		Type, Nonce, ServerID string
		LinkPort              int `json:"link_port"`
	}
	_ = json.Unmarshal(buffer[:n], &request)
	if request.Type != discoveryRequestType || len(request.Nonce) != 32 || request.LinkPort != 18788 || !strings.Contains(string(buffer[:n]), a.linkCert) {
		t.Fatalf("invalid discovery request: %s", buffer[:n])
	}
	// 挑战在发送前登记：手机凭它来配对
	if !time.Now().Before(a.discoveryNonces[request.Nonce]) {
		t.Fatal("nonce should be registered before sending")
	}
}

func TestDiscoveryNeedsLinkListener(t *testing.T) {
	a := testApp(t)
	if err := a.sendDiscovery(context.Background(), []*net.UDPAddr{{IP: net.IPv4(127, 0, 0, 1), Port: 39000}}); err == nil || !strings.Contains(err.Error(), "接入端口") {
		t.Fatalf("discovery without the link listener should explain why: %v", err)
	}
}

func TestDiscoveryCancellation(t *testing.T) {
	a := testApp(t)
	a.linkCert, a.linkPort = strings.Repeat("f", 64), 18788
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	targets := make([]*net.UDPAddr, 64)
	for i := range targets {
		targets[i] = &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 39000}
	}
	if err := a.sendDiscovery(ctx, targets); err == nil {
		t.Fatal("cancelled discovery should return an error")
	}
}

func TestEventLoopConnectsAndIdentifiesAccount(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	a.state.Phones = []*PhoneConfig{{ID: "p1", DeviceID: "phone-a", Token: strings.Repeat("s", 32)}}
	a.syncPhonesLocked()
	linkPhone(a, "p1", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/device" {
			fmt.Fprint(w, `{"online":true,"info":{"ready":true,"account":{"wechat_id":"wx-a"}}}`)
			return
		}
		time.Sleep(50 * time.Millisecond)
		fmt.Fprint(w, `{"events":[{"seq":124,"kind":"notification","account":"wx-a","chat":"小王","text":"在吗"}],"cursor":124,"latest_cursor":124}`)
	}))
	a.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.eventLoop(ctx, "p1") }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		p := a.phoneLocked("p1")
		ready := a.onlineLocked("p1") && p.Account == "wx-a" && p.Cursor == 124 && len(a.state.Conversations) == 1
		a.mu.Unlock()
		if ready {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("phone did not connect, identify its account and deliver events")
}

func TestReachableUnreadyPhoneClearsConnectionError(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	addTestPhone(a, nil)
	a.mu.Unlock()
	a.setPhoneStatus("p1", connFailed, nil, errors.New("无法连接手机"))
	a.setPhoneStatus("p1", connNotReady, json.RawMessage(`{"online":true,"info":{"ready":false,"reasons":["SCREEN_LOCKED"]}}`), nil)
	if a.phones["p1"].err != "" || a.phones["p1"].connection != connNotReady {
		t.Fatal("reachable phone kept an old connection error")
	}
}

func TestPhoneWithoutLinkWaits(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	addTestPhone(a, nil)
	a.mu.Unlock()
	if err := a.refreshDeviceStatus(context.Background(), "p1"); err == nil || !strings.Contains(err.Error(), "等待手机主动连接") {
		t.Fatalf("phone without a link: %v", err)
	}
}
