# 微信消息台

Go + Gin + `openai-go`，前端通过 `go:embed` 编进同一个程序。

## 启动

```bash
./run.sh
```

打开 http://127.0.0.1:8787 ，在左侧“手机连接”添加手机 IP 和 Token（可以添加多台），等手机识别出微信号后，在左上角切换账号。

服务无需启动参数。默认监听 `127.0.0.1:8787`，数据库固定为 `.state/wechat.db`，旧数据自动从 `.state/state.json` 导入。

需要调整监听地址时，将 `config.example.json` 复制为 `config.json` 后修改：

```json
{
  "listen": "127.0.0.1:8787",
  "allow_remote": false
}
```

`config.json` 可省略，修改后重启生效。手机 IP、Token 和 AI 设置在网页中配置。

## Docker

推送到 `main` 或打 `v*` 标签后，GitHub Actions（`.github/workflows/docker-image.yml`）会测试并构建 amd64/arm64 镜像，推送到 `ghcr.io/smallsmartmouse/wxrobot-web`。

```bash
docker run -d --name wxrobot-web -p 127.0.0.1:8787:8787 -v wxrobot-data:/data ghcr.io/smallsmartmouse/wxrobot-web:latest
```

- 端口只映射到宿主机的 `127.0.0.1`：镜像使用内置配置 `allow_remote: true`以接受 Docker 网桥转发的请求，但仍只接受 Host 为本机名的访问。
- 数据库和图片在 `/data` 卷中。迁移已有数据：停止服务后把 `.state/wechat.db*` 和 `.state/media/` 复制进卷。
- 自定义服务配置可挂载到 `/app/config.json`。
- 容器需要能访问手机所在的局域网（Docker Desktop 默认可以）。日志输出到 `docker logs`，调试页不显示服务日志。
- 仓库公开时镜像包也是公开的，可以直接拉取；仓库改为私有后需要先 `docker login ghcr.io`。

## 代码结构

| 文件 | 内容 |
| --- | --- |
| `main.go` | 启动、状态结构 |
| `store.go` | SQLite 读写：只写入变化的行，一次保存一个事务 |
| `accounts.go` | 多台手机和账号：连接管理、会话归属、任务分派 |
| `phone.go` | 手机接口调用、事件长轮询、读写任务执行 |
| `messages.go` | 会话与消息结构、把手机读到的屏幕内容并入会话 |
| `ai.go` | AI 设置与名称规则、自动回复 |
| `media.go` | 图片保存与读取 |
| `router.go` | 网页接口 |
| `static/` | 网页 |

## 多账号

- **账号就是微信号**。每台手机上报它当前登录的微信号；会话属于一个账号，不同账号的同名会话是不同的会话，聊天记录互不混用。
- **每台手机一个 `eventLoop` 和一个 `worker`**，互不阻塞。事件带着发生时的微信号，按它归到对应账号；手机还没识别出微信号时的事件丢弃，之后的读取会补上。
- **任务分派**：任务交给当前登录着会话账号的手机，开始执行时记下 `phone_id`，服务重启后仍向同一台手机查询。没有任何手机登录该账号时，排队的任务直接失败（未执行）。
- **账号核对**：提交任务时带上预期的微信号，手机不一致就拒绝执行（`ACCOUNT_MISMATCH`）；发送前手机的识别结果超过 5 分钟会先重新识别。读取结果里的微信号再核对一次，不一致就不保存。
- **换号**：手机上切换微信账号后，可以在“手机连接”里点“重新识别账号”，否则手机空闲时每 30 分钟也会重新识别一次。原账号的会话保留，之后有手机登录同一个微信号时继续使用。
- **从单手机版本升级**：原来的手机连接迁移为第一台手机，它第一次上报微信号时，原有会话都归到这个账号。

## 数据流

1. **事件**：每台手机的 `eventLoop` 长轮询 `/v1/events`。通知和未读提示只标记会话“需要读取”；当前聊天的屏幕快照直接并入正文。
2. **读取时机**（`worker` 空闲时安排，同时满足多个时按 通知触发 > 定时 > 补取原图 的顺序，同类按最久未读排序）：
   - 通知 / 首页未读提示：距上次读取满 5 秒立即读取；
   - 定时读取：会话工具栏可设每 1 分钟到 1 小时；
   - 补取原图：最近 10 条消息里还有图片没取原图时，距上次读取满 1 分钟再读（每次最多 2 张）。更早的图片只保留缩略图，避免手机为找图片翻很多页；
   - 发送后：手机直接回传当前屏幕；接不上已有记录或补读失败时再安排一次读取；
   - 手机上打开的聊天：内容变化时实时推送屏幕快照。
   自动读取把已记录的最后 3 条文字（跳过图片、表情和系统提示）作为停止点发给手机，手机向上翻页读到它们就停；要取原图时停止点挪到最近 10 条里最早一张待取原图的图片之前。有停止点时一次最多读 100 条；还没有已记录的文字时读 30 条，接不上再加深到 100 条。
   手机因翻页上限、两屏比对不上等原因提前停止时，加深读取也会停在同一处，所以直接整批追加并标记缺口，不再重读。
