package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	a.mergeLocked(c, snapshotJSON("a", "b"), false)
	a.mergeLocked(c, snapshotJSON("b", "c"), false)
	if got := texts(c); got != "a,b,c" || c.Unread != 3 || c.LastSeq != 3 {
		t.Fatalf("aligned merge: %s unread=%d seq=%d", got, c.Unread, c.LastSeq)
	}
	a.mergeLocked(c, snapshotJSON("old1", "old2"), false) // 用户翻到历史位置：忽略
	if got := texts(c); got != "a,b,c" {
		t.Fatalf("monitor window should be ignored: %s", got)
	}
	a.mergeLocked(c, snapshotJSON("x", "y"), true) // 读取任务：整窗追加并标记缺口
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

func TestLegacyStateMigration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	legacy := `{"seen":{"e1":true},"config":{"phone_url":"http://p:8766","token":"t"},"conversations":{"x":{"id":"x","title":"群","kind":"group","body_cursor":1,
		"messages":[{"id":"n","text":"通知","source":"android_notification"},{"id":"b","seq":1,"text":"正文","source":"chat_body"}]}}}`
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	a, err := newApp(filepath.Join(dir, "wechat.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err = a.importJSON(path); err != nil {
		t.Fatal(err)
	}
	b := reopen(t, a)
	if got := texts(b.state.Conversations["x"]); got != "正文" || len(b.state.Phones) != 1 || b.state.Phones[0].URL != "http://p:8766" {
		t.Fatalf("legacy data should be imported (notifications dropped): %s %+v", got, b.state.Phones)
	}
	if _, err := os.Stat(path + ".migrated"); err != nil {
		t.Fatal("legacy file should be kept as .migrated")
	}
}

