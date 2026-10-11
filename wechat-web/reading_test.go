package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestReadingSettingsPersistAndValidate(t *testing.T) {
	a := testApp(t)
	if a.state.NewMessagesOnly {
		t.Fatal("old behavior must remain default")
	}
	c := a.conversationLocked("acc", "小王")
	a.mergeOrAppendLocked(c, snapshotJSON("saved"))
	for _, body := range []string{`{}`, `{"read_history":"false"}`, `{"read_history":null}`} {
		if w := call(a, "POST", "/api/system-settings", body, ""); w.Code != 400 {
			t.Fatalf("invalid request accepted: %s", body)
		}
	}
	if w := setReadHistory(a, false); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	a.mergeLatestLocked(c, snapshotJSON("saved", "new1"))
	a.mergeLocked(c, snapshotJSON("saved", "new1"))
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
	b.mergeLocked(d, snapshotJSON("new1", "new2"))
	if texts(d) != "saved,new1,new2" {
		t.Fatal(texts(d))
	}
	if w := setReadHistory(b, true); w.Code != 200 {
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
	a.mergeLocked(c, snapshotJSON("passive history"))
	if len(c.LiveAnchor) != 0 {
		t.Fatal("passive history must not initialize baseline")
	}
	a.mergeLatestLocked(c, snapshotJSON("old1", "old2"))
	if len(c.Messages) != 0 {
		t.Fatal("first window imported old messages")
	}
	a.mergeLocked(c, snapshotJSON("old2", "new1"))
	a.mergeLocked(c, snapshotJSON("old1", "old2"))
	a.mergeLocked(c, snapshotJSON("ancient1", "ancient2"))
	a.mergeLocked(c, snapshotJSON("new1", "new2"))
	a.mergeLocked(c, snapshotJSON("new1", "new2"))
	if texts(c) != "new1,new2" {
		t.Fatal(texts(c))
	}
	op := &Operation{ID: "live", ConversationID: c.ID, Kind: "read", NewMessagesOnly: true, Auto: true, Limit: 30}
	a.state.Operations[op.ID] = op
	a.finishLocked(op, "succeeded", snapshotJSON("gap1", "gap2"), "")
	if len(a.state.Operations) != 1 || texts(c) != "new1,new2,|gap1,gap2" || c.ReadWarning == "" {
		t.Fatal("current screen lost or deep read queued")
	}
	a.mergeLocked(c, snapshotJSON("gap2", "new3"))
	if texts(c) != "new1,new2,|gap1,gap2,new3" {
		t.Fatal(texts(c))
	}
	old := &Operation{ID: "old", ConversationID: c.ID, Kind: "read"}
	a.finishLocked(old, "succeeded", snapshotJSON("history"), "")
	if len(old.Warnings) != 1 || texts(c) != "new1,new2,|gap1,gap2,new3" {
		t.Fatal("in-flight old mode result was accepted")
	}
}

// 仅新增模式也补取最近消息里没取到的原图：停止点设在待取图片前面的那条文字，排在新消息读取之后。
func TestLiveModeBackfillsRecentOriginals(t *testing.T) {
	var until any
	a := testApp(t)
	addTestPhone(a, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			until = body["until"]
		}
		w.Write([]byte(`{"id":"phone-task","status":"succeeded","result":{"messages":[]}}`))
	}))
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	c.Messages = []Message{{Text: "a", Direction: "incoming", Seq: 1}, {Text: "b", Direction: "incoming", Seq: 2}, imageMsg(""), {Text: "c", Direction: "incoming", Seq: 4}}
	c.Messages[2].Seq = 3
	c.LastSeq = 4
	c.LiveAnchor, c.LiveReady = liveAnchorOf(c.Messages), true
	c.OriginalsDue = true
	other := a.conversationLocked("acc", "小李")
	other.NeedsRead = true
	if !a.scheduleAutoRead("p1") || other.NeedsRead || !c.OriginalsDue {
		t.Fatal("new message read should go first")
	}
	if !a.scheduleAutoRead("p1") || c.OriginalsDue {
		t.Fatal("originals backfill should be scheduled in live mode")
	}
	for _, op := range a.state.Operations {
		if op.ConversationID == c.ID {
			a.runOperation(context.Background(), "p1", op.ID)
		}
	}
	if got, _ := json.Marshal(until); string(got) != `["b"]` {
		t.Fatalf("until should be the text before the pending image: %s", got)
	}
}

