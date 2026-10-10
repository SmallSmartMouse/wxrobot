package main

// SQLite 持久化。运行时数据都在内存（App.state）里，saveLocked 只把变化的部分写入数据库，
// 一次保存在一个事务中完成：
//   - messages：每条消息一行，字段都是独立的列，可直接用 SQL 查询。
//     新增消息和补上图片的消息由 markMessage 标记，保存时只写这些行。
//   - conversations / operations / ai_jobs / settings：每条记录一行 JSON，
//     与上次写入的内容不同才写；内存里已删除的（例如清理掉的旧任务）同步删除。

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS settings      (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations    (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_jobs       (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
	conversation_id TEXT    NOT NULL,
	seq             INTEGER NOT NULL,
	id              TEXT    NOT NULL,
	text            TEXT    NOT NULL,
	direction       TEXT    NOT NULL,
	sender          TEXT    NOT NULL DEFAULT '',
	kind            TEXT    NOT NULL DEFAULT '',
	image_hash      TEXT    NOT NULL DEFAULT '',
	image_error     TEXT    NOT NULL DEFAULT '',
	original_hash   TEXT    NOT NULL DEFAULT '',
	original_error  TEXT    NOT NULL DEFAULT '',
	original_tries  INTEGER NOT NULL DEFAULT 0,
	original_note   TEXT    NOT NULL DEFAULT '',
	time            TEXT    NOT NULL,
	gap             INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (conversation_id, seq)
);`

const messageColumns = "conversation_id, seq, id, text, direction, sender, kind, image_hash, image_error, original_hash, original_error, original_tries, original_note, time, gap"

type store struct {
	db      *sql.DB
	written map[string]string         // "表:编号" → 上次写入的 JSON
	dirty   map[string]map[int64]bool // 会话编号 → 需要写入的消息序号
	cleared map[string]bool           // 会话编号 → 需要删除已保存的全部消息（删除聊天记录或删除会话）
}

// openStore 打开数据库文件并建表（已存在则跳过）。
func openStore(path string) (*store, error) {
	// WAL 模式：写入不阻塞读取；synchronous=NORMAL 在 WAL 下兼顾安全和速度；忙时最多等 5 秒
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	// 只有本服务一个进程使用，单连接避免并发写冲突
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("数据库初始化失败：%w", err)
	}
	return &store{db: db, written: map[string]string{}, dirty: map[string]map[int64]bool{}, cleared: map[string]bool{}}, nil
}

// markMessage 标记消息需要写入（新增或修改）。
func (a *App) markMessage(conversationID string, seq int64) {
	if a.store.dirty[conversationID] == nil {
		a.store.dirty[conversationID] = map[int64]bool{}
	}
	a.store.dirty[conversationID][seq] = true
}

// settingsLocked settings 表中的配置项：配置项名 → 内存中对应字段的指针。
func (a *App) settingsLocked() map[string]any {
	return map[string]any{
		"account_ai": &a.state.AccountAI, "phones": &a.state.Phones, "ai": &a.state.AI, "ai_rules": &a.state.AIRules,
		"forward_rules": &a.state.ForwardRules, "discovery": &a.state.Discovery, "new_messages_only": &a.state.NewMessagesOnly,
		"account_names": &a.state.AccountNames,
	}
}

// ---------- 读取 ----------

// loadLocked 从数据库读入全部数据：配置、会话、任务、AI 记录，最后是各会话的消息。
func (a *App) loadLocked() error {
	settings := a.settingsLocked()
	readers := []struct {
		table string
		each  func(id, data string) error
	}{
		{"settings", func(id, data string) error {
			if target, ok := settings[id]; ok {
				return json.Unmarshal([]byte(data), target)
			}
			return nil
		}},
		{"conversations", func(id, data string) error {
			return decodeInto(a.state.Conversations, id, data)
		}},
		{"operations", func(id, data string) error {
			return decodeInto(a.state.Operations, id, data)
		}},
		{"ai_jobs", func(id, data string) error {
			return decodeInto(a.state.AIJobs, id, data)
		}},
	}
	for _, r := range readers {
		if err := a.readJSONTable(r.table, r.each); err != nil {
			return err
		}
	}
	return a.readMessages()
}

// decodeInto 把一行 JSON 解析为新记录，放进 records[id]。
func decodeInto[T any](records map[string]*T, id, data string) error {
	record := new(T)
	records[id] = record
	return json.Unmarshal([]byte(data), record)
}

// readJSONTable 逐行读取 (id, data) 表交给 each 解析，并记下读到的内容，保存时据此判断是否变化。
func (a *App) readJSONTable(table string, each func(id, data string) error) error {
	rows, err := a.store.db.Query("SELECT id, data FROM " + table)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, data string
		if err := rows.Scan(&id, &data); err != nil {
			return err
		}
		if err := each(id, data); err != nil {
			return fmt.Errorf("%s 表的 %s 无法读取：%w", table, id, err)
		}
		a.store.written[table+":"+id] = data
	}
	return rows.Err()
}

// readMessages 按会话和序号顺序读出消息，依次追加到各自的会话。
func (a *App) readMessages() error {
	rows, err := a.store.db.Query("SELECT " + messageColumns + " FROM messages ORDER BY conversation_id, seq")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var conversationID string
		var m Message
		err := rows.Scan(&conversationID, &m.Seq, &m.ID, &m.Text, &m.Direction, &m.Sender, &m.Kind, &m.ImageHash, &m.ImageError,
			&m.OriginalHash, &m.OriginalError, &m.OriginalTries, &m.OriginalNote, &m.Time, &m.Gap)
		if err != nil {
			return err
		}
		if c := a.state.Conversations[conversationID]; c != nil {
			c.Messages = append(c.Messages, m)
		}
	}
	return rows.Err()
}

// ---------- 保存 ----------

// saveLocked 在一个事务中写入所有变化：要么全部成功，要么全部不生效。失败时下次保存会再次尝试写入。
func (a *App) saveLocked() error {
	a.pruneLocked()
	tx, err := a.store.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	w := &recordWriter{tx: tx, written: a.store.written, changed: map[string]string{}, current: map[string]bool{}}
	if err = a.writeRecords(w); err != nil {
		return err
	}
	removed, err := w.deleteMissing()
	if err != nil {
		return err
	}
	if err = a.writeMessages(tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	// 提交成功后才更新“已写入”的记录；提交失败时下次保存会重新写
	w.remember(removed)
	a.store.dirty = map[string]map[int64]bool{}
	a.store.cleared = map[string]bool{}
	return nil
}

// writeRecords 写入配置、会话（不含消息，消息单独存在 messages 表）、任务和 AI 记录中变化的。
func (a *App) writeRecords(w *recordWriter) error {
	for id, value := range a.settingsLocked() {
		if err := w.put("settings", id, value); err != nil {
			return err
		}
	}
	for id, c := range a.state.Conversations {
		meta := *c
		meta.Messages = nil
		if err := w.put("conversations", id, meta); err != nil {
			return err
		}
	}
	for id, op := range a.state.Operations {
		if err := w.put("operations", id, op); err != nil {
			return err
		}
	}
	for id, j := range a.state.AIJobs {
		if err := w.put("ai_jobs", id, j); err != nil {
			return err
		}
	}
	return nil
}

// writeMessages 先删除清空过聊天记录的会话已保存的消息，再写入被标记过的消息（新增的、补上图片的）。
func (a *App) writeMessages(tx *sql.Tx) error {
	for conversationID := range a.store.cleared {
		if _, err := tx.Exec("DELETE FROM messages WHERE conversation_id = ?", conversationID); err != nil {
			return err
		}
	}
	for conversationID, seqs := range a.store.dirty {
		c := a.state.Conversations[conversationID]
		if c == nil {
			continue
		}
		for seq := range seqs {
			m := c.messageBySeq(seq)
			if m == nil {
				continue // 已被删除
			}
			_, err := tx.Exec("INSERT OR REPLACE INTO messages("+messageColumns+") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
				conversationID, m.Seq, m.ID, m.Text, m.Direction, m.Sender, m.Kind, m.ImageHash, m.ImageError,
				m.OriginalHash, m.OriginalError, m.OriginalTries, m.OriginalNote, m.Time, m.Gap)
			if err != nil {
				return err
			}
		}
	}
	return nil
}

// recordWriter 在一次保存中写入 JSON 记录：只写与上次写入不同的，并记下本次仍存在的记录。
type recordWriter struct {
	tx      *sql.Tx
	written map[string]string // 上次写入的内容（store.written）
	changed map[string]string // 本次写入的内容，提交成功后更新到 written
	current map[string]bool   // 本次仍存在的记录
}

// put 把一条记录序列化为 JSON；与上次写入的内容相同就跳过。
func (w *recordWriter) put(table, id string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	key := table + ":" + id
	w.current[key] = true
	if w.written[key] == string(b) {
		return nil
	}
	w.changed[key] = string(b)
	_, err = w.tx.Exec("INSERT INTO "+table+"(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", id, string(b))
	return err
}

// deleteMissing 删除上次写过、但本次已不存在的记录（例如被清理的旧任务），返回删除的键。
func (w *recordWriter) deleteMissing() ([]string, error) {
	var removed []string
	for key := range w.written {
		if w.current[key] {
			continue
		}
		table, id, _ := strings.Cut(key, ":")
		if _, err := w.tx.Exec("DELETE FROM "+table+" WHERE id = ?", id); err != nil {
			return nil, err
		}
		removed = append(removed, key)
	}
	return removed, nil
}

// remember 提交成功后，把本次写入和删除的记录同步到“已写入”。
func (w *recordWriter) remember(removed []string) {
	for key, data := range w.changed {
		w.written[key] = data
	}
	for _, key := range removed {
		delete(w.written, key)
	}
}
