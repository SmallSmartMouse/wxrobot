package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testApp(t *testing.T) *App {
	t.Helper()
	a, err := newApp(filepath.Join(t.TempDir(), "wechat.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.store.db.Close() })
	return a
}

func call(a *App, method, path, body, key string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8787"+path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:5000"
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	return w
}

func msgs(texts ...string) []Message {
	out := make([]Message, len(texts))
	for i, t := range texts {
		out[i] = Message{Text: t, Direction: "incoming"}
	}
	return out
}

func snapshotJSON(texts ...string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"messages": msgs(texts...), "captured_at": now()})
	return b
}

func texts(c *Conversation) string {
	var parts []string
	for _, m := range c.Messages {
		s := m.Text
		if m.Gap {
			s = "|" + s
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, ",")
}

func TestNewMessagesStart(t *testing.T) {
	cases := []struct {
		known, window []string
		start         int
		aligned       bool
	}{
		{nil, []string{"a"}, 0, true},
		{[]string{"a", "b", "c"}, []string{"b", "c", "d"}, 2, true},  // 末尾衔接
		{[]string{"a", "b", "c"}, []string{"a", "b"}, 2, true},       // 窗口已全部记录
		{[]string{"a", "b"}, []string{"x", "y"}, 0, false},           // 完全无关
		{[]string{"a", "b"}, []string{"b", "x", "b", "y"}, 0, false}, // 衔接点不唯一
	}
	for _, tc := range cases {
		start, _, aligned := newMessagesStart(msgs(tc.known...), msgs(tc.window...))
		if start != tc.start || aligned != tc.aligned {
			t.Errorf("%v + %v = %d %v, want %d %v", tc.known, tc.window, start, aligned, tc.start, tc.aligned)
		}
	}
	unknown := []Message{{Text: "a", Direction: "unknown"}}
	if start, _, ok := newMessagesStart(msgs("a"), append(unknown, msgs("b")...)); start != 1 || !ok {
		t.Error("unknown direction should still align")
	}
}

func TestMergeTaskGapAndIgnoredMonitorWindow(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.conversationLocked("acc", "小王")
	a.mergeLocked(c, snapshotJSON("a", "b"))
	a.mergeLocked(c, snapshotJSON("b", "c"))
	if got := texts(c); got != "a,b,c" || c.Unread != 3 || c.LastSeq != 3 {
		t.Fatalf("aligned merge: %s unread=%d seq=%d", got, c.Unread, c.LastSeq)
	}
	a.mergeLocked(c, snapshotJSON("old1", "old2")) // 用户翻到历史位置：忽略
	if got := texts(c); got != "a,b,c" {
		t.Fatalf("monitor window should be ignored: %s", got)
	}
	a.mergeOrAppendLocked(c, snapshotJSON("x", "y")) // 读取任务：整窗追加并标记缺口
	if got := texts(c); got != "a,b,c,|x,y" {
		t.Fatalf("task gap merge: %s", got)
	}
	if a.aiCursor[c.ID] != c.LastSeq {
		t.Fatal("gap batch must not trigger AI")
	}
}

func reopen(t *testing.T, a *App) *App {
	t.Helper()
	a.store.db.Close()
	b, err := newApp(a.path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.store.db.Close() })
	return b
}

func TestSQLiteRoundTrip(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	c := a.conversationLocked("acc", "小王")
	c.Kind = "person"
	a.mergeOrAppendLocked(c, snapshotJSON("a", "b"))
	window := `{"messages":[{"text":"b","direction":"incoming"},{"text":"[图片]","kind":"image","direction":"incoming"}]}`
	a.mergeOrAppendLocked(c, json.RawMessage(window))
	// 之后补上这张图片的原图：只更新已有的那一行
	a.mergeOrAppendLocked(c, json.RawMessage(`{"messages":[{"text":"[图片]","kind":"image","direction":"incoming","original_hash":"abc"}]}`))
	for i := 0; i < maxFinishedOperations+5; i++ {
		id := fmt.Sprintf("op-%03d", i)
		a.state.Operations[id] = &Operation{ID: id, ConversationID: c.ID, Kind: "read", Status: "succeeded", Created: fmt.Sprintf("2026-01-01T00:00:%03d", i)}
	}
	if err := a.commitLocked(); err != nil {
		t.Fatal(err)
	}
	a.mu.Unlock()

	b := reopen(t, a)
	got := b.state.Conversations[c.ID]
	if texts(got) != "a,b,[图片]" || got.Messages[2].OriginalHash != "abc" || got.Kind != "person" || got.LastSeq != 3 {
		t.Fatalf("messages not persisted: %s %+v", texts(got), got.Messages)
	}
	var rows int
	b.store.db.QueryRow("SELECT count(*) FROM operations").Scan(&rows)
	if len(b.state.Operations) != maxFinishedOperations || rows != maxFinishedOperations || b.state.Operations["op-000"] != nil {
		t.Fatalf("pruned operations should be deleted from the database: memory=%d rows=%d", len(b.state.Operations), rows)
	}
}

// fakePhone 模拟手机桥：任务创建后第一次查询即完成。
type fakePhone struct {
	posts     atomic.Int32
	result    string // 任务结果 JSON
	status    string
	missing   bool // 查询任务时返回 404（模拟手机桥重启）
	lastBody  map[string]any
	lastKey   string
	rejectNew bool
	file      []byte // /v1/files/ 返回的内容
}

func (p *fakePhone) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == "POST" && p.rejectNew:
		w.WriteHeader(409)
		w.Write([]byte(`{"error":{"message":"手机未就绪"}}`))
	case strings.HasPrefix(r.URL.Path, "/v1/files/"):
		w.Write(p.file)
	case r.Method == "POST":
		p.posts.Add(1)
		p.lastKey = r.Header.Get("Idempotency-Key")
		json.NewDecoder(r.Body).Decode(&p.lastBody)
		w.Write([]byte(`{"id":"task-1","status":"queued"}`))
	case p.missing:
		w.WriteHeader(404)
		w.Write([]byte(`{"error":{"message":"任务不存在"}}`))
	default:
		w.Write([]byte(`{"id":"task-1","status":"` + p.status + `","result":` + p.result + `}`))
	}
}

// call 按手机桥接口处理一个经连接发来的请求：请求交给 HTTP handler；文件按分块格式返回（测试文件很小，一块就是全部）。
func (p handlerPhone) call(ctx context.Context, req linkRequest) (linkMessage, error) {
	if strings.HasPrefix(req.Path, "/v1/files/") && strings.Contains(req.Path, "done=1") {
		return linkMessage{Status: 200, Body: json.RawMessage(`{"ok":true}`)}, nil
	}
	var body io.Reader = http.NoBody
	if req.Body != nil {
		b, _ := json.Marshal(req.Body)
		body = bytes.NewReader(b)
	}
	path, _, _ := strings.Cut(req.Path, "?")
	if !strings.HasPrefix(path, "/v1/files/") {
		path = req.Path
	}
	r := httptest.NewRequest(req.Method, path, body)
	if req.Key != "" {
		r.Header.Set("Idempotency-Key", req.Key)
	}
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	if strings.HasPrefix(req.Path, "/v1/files/") && w.Code == 200 {
		chunk, _ := json.Marshal(map[string]any{"size": w.Body.Len(), "data": base64.StdEncoding.EncodeToString(w.Body.Bytes())})
		return linkMessage{Status: 200, Body: chunk}, nil
	}
	return linkMessage{Status: w.Code, Body: w.Body.Bytes()}, nil
}