// 补取没有进展（图片没能定位，最早待取的位置没变）时不再安排补取，避免每分钟重复读取。
func TestOriginalsBackfillStopsWithoutProgress(t *testing.T) {
	a := testApp(t)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	c.Kind = "person"
	a.mergeLatestLocked(c, latestJSON("a"))
	skipped := `{"at_latest":true,"messages":[{"text":"a","direction":"incoming"},{"text":"[图片]","kind":"image","direction":"incoming","original_skipped":"没能在屏幕上定位这张图片"}]}`
	op := &Operation{ID: "live", ConversationID: c.ID, Kind: "read", NewMessagesOnly: true, Auto: true, Limit: 30}
	a.mergeLiveReadLocked(op, c, json.RawMessage(skipped))
	if !c.OriginalsDue || c.firstPendingOriginal() < 0 {
		t.Fatalf("new image should be due for originals: %+v", c.Messages)
	}
	c.OriginalsDue = false
	a.mergeLiveReadLocked(op, c, json.RawMessage(skipped))
	if c.OriginalsDue {
		t.Fatal("no progress: must not schedule another backfill")
	}
}

func TestLiveReadReachesPhone(t *testing.T) {
	posted := false
	a := testApp(t)
	addTestPhone(a, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posted = true
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["read_history"] != false {
				t.Errorf("read mode not propagated: %v", body)
			}
		}
		w.Write([]byte(`{"id":"phone-task","status":"succeeded","result":{"messages":[]}}`))
	}))
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	op := &Operation{ID: "read-live", ConversationID: c.ID, Kind: "read", Limit: 30, Status: "queued"}
	a.state.Operations[op.ID] = op
	a.runOperation(context.Background(), "p1", op.ID)
	if !posted || op.Status != "succeeded" {
		t.Fatalf("read failed: %+v", op)
	}
}

func TestLiveEmptyChatKeepsFirstNewMessage(t *testing.T) {
	a := testApp(t)
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "empty")
	a.mergeLatestLocked(c, snapshotJSON())
	a.mergeLocked(c, snapshotJSON("first new"))
	if texts(c) != "first new" {
		t.Fatal("first new message in empty chat was lost")
	}
}

func TestReadModeSwitchDoesNotReadEveryChatAndDropsStaleSignals(t *testing.T) {
	a := testApp(t)
	quiet := a.conversationLocked("acc", "很久以前有未读")
	a.ingestLocked(PhoneEvent{Account: "acc", Kind: "unread_chat", Chat: quiet.Title, UnreadCount: 30})
	// 历史模式读完：之前的提示已处理
	op := &Operation{ID: "r", Kind: "read", Auto: true, ConversationID: quiet.ID, Limit: 30, Status: "running", Created: now()}
	a.state.Operations[op.ID] = op
	a.finishLocked(op, "succeeded", json.RawMessage(`{"messages":[]}`), "")
	if quiet.LiveSignal || quiet.LiveUnread != 0 {
		t.Fatal("history read should clear live signals")
	}
	quiet.NeedsRead = false
	pending := a.conversationLocked("acc", "还没读")
	a.ingestLocked(PhoneEvent{Account: "acc", Kind: "unread_chat", Chat: pending.Title, UnreadCount: 2})
	idle := a.conversationLocked("acc", "旧提示")
	idle.LiveSignal, idle.LiveUnread = true, 30 // 之前留下、已经过时的提示
	if w := setReadHistory(a, false); w.Code != 200 {
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
	a := testApp(t)
	addTestPhone(a, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			until = body["until"]
		}
		w.Write([]byte(`{"id":"phone-task","status":"succeeded","result":{"messages":[]}}`))
	}))
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	c.LiveAnchor = []Message{{Text: "a"}, {Text: "b"}, {Text: "[图片]", Kind: "image"}, {Text: "c"}, {Text: "[图片]", Kind: "image"}}
	op := &Operation{ID: "read-live", ConversationID: c.ID, Kind: "read", Limit: 30, Auto: true, Status: "queued"}
	a.state.Operations[op.ID] = op
	a.runOperation(context.Background(), "p1", op.ID)
	if got, _ := json.Marshal(until); string(got) != `["c"]` {
		t.Fatalf("until=%s", got)
	}
}
