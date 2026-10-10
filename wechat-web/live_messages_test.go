package main

import (
	"encoding/json"
	"testing"
	"time"
)

func latestJSON(texts ...string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"messages": msgs(texts...), "captured_at": now(), "at_latest": true})
	return b
}

func TestFirstUnreadWindowKeepsIncrement(t *testing.T) {
	for _, withCount := range []bool{true, false} {
		t.Run(map[bool]string{true: "badge", false: "notification"}[withCount], func(t *testing.T) {
			a := testApp(t)
			a.state.NewMessagesOnly = true
			if withCount {
				a.ingestLocked(PhoneEvent{Account: "acc", Kind: "unread_chat", Chat: "小王", UnreadCount: 2})
			} else {
				a.ingestLocked(PhoneEvent{Account: "acc", Kind: "notification", Chat: "小王", Text: "new1"})
				a.ingestLocked(PhoneEvent{Account: "acc", Kind: "notification", Chat: "小王", Text: "new2"})
			}
			c := a.conversationLocked("acc", "小王")
			// 用户手动打开手机对话框，未读角标消失，底部快照仍必须保住打开之前的增量。
			a.ingestLocked(PhoneEvent{Account: "acc", Kind: "visible_snapshot", Chat: "小王", Snapshot: latestJSON("old1", "old2", "new1", "new2")})
			if texts(c) != "new1,new2" {
				t.Fatalf("first unread messages lost/imported history: %s", texts(c))
			}
			a.mergeLocked(c, latestJSON("old2", "new1", "new2"))
			if texts(c) != "new1,new2" {
				t.Fatal("duplicate window imported twice")
			}
		})
	}
}

func TestToggleRetainsBoundaryAndInFlightIncrement(t *testing.T) {
	a := testApp(t)
	c := a.conversationLocked("acc", "小王")
	a.mergeOrAppendLocked(c, snapshotJSON("old"))
	oldTask := &Operation{ID: "old-task", Kind: "read", ConversationID: c.ID}
	if w := setReadHistory(a, false); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	a.finishLocked(oldTask, "succeeded", latestJSON("old", "during-toggle"), "")
	if texts(c) != "old,during-toggle" || !c.NeedsRead {
		t.Fatal(texts(c), c.NeedsRead)
	}
	a.mergeLatestLocked(c, latestJSON("during-toggle", "new"))
	if texts(c) != "old,during-toggle,new" {
		t.Fatal(texts(c))
	}
	// 反向切换也不能丢掉已完成的仅新增任务。
	setReadHistory(a, true)
	liveTask := &Operation{ID: "live-task", Kind: "read", ConversationID: c.ID, NewMessagesOnly: true}
	a.finishLocked(liveTask, "succeeded", latestJSON("new", "after-toggle"), "")
	if texts(c) != "old,during-toggle,new,after-toggle" {
		t.Fatal(texts(c))
	}
}

func TestGapAndStaleResultDoNotSwallowIncrement(t *testing.T) {
	a := testApp(t)
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	a.mergeLatestLocked(c, snapshotJSON("baseline"))
	stale := latestJSON("baseline", "old-result")
	a.mergeLocked(c, latestJSON("gap-new1", "gap-new2"))
	if texts(c) != "|gap-new1,gap-new2" || c.ReadWarning == "" {
		t.Fatal(texts(c))
	}
	a.mergeLatestLocked(c, stale)
	a.mergeLocked(c, latestJSON("gap-new2", "new3"))
	if texts(c) != "|gap-new1,gap-new2,|baseline,old-result,new3" {
		t.Fatal("late response rewound baseline", texts(c))
	}
}

func TestEmptyVisibleChatKeepsFirstArrival(t *testing.T) {
	a := testApp(t)
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	a.ingestLocked(PhoneEvent{Account: "acc", Chat: c.Title, Kind: "visible_snapshot", Snapshot: latestJSON()})
	a.ingestLocked(PhoneEvent{Account: "acc", Chat: c.Title, Kind: "visible_snapshot", Snapshot: latestJSON("first")})
	if texts(c) != "first" {
		t.Fatal(texts(c))
	}
}

func TestFailedReadRetriesWithBackoff(t *testing.T) {
	a := testApp(t)
	addTestPhone(a, nil)
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	c.NeedsRead = true
	if !a.scheduleAutoRead("p1") {
		t.Fatal("not queued")
	}
	var op *Operation
	for _, v := range a.state.Operations {
		op = v
	}
	a.finishLocked(op, "failed", nil, "network disconnected")
	if !c.NeedsRead || c.ReadRetryAt == "" {
		t.Fatal("failure consumed dirty flag")
	}
	if a.scheduleAutoRead("p1") {
		t.Fatal("retry loop has no backoff")
	}
	c.ReadRetryAt = stamp(time.Now().Add(-time.Minute))
	c.LastRead = stamp(time.Now().Add(-time.Minute))
	if !a.scheduleAutoRead("p1") {
		t.Fatal("increment never retried")
	}
}

