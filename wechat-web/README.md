# 微信消息台

Go + Gin + `openai-go`，前端通过 `go:embed` 编进同一个程序。

## 启动

```bash
./run.sh
```

打开 http://127.0.0.1:8787 ，在左侧“手机连接”填写手机 IP 和 Token。

| 参数 | 默认值 |
| --- | --- |
| `-listen` | `127.0.0.1:8787`（只接受本机访问） |
| `-db` | `.state/wechat.db`（SQLite） |
| `-data` | `.state/state.json`，旧版 JSON 数据，数据库为空时自动导入 |
| `-phone` | 空；首次启动可填手机 IP，并从 `-bootstrap` 文件导入 Token |
| `-bootstrap` | `../wechat-bridge/.state/credentials.json` |

## 代码结构

| 文件 | 内容 |
| --- | --- |
| `main.go` | 启动、状态结构 |
| `store.go` | SQLite 读写：只写入变化的行，一次保存一个事务 |
| `phone.go` | 手机接口调用、事件长轮询、读写任务执行 |
| `messages.go` | 会话与消息结构、把手机读到的屏幕内容并入会话 |
| `ai.go` | AI 设置与名称规则、自动回复 |
| `media.go` | 图片保存与读取 |
| `router.go` | 网页接口 |
| `static/` | 网页 |

## 数据流

1. **事件**：`eventLoop` 长轮询手机 `/v1/events`。通知和未读提示只标记会话“需要读取”；当前聊天的屏幕快照直接并入正文。
2. **读取时机**（`worker` 空闲时安排，同时满足多个时先处理通知触发，再按最久未读排序）：
   - 通知 / 首页未读提示：距上次读取满 5 秒立即读 30 条；
   - 定时读取：会话工具栏可设每 1 分钟到 1 小时；
   - 发送后：手机直接回传当前屏幕；接不上已有记录或补读失败时再安排一次读取；
   - 手机上打开的聊天：内容变化时实时推送屏幕快照。
   自动读取的 30 条接不上已有记录时，先加深到 100 条再读，仍接不上才整批追加并标记缺口。
3. **任务**：`worker` 按创建顺序逐个执行。任务 ID 同时作为手机端的 `Idempotency-Key`，服务重启后用同一 ID 继续，不会重复执行。
4. **消息合并**：在已记录消息的末尾与新屏幕内容之间找唯一衔接点，只追加新消息。读取任务找不到衔接点时整屏追加并标记缺口；界面监测找不到时忽略（可能是用户在手机上翻看历史）。
5. **AI**：`aiLoop` 每秒检查开启回复的会话，有新来信（含触发词）且超过最短间隔时调用模型。生成后会话仍是自动回复就建立发送任务。

## 发送结果

| 状态 | 含义 |
| --- | --- |
| `succeeded` | 手机界面观察到新消息（不表示对方已收到） |
| `failed` | 手机拒绝或未执行，可以重试 |
| `unknown` | 可能已发出：已点击发送后出错、请求中断、手机桥重启。不会自动重发，请先看手机 |

## AI 设置

- 全局：兼容 OpenAI 的接口地址（如 `https://host/v1`）、密钥、模型、提示词、是否发送图片。
- 回复方式：会话单独设置 > 第一条匹配的名称规则（通配符或 Go RE2 正则）> 关闭。
- 群聊自动回复必须设置触发词（文字包含匹配）。只处理开启之后的新来信；与之前记录无法衔接的消息不触发。
- 回复方式只有“关闭”和“自动回复”。上下文为最近 20 条消息，生成超时 30 秒；生成和发送记录在调试页查看。

## 接口

| 方法和路径 | 作用 |
| --- | --- |
| `GET /api/state` | 会话列表、最近任务、每个会话最新的 AI 记录、连接状态 |
| `GET /api/stream` | SSE，数据变化时推送 `refresh` |
| `POST /api/config` | 手机地址和 Token |
| `POST /api/conversations` | 新建会话 |
| `GET /api/conversations/{id}` | 会话详情和消息 |
| `POST /api/conversations/{id}/seen` | 清除未读 |
| `POST /api/conversations/{id}/kind` | 设置会话类型 |
| `POST /api/conversations/{id}/read` | 读取，需 `Idempotency-Key` |
| `POST /api/conversations/{id}/send` | 发送 `text` 或 `image_hash`，需 `Idempotency-Key` |
| `POST /api/conversations/{id}/ai` | 会话回复方式，`mode: inherit` 表示跟随名称规则 |
| `GET/POST /api/ai/config` | 全局 AI 设置和名称规则 |
| `POST /api/media` | 上传 PNG/JPEG（Base64） |
| `GET /api/media/{hash}` | 读取图片 |

## 数据

数据在 SQLite 数据库 `.state/wechat.db`，图片在 `.state/media/`。最多保留 200 个已结束任务和 100 条 AI 记录。

| 表 | 内容 |
| --- | --- |
| `messages` | 每条消息一行：`conversation_id`、`seq`、`text`、`direction`、`kind`、`time`、图片和原图信息等列 |
| `conversations` | 会话设置（类型、未读、AI、定时读取、原图开关），JSON |
| `operations` / `ai_jobs` | 读写任务、AI 自动回复记录，JSON |
| `settings` | 手机连接、事件游标、AI 设置与名称规则，JSON |

可以直接查询，例如：

```bash
sqlite3 .state/wechat.db "SELECT time, direction, text FROM messages ORDER BY time DESC LIMIT 20"
```

第一次启动新版本时，如果数据库为空而 `.state/state.json` 存在，会自动导入，并把原文件改名为 `state.json.migrated` 保留。备份时停止服务后复制 `.state/` 目录（包括 `wechat.db-wal` 文件）。