3. **任务**：每台手机的 `worker` 按创建顺序逐个执行它负责的任务。任务 ID 同时作为手机端的 `Idempotency-Key`，服务重启后用同一 ID 继续，不会重复执行。
4. **消息合并**：在已记录消息的末尾与新屏幕内容之间找唯一衔接点，只追加新消息。读取任务找不到衔接点时整屏追加并标记缺口；界面监测找不到时忽略（可能是用户在手机上翻看历史）。
5. **AI**：`aiLoop` 每秒检查开启回复的会话，有新来信（含触发词）且超过最短间隔时调用模型。生成后会话仍是自动回复就建立发送任务。

## 执行诊断

左上角“诊”打开诊断页（`/debug.html`），有新的失败或降级时入口上显示红点。

- **降级**：操作完成了，但用了不太可靠的办法或结果不完整，例如原图保存失败改用大图截图、翻页没能确认重叠而提前停止、缩略图截取失败、截图授权失效。
- **出错截图**：进入聊天失败、发现聊天被切换、发送未确认等情况，手机会附上当时的屏幕截图，诊断页在对应步骤下显示；清理旧任务时一起删除。
- 手机执行每个任务时记录步骤和耗时，随结果上报；电脑把耗时、步骤和降级保存在任务记录里。会话里最近一次任务有降级时，消息下方会提示并可跳到诊断页。
- 手机桥另外保留最近 50 条异常和降级事件（包括后台监测），同一问题 10 分钟内只记一条并累计次数，通过 `/v1/device` 的 `diagnostics` 提供。

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
| `GET /api/state` | 会话列表（带 `account`）、最近任务、手机列表和连接状态、账号列表 |
| `GET /api/stream` | SSE，数据变化时推送 `refresh` |
| `POST /api/phones` | 添加手机 `{phone_url, token}` |
| `POST /api/phones/{id}` | 修改手机地址或 Token（Token 留空保留原值）；有任务执行中时返回 409 |
| `POST /api/phones/{id}/delete` | 删除手机连接（会话保留在原账号下）；有任务执行中时返回 409 |
| `POST /api/phones/{id}/refresh-account` | 让手机空闲时重新识别微信号 |
| `POST /api/conversations` | 新建会话 `{account, title, kind}` |
| `GET /api/conversations/{id}` | 会话详情和消息 |
| `POST /api/conversations/{id}/seen` | 清除未读 |
| `POST /api/conversations/{id}/kind` | 设置会话类型 |
| `POST /api/conversations/{id}/read` | 读取，需 `Idempotency-Key` |
| `POST /api/conversations/{id}/send` | 发送 `text` 或 `image_hash`，需 `Idempotency-Key` |
| `POST /api/conversations/{id}/ai` | 会话回复方式，`mode: inherit` 表示跟随名称规则 |
| `POST /api/conversations/{id}/clear` | 删除电脑上的聊天记录和只被它们用到的图片（手机微信不受影响）；有读写任务执行中也可以删，任务结果按删除时留下的衔接点合并，旧消息不会再导入 |
| `GET/POST /api/ai/config` | 全局 AI 设置和名称规则 |
| `POST /api/media` | 上传 PNG/JPEG（Base64） |
| `GET /api/media/{hash}` | 读取图片 |

## 数据

数据在 SQLite 数据库 `.state/wechat.db`，图片在 `.state/media/`。最多保留 200 个已结束任务和 100 条 AI 记录。

| 表 | 内容 |
| --- | --- |
| `messages` | 每条消息一行：`conversation_id`、`seq`、`text`、`direction`、`sender`、`kind`（`image` / `sticker`）、`time`、图片和原图信息等列 |
| `conversations` | 会话设置（类型、未读、AI、定时读取、原图开关）、群成员头像（`members`：名称 → 图片哈希）、删除记录时留下的衔接点（`anchor`，不显示，只用来避免旧消息被重新导入），JSON |
| `operations` / `ai_jobs` | 读写任务、AI 自动回复记录，JSON |
| `settings` | 手机列表（地址、Token、事件游标、最近的微信号）、AI 设置与名称规则，JSON |

可以直接查询，例如：

```bash
sqlite3 .state/wechat.db "SELECT time, direction, text FROM messages ORDER BY time DESC LIMIT 20"
```

第一次启动新版本时，如果数据库为空而 `.state/state.json` 存在，会自动导入，并把原文件改名为 `state.json.migrated` 保留。备份时停止服务后复制 `.state/` 目录（包括 `wechat.db-wal` 文件）。