func (p handlerPhone) close() {}

// handlerPhone 把 http.Handler 当作手机的连接（phoneConn），测试用。
type handlerPhone struct{ http.Handler }

// linkPhone 把 handler 设为手机 id 的连接。
func linkPhone(a *App, id string, phone http.Handler) {
	a.links[id] = handlerPhone{phone}
}

// addTestPhone 添加一台编号 p1、登录着账号 acc、在线的手机（不启动事件循环）；phone 不为空时作为它的连接。调用方按需持有锁。
func addTestPhone(a *App, phone http.Handler) {
	a.state.Phones = append(a.state.Phones, &PhoneConfig{ID: "p1", DeviceID: "dev-p1", Token: strings.Repeat("t", 32), Account: "acc"})
	a.syncPhonesLocked()
	a.phones["p1"].connection = connOnline
	if phone != nil {
		linkPhone(a, "p1", phone)
	}
}

func appWithPhone(t *testing.T, phone *fakePhone) (*App, *Conversation) {
	a := testApp(t)
	addTestPhone(a, phone)
	a.mu.Lock()
	c := a.conversationLocked("acc", "家人群")
	c.Kind = "group"
	a.mu.Unlock()
	return a, c
}

// setReadHistory 经系统设置接口切换读取模式（搜索设置保持默认），返回响应。
func setReadHistory(a *App, readHistory bool) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]any{"discovery": defaultDiscoverySettings(), "read_history": readHistory})
	return call(a, "POST", "/api/system-settings", string(body), "")
}

func runAll(a *App) {
	for id := a.nextOperation("p1"); id != ""; id = a.nextOperation("p1") {
		a.runOperation(context.Background(), "p1", id)
	}
}

func TestSendFlowAndIdempotency(t *testing.T) {
	phone := &fakePhone{status: "succeeded", result: `{"confirmation":"ui_observed","snapshot":` + string(snapshotJSON("你好")) + `}`}
	a, c := appWithPhone(t, phone)
	path := "/api/conversations/" + c.ID + "/send"
	if w := call(a, "POST", path, `{"text":"你好"}`, "k1"); w.Code != 202 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	if w := call(a, "POST", path, `{"text":"你好"}`, "k1"); w.Code != 202 {
		t.Fatalf("repeat should return the same operation: %d", w.Code)
	}
	if w := call(a, "POST", path, `{"text":"别的"}`, "k1"); w.Code != 409 {
		t.Fatalf("reused key with other content: %d", w.Code)
	}
	runAll(a)
	op := a.state.Operations["k1"]
	if op.Status != "succeeded" || phone.posts.Load() != 1 || phone.lastKey != "k1" || phone.lastBody["chat_type"] != "group" {
		t.Fatalf("op=%+v posts=%d key=%s body=%v", op, phone.posts.Load(), phone.lastKey, phone.lastBody)
	}
	if texts(c) != "你好" {
		t.Fatalf("post-send snapshot not merged: %s", texts(c))
	}
}

func TestPhoneRestartMakesSendUnknownAndReadFailed(t *testing.T) {
	phone := &fakePhone{missing: true}
	a, c := appWithPhone(t, phone)
	call(a, "POST", "/api/conversations/"+c.ID+"/send", `{"text":"hi"}`, "s1")
	call(a, "POST", "/api/conversations/"+c.ID+"/read", `{"limit":20}`, "r1")
	runAll(a)
	if s := a.state.Operations["s1"].Status; s != "unknown" {
		t.Fatalf("send after phone restart = %s, want unknown", s)
	}
	if s := a.state.Operations["r1"].Status; s != "failed" {
		t.Fatalf("read after phone restart = %s, want failed", s)
	}
}

func TestRejectedSendIsFailedNotUnknown(t *testing.T) {
	a, c := appWithPhone(t, &fakePhone{rejectNew: true})
	call(a, "POST", "/api/conversations/"+c.ID+"/send", `{"text":"hi"}`, "s1")
	runAll(a)
	if op := a.state.Operations["s1"]; op.Status != "failed" || op.Error != "手机未就绪" {
		t.Fatalf("op=%+v", op)
	}
}

func TestResumeRunningOperationAfterRestart(t *testing.T) {
	phone := &fakePhone{status: "succeeded", result: string(snapshotJSON("x"))}
	a, c := appWithPhone(t, phone)
	a.state.Operations["r1"] = &Operation{ID: "r1", ConversationID: c.ID, Kind: "read", Limit: 20, Status: "running", PhoneTaskID: "task-1", Created: now()}
	runAll(a)
	if phone.posts.Load() != 0 || a.state.Operations["r1"].Status != "succeeded" || texts(c) != "x" {
		t.Fatalf("should poll the existing phone task without resubmitting: posts=%d", phone.posts.Load())
	}
}

func TestLocalOnly(t *testing.T) {
	a := testApp(t)
	cases := []struct {
		remote, host, origin string
		want                 int
	}{
		{"127.0.0.1:1", "127.0.0.1:8787", "", 200},
		{"192.168.1.9:1", "127.0.0.1:8787", "", 403},                    // 局域网来源
		{"127.0.0.1:1", "evil.example:8787", "", 403},                   // DNS 重绑定
		{"127.0.0.1:1", "127.0.0.1:8787", "http://evil.example", 403},   // 跨站
		{"127.0.0.1:1", "localhost:8787", "http://localhost:8787", 200}, // 同源
	}
	for _, tc := range cases {
		r := httptest.NewRequest("GET", "/api/state", nil)
		r.RemoteAddr, r.Host = tc.remote, tc.host
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%+v: got %d", tc, w.Code)
		}
	}
}

func TestAISettingPrecedenceAndTrigger(t *testing.T) {
	a := testApp(t)
	a.state.AI = AIConfig{URL: "http://ai.invalid/v1", Model: "m"}
	a.state.AIRules = []AIRule{{Kind: "group", Matcher: "wildcard", Pattern: "*线报*", AISetting: AISetting{Mode: "auto", Keyword: "@助手", IntervalSeconds: 5}}}
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.conversationLocked("acc", "京东线报1群")
	c.Kind = "group"
	if s := a.aiSettingLocked(c); s.Mode != "auto" {
		t.Fatalf("name rule not applied: %+v", s)
	}
	a.mergeOrAppendLocked(c, snapshotJSON("旧消息 @助手"))
	if a.nextAIJobLocked() != "" {
		t.Fatal("messages present before the first check must not trigger")
	}
	a.mergeOrAppendLocked(c, snapshotJSON("旧消息 @助手", "没有触发词"))
	if a.nextAIJobLocked() != "" {
		t.Fatal("message without keyword must not trigger")
	}
	a.mergeOrAppendLocked(c, snapshotJSON("没有触发词", "@助手 在吗"))
	if a.nextAIJobLocked() == "" {
		t.Fatal("keyword message should trigger")
	}
	c.AI = AISetting{Mode: "off", IntervalSeconds: 5}
	if s := a.aiSettingLocked(c); s.Mode != "off" {
		t.Fatal("conversation setting should override name rule")
	}
}

