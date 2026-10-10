package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReadingSettingsPersistAndValidate(t *testing.T) {
	a := testApp(t)
	if a.state.NewMessagesOnly {
		t.Fatal("old behavior must remain default")
	}
	c := a.conversationLocked("acc", "小王")
	a.mergeLocked(c, snapshotJSON("saved"), true)
	for _, body := range []string{`{}`, `{"read_history":"false"}`, `{"read_history":null}`} {
		if w := call(a, "POST", "/api/reading", body, ""); w.Code != 400 {
			t.Fatalf("invalid request accepted: %s", body)
		}
	}
	if w := call(a, "POST", "/api/reading", `{"read_history":false}`, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	a.mergeModeLocked(c, snapshotJSON("saved", "new1"), false, true)
	a.mergeLocked(c, snapshotJSON("saved", "new1"), false)
	if texts(c) != "saved,new1" {
		t.Fatal(texts(c))
	}
	if err := a.commitLocked(); err != nil {
		t.Fatal(err)
	}
	b, err := newApp(a.path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.store.db.Close()
	if !b.state.NewMessagesOnly {
		t.Fatal("setting lost on restart")
	}
	d := b.state.Conversations[c.ID]
	b.mergeLocked(d, snapshotJSON("new1", "new2"), false)
	if texts(d) != "saved,new1,new2" {
		t.Fatal(texts(d))
	}
	if w := call(b, "POST", "/api/reading", `{"read_history":true}`, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if b.state.NewMessagesOnly || !d.LiveReady {
		t.Fatal("failed to restore history mode")
	}
}

func TestLiveSnapshotsIgnoreHistoryAndRecoverWithoutDeepRead(t *testing.T) {
	a := testApp(t)
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	a.mergeLocked(c, snapshotJSON("passive history"), false)
	if len(c.LiveAnchor) != 0 {
		t.Fatal("passive history must not initialize baseline")
	}
	a.mergeModeLocked(c, snapshotJSON("old1", "old2"), false, true)
	if len(c.Messages) != 0 {
		t.Fatal("first window imported old messages")
	}
	a.mergeLocked(c, snapshotJSON("old2", "new1"), false)
	a.mergeLocked(c, snapshotJSON("old1", "old2"), false)
	a.mergeLocked(c, snapshotJSON("ancient1", "ancient2"), false)
	a.mergeLocked(c, snapshotJSON("new1", "new2"), false)
	a.mergeLocked(c, snapshotJSON("new1", "new2"), false)
	if texts(c) != "new1,new2" {
		t.Fatal(texts(c))
	}
	op := &Operation{ID: "live", ConversationID: c.ID, Kind: "read", NewMessagesOnly: true, Auto: true, Limit: 30}
	a.state.Operations[op.ID] = op
	a.finishLocked(op, "succeeded", snapshotJSON("gap1", "gap2"), "")
	if len(a.state.Operations) != 1 || texts(c) != "new1,new2,|gap1,gap2" || c.ReadWarning == "" {
		t.Fatal("current screen lost or deep read queued")
	}
	a.mergeLocked(c, snapshotJSON("gap2", "new3"), false)
	if texts(c) != "new1,new2,|gap1,gap2,new3" {
		t.Fatal(texts(c))
	}
	old := &Operation{ID: "old", ConversationID: c.ID, Kind: "read"}
	a.finishLocked(old, "succeeded", snapshotJSON("history"), "")
	if len(old.Warnings) != 1 || texts(c) != "new1,new2,|gap1,gap2,new3" {
		t.Fatal("in-flight old mode result was accepted")
	}
}

func TestLiveModeDoesNotScheduleHistoricalOriginals(t *testing.T) {
	a := testApp(t)
	addTestPhone(a, "http://phone.test")
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	c.OriginalsDue = true
	if a.scheduleAutoRead("p1") {
		t.Fatal("historical originals scheduled")
	}
	c.NeedsRead = true
	if !a.scheduleAutoRead("p1") {
		t.Fatal("new message trigger ignored")
	}
}

func TestLiveReadReachesPhoneAndRejectsOldBridge(t *testing.T) {
	for _, supported := range []bool{true, false} {
		t.Run(map[bool]string{true: "supported", false: "legacy"}[supported], func(t *testing.T) {
			posted := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					posted = true
					var body map[string]any
					json.NewDecoder(r.Body).Decode(&body)
					if body["read_history"] != false {
						t.Errorf("read mode not propagated: %v", body)
					}
					w.Header().Set("Content-Type", "application/json")
					w.Write([]byte(`{"id":"phone-task","status":"succeeded","result":{"messages":[]}}`))
				} else {
					w.Write([]byte(`{"id":"phone-task","status":"succeeded","result":{"messages":[]}}`))
				}
			}))
			defer server.Close()
			a := testApp(t)
			addTestPhone(a, server.URL)
			a.state.NewMessagesOnly = true
			a.phones["p1"].device = json.RawMessage(`{"info":{"read_history_control":false}}`)
			if supported {
				a.phones["p1"].device = json.RawMessage(`{"info":{"read_history_control":true}}`)
			}
			c := a.conversationLocked("acc", "小王")
			op := &Operation{ID: "read-live", ConversationID: c.ID, Kind: "read", Limit: 30, Status: "queued"}
			a.state.Operations[op.ID] = op
			a.runOperation(context.Background(), "p1", op.ID)
			if supported && (!posted || op.Status != "succeeded") {
				t.Fatalf("read failed: %+v", op)
			}
			if !supported && (posted || op.Status != "failed") {
				t.Fatal("old bridge must not receive a read it cannot honor")
			}
		})
	}
}

