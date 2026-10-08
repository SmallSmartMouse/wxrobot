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
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
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

const messageColumns = "conversation_id, seq, id, text, direction, kind, image_hash, image_error, original_hash, original_error, original_tries, original_note, time, gap"

type store struct {
	db      *sql.DB
	written map[string]string         // "表:编号" → 上次写入的 JSON
	dirty   map[string]map[int64]bool // 会话编号 → 需要写入的消息序号
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
	return &store{db: db, written: map[string]string{}, dirty: map[string]map[int64]bool{}}, nil
}

// markMessage 标记消息需要写入（新增或修改）。
func (a *App) markMessage(conversationID string, seq int64) {
	if a.store.dirty[conversationID] == nil {
		a.store.dirty[conversationID] = map[int64]bool{}
	}
	a.store.dirty[conversationID][seq] = true
}

// settings 表中的配置项。
func (a *App) settingsLocked() map[string]any {
	return map[string]any{"phone": &a.state.Phone, "cursor": &a.state.Cursor, "ai": &a.state.AI, "ai_rules": &a.state.AIRules}
}

// loadLocked 从数据库读入全部数据，返回数据库是否为空。
func (a *App) loadLocked() (empty bool, err error) {
	// 配置项名 → 内存中对应字段的指针，读出的 JSON 直接解析进去
	settings := a.settingsLocked()
	rowsRead := 0
	// readJSON 逐行读取 (id, data) 表，交给 each 解析，并记下读到的内容，后续保存时用于判断是否变化
	readJSON := func(table string, each func(id, data string) error) error {
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
			rowsRead++
		}
		return rows.Err()
	}
	// 依次读配置、会话、任务、AI 记录；任意一步出错就停止
	err = readJSON("settings", func(id, data string) error {
		if target, ok := settings[id]; ok {
			return json.Unmarshal([]byte(data), target)
		}
		return nil
	})
	if err == nil {
		err = readJSON("conversations", func(id, data string) error {
			c := &Conversation{}
			a.state.Conversations[id] = c
			return json.Unmarshal([]byte(data), c)
		})
	}
	if err == nil {
		err = readJSON("operations", func(id, data string) error {
			op := &Operation{}
			a.state.Operations[id] = op
			return json.Unmarshal([]byte(data), op)
		})
	}
	if err == nil {
		err = readJSON("ai_jobs", func(id, data string) error {
			j := &AIJob{}
			a.state.AIJobs[id] = j
			return json.Unmarshal([]byte(data), j)
		})
	}
	if err != nil {
		return false, err
	}
	// 消息按会话和序号排序读出，依次追加到各自会话
	rows, err := a.store.db.Query("SELECT " + messageColumns + " FROM messages ORDER BY conversation_id, seq")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var conversationID string
		var m Message
		err := rows.Scan(&conversationID, &m.Seq, &m.ID, &m.Text, &m.Direction, &m.Kind, &m.ImageHash, &m.ImageError,
			&m.OriginalHash, &m.OriginalError, &m.OriginalTries, &m.OriginalNote, &m.Time, &m.Gap)
		if err != nil {
			return false, err
		}
		if c := a.state.Conversations[conversationID]; c != nil {
			c.Messages = append(c.Messages, m)
		}
	}
	return rowsRead == 0, rows.Err()
}

// saveLocked 在一个事务中写入所有变化。失败时内存不变，下次保存会再次尝试写入。
func (a *App) saveLocked() error {
	a.pruneLocked()
	// 一次保存的所有写入放在同一个事务里，要么全部成功，要么全部不生效
	tx, err := a.store.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	changed := map[string]string{} // 提交成功后更新到 written
	current := map[string]bool{}
	// put 把一条记录序列化为 JSON；与上次写入的内容相同就跳过，不同才写入
	put := func(table, id string, value any) error {
		b, err := json.Marshal(value)
		if err != nil {
			return err
		}
		key := table + ":" + id
		current[key] = true
		if a.store.written[key] == string(b) {
			return nil
		}
		changed[key] = string(b)
		_, err = tx.Exec("INSERT INTO "+table+"(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", id, string(b))
		return err
	}

	// 配置、会话（不含消息）、任务、AI 记录：逐条比较后写入变化的
	for id, value := range a.settingsLocked() {
		if err = put("settings", id, value); err != nil {
			return err
		}
	}
	for id, c := range a.state.Conversations {
		meta := *c
		meta.Messages = nil // 消息单独存在 messages 表
		if err = put("conversations", id, meta); err != nil {
			return err
		}
	}
	for id, op := range a.state.Operations {
		if err = put("operations", id, op); err != nil {
			return err
		}
	}
	for id, j := range a.state.AIJobs {
		if err = put("ai_jobs", id, j); err != nil {
			return err
		}
	}
	// 上次写过、但内存里已经没有的记录（例如被清理的旧任务），从数据库删除
	var removed []string
	for key := range a.store.written {
		if !current[key] {
			table, id, _ := strings.Cut(key, ":")
			if _, err = tx.Exec("DELETE FROM "+table+" WHERE id = ?", id); err != nil {
				return err
			}
			removed = append(removed, key)
		}
	}
	// 消息只写被标记过的行（新增的消息、补上图片的消息）
	for conversationID, seqs := range a.store.dirty {
		c := a.state.Conversations[conversationID]
		if c == nil {
			continue
		}
		for seq := range seqs {
			// 消息按序号有序，二分查找；找不到说明已被删除，跳过
			i := sort.Search(len(c.Messages), func(i int) bool { return c.Messages[i].Seq >= seq })
			if i == len(c.Messages) || c.Messages[i].Seq != seq {
				continue
			}
			m := c.Messages[i]
			_, err = tx.Exec("INSERT OR REPLACE INTO messages("+messageColumns+") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
				conversationID, m.Seq, m.ID, m.Text, m.Direction, m.Kind, m.ImageHash, m.ImageError,
				m.OriginalHash, m.OriginalError, m.OriginalTries, m.OriginalNote, m.Time, m.Gap)
			if err != nil {
				return err
			}
		}
	}
	// 提交成功后才更新“已写入”的记录；提交失败时下次保存会重新写
	if err = tx.Commit(); err != nil {
		return err
	}
	for key, data := range changed {
		a.store.written[key] = data
	}
	for _, key := range removed {
		delete(a.store.written, key)
	}
	a.store.dirty = map[string]map[int64]bool{}
	return nil
}

// importJSON 把旧版本的 state.json 导入数据库（只在数据库为空时调用），成功后改名保留为 .migrated。
func (a *App) importJSON(path string) error {
	// 没有旧数据文件就什么都不做
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var legacy State
	if err = json.Unmarshal(b, &legacy); err != nil {
		return fmt.Errorf("旧数据 %s 无法读取：%w", path, err)
	}
	// 用旧数据替换内存状态并整理，然后把所有消息标记为待写入
	a.state = legacy
	a.normalizeLocked()
	for id, c := range a.state.Conversations {
		for _, m := range c.Messages {
			a.markMessage(id, m.Seq)
		}
	}
	if err = a.saveLocked(); err != nil {
		return err
	}
	// 改名保留原文件，需要时可以回退
	log.Printf("已把 %s 导入数据库", path)
	return os.Rename(path, path+".migrated")
}