func TestGenerateReplySendsOnlyIfStillAuto(t *testing.T) {
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":" 好的 "}}]}`))
	}))
	defer model.Close()
	a := testApp(t)
	a.state.AI = AIConfig{URL: model.URL + "/v1", Model: "m", Prompt: "p"}
	a.mu.Lock()
	addTestPhone(a, nil)
	c := a.conversationLocked("acc", "小王")
	c.Kind = "person"
	c.AI = AISetting{Mode: "auto", IntervalSeconds: 5}
	a.mergeOrAppendLocked(c, snapshotJSON("在吗"))
	auto := a.newAIJobLocked(c.ID)
	a.mu.Unlock()
	a.generateReply(context.Background(), auto.ID)
	if auto.Status != "sent" || a.state.Operations[auto.OperationID].Text != "好的" {
		t.Fatalf("auto reply should queue a send: %+v", auto)
	}

	a.mu.Lock()
	turnedOff := a.newAIJobLocked(c.ID)
	c.AI.Mode = "off" // 生成期间关闭了自动回复
	a.mu.Unlock()
	a.generateReply(context.Background(), turnedOff.ID)
	if turnedOff.Status != "failed" || turnedOff.OperationID != "" {
		t.Fatalf("must not send after auto reply is turned off: %+v", turnedOff)
	}
}

