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
	c := a.conversationLocked("小王")
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
	if got := texts(b.state.Conversations["x"]); got != "正文" || b.state.Phone.URL != "http://p:8766" {
		t.Fatalf("legacy data should be imported (notifications dropped): %s %+v", got, b.state.Phone)
	}
	if _, err := os.Stat(path + ".migrated"); err != nil {
		t.Fatal("legacy file should be kept as .migrated")
	}
}

func TestSQLiteRoundTrip(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	c := a.conversationLocked("小王")
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

func appWithPhone(t *testing.T, phone *fakePhone) (*App, *Conversation) {
	server := httptest.NewServer(phone)
	t.Cleanup(server.Close)
	a := testApp(t)
	a.state.Phone = PhoneConfig{URL: server.URL, Token: strings.Repeat("t", 32)}
	a.mu.Lock()
	c := a.conversationLocked("家人群")
	c.Kind = "group"
	a.mu.Unlock()
	return a, c
}

func runAll(a *App) {
	for id := a.nextOperation(); id != ""; id = a.nextOperation() {
		a.runOperation(context.Background(), id)
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
	c := a.conversationLocked("京东线报1群")
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
	c := a.conversationLocked("小王")
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
	a.state.Phone.Token = "secret-phone-token-0123456789abcdef"
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
	c := a.conversationLocked("小王")
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
	c := a.conversationLocked("小王")
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
	a.connection = "在线"
	a.mu.Lock()
	fresh := a.conversationLocked("新会话")
	fresh.NeedsRead = true
	a.mu.Unlock()
	if !a.scheduleAutoRead() {
		t.Fatal("expected a read for the new conversation")
	}
	a.mu.Lock()
	known := a.conversationLocked("老会话")
	a.mergeLocked(known, snapshotJSON("a", "b"), true)
	known.NeedsRead = true
	a.mu.Unlock()
	if !a.scheduleAutoRead() {
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
	c := a.conversationLocked("小王")
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
	a.connection = "在线"
	a.mu.Lock()
	timed := a.conversationLocked("定时")
	timed.ReadEvery = 60
	notified := a.conversationLocked("通知")
	notified.NeedsRead = true
	quiet := a.conversationLocked("安静")
	quiet.ReadEvery = 60
	quiet.LastRead = now()
	a.mu.Unlock()

	if !a.scheduleAutoRead() || notified.NeedsRead || notified.LastRead == "" {
		t.Fatal("notified conversation should be read first")
	}
	if !a.scheduleAutoRead() || timed.LastRead == "" {
		t.Fatal("due scheduled conversation should be read next")
	}
	if a.scheduleAutoRead() {
		t.Fatal("nothing else is due")
	}
	notified.NeedsRead = true
	if a.scheduleAutoRead() {
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
	c := a.conversationLocked("小王")
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

func TestGroupsSkipOriginalsByDefault(t *testing.T) {
	group := &Conversation{Kind: "group"}
	person := &Conversation{Kind: "person"}
	if group.wantsOriginals() || !person.wantsOriginals() {
		t.Fatal("default: contacts fetch originals, groups do not")
	}
	group.Originals = "on"
	if !group.wantsOriginals() {
		t.Fatal("explicit on")
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
