package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func workspaceDevices(a *App) {
	a.state.Phones = []*PhoneConfig{{ID: "a1", Account: "A"}, {ID: "a2", Account: "A"}, {ID: "b1", Account: "B"}}
	a.syncPhonesLocked()
	for _, p := range a.state.Phones {
		a.phones[p.ID].connection = "在线"
	}
}

func TestWorkspaceDeviceSelectionAndIdempotency(t *testing.T) {
	a := testApp(t)
	workspaceDevices(a)
	c := a.conversationLocked("A", "chat")
	c.Kind = "person"
	path := "/api/conversations/" + c.ID + "/send"
	if w := call(a, "POST", path, `{"text":"hello","phone_id":"b1"}`, "wrong"); w.Code != 409 {
		t.Fatalf("wrong account: %d %s", w.Code, w.Body)
	}
	a.phones["a2"].connection = "离线"
	if w := call(a, "POST", path, `{"text":"hello","phone_id":"a2"}`, "offline"); w.Code != 409 {
		t.Fatalf("offline: %d", w.Code)
	}
	a.phones["a2"].connection = "在线"
	if w := call(a, "POST", path, `{"text":"hello","phone_id":"a2"}`, "chosen"); w.Code != 202 {
		t.Fatalf("valid: %d %s", w.Code, w.Body)
	}
	op := a.state.Operations["chosen"]
	if op.PhoneID != "a2" || op.Account != "A" {
		t.Fatalf("unbound: %+v", op)
	}
	if a.nextOperation("a1") != "" {
		t.Fatal("another worker claimed pinned task")
	}
	if w := call(a, "POST", path, `{"text":"hello","phone_id":"a1"}`, "chosen"); w.Code != 409 {
		t.Fatal("changed device reused idempotency key")
	}
	if w := call(a, "POST", path, `{"text":"automatic"}`, "auto"); w.Code != 202 || a.state.Operations["auto"].PhoneID != "a1" {
		t.Fatalf("shortest queue: %d %s", w.Code, w.Body)
	}
	a.phoneLocked("a2").Account = "B"
	a.failOrphansLocked()
	if op.Status != "failed" {
		t.Fatal("account switch did not stop queued task")
	}
}

func TestWorkspaceAccountAIInheritanceAndPersistence(t *testing.T) {
	a := testApp(t)
	workspaceDevices(a)
	a.state.AI = AIConfig{URL: "https://global.example/v1", Model: "global", Key: "secret-global", Prompt: "global prompt", Vision: true}
	a.state.AIRules = []AIRule{{Kind: "person", Matcher: "wildcard", Pattern: "*", AISetting: AISetting{Mode: "auto", IntervalSeconds: 30}}}
	body := `{"inherit_model":true,"prompt":"account prompt","vision":false,"rules":[{"kind":"person","matcher":"wildcard","pattern":"*","mode":"off","interval_seconds":30}]}`
	if w := call(a, "POST", "/api/ai/accounts/A", body, ""); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	cfg := a.effectiveAIConfigLocked("A")
	if cfg.Model != "global" || cfg.Prompt != "account prompt" || cfg.Vision {
		t.Fatalf("effective %+v", cfg)
	}
	c := a.conversationLocked("A", "chat")
	c.Kind = "person"
	if a.aiSettingLocked(c).Mode != "off" {
		t.Fatal("account rule not applied")
	}
	c.AI = AISetting{Mode: "auto", IntervalSeconds: 30}
	if a.aiSettingLocked(c).Mode != "auto" {
		t.Fatal("conversation override lost")
	}
	a.state.AI.Model = "updated"
	if a.effectiveAIConfigLocked("A").Model != "updated" {
		t.Fatal("inheritance snapshot instead of live")
	}
	if w := call(a, "GET", "/api/ai/accounts/A", "", ""); strings.Contains(w.Body.String(), "secret-global") {
		t.Fatal("key leaked")
	}
	if err := a.commitLocked(); err != nil {
		t.Fatal(err)
	}
	b := reopen(t, a)
	if b.effectiveAIConfigLocked("A").Prompt != "account prompt" {
		t.Fatal("override not persisted")
	}
	if w := call(b, "POST", "/api/ai/accounts/A", `{"inherit_model":true,"prompt":null,"vision":null,"rules":[]}`, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if b.effectiveAIConfigLocked("A").Prompt != "global prompt" {
		t.Fatal("restore inheritance failed")
	}
}

func TestWorkspaceIndependentForwardRuleAndDeviceValidation(t *testing.T) {
	a := testApp(t)
	workspaceDevices(a)
	src := a.conversationLocked("A", "source")
	src.Kind = "group"
	target := a.conversationLocked("B", "target")
	target.Kind = "group"
	body := fmt.Sprintf(`{"name":"rule","enabled":true,"sources":[%q],"targets":[%q],"target_phones":{%q:"a1"}}`, src.ID, target.ID, target.ID)
	if w := call(a, "POST", "/api/forward/rule", body, ""); w.Code != 400 {
		t.Fatal("wrong account target accepted")
	}
	body = strings.Replace(body, `"a1"`, `"b1"`, 1)
	if w := call(a, "POST", "/api/forward/rule", body, ""); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if w := call(a, "POST", "/api/forward/rule", body, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	id := a.state.ForwardRules[0].ID
	if w := call(a, "POST", "/api/forward/"+id+"/delete", "{}", ""); w.Code != 200 || len(a.state.ForwardRules) != 1 {
		t.Fatal("delete affected other rule")
	}
}

func TestWorkspaceSystemSettingsAtomicValidation(t *testing.T) {
	a := testApp(t)
	invalid := `{"discovery":{"enabled":true,"local_broadcast":false,"networks":[],"interval_seconds":30},"read_history":false}`
	if w := call(a, "POST", "/api/system-settings", invalid, ""); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if a.state.NewMessagesOnly {
		t.Fatal("invalid discovery partially changed reading")
	}
	conv := a.conversationLocked("A", "history-boundary")
	conv.LiveSignal, conv.LiveUnread, conv.OriginalsDue = true, 3, true
	valid := strings.Replace(invalid, `"local_broadcast":false`, `"local_broadcast":true`, 1)
	if w := call(a, "POST", "/api/system-settings", valid, ""); w.Code != 200 || !a.state.NewMessagesOnly {
		t.Fatal(w.Code, w.Body)
	}
	if conv.LiveSignal || conv.LiveUnread != 0 || conv.OriginalsDue {
		t.Fatal("reading mode change did not reset stale live signals and original-image work")
	}
}

func TestWorkspaceUnavailableReadinessAndActiveTaskSummary(t *testing.T) {
	a := testApp(t)
	workspaceDevices(a)
	a.phones["a1"].device = json.RawMessage(`{"online":true,"info":{"ready":false}}`)
	c := a.conversationLocked("A", "chat")
	if p := a.selectDeviceLocked(c, ""); p == nil || p.ID != "a2" {
		t.Fatal("unready device selected")
	}
	for i := 0; i < 60; i++ {
		id := fmt.Sprint(i)
		a.state.Operations[id] = &Operation{ID: id, Status: "queued", Created: id, PhoneID: "a2", ConversationID: c.ID}
	}
	w := call(a, "GET", "/api/state", "", "")
	var data struct {
		Operations []Operation `json:"operations"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Operations) != 60 {
		t.Fatalf("active tasks truncated: %d", len(data.Operations))
	}
}
