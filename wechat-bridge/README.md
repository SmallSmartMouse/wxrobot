# 手机微信桥

AutoJs6 脚本，在手机上同时提供 HTTP 接口并操作微信。电脑用 Bash + ADB 部署。

| 文件 | 作用 |
| --- | --- |
| `bridge.js` | 主脚本：HTTP 接口、任务执行、消息监测 |
| `wechat.js` | 微信界面操作：打开聊天、读取消息、发送文字和图片 |
| `restart.js` | 停止旧脚本，等锁释放后启动 `bridge.js` |
| `deploy-phone.sh` | 电脑端部署入口 |
| `config.example.json` | 首次部署的配置模板 |

手机上的目录固定为 `/sdcard/wechat-bridge/`。

## 运行方式

`bridge.js` 只有一个进程，三条执行线：

```
HTTP 线程（每个连接一个）       主线程（循环，每 0.4 秒）           通知回调
  POST /v1/messages/*  ─► 排队任务 ─► 执行任务：打开聊天 → 读取/发送       微信通知
  GET  /v1/tasks/{id}  ◄── 任务结果       ↓ 空闲时
  GET  /v1/events      ◄── 事件队列 ◄── 监测：首页未读 / 当前聊天变化  ◄──┘
```

- **同一时刻最多一个排队任务**，界面操作完全串行。手机长时间未就绪时，排队超过 60 秒的任务标记失败（未执行，可安全重试）。
- **任务和事件只在内存中。** 脚本重启后电脑查询不到原任务，发送会被电脑标记为“结果未知”，不会重发。
- **发送只点击一次。** 点击前核对聊天标题、输入内容；点击后出错一律报告 `unknown`。
- 打开聊天的顺序：已在目标聊天 → 首页最近会话 → 全局搜索；结果不唯一就停止。
- **确认聊天对象**：当前微信（8.0.78）的聊天页不向无障碍服务提供标题控件，所以不在进入后识别标题，而是在进入前确认：首页会话列表或搜索结果中名称完全一致且唯一的那一项，点击它进入。进入后记下屏幕上的消息，点发送前和读取前后确认当前屏幕仍能和它接上（新消息把旧的挤上去也算接上），接不上说明被切到了别的聊天，立即停止（`CHAT_CHANGED`）。如果微信提供了标题控件，则优先用标题精确核对。
- 后台监测同样只把“和最近操作的聊天接得上”的屏幕记为该聊天的快照；手机上手动打开的其他聊天不会被记错地方。

## 部署

电脑需要 Bash、ADB、jq、curl 和 `sha256sum` 或 `shasum`。在本目录执行：

```bash
./deploy-phone.sh --dry-run
```

```bash
./deploy-phone.sh
```

| 参数 | 含义 |
| --- | --- |
| `--adb 路径` | 指定 ADB，也可用环境变量 `ADB` |
| `--serial 序列号` | 多台手机时必填 |
| `--config 配置文件` | 手机上还没有 `config.json` 时上传 |
| `--no-restart` | 只更新文件 |
| `--dry-run` | 只检查，不修改手机 |

脚本上传 3 个运行文件并核对 SHA-256，删除旧版本的代码文件，保留手机上的配置，然后运行 `restart.js` 并通过 ADB 端口转发确认就绪。不要在发送过程中部署。

## 配置

`config.json` 字段：`device_id`（ADB 序列号）、`phone_api_token`（至少 32 字符）、`phone_api_port`、`wechat_version`、`profile`（控件编号，`message_id`、`list_id`、`input_id` 必须校准）、`chat_aliases`（名称不一致时的别名）。旧版本的 `agent_token`、`mode`、`screen` 等字段已不再使用，保留也无影响。

## 接口

除 `/health` 外都需要 `Authorization: Bearer <phone_api_token>`。

| 方法和路径 | 作用 |
| --- | --- |
| `GET /health` | 存活检查 |
| `GET /v1/device` | `online`（主循环 45 秒内有心跳）和 `info.ready`、`info.reasons` |
| `POST /v1/messages/read` | `{chat, chat_type, limit, return_list}`，需要 `Idempotency-Key` |
| `POST /v1/messages/send` | `{chat, chat_type, text}` 或 `{chat, chat_type, image_base64}`，需要 `Idempotency-Key` |
| `GET /v1/tasks/{id}` | 任务状态和结果；最近 50 个任务 |
| `GET /v1/events?after=&limit=&wait=` | 长轮询消息事件：`notification`、`unread_chat`、`visible_snapshot` |

## 诊断

- `wechat.js` 在每次操作中记录步骤和降级（`steps`、`warnings`），`bridge.js` 把它们附在任务结果的 `diagnostics` 里。
- `bridge.js` 保留最近 50 条异常和降级事件，`GET /v1/device` 的 `diagnostics` 字段返回，电脑的诊断页展示。
- 截图授权申请失败（例如锁屏时重启）不会让脚本退出：状态报告 `CAPTURE_PERMISSION_REQUIRED`，解锁后每分钟自动重试，并自动点系统弹窗的“立即开始”。

## 排查

- **未就绪**：查看 `/v1/device` 的 `info.reasons`（无障碍、随选朗读、锁屏、微信版本、截图授权、控件校准）。
- **聊天不匹配**：检查完整名称、别名、群人数后缀。
- **发送结果未知**：先看手机，不要直接重发。
- 手机上的 `bridge.log` 记录任务开始、结束和错误码，不含消息正文。
