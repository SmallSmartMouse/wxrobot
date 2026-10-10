package main

import (
	"encoding/json"
	"testing"
)

func TestAccountNamesRemainKeyedByWechatID(t *testing.T) {
	a := testApp(t)
	addTestPhone(a, "http://phone.test")
	report := func(id, name string) {
		raw, _ := json.Marshal(map[string]any{"info": map[string]any{"account": map[string]string{"wechat_id": id, "nickname": name}}})
		a.setPhoneStatus("p1", "在线", raw, nil)
	}
	report("account-a", "同名用户")
	first := a.conversationLocked("account-a", "联系人")
	report("account-b", "同名用户")
	second := a.conversationLocked("account-b", "联系人")
	if first.ID == second.ID {
		t.Fatal("equal nicknames merged accounts")
	}
	if a.state.AccountNames["account-a"] != "同名用户" || a.state.AccountNames["account-b"] != "同名用户" {
		t.Fatal("names not keyed by id")
	}
	report("account-a", "改名后的用户")
	if first.Account != "account-a" || second.Account != "account-b" || a.conversationLocked("account-a", "联系人").ID != first.ID {
		t.Fatal("rename changed account identity")
	}
	report("account-a", "") // 旧脚本或本次未读出昵称，不覆盖已保存的昵称。
	if a.state.AccountNames["account-a"] != "改名后的用户" {
		t.Fatal("missing nickname erased saved name")
	}
	report("", "无效昵称")
	if _, ok := a.state.AccountNames[""]; ok {
		t.Fatal("nickname saved without account id")
	}
	report("account-b", "同名用户")
	if err := a.commitLocked(); err != nil {
		t.Fatal(err)
	}
	b, err := newApp(a.path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.store.db.Close()
	names := map[string]string{}
	for _, v := range b.accountsLocked() {
		names[v.WechatID] = v.Nickname
	}
	if names["account-a"] != "改名后的用户" || names["account-b"] != "同名用户" {
		t.Fatalf("offline nickname lost on restart: %v", names)
	}
}