func TestSQLiteRoundTrip(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	c := a.conversationLocked("acc", "小王")
	c.Kind = "person"
	a.mergeLocked(c, snapshotJSON("a", "b"), true)
	window := `{"messages":[{"text":"b","direction":"incoming"},{"text":"[图片]","kind":"image","direction":"incoming"}]}`
	a.mergeLocked(c, json.RawMessage(window), true)
	// 之后补上这张图片的原图：只更新已有的那一行
	a.mergeLocked(c, json.RawMessage(`{"messages":[{"text":"[图片]","kind":"image","direction":"incoming","original_hash":"abc"}]}`), true)
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

// addTestPhone 添加一台编号 p1、登录着账号 acc、在线的手机（不启动事件循环）。调用方按需持有锁。
func addTestPhone(a *App, url string) {
	a.state.Phones = append(a.state.Phones, &PhoneConfig{ID: "p1", URL: url, Token: strings.Repeat("t", 32), Account: "acc"})
	a.syncPhonesLocked()
	a.phones["p1"].connection = "在线"
}

func appWithPhone(t *testing.T, phone *fakePhone) (*App, *Conversation) {
	server := httptest.NewServer(phone)
	t.Cleanup(server.Close)
	a := testApp(t)
	addTestPhone(a, server.URL)
	a.mu.Lock()
	c := a.conversationLocked("acc", "家人群")
	c.Kind = "group"
	a.mu.Unlock()
	return a, c
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
	a.mergeLocked(c, snapshotJSON("旧消息 @助手"), true)
	if a.nextAutoJobLocked() != "" {
		t.Fatal("messages present before the first check must not trigger")
	}
	a.mergeLocked(c, snapshotJSON("旧消息 @助手", "没有触发词"), true)
	if a.nextAutoJobLocked() != "" {
		t.Fatal("message without keyword must not trigger")
	}
	a.mergeLocked(c, snapshotJSON("没有触发词", "@助手 在吗"), true)
	if a.nextAutoJobLocked() == "" {
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
	addTestPhone(a, "http://phone.test")
	c := a.conversationLocked("acc", "小王")
	c.Kind = "person"
	c.AI = AISetting{Mode: "auto", IntervalSeconds: 5}
	a.mergeLocked(c, snapshotJSON("在吗"), true)
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
	addTestPhone(a, "http://phone.test")
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
	a.mergeLocked(c, snapshotJSON("a", "b"), true)
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
	a.mergeLocked(c, snapshotJSON("a", "b"), true)
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
	addTestPhone(a, "http://phone.test")
	a.mu.Lock()
	fresh := a.conversationLocked("acc", "新会话")
	fresh.NeedsRead = true
	a.mu.Unlock()
	if !a.scheduleAutoRead("p1") {
		t.Fatal("expected a read for the new conversation")
	}
	a.mu.Lock()
	known := a.conversationLocked("acc", "老会话")
	a.mergeLocked(known, snapshotJSON("a", "b"), true)
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
	a.mergeLocked(c, snapshotJSON("a"), true)
	op := &Operation{ID: "send", ConversationID: c.ID, Kind: "send", Text: "hi", Status: "running", Created: now()}
	a.state.Operations[op.ID] = op
	a.finishLocked(op, "succeeded", json.RawMessage(`{"snapshot":`+string(snapshotJSON("x", "hi"))+`}`), "")
	if texts(c) != "a" || !c.NeedsRead {
		t.Fatalf("unaligned send snapshot should request a read instead of appending: %s %v", texts(c), c.NeedsRead)
	}
}

func TestScheduleAutoReadPriority(t *testing.T) {
	a := testApp(t)
	addTestPhone(a, "http://phone.test")
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
	a.mergeLocked(c, snapshotJSON("a", "b", "c"), true)
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
	a.mergeLocked(c, json.RawMessage(window), true)
	if c.firstPendingOriginal() != 1 {
		t.Fatal("image should still be pending after one failure")
	}
	a.mergeLocked(c, json.RawMessage(window), true)
	if c.firstPendingOriginal() != -1 || c.Messages[1].OriginalTries != 2 {
		t.Fatalf("should give up after two failures: %+v", c.Messages[1])
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
	a.mergeLocked(c, json.RawMessage(first), true)
	// 第二屏：同一条消息完整显示，补上发送人；后面是另一个人的表情
	second := `{"messages":[{"text":"好","direction":"incoming","sender":"李四"},{"text":"[表情]","kind":"sticker","direction":"incoming","sender":"李四","thumbnail":"` + avatar + `"}]}`
	if !a.mergeLocked(c, json.RawMessage(second), false) {
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

func TestOldDatabaseGetsSenderColumn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wechat.db")
	a, err := newApp(path)
	if err != nil {
		t.Fatal(err)
	}
	// 模拟旧版本的表结构：没有 sender 列
	for _, q := range []string{"DROP TABLE messages", strings.Replace(strings.Split(schema, "CREATE TABLE IF NOT EXISTS messages")[1], "sender          TEXT    NOT NULL DEFAULT '',", "", 1)} {
		if !strings.HasPrefix(q, "DROP") {
			q = "CREATE TABLE messages" + q
		}
		if _, err = a.store.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = a.store.db.Exec("INSERT INTO messages(conversation_id, seq, id, text, direction, time) VALUES('x', 1, 'x:1', '旧', 'incoming', '')"); err != nil {
		t.Fatal(err)
	}
	a.store.db.Close()
	b, err := newApp(path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.store.db.Close()
	var sender string
	if err = b.store.db.QueryRow("SELECT sender FROM messages WHERE id = 'x:1'").Scan(&sender); err != nil || sender != "" {
		t.Fatalf("sender column should be added with an empty default: %q %v", sender, err)
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
	// 旧版本存下的系统提示：方向未识别、没有类型
	c.Messages = []Message{{Seq: 1, Text: "a", Direction: "incoming"}, {Seq: 2, Text: "你的账号被限制与对方聊天，轻触了解详情", Direction: "unknown"}, {Seq: 3, Text: "被截断的普通消息", Direction: "unknown"}}
	c.LastSeq = 3
	for seq := int64(1); seq <= 3; seq++ {
		a.markMessage(c.ID, seq)
	}
	// 微信自己的系统通知不建会话；旧版本建过的空会话启动时删除
	a.ingestLocked(&PhoneConfig{Account: "acc"}, PhoneEvent{Kind: "notification", Chat: "微信", Text: "你有1条消息未发送"})
	if len(a.state.Conversations) != 1 {
		t.Fatal("system notification should not create a conversation")
	}
	junk := a.conversationLocked("acc", "微信")
	if err := a.commitLocked(); err != nil {
		t.Fatal(err)
	}
	a.mu.Unlock()

	b := reopen(t, a)
	got := b.state.Conversations[c.ID]
	if got.Messages[1].Kind != "system" || got.Messages[2].Kind != "" {
		t.Fatalf("legacy notice should become system, other unknown text unchanged: %+v", got.Messages)
	}
	if b.state.Conversations[junk.ID] != nil {
		t.Fatal("empty 微信 conversation should be removed")
	}
	if ts := lastTexts(got.Messages, 3); strings.Join(ts, ",") != "a,被截断的普通消息" {
		t.Fatalf("system notices must not be stop texts: %v", ts)
	}
	// 新读到的系统提示不改列表预览
	b.mu.Lock()
	defer b.mu.Unlock()
	got.Preview = "before"
	b.mergeLocked(got, json.RawMessage(`{"messages":[{"text":"被截断的普通消息","direction":"incoming"},{"text":"x撤回了一条消息","direction":"unknown","kind":"system"}]}`), true)
	if got.Preview != "before" || got.Messages[len(got.Messages)-1].Kind != "system" {
		t.Fatalf("system notice appended without changing preview: %q", got.Preview)
	}
	reopened, _ := b.store.db.Query("SELECT kind FROM messages WHERE conversation_id = ? AND seq = 2", c.ID)
	defer reopened.Close()
	var kind string
	if !reopened.Next() || reopened.Scan(&kind) != nil || kind != "system" {
		t.Fatalf("migrated kind should be saved: %q", kind)
	}
}

func TestOriginalsBackfillIsBoundedAndThrottled(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	addTestPhone(a, "http://phone.test")
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
	a.mergeLocked(c, json.RawMessage(`{"messages":[{"text":"a","direction":"incoming"},{"text":"[图片]","kind":"image","direction":"incoming","thumbnail":"`+thumb+`"},{"text":"b","direction":"outgoing"}]}`), true)
	// 另一个会话里有同一张图：删除时不能删掉这个文件
	other := a.conversationLocked("acc", "小李")
	a.mergeLocked(other, json.RawMessage(`{"messages":[{"text":"[图片]","kind":"image","direction":"incoming","thumbnail":"`+shared+`"}]}`), true)
	a.mergeLocked(c, json.RawMessage(`{"messages":[{"text":"b","direction":"outgoing"},{"text":"[图片]","kind":"image","direction":"incoming","thumbnail":"`+shared+`"}]}`), true)
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
	if !b.mergeLocked(got, json.RawMessage(screen), false) {
		t.Fatal("screen should align with the anchor")
	}
	if texts(got) != "c" {
		t.Fatalf("old messages must not be imported again: %s", texts(got))
	}
}

func TestOfficialAccountsIgnoredAndRemoved(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	a.ingestLocked(&PhoneConfig{Account: "acc"}, PhoneEvent{Kind: "unread_chat", Chat: "公众号"})
	if len(a.state.Conversations) != 0 {
		t.Fatal("公众号 should be ignored")
	}
	// 旧版本建过的公众号会话（带消息）启动时整个删除
	c := a.conversationLocked("acc", "公众号")
	a.mergeLocked(c, snapshotJSON("快讯"), true)
	if err := a.commitLocked(); err != nil {
		t.Fatal(err)
	}
	a.mu.Unlock()
	b := reopen(t, a)
	var rows int
	b.store.db.QueryRow("SELECT count(*) FROM messages").Scan(&rows)
	if len(b.state.Conversations) != 0 || rows != 0 {
		t.Fatalf("公众号 conversation and messages should be removed: %d rows=%d", len(b.state.Conversations), rows)
	}
	if w := call(b, "POST", "/api/conversations", `{"title":"公众号","kind":"person"}`, ""); w.Code != 400 {
		t.Fatalf("adding 公众号 manually should be rejected: %d", w.Code)
	}
}

func TestSinglePhoneDataMigratesToFirstAccount(t *testing.T) {
	a := testApp(t)
	// 模拟单手机版本的数据：settings 里的 phone / cursor，会话没有账号
	a.mu.Lock()
	old := a.conversationLocked("", "小王")
	a.mergeLocked(old, snapshotJSON("旧消息"), true)
	_ = a.commitLocked()
	a.mu.Unlock()
	for id, data := range map[string]string{"phone": `{"phone_url":"http://p:8766","token":"` + strings.Repeat("t", 32) + `"}`, "cursor": `42`} {
		if _, err := a.store.db.Exec("INSERT INTO settings(id, data) VALUES(?, ?)", id, data); err != nil {
			t.Fatal(err)
		}
	}
	b := reopen(t, a)
	if len(b.state.Phones) != 1 || !b.state.Phones[0].Legacy || b.state.Phones[0].Cursor != 42 {
		t.Fatalf("legacy phone should migrate: %+v", b.state.Phones)
	}
	var rows int
	b.store.db.QueryRow("SELECT count(*) FROM settings WHERE id IN ('phone', 'cursor')").Scan(&rows)
	if rows != 0 {
		t.Fatal("legacy settings rows should be removed after migration")
	}
	// 迁移来的手机第一次上报微信号：旧会话归到这个账号，会话编号不变
	p := b.state.Phones[0]
	b.setPhoneStatus(p.ID, "在线", json.RawMessage(`{"online":true,"info":{"ready":true,"account":{"wechat_id":"smallmouse-"}}}`), nil)
	got := b.state.Conversations[old.ID]
	if got == nil || got.Account != "smallmouse-" || p.Account != "smallmouse-" || p.Legacy {
		t.Fatalf("legacy conversations should be adopted: %+v %+v", got, p)
	}
	// 之后换成另一个账号：旧会话不再跟着走
	b.setPhoneStatus(p.ID, "在线", json.RawMessage(`{"info":{"account":{"wechat_id":"other"}}}`), nil)
	if got.Account != "smallmouse-" || p.Account != "other" {
		t.Fatalf("only the first account adopts legacy data: %+v", got)
	}
}

func TestOperationsRouteToTheAccountsPhone(t *testing.T) {
	phoneA, phoneB := &fakePhone{status: "succeeded", result: `{"messages":[],"account":"A"}`}, &fakePhone{status: "succeeded", result: `{"messages":[],"account":"B"}`}
	serverA, serverB := httptest.NewServer(phoneA), httptest.NewServer(phoneB)
	defer serverA.Close()
	defer serverB.Close()
	a := testApp(t)
	a.mu.Lock()
	a.state.Phones = []*PhoneConfig{{ID: "pa", URL: serverA.URL, Token: strings.Repeat("t", 32), Account: "A"}, {ID: "pb", URL: serverB.URL, Token: strings.Repeat("t", 32), Account: "B"}}
	a.syncPhonesLocked()
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
	p := &PhoneConfig{ID: "p", Account: "A"}
	a.ingestLocked(p, PhoneEvent{Kind: "notification", Account: "B", Chat: "小王", Text: "hi"})
	a.ingestLocked(p, PhoneEvent{Kind: "notification", Chat: "小李", Text: "hi"}) // 旧版手机桥：用手机当前账号
	a.ingestLocked(&PhoneConfig{ID: "q"}, PhoneEvent{Kind: "notification", Chat: "小张", Text: "hi"})
	accounts := map[string]string{}
	for _, c := range a.state.Conversations {
		accounts[c.Title] = c.Account
	}
	if accounts["小王"] != "B" || accounts["小李"] != "A" || len(accounts) != 2 {
		t.Fatalf("events should go to the reported account; unknown account dropped: %v", accounts)
	}
}

func TestPhonesAPI(t *testing.T) {
	a := testApp(t)
	token := strings.Repeat("s", 32)
	if w := call(a, "POST", "/api/phones", `{"phone_url":"192.168.0.2","token":"`+token+`"}`, ""); w.Code != 200 {
		t.Fatalf("add: %d %s", w.Code, w.Body)
	}
	if w := call(a, "POST", "/api/phones", `{"phone_url":"http://192.168.0.2:8766","token":"`+token+`"}`, ""); w.Code != 409 {
		t.Fatalf("same address twice should be rejected: %d", w.Code)
	}
	id := a.state.Phones[0].ID
	if w := call(a, "POST", "/api/phones/"+id, `{"phone_url":"192.168.0.3","token":""}`, ""); w.Code != 200 || a.state.Phones[0].Token != token || a.state.Phones[0].URL != "http://192.168.0.3:8766" {
		t.Fatalf("update should keep the token when blank: %d %+v", w.Code, a.state.Phones[0])
	}
	body := call(a, "GET", "/api/state", "", "").Body.String()
	if strings.Contains(body, token) || !strings.Contains(body, `"token_set":true`) {
		t.Fatalf("state must not expose phone tokens: %s", body)
	}
	// 新建会话必须选一个已知账号
	if w := call(a, "POST", "/api/conversations", `{"account":"nobody","title":"小王","kind":"person"}`, ""); w.Code != 400 {
		t.Fatalf("unknown account should be rejected: %d", w.Code)
	}
	a.mu.Lock()
	a.state.Phones[0].Account = "A"
	c := a.conversationLocked("A", "小王")
	a.state.Operations["busy"] = &Operation{ID: "busy", ConversationID: c.ID, Kind: "send", Status: "running", PhoneID: id, Created: now()}
	a.mu.Unlock()
	if w := call(a, "POST", "/api/phones/"+id+"/delete", `{}`, ""); w.Code != 409 {
		t.Fatalf("phone with a running task must not be deleted: %d", w.Code)
	}
	a.mu.Lock()
	a.state.Operations["busy"].Status = "unknown"
	a.mu.Unlock()
	if w := call(a, "POST", "/api/phones/"+id+"/delete", `{}`, ""); w.Code != 200 || len(a.state.Phones) != 0 || len(a.phones) != 0 {
		t.Fatalf("delete: %d", w.Code)
	}
	// 删除手机后账号和会话仍在，可以查看记录
	body = call(a, "GET", "/api/state", "", "").Body.String()
	if !strings.Contains(body, `"wechat_id":"A"`) || a.state.Conversations[c.ID] == nil {
		t.Fatalf("account with history should remain listed: %s", body)
	}
}