func TestMediaUploadAndRead(t *testing.T) {
	a := testApp(t)
	// 1×1 PNG
	png := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	w := call(a, "POST", "/api/media", `{"data":"data:image/png;base64,`+png+`"}`, "")
	var out struct {
		Hash string `json:"image_hash"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	if w.Code != 200 || len(out.Hash) != 64 {
		t.Fatalf("upload: %d %s", w.Code, w.Body)
	}
	if w := call(a, "GET", "/api/media/"+out.Hash, "", ""); w.Code != 200 || w.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("read: %d %s", w.Code, w.Header())
	}
	if w := call(a, "GET", "/api/media/../state.json", "", ""); w.Code == 200 {
		t.Fatal("path traversal")
	}
}

func TestStateHidesSecrets(t *testing.T) {
	a := testApp(t)
	addTestPhone(a, nil)
	a.state.Phones[0].Token = "secret-phone-token-0123456789abcdef"
	a.state.AI.Key = "secret-ai-key"
	for _, path := range []string{"/api/state", "/api/ai/config"} {
		if body := call(a, "GET", path, "", "").Body.String(); strings.Contains(body, "secret") {
			t.Fatalf("%s leaks secret: %s", path, body)
		}
	}
}

func TestShallowAutoReadDeepensBeforeMarkingGap(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.conversationLocked("acc", "小王")
	a.mergeOrAppendLocked(c, snapshotJSON("a", "b"))
	shallow := &Operation{ID: "s", ConversationID: c.ID, Kind: "read", Limit: shallowRead, Auto: true, Status: "running", Created: now()}
	a.state.Operations[shallow.ID] = shallow
	a.finishLocked(shallow, "succeeded", snapshotJSON("x", "y"), "")
	if texts(c) != "a,b" {
		t.Fatalf("unaligned shallow read must not append: %s", texts(c))
	}
	var deep *Operation
	for _, op := range a.state.Operations {
		if op.Reason == "deep" {
			deep = op
		}
	}
	if deep == nil || deep.Limit != deepRead {
		t.Fatal("expected a deep read to be queued")
	}
	a.finishLocked(deep, "succeeded", snapshotJSON("p", "q"), "")
	if texts(c) != "a,b,|p,q" {
		t.Fatalf("deep read should append with gap: %s", texts(c))
	}
	deeps := 0
	for _, op := range a.state.Operations {
		if op.Reason == "deep" {
			deeps++
		}
	}
	if deeps != 1 {
		t.Fatalf("a deep read that appended with gap must not queue another one: %d", deeps)
	}
}

func TestAutoReadStoppedEarlyAppendsWithoutDeepening(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.conversationLocked("acc", "小王")
	a.mergeOrAppendLocked(c, snapshotJSON("a", "b"))
	op := &Operation{ID: "s", ConversationID: c.ID, Kind: "read", Limit: shallowRead, Auto: true, Status: "running", Created: now()}
	a.state.Operations[op.ID] = op
	var result map[string]any
	_ = json.Unmarshal(snapshotJSON("x", "y"), &result)
	result["stop_reason"] = "page_cap"
	raw, _ := json.Marshal(result)
	a.finishLocked(op, "succeeded", raw, "")
	if texts(c) != "a,b,|x,y" {
		t.Fatalf("read that stopped at the page cap should append with gap: %s", texts(c))
	}
	for _, other := range a.state.Operations {
		if other.Reason == "deep" {
			t.Fatal("deep read would stop at the same place and must not be queued")
		}
	}
}

func TestAutoReadLimitDependsOnKnownTexts(t *testing.T) {
	a := testApp(t)
	addTestPhone(a, nil)
	a.mu.Lock()
	fresh := a.conversationLocked("acc", "新会话")
	fresh.NeedsRead = true
	a.mu.Unlock()
	if !a.scheduleAutoRead("p1") {
		t.Fatal("expected a read for the new conversation")
	}
	a.mu.Lock()
	known := a.conversationLocked("acc", "老会话")
	a.mergeOrAppendLocked(known, snapshotJSON("a", "b"))
	known.NeedsRead = true
	a.mu.Unlock()
	if !a.scheduleAutoRead("p1") {
		t.Fatal("expected a read for the known conversation")
	}
	limits := map[string]int{}
	for _, op := range a.state.Operations {
		limits[op.ConversationID] = op.Limit
	}
	if limits[fresh.ID] != shallowRead || limits[known.ID] != deepRead {
		t.Fatalf("limits: new=%d known=%d", limits[fresh.ID], limits[known.ID])
	}
}

func TestSendSnapshotGapTriggersRead(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.conversationLocked("acc", "小王")
	a.mergeOrAppendLocked(c, snapshotJSON("a"))
	op := &Operation{ID: "send", ConversationID: c.ID, Kind: "send", Text: "hi", Status: "running", Created: now()}
	a.state.Operations[op.ID] = op
	a.finishLocked(op, "succeeded", json.RawMessage(`{"snapshot":`+string(snapshotJSON("x", "hi"))+`}`), "")
	if texts(c) != "a" || !c.NeedsRead {
		t.Fatalf("unaligned send snapshot should request a read instead of appending: %s %v", texts(c), c.NeedsRead)
	}
}

func TestScheduleAutoReadPriority(t *testing.T) {
	a := testApp(t)
	addTestPhone(a, nil)
	a.mu.Lock()
	timed := a.conversationLocked("acc", "定时")
	timed.ReadEvery = 60
	notified := a.conversationLocked("acc", "通知")
	notified.NeedsRead = true
	quiet := a.conversationLocked("acc", "安静")
	quiet.ReadEvery = 60
	quiet.LastRead = now()
	a.mu.Unlock()

	if !a.scheduleAutoRead("p1") || notified.NeedsRead || notified.LastRead == "" {
		t.Fatal("notified conversation should be read first")
	}
	if !a.scheduleAutoRead("p1") || timed.LastRead == "" {
		t.Fatal("due scheduled conversation should be read next")
	}
	if a.scheduleAutoRead("p1") {
		t.Fatal("nothing else is due")
	}
	notified.NeedsRead = true
	if a.scheduleAutoRead("p1") {
		t.Fatal("a second trigger within 5 seconds must wait")
	}
}

func TestAutoReadSendsKnownTail(t *testing.T) {
	phone := &fakePhone{status: "succeeded", result: string(snapshotJSON("b", "c", "d"))}
	a, c := appWithPhone(t, phone)
	a.mu.Lock()
	a.mergeOrAppendLocked(c, snapshotJSON("a", "b", "c"))
	a.queueReadLocked(c, shallowRead, "schedule")
	a.mu.Unlock()
	runAll(a)
	until, _ := json.Marshal(phone.lastBody["until"])
	if string(until) != `["a","b","c"]` || texts(c) != "a,b,c,d" {
		t.Fatalf("until=%s messages=%s", until, texts(c))
	}
}

func TestLastTextsSkipsImages(t *testing.T) {
	m := []Message{{Text: "a"}, {Text: "[图片]", Kind: "image"}, {Text: "b"}, {Text: "[图片]", Kind: "image"}}
	if got, _ := json.Marshal(lastTexts(m, 3)); string(got) != `["a","b"]` {
		t.Fatal(string(got))
	}
}

func imageMsg(original string) Message {
	return Message{Text: "[图片]", Kind: "image", Direction: "incoming", OriginalHash: original}
}

func TestAutoReadAsksForOriginalsBeforePendingImage(t *testing.T) {
	jpegData := []byte("\xff\xd8\xff\xe0fake-jpeg")
	result := `{"messages":[{"text":"a","direction":"incoming"},{"text":"[图片]","kind":"image","direction":"incoming","original_file":"x.jpg"},{"text":"b","direction":"incoming"}]}`
	phone := &fakePhone{status: "succeeded", result: result, file: jpegData}
	a, c := appWithPhone(t, phone)
	a.mu.Lock()
	c.Kind = "person"
	c.Messages = []Message{{Text: "a", Direction: "incoming", Seq: 1}, imageMsg(""), {Text: "b", Direction: "incoming", Seq: 3}}
	c.Messages[1].Seq = 2
	c.LastSeq = 3
	a.queueReadLocked(c, shallowRead, "notification")
	a.mu.Unlock()
	runAll(a)
	until, _ := json.Marshal(phone.lastBody["until"])
	if string(until) != `["a"]` || phone.lastBody["originals"] != float64(2) {
		t.Fatalf("until=%s originals=%v", until, phone.lastBody["originals"])
	}
	img := c.Messages[1]
	if img.OriginalHash == "" || texts(c) != "a,[图片],b" {
		t.Fatalf("original should attach to the existing image: %+v / %s", img, texts(c))
	}
	if b, _ := os.ReadFile(filepath.Join(filepath.Dir(a.path), "media", img.OriginalHash+".jpg")); string(b) != string(jpegData) {
		t.Fatal("JPEG original must be stored unchanged")
	}
}

func TestOriginalFailuresStopAfterTwoTries(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.conversationLocked("acc", "小王")
	c.Kind = "person"
	window := `{"messages":[{"text":"a","direction":"incoming"},{"text":"[图片]","kind":"image","direction":"incoming","original_error":"大图没有打开"}]}`
	a.mergeOrAppendLocked(c, json.RawMessage(window))
	if c.firstPendingOriginal() != 1 {
		t.Fatal("image should still be pending after one failure")
	}
	a.mergeOrAppendLocked(c, json.RawMessage(window))
	if c.firstPendingOriginal() != -1 || c.Messages[1].OriginalTries != 2 {
		t.Fatalf("should give up after two failures: %+v", c.Messages[1])
	}
}

// 手机没能在屏幕上定位图片、没点开过大图：记下原因，但不算一次失败，之后还会再取。
func TestUnlocatedOriginalIsNotCountedAsTry(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.conversationLocked("acc", "小王")
	c.Kind = "person"
	window := `{"messages":[{"text":"a","direction":"incoming"},{"text":"[图片]","kind":"image","direction":"incoming","original_skipped":"没能在屏幕上定位这张图片"}]}`
	for i := 0; i < maxOriginalTries+1; i++ {
		a.mergeOrAppendLocked(c, json.RawMessage(window))
	}
	img := c.Messages[1]
	if c.firstPendingOriginal() != 1 || img.OriginalTries != 0 || img.OriginalError != "没能在屏幕上定位这张图片" {
		t.Fatalf("unlocated image should stay pending with its reason: %+v", img)
	}
}

func TestOriginalsOnByDefault(t *testing.T) {
	group := &Conversation{Kind: "group"}
	person := &Conversation{Kind: "person"}
	if !group.wantsOriginals() || !person.wantsOriginals() {
		t.Fatal("default: fetch originals for contacts and groups")
	}
	group.Originals = "off"
	if group.wantsOriginals() {
		t.Fatal("explicit off")
	}
}

// tinyJPEG 生成一张 w×h 的 JPEG（Base64）。
func tinyJPEG(t *testing.T, w, h int) string {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestGroupSenderAndAvatarPersist(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	c := a.conversationLocked("acc", "群")
	c.Kind = "group"
	avatar := tinyJPEG(t, 20, 20)
	// 第一屏：最后一条被截断，没识别出发送人
	first := `{"messages":[{"text":"早","direction":"incoming","sender":"张三","avatar":"` + avatar + `"},{"text":"好","direction":"unknown"}]}`
	a.mergeOrAppendLocked(c, json.RawMessage(first))
	// 第二屏：同一条消息完整显示，补上发送人；后面是另一个人的表情
	second := `{"messages":[{"text":"好","direction":"incoming","sender":"李四"},{"text":"[表情]","kind":"sticker","direction":"incoming","sender":"李四","thumbnail":"` + avatar + `"}]}`
	if !a.mergeLocked(c, json.RawMessage(second)) {
		t.Fatal("second screen should align")
	}
	if err := a.commitLocked(); err != nil {
		t.Fatal(err)
	}
	a.mu.Unlock()

	b := reopen(t, a)
	got := b.state.Conversations[c.ID]
	if texts(got) != "早,好,[表情]" || got.Messages[0].Sender != "张三" || got.Messages[1].Sender != "李四" {
		t.Fatalf("senders not merged or persisted: %s %+v", texts(got), got.Messages)
	}
	if got.Messages[1].Direction != "incoming" {
		t.Fatalf("direction of the clipped message should be filled in: %+v", got.Messages[1])
	}
	if got.Messages[2].ImageHash == "" || got.Members["张三"] == "" || got.Members["李四"] != "" {
		t.Fatalf("sticker thumbnail and avatar should be saved: %+v %+v", got.Messages[2], got.Members)
	}
	if ts := lastTexts(got.Messages, 3); len(ts) != 2 {
		t.Fatalf("stickers must not be used as stop texts: %v", ts)
	}
}

func TestSameTextFromDifferentSendersIsDifferent(t *testing.T) {
	a := Message{Text: "1", Direction: "incoming", Sender: "张三"}
	b := Message{Text: "1", Direction: "incoming", Sender: "李四"}
	unknown := Message{Text: "1", Direction: "incoming"}
	if sameMessage(a, b) || !sameMessage(a, unknown) {
		t.Fatal("different senders differ; a missing sender matches any")
	}
}

func TestAllowRemoteKeepsHostCheck(t *testing.T) {
	a := testApp(t)
	a.allowRemote = true
	for _, tc := range []struct {
		host string
		want int
	}{{"127.0.0.1:8787", 200}, {"evil.example:8787", 403}} {
		r := httptest.NewRequest("GET", "/api/state", nil)
		r.RemoteAddr, r.Host = "172.17.0.1:5000", tc.host // Docker 网桥转发的请求
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("host %s: got %d", tc.host, w.Code)
		}
	}
}

func TestTaskDiagnosticsAreKept(t *testing.T) {
	result := `{"code":"CHAT_MISMATCH","message":"聊天标题不匹配","diagnostics":{"duration_ms":4200,
		"steps":[{"ms":10,"step":"打开聊天","detail":"从首页会话列表打开"},{"ms":900,"step":"降级","detail":"改用截图 OCR 核对"}],
		"warnings":[{"code":"TITLE_OCR","message":"改用截图 OCR 核对"}]}}`
	phone := &fakePhone{status: "failed", result: result}
	a, c := appWithPhone(t, phone)
	call(a, "POST", "/api/conversations/"+c.ID+"/read", `{"limit":5}`, "r1")
	runAll(a)
	op := a.state.Operations["r1"]
	if op.Status != "failed" || op.DurationMS != 4200 || len(op.Steps) != 2 || len(op.Warnings) != 1 || op.Warnings[0].Code != "TITLE_OCR" {
		t.Fatalf("diagnostics not kept: %+v", op)
	}
	var state struct {
		Operations []Operation `json:"operations"`
	}
	json.Unmarshal(call(a, "GET", "/api/state", "", "").Body.Bytes(), &state)
	if len(state.Operations) != 1 || state.Operations[0].Steps != nil || len(state.Operations[0].Warnings) != 1 {
		t.Fatalf("state should carry warnings but not steps: %+v", state.Operations)
	}
}

func TestStepScreenshotSavedAndCleaned(t *testing.T) {
	// 生成一张 40×8 的 JPEG 作为标题栏截图
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 40, 8)), nil); err != nil {
		t.Fatal(err)
	}
	shot := base64.StdEncoding.EncodeToString(buf.Bytes())
	result := `{"messages":[],"diagnostics":{"duration_ms":10,"steps":[{"ms":5,"step":"标题核对","detail":"OCR","image":"` + shot + `"}]}}`
	phone := &fakePhone{status: "succeeded", result: result}
	a, c := appWithPhone(t, phone)
	call(a, "POST", "/api/conversations/"+c.ID+"/read", `{"limit":5}`, "r1")
	runAll(a)
	img := a.state.Operations["r1"].Steps[0].Image
	path, ok := a.mediaPath(img)
	if !ok {
		t.Fatalf("step image should be saved as a hash, got %q", img)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.state.Operations["r1"].Created = "2000-01-01T00:00:00Z" // 最旧，会被清理
	for i := 0; i < maxFinishedOperations; i++ {
		id := fmt.Sprintf("op-%03d", i)
		a.state.Operations[id] = &Operation{ID: id, ConversationID: c.ID, Kind: "read", Status: "succeeded", Created: now()}
	}
	a.pruneLocked()
	a.mu.Unlock()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("screenshot of a pruned task should be removed")
	}
}

func TestSystemNoticesAndWechatNotifications(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	c := a.conversationLocked("acc", "小王")
	c.Kind = "person"
	a.mergeOrAppendLocked(c, json.RawMessage(`{"messages":[{"text":"a","direction":"incoming"},{"text":"你的账号被限制与对方聊天","direction":"unknown","kind":"system"},{"text":"被截断的普通消息","direction":"unknown"}]}`))
	// 微信自己的系统通知不建会话
	a.ingestLocked(PhoneEvent{Kind: "notification", Account: "acc", Chat: "微信", Text: "你有1条消息未发送"})
	if len(a.state.Conversations) != 1 {
		t.Fatal("system notification should not create a conversation")
	}
	if ts := lastTexts(c.Messages, 3); strings.Join(ts, ",") != "a,被截断的普通消息" {
		t.Fatalf("system notices must not be stop texts: %v", ts)
	}
	// 新读到的系统提示不改列表预览
	c.Preview = "before"
	a.mergeOrAppendLocked(c, json.RawMessage(`{"messages":[{"text":"被截断的普通消息","direction":"incoming"},{"text":"x撤回了一条消息","direction":"unknown","kind":"system"}]}`))
	if c.Preview != "before" || c.Messages[len(c.Messages)-1].Kind != "system" {
		t.Fatalf("system notice appended without changing preview: %q", c.Preview)
	}
	if err := a.commitLocked(); err != nil {
		t.Fatal(err)
	}
	a.mu.Unlock()
	b := reopen(t, a)
	if got := b.state.Conversations[c.ID]; got.Messages[1].Kind != "system" || got.Messages[2].Kind != "" {
		t.Fatalf("system kind should be saved: %+v", got.Messages)
	}
}

func TestOriginalsBackfillIsBoundedAndThrottled(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	addTestPhone(a, nil)
	c := a.conversationLocked("acc", "群")
	c.Kind = "group"
	// 待取原图的图片在最近 10 条之外：不再挪动停止点，也不算待取
	c.Messages = []Message{imageMsg("")}
	for i := 0; i < originalWindow; i++ {
		c.Messages = append(c.Messages, Message{Text: fmt.Sprint(i), Direction: "incoming"})
	}
	if c.firstPendingOriginal() != -1 || strings.Join(autoReadUntil(c), ",") != "7,8,9" {
		t.Fatalf("old images should not pull the stop point back: %v", autoReadUntil(c))
	}
	// 只为补取原图的读取：距上次读取不足 1 分钟不安排
	c.OriginalsDue = true
	c.LastRead = now()
	a.mu.Unlock()
	if a.scheduleAutoRead("p1") {
		t.Fatal("originals backfill must wait a minute")
	}
	// 满 1 分钟后安排，但排在新消息提示之后
	a.mu.Lock()
	c.LastRead = time.Now().Add(-2 * originalsReadGap).UTC().Format(time.RFC3339Nano)
	other := a.conversationLocked("acc", "小王")
	other.NeedsRead = true
	other.LastRead = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	a.mu.Unlock()
	if !a.scheduleAutoRead("p1") || other.NeedsRead || !c.OriginalsDue {
		t.Fatal("notification read should go first")
	}
	if !a.scheduleAutoRead("p1") || c.OriginalsDue {
		t.Fatal("originals backfill should be scheduled after a minute")
	}
	for _, op := range a.state.Operations {
		if op.ConversationID == c.ID && op.Reason != "originals" {
			t.Fatalf("reason should be originals: %+v", op)
		}
	}
}

func TestClearHistoryOnlyLocalAndNoReimport(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	c := a.conversationLocked("acc", "小王")
	c.Kind = "person"
	thumb := tinyJPEG(t, 10, 10)
	shared := tinyJPEG(t, 12, 12)
	a.mergeOrAppendLocked(c, json.RawMessage(`{"messages":[{"text":"a","direction":"incoming"},{"text":"[图片]","kind":"image","direction":"incoming","thumbnail":"`+thumb+`"},{"text":"b","direction":"outgoing"}]}`))
	// 另一个会话里有同一张图：删除时不能删掉这个文件
	other := a.conversationLocked("acc", "小李")
	a.mergeOrAppendLocked(other, json.RawMessage(`{"messages":[{"text":"[图片]","kind":"image","direction":"incoming","thumbnail":"`+shared+`"}]}`))
	a.mergeOrAppendLocked(c, json.RawMessage(`{"messages":[{"text":"b","direction":"outgoing"},{"text":"[图片]","kind":"image","direction":"incoming","thumbnail":"`+shared+`"}]}`))
	own, _ := a.mediaPath(c.Messages[1].ImageHash)
	common, _ := a.mediaPath(other.Messages[0].ImageHash)
	// 有读取正在执行时也可以删
	a.state.Operations["r"] = &Operation{ID: "r", ConversationID: c.ID, Kind: "read", Limit: 100, Status: "running", Created: now()}
	if err := a.commitLocked(); err != nil {
		t.Fatal(err)
	}
	a.mu.Unlock()
	if w := call(a, "POST", "/api/conversations/"+c.ID+"/clear", `{}`, ""); w.Code != 200 {
		t.Fatalf("clear failed: %d %s", w.Code, w.Body)
	}
	// 删除前开始的那次读取现在才回来：屏幕上的旧消息不再导入，只追加删除之后的新消息
	a.mu.Lock()
	late := `{"messages":[{"text":"a","direction":"incoming"},{"text":"[图片]","kind":"image","direction":"incoming"},{"text":"b","direction":"outgoing"},{"text":"[图片]","kind":"image","direction":"incoming"},{"text":"新","direction":"incoming"}],"stop_reason":"limit_reached"}`
	a.finishLocked(a.state.Operations["r"], "succeeded", json.RawMessage(late), "")
	if texts(c) != "新" || c.Unread != 1 {
		t.Fatalf("in-flight read must not bring back cleared messages: %s unread=%d", texts(c), c.Unread)
	}
	// 再删一次，后面按删空的状态继续检查
	a.clearHistoryLocked(c)
	_ = a.commitLocked()
	a.mu.Unlock()
	if _, err := os.Stat(own); !os.IsNotExist(err) {
		t.Fatal("image used only by the cleared messages should be removed")
	}
	if _, err := os.Stat(common); err != nil {
		t.Fatal("image still used by another conversation must be kept")
	}

	b := reopen(t, a)
	got := b.state.Conversations[c.ID]
	var rows int
	b.store.db.QueryRow("SELECT count(*) FROM messages WHERE conversation_id = ?", c.ID).Scan(&rows)
	if len(got.Messages) != 0 || rows != 0 || got.Kind != "person" || got.Unread != 0 {
		t.Fatalf("history should be cleared but the conversation kept: %+v rows=%d", got, rows)
	}
	// 之后读到的屏幕里还有旧消息：只追加衔接点之后的新消息
	b.mu.Lock()
	defer b.mu.Unlock()
	if strings.Join(autoReadUntil(got), ",") != "a,b,新" {
		t.Fatalf("anchor should provide stop texts: %v", autoReadUntil(got))
	}
	screen := `{"messages":[{"text":"b","direction":"outgoing"},{"text":"[图片]","kind":"image","direction":"incoming"},{"text":"新","direction":"incoming"},{"text":"c","direction":"incoming"}]}`
	if !b.mergeLocked(got, json.RawMessage(screen)) {
		t.Fatal("screen should align with the anchor")
	}
	if texts(got) != "c" {
		t.Fatalf("old messages must not be imported again: %s", texts(got))
	}
}

func TestOfficialAccountsIgnored(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	a.ingestLocked(PhoneEvent{Kind: "unread_chat", Account: "acc", Chat: "公众号"})
	a.conversationLocked("acc", "小王")
	a.mu.Unlock()
	if len(a.state.Conversations) != 1 {
		t.Fatal("公众号 should be ignored")
	}
	if w := call(a, "POST", "/api/conversations", `{"account":"acc","title":"公众号","kind":"person"}`, ""); w.Code != 400 {
		t.Fatalf("adding 公众号 manually should be rejected: %d", w.Code)
	}
}

func TestOperationsRouteToTheAccountsPhone(t *testing.T) {
	phoneA, phoneB := &fakePhone{status: "succeeded", result: `{"messages":[],"account":"A"}`}, &fakePhone{status: "succeeded", result: `{"messages":[],"account":"B"}`}
	a := testApp(t)
	a.mu.Lock()
	a.state.Phones = []*PhoneConfig{{ID: "pa", Token: strings.Repeat("t", 32), Account: "A"}, {ID: "pb", Token: strings.Repeat("t", 32), Account: "B"}}
	a.syncPhonesLocked()
	linkPhone(a, "pa", phoneA)
	linkPhone(a, "pb", phoneB)
	// 同名会话在不同账号下是不同的会话
	ca, cb, orphan := a.conversationLocked("A", "小王"), a.conversationLocked("B", "小王"), a.conversationLocked("C", "小王")
	if ca.ID == cb.ID || ca.ID == orphan.ID {
		t.Fatal("same title in different accounts must be different conversations")
	}
	for _, c := range []*Conversation{ca, cb, orphan} {
		a.state.Operations["r-"+c.Account] = &Operation{ID: "r-" + c.Account, ConversationID: c.ID, Kind: "read", Limit: 5, Status: "queued", Created: now()}
	}
	a.mu.Unlock()
	// 手机 B 只拿账号 B 的任务；账号 C 没有手机，任务直接失败
	if id := a.nextOperation("pb"); id != "r-B" {
		t.Fatalf("phone B should take B's operation, got %q", id)
	}
	if op := a.state.Operations["r-C"]; op.Status != "failed" || !strings.Contains(op.Error, "C") {
		t.Fatalf("operation without a phone should fail: %+v", op)
	}
	a.runOperation(context.Background(), "pb", "r-B")
	if phoneB.lastBody["account"] != "B" || phoneA.posts.Load() != 0 || a.state.Operations["r-B"].PhoneID != "pb" {
		t.Fatalf("B's read should go to phone B with the expected account: %v", phoneB.lastBody)
	}
	if id := a.nextOperation("pb"); id != "" {
		t.Fatalf("phone B must not take A's operation: %q", id)
	}
	if id := a.nextOperation("pa"); id != "r-A" {
		t.Fatalf("phone A should take A's operation: %q", id)
	}
	// 手机 A 执行时已换成别的账号：读到的内容不属于这个会话，不保存
	phoneA.result = `{"messages":[{"text":"别人的消息","direction":"incoming"}],"account":"X"}`
	a.runOperation(context.Background(), "pa", "r-A")
	if op := a.state.Operations["r-A"]; op.Status != "failed" || len(ca.Messages) != 0 {
		t.Fatalf("result from another account must not be merged: %+v %s", op, texts(ca))
	}
}

func TestEventsBelongToTheReportedAccount(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ingestLocked(PhoneEvent{Kind: "notification", Account: "B", Chat: "小王", Text: "hi"})
	a.ingestLocked(PhoneEvent{Kind: "notification", Chat: "小张", Text: "hi"}) // 手机还没识别出账号：丢弃
	accounts := map[string]string{}
	for _, c := range a.state.Conversations {
		accounts[c.Title] = c.Account
	}
	if accounts["小王"] != "B" || len(accounts) != 1 {
		t.Fatalf("events should go to the reported account; unknown account dropped: %v", accounts)
	}
}

func TestPhonesAPI(t *testing.T) {
	a := testApp(t)
	token := strings.Repeat("s", 32)
	a.mu.Lock()
	a.state.Phones = []*PhoneConfig{{ID: "p1", DeviceID: "dev", Token: token, Account: "A"}}
	a.syncPhonesLocked()
	a.mu.Unlock()
	if body := call(a, "GET", "/api/state", "", "").Body.String(); strings.Contains(body, token) {
		t.Fatalf("state must not expose phone tokens: %s", body)
	}
	if w := call(a, "POST", "/api/phones/p1/name", `{"name":" 前台手机 "}`, ""); w.Code != 200 || a.state.Phones[0].Name != "前台手机" {
		t.Fatalf("rename: %d %+v", w.Code, a.state.Phones[0])
	}
	// 新建会话必须选一个已知账号
	if w := call(a, "POST", "/api/conversations", `{"account":"nobody","title":"小王","kind":"person"}`, ""); w.Code != 400 {
		t.Fatalf("unknown account should be rejected: %d", w.Code)
	}
	a.mu.Lock()
	c := a.conversationLocked("A", "小王")
	a.state.Operations["busy"] = &Operation{ID: "busy", ConversationID: c.ID, Kind: "send", Status: "running", PhoneID: "p1", Created: now()}
	a.mu.Unlock()
	if w := call(a, "POST", "/api/phones/p1/delete", `{}`, ""); w.Code != 409 {
		t.Fatalf("phone with a running task must not be deleted: %d", w.Code)
	}
	a.mu.Lock()
	a.state.Operations["busy"].Status = "unknown"
	a.mu.Unlock()
	if w := call(a, "POST", "/api/phones/p1/delete", `{}`, ""); w.Code != 200 || len(a.state.Phones) != 0 || len(a.phones) != 0 {
		t.Fatalf("delete: %d", w.Code)
	}
	// 删除手机后账号和会话仍在，可以查看记录
	body := call(a, "GET", "/api/state", "", "").Body.String()
	if !strings.Contains(body, `"wechat_id":"A"`) || a.state.Conversations[c.ID] == nil {
		t.Fatalf("account with history should remain listed: %s", body)
	}
}

// screen 生成一屏消息：每项是“发送人：文字”，没有冒号时发送人为空；以“我：”开头的是发出的。
func screen(items ...string) json.RawMessage {
	var out []observedMessage
	for _, item := range items {
		m := observedMessage{Text: item, Direction: "incoming"}
		if sender, text, ok := strings.Cut(item, "："); ok {
			m.Sender, m.Text = sender, text
		}
		if m.Sender == "我" {
			m.Sender, m.Direction = "", "outgoing"
		}
		out = append(out, m)
	}
	b, _ := json.Marshal(map[string]any{"messages": out, "captured_at": now()})
	return b
}

// forwards 返回目标会话的转发任务文字（按创建时间排序，图片显示为 img:哈希）。
func forwards(a *App, targetID string) []string {
	var ops []*Operation
	for _, op := range a.state.Operations {
		if op.ConversationID == targetID && op.ForwardRule != "" {
			ops = append(ops, op)
		}
	}
	sort.Slice(ops, func(i, j int) bool { return ops[i].Created < ops[j].Created })
	var out []string
	for _, op := range ops {
		if op.ImageHash != "" {
			out = append(out, "img:"+op.ImageHash)
		} else {
			out = append(out, op.Text)
		}
	}
	return out
}

func forwardApp(t *testing.T) (*App, *Conversation, *Conversation) {
	phone := &fakePhone{status: "succeeded", result: `{}`}
	a, source := appWithPhone(t, phone)
	a.mu.Lock()
	target := a.conversationLocked("acc", "转发群")
	target.Kind = "group"
	a.mu.Unlock()
	return a, source, target
}

func TestForwardFiltersFormatAndOrder(t *testing.T) {
	a, source, target := forwardApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	rule := ForwardRule{ID: "r1", Enabled: true, Sources: []string{source.ID}, Targets: []string{target.ID},
		Senders: []string{"张三，李四"}, Include: []string{"京东, 淘宝"}, Exclude: []string{"广告"}, Template: "【{chat}】{sender}：{text}"}
	if err := rule.validate(a.state.Conversations); err != nil {
		t.Fatal(err)
	}
	a.state.ForwardRules = []ForwardRule{rule}
	a.mergeOrAppendLocked(source, screen("张三：京东 旧消息"))
	if a.forwardLocked() {
		t.Fatal("messages present before the first check must not be forwarded")
	}
	a.mergeLocked(source, screen("张三：京东 旧消息", "张三：京东 好价 {sender}", "王五：京东 别人发的", "李四：淘宝 广告", "我：京东 自己发的", "李四：淘宝 好价"))
	if !a.forwardLocked() {
		t.Fatal("matching messages should be forwarded")
	}
	got := strings.Join(forwards(a, target.ID), "|")
	if got != "【家人群】张三：京东 好价 {sender}|【家人群】李四：淘宝 好价" {
		t.Fatalf("forwarded: %s", got)
	}
	if a.forwardLocked() {
		t.Fatal("same messages must not be forwarded twice")
	}
	// 与之前记录没能衔接的批次可能是重复的，不转发
	a.mergeOrAppendLocked(source, screen("张三：京东 缺口后"))
	if a.forwardLocked() {
		t.Fatal("gap batch must not be forwarded")
	}
	// 关闭规则后的新消息不转发，重新开启后也不补发
	a.state.ForwardRules[0].Enabled = false
	a.mergeLocked(source, screen("张三：京东 缺口后", "张三：京东 关闭期间"))
	a.forwardLocked()
	a.state.ForwardRules[0].Enabled = true
	if a.forwardLocked() {
		t.Fatal("messages received while the rule was off must not be forwarded later")
	}
}

func TestForwardDedupAcrossSourcesAndRegex(t *testing.T) {
	a, source, target := forwardApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	other := a.conversationLocked("acc", "线报2群")
	other.Kind = "group"
	rule := ForwardRule{ID: "r1", Enabled: true, Sources: []string{source.ID, other.ID}, Targets: []string{target.ID}, Regex: `\d+元`, DedupMinutes: 30}
	if err := rule.validate(a.state.Conversations); err != nil {
		t.Fatal(err)
	}
	a.state.ForwardRules = []ForwardRule{rule}
	a.forwardLocked()
	a.mergeOrAppendLocked(source, screen("甲：纸巾 9元", "甲：没有价格"))
	a.mergeOrAppendLocked(other, screen("乙：纸巾 9元", "乙：牙膏 5元"))
	a.forwardLocked()
	if got := strings.Join(forwards(a, target.ID), "|"); got != "纸巾 9元|牙膏 5元" {
		t.Fatalf("dedup/regex: %s", got)
	}
}

func TestForwardImageWaitsForOriginal(t *testing.T) {
	a, source, target := forwardApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.state.ForwardRules = []ForwardRule{{ID: "r1", Enabled: true, Sources: []string{source.ID}, Targets: []string{target.ID}, Images: true}}
	a.forwardLocked()
	thumb := tinyJPEG(t, 10, 10)
	a.mergeOrAppendLocked(source, json.RawMessage(`{"messages":[{"text":"[图片]","kind":"image","direction":"incoming","thumbnail":"`+thumb+`"},{"text":"图后文字","direction":"incoming"}],"captured_at":"`+now()+`"}`))
	if a.forwardLocked() {
		t.Fatal("image should wait for its original, and keep later messages in order")
	}
	source.Messages[0].OriginalHash = strings.Repeat("a", 64)
	a.forwardLocked()
	if got := strings.Join(forwards(a, target.ID), "|"); got != "img:"+strings.Repeat("a", 64)+"|图后文字" {
		t.Fatalf("forwarded: %s", got)
	}
	// 等原图超时：用缩略图转发
	a.mergeLocked(source, json.RawMessage(`{"messages":[{"text":"图后文字","direction":"incoming"},{"text":"[图片]","kind":"image","direction":"incoming","thumbnail":"`+thumb+`"}],"captured_at":"`+stamp(time.Now().Add(-imageWaitLimit))+`"}`))
	a.forwardLocked()
	if got := forwards(a, target.ID); len(got) != 3 || got[2] != "img:"+source.Messages[2].ImageHash {
		t.Fatalf("thumbnail after timeout: %v", got)
	}
}

func TestForwardSendsThroughTargetPhone(t *testing.T) {
	phone := &fakePhone{status: "succeeded", result: `{}`}
	a, source := appWithPhone(t, phone)
	a.mu.Lock()
	target := a.conversationLocked("acc", "小王")
	target.Kind = "person"
	a.state.ForwardRules = []ForwardRule{{ID: "r1", Enabled: true, Sources: []string{source.ID}, Targets: []string{target.ID}}}
	a.forwardLocked()
	a.mergeOrAppendLocked(source, screen("张三：转给小王"))
	a.forwardLocked()
	a.mu.Unlock()
	runAll(a)
	if phone.lastBody["chat"] != "小王" || phone.lastBody["text"] != "转给小王" || phone.lastBody["chat_type"] != nil {
		t.Fatalf("phone body: %v", phone.lastBody)
	}
	// 目标会话里转发出去的是“发出的”消息，不会再被转发回来
	a.mu.Lock()
	defer a.mu.Unlock()
	a.state.ForwardRules = append(a.state.ForwardRules, ForwardRule{ID: "r2", Enabled: true, Sources: []string{target.ID}, Targets: []string{source.ID}})
	a.forwardLocked()
	a.mergeOrAppendLocked(target, screen("我：转给小王"))
	if a.forwardLocked() {
		t.Fatal("outgoing messages must not be forwarded back")
	}
}

func TestForwardBacklogAndMissingPhone(t *testing.T) {
	a, source, target := forwardApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.state.ForwardRules = []ForwardRule{{ID: "r1", Enabled: true, Sources: []string{source.ID}, Targets: []string{target.ID}}}
	a.forwardLocked()
	var lines []string
	for i := 0; i < maxForwardBacklog+5; i++ {
		lines = append(lines, fmt.Sprintf("甲：第%d条", i))
	}
	a.mergeOrAppendLocked(source, screen(lines...))
	a.forwardLocked()
	if n := len(forwards(a, target.ID)); n != maxForwardBacklog || a.forwardStatus["r1"].Problem == "" {
		t.Fatalf("backlog should cap at %d: %d %+v", maxForwardBacklog, n, a.forwardStatus["r1"])
	}
	other := a.conversationLocked("另一个号", "外部群")
	other.Kind = "group"
	a.state.ForwardRules[0].Targets = []string{other.ID}
	a.mergeLocked(source, screen("甲：第24条", "甲：新的"))
	a.forwardLocked()
	if len(forwards(a, other.ID)) != 0 || !strings.Contains(a.forwardStatus["r1"].Problem, "没有连接的手机") {
		t.Fatalf("no phone for the target account: %+v", a.forwardStatus["r1"])
	}
}

func TestForwardAPI(t *testing.T) {
	a, source, target := forwardApp(t)
	post := func(rule string) *httptest.ResponseRecorder {
		return call(a, "POST", "/api/forward/rule", rule, "")
	}
	if w := post(`{"enabled":true,"sources":["` + source.ID + `"],"targets":["` + source.ID + `"]}`); w.Code != 400 {
		t.Fatalf("target equal to source: %d", w.Code)
	}
	a.mu.Lock()
	unknown := a.conversationLocked("acc", "没分类")
	a.mu.Unlock()
	if w := post(`{"enabled":true,"sources":["` + source.ID + `"],"targets":["` + unknown.ID + `"]}`); w.Code != 400 || !strings.Contains(w.Body.String(), "类型") {
		t.Fatalf("target without kind: %d %s", w.Code, w.Body)
	}
	if w := post(`{"enabled":true,"sources":["` + source.ID + `"],"targets":["` + target.ID + `"],"regex":"("}`); w.Code != 400 {
		t.Fatalf("bad regex: %d", w.Code)
	}
	if w := post(`{"name":"线报","enabled":true,"sources":["` + source.ID + `"],"targets":["` + target.ID + `"],"regex":"元$","include":["京东，淘宝"]}`); w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	w := call(a, "GET", "/api/forward", "", "")
	var got struct {
		Rules []forwardRuleView `json:"rules"`
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	if len(got.Rules) != 1 || got.Rules[0].ID == "" || strings.Join(got.Rules[0].Include, "|") != "京东|淘宝" {
		t.Fatalf("get: %s", w.Body)
	}
	// 重启后规则还在，正则重新编译
	b := reopen(t, a)
	r := b.state.ForwardRules[0]
	if r.ID != got.Rules[0].ID || !r.accepts(Message{Text: "京东 9元"}) || r.accepts(Message{Text: "京东 9元起"}) {
		t.Fatalf("rule after restart: %+v", r)
	}
}

func TestForwardDedupOnlyAfterForwarded(t *testing.T) {
	a, source, _ := forwardApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	offline := a.conversationLocked("另一个号", "外部群")
	offline.Kind = "group"
	a.state.ForwardRules = []ForwardRule{{ID: "r1", Enabled: true, Sources: []string{source.ID}, Targets: []string{offline.ID}, DedupMinutes: 30}}
	a.forwardLocked()
	a.mergeOrAppendLocked(source, screen("甲：好价"))
	a.forwardLocked()
	// 目标账号的手机连上之后，相同内容再出现时应该能转发
	a.state.Phones = append(a.state.Phones, &PhoneConfig{ID: "p2", Token: strings.Repeat("t", 32), Account: "另一个号"})
	a.mergeLocked(source, screen("甲：好价", "乙：好价"))
	a.forwardLocked()
	if got := forwards(a, offline.ID); len(got) != 1 || got[0] != "好价" {
		t.Fatalf("message not forwarded earlier must not be treated as a duplicate: %v", got)
	}
}

func TestEmptyListsAreJSONArrays(t *testing.T) {
	a := testApp(t)
	for _, path := range []string{"/api/state", "/api/debug"} {
		var body map[string]json.RawMessage
		json.Unmarshal(call(a, "GET", path, "", "").Body.Bytes(), &body)
		for _, key := range []string{"operations", "ai_jobs", "conversations", "phones"} {
			if v, ok := body[key]; ok && string(v) == "null" {
				t.Fatalf("%s %s must be [] for the web page, got null", path, key)
			}
		}
	}
}