func TestUnreadHintSurvivesRestartAndBrowserOpening(t *testing.T) {
	a := testApp(t)
	a.state.NewMessagesOnly = true
	a.ingestLocked(PhoneEvent{Account: "acc", Kind: "unread_chat", Chat: "小王", UnreadCount: 1})
	c := a.conversationLocked("acc", "小王")
	call(a, "POST", "/api/conversations/"+c.ID+"/seen", `{}`, "")
	if err := a.commitLocked(); err != nil {
		t.Fatal(err)
	}
	b, err := newApp(a.path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.store.db.Close()
	d := b.state.Conversations[c.ID]
	b.mergeLatestLocked(d, latestJSON("old", "new"))
	if texts(d) != "new" {
		t.Fatal(texts(d))
	}
}

func TestReadRetryBacksOffAndSkipsManualReads(t *testing.T) {
	a := testApp(t)
	addTestPhone(a, nil)
	c := a.conversationLocked("acc", "小王")
	// 手动读取失败不自动重读
	manual := &Operation{ID: "m", Kind: "read", ConversationID: c.ID, Limit: 20, Status: "running", Created: now()}
	a.state.Operations[manual.ID] = manual
	a.finishLocked(manual, "failed", nil, "手机未就绪")
	if c.NeedsRead || c.ReadRetryAt != "" {
		t.Fatal("manual read failure must not schedule automatic retries")
	}
	// 连续失败时等待时间加倍，最长 readRetryMax
	var waits []time.Duration
	for i := 0; i < 8; i++ {
		op := &Operation{ID: randomID(), Kind: "read", Auto: true, ConversationID: c.ID, Limit: 30, Status: "running", Created: now()}
		a.state.Operations[op.ID] = op
		a.finishLocked(op, "failed", nil, "手机脚本不支持仅新增模式")
		at, _ := time.Parse(time.RFC3339Nano, c.ReadRetryAt)
		waits = append(waits, time.Until(at).Round(time.Second))
	}
	if waits[0] != readRetryBase || waits[1] != 2*readRetryBase || waits[7] != readRetryMax {
		t.Fatalf("backoff: %v", waits)
	}
	ok := &Operation{ID: "ok", Kind: "read", Auto: true, ConversationID: c.ID, Limit: 30, Status: "running", Created: now()}
	a.state.Operations[ok.ID] = ok
	a.finishLocked(ok, "succeeded", snapshotJSON("a"), "")
	if c.ReadFailures != 0 || c.ReadRetryAt != "" {
		t.Fatal("success should reset the backoff")
	}
}

func TestEmptyLiveReadWithSignalBacksOff(t *testing.T) {
	a := testApp(t)
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	a.ingestLocked(PhoneEvent{Account: "acc", Kind: "unread_chat", Chat: c.Title, UnreadCount: 1})
	for i := 1; i <= 2; i++ {
		op := &Operation{ID: randomID(), Kind: "read", Auto: true, NewMessagesOnly: true, ConversationID: c.ID, Limit: 30, Status: "running", Created: now()}
		a.state.Operations[op.ID] = op
		a.finishLocked(op, "succeeded", latestJSON(), "")
		if !c.NeedsRead || c.ReadFailures != i || c.ReadRetryAt == "" {
			t.Fatalf("empty screen with a pending signal should retry with backoff: failures=%d retry=%q", c.ReadFailures, c.ReadRetryAt)
		}
	}
	op := &Operation{ID: randomID(), Kind: "read", Auto: true, NewMessagesOnly: true, ConversationID: c.ID, Limit: 30, Status: "running", Created: now()}
	a.state.Operations[op.ID] = op
	a.finishLocked(op, "succeeded", latestJSON("old", "new"), "")
	if texts(c) != "new" || c.ReadFailures != 0 || c.LiveSignal {
		t.Fatalf("messages read after retries: %s failures=%d", texts(c), c.ReadFailures)
	}
}

// 缺口提示在底部一屏重新衔接后清除，不能一直挂在之后的读取上。
func TestAlignedLatestReadClearsGapWarning(t *testing.T) {
	a := testApp(t)
	a.state.NewMessagesOnly = true
	c := a.conversationLocked("acc", "小王")
	a.mergeLatestLocked(c, snapshotJSON("baseline"))
	a.mergeLatestLocked(c, latestJSON("gap1", "gap2"))
	if c.ReadWarning == "" {
		t.Fatal("gap must be reported")
	}
	a.mergeLatestLocked(c, latestJSON("gap2", "new"))
	if c.ReadWarning != "" || texts(c) != "|gap1,gap2,new" {
		t.Fatal("aligned read kept stale warning:", c.ReadWarning, texts(c))
	}
}