func TestLiveEmptyChatKeepsFirstNewMessage(t *testing.T) {
	a := testApp(t)
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "empty")
	a.mergeModeLocked(c, snapshotJSON(), false, true)
	a.mergeLocked(c, snapshotJSON("first new"), false)
	if texts(c) != "first new" {
		t.Fatal("first new message in empty chat was lost")
	}
}

func TestReadModeSwitchDoesNotReadEveryChatAndDropsStaleSignals(t *testing.T) {
	a := testApp(t)
	p := &PhoneConfig{Account: "acc"}
	quiet := a.conversationLocked("acc", "很久以前有未读")
	a.ingestLocked(p, PhoneEvent{Kind: "unread_chat", Chat: quiet.Title, UnreadCount: 30})
	// 历史模式读完：之前的提示已处理
	op := &Operation{ID: "r", Kind: "read", Auto: true, ConversationID: quiet.ID, Limit: 30, Status: "running", Created: now()}
	a.state.Operations[op.ID] = op
	a.finishLocked(op, "succeeded", json.RawMessage(`{"messages":[]}`), "")
	if quiet.LiveSignal || quiet.LiveUnread != 0 {
		t.Fatal("history read should clear live signals")
	}
	quiet.NeedsRead = false
	pending := a.conversationLocked("acc", "还没读")
	a.ingestLocked(p, PhoneEvent{Kind: "unread_chat", Chat: pending.Title, UnreadCount: 2})
	idle := a.conversationLocked("acc", "旧提示")
	idle.LiveSignal, idle.LiveUnread = true, 30 // 旧版本留下的过时提示
	if w := call(a, "POST", "/api/reading", `{"read_history":false}`, ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if quiet.NeedsRead || idle.NeedsRead {
		t.Fatal("switching modes must not queue reads for every conversation")
	}
	if idle.LiveSignal || idle.LiveUnread != 0 || !pending.LiveSignal || pending.LiveUnread != 2 {
		t.Fatalf("stale signals should be dropped and pending ones kept: idle=%v/%d pending=%v/%d", idle.LiveSignal, idle.LiveUnread, pending.LiveSignal, pending.LiveUnread)
	}
}

// 仅新增模式的自动读取只把上次读到的最后 1 条文字交给手机作停止点，少翻页。
func TestLiveAutoReadStopsAtLastKnownText(t *testing.T) {
	var until any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			until = body["until"]
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"phone-task","status":"succeeded","result":{"messages":[]}}`))
	}))
	defer server.Close()
	a := testApp(t)
	addTestPhone(a, server.URL)
	a.state.NewMessagesOnly = true
	a.phones["p1"].device = json.RawMessage(`{"info":{"read_history_control":true}}`)
	c := a.conversationLocked("acc", "小王")
	c.LiveAnchor = []Message{{Text: "a"}, {Text: "b"}, {Text: "[图片]", Kind: "image"}, {Text: "c"}, {Text: "[图片]", Kind: "image"}}
	op := &Operation{ID: "read-live", ConversationID: c.ID, Kind: "read", Limit: 30, Auto: true, Status: "queued"}
	a.state.Operations[op.ID] = op
	a.runOperation(context.Background(), "p1", op.ID)
	if got, _ := json.Marshal(until); string(got) != `["c"]` {
		t.Fatalf("until=%s", got)
	}
}
