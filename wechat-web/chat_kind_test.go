package main

import (
	"encoding/json"
	"testing"
)

func TestObservedChatKind(t *testing.T) {
	for _, tc := range []struct{ before, observed, want string }{
		{"unknown", "person", "person"},
		{"unknown", "group", "group"},
		{"unknown", "invalid", "unknown"},
		{"unknown", "unknown", "unknown"},
		{"person", "group", "person"},
		{"group", "person", "group"},
	} {
		t.Run(tc.before+"_"+tc.observed, func(t *testing.T) {
			a := testApp(t)
			c := a.conversationLocked("acc", "name")
			c.Kind = tc.before
			raw, _ := json.Marshal(map[string]any{"chat_type": tc.observed, "messages": []any{}})
			a.mergeLatestLocked(c, raw)
			if c.Kind != tc.want {
				t.Fatalf("got %s, want %s", c.Kind, tc.want)
			}
		})
	}
}
