# 手机微信桥

AutoJs6 脚本，在手机上同时提供 HTTP 接口并操作微信。电脑用 Bash + ADB 部署。

| 文件 | 作用 |
| --- | --- |
| `bridge.js` | 主脚本：HTTP 接口、任务执行、消息监测；启动时先停止正在运行的旧实例 |
| `connection.js` | 局域网 UDP 发现（回复电脑的发现请求）、WSS 主动连接、手机验证码与授权保存 |
| `wechat.js` | 微信界面操作：打开聊天、读取消息、发送文字和图片 |
| `deploy-phone.sh` | 电脑端部署入口 |
| `config.example.json` | 首次部署的配置模板 |
| `project.json` | AutoJs6 项目配置（入口 `bridge.js`，`ignore` 列出不发送到手机的文件） |
| `package.json`、`jsconfig.json` | VSCode 代码补全：`npm install` 安装 AutoJs6 声明文件 |

手机上的目录固定为 `/sdcard/wechat-bridge/`。`config.json`、锁、日志、原图都放在这里；代码从 `bridge.js` 所在目录加载。

## 运行方式

`bridge.js` 只有一个进程，三条执行线：

```
HTTP 线程（每个连接一个）       主线程（循环，每 0.4 秒）           通知回调
  POST /v1/messages/*  ─► 排队任务 ─► 执行任务：打开聊天 → 读取/发送       微信通知
  GET  /v1/tasks/{id}  ◄── 任务结果       ↓ 空闲时
  GET  /v1/events      ◄── 事件队列 ◄── 监测：首页未读 / 当前聊天变化  ◄──┘
```

- **同一时刻最多一个排队任务**，界面操作完全串行。手机长时间未就绪时，排队超过 60 秒的任务标记失败（未执行，可安全重试）；排队时间从前一个任务结束时算起。
- 读取时最多向上翻 20 页；读完为取原图回头找图片时最多翻 8 页。判断能否继续向上翻之前先刷新列表控件（无障碍缓存的旧信息曾让刚进入的聊天误报“已到最早”）。
- **任务和事件只在内存中。** 脚本重启后电脑查询不到原任务，发送会被电脑标记为“结果未知”，不会重发。
- **发送只点击一次。** 点击前核对聊天标题、输入内容；点击后出错一律报告 `unknown`。
- 打开聊天的顺序：已在目标聊天 → 首页最近会话 → 全局搜索；结果不唯一就停止。
- **确认聊天对象**：当前微信（8.0.78）的聊天页不向无障碍服务提供标题控件，所以不在进入后识别标题，而是在进入前确认：首页会话列表或搜索结果中名称完全一致且唯一的那一项，点击它进入。进入后记下屏幕上的消息，点发送前和读取前后确认当前屏幕仍能和它接上（新消息把旧的挤上去也算接上），接不上说明被切到了别的聊天，立即停止（`CHAT_CHANGED`）。如果微信提供了标题控件，则优先用标题精确核对。
- 后台监测同样只把“和最近操作的聊天接得上”的屏幕记为该聊天的快照；手机上手动打开的其他聊天不会被记错地方。
- **消息内容**：文字（`message_id`）、图片（描述“图片”或 `image_id`）、表情包（描述匹配 `sticker_desc` 或 `sticker_id`）。每条消息按同一高度的头像判断方向，发送人名称取头像描述“xxx头像”（配置了 `sender_id` 时优先取群昵称控件）。读取时每个发送人截一次头像。有头像却没认出内容的消息记一条降级 `UNRECOGNIZED_MESSAGES`，附带附近控件的描述，用来校准。
- **账号核对**：任务带 `account`（电脑预期的微信号）时，执行前核对，不一致报 `ACCOUNT_MISMATCH`、还没识别出报 `ACCOUNT_UNKNOWN`，都不执行；发送前识别结果超过 5 分钟先重新识别。任务结果和事件都带 `account`（当时登录的微信号）。识别成功后空闲时每 30 分钟重新识别一次。
- **当前账号**：启动后空闲时先识别一次：回到首页（底部“微信、通讯录、发现、我”四个标签）→ 点“我” → 读 `account_id`（默认 `com.tencent.mm:id/ouv`）的“微信号：xxx”，控件编号失效时在“我”页面上半部分按同样格式匹配 → 回到“微信”标签。只在“我”页面读取（四个标签中唯一顶部没有搜索按钮的页面），不截图。失败时账号清空并记诊断，每分钟重试；结果在 `/v1/device` 的 `info.account`，`bridge.log` 记录流程、结果和耗时。

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

脚本上传 3 个运行文件并核对 SHA-256，保留手机上的配置，然后运行 `bridge.js`（它会先停止旧实例、等锁释放）并通过 ADB 端口转发确认就绪。不要在发送过程中部署。

### VSCode 调试

1. 安装插件 AutoJs6 VSCode Extension（`003.autojs6-vscode-ext`），用 VSCode 单独打开 `wechat-bridge` 目录（插件把第一个工作区目录当作项目）。
2. 在本目录执行 `npm install`，安装 AutoJs6 声明文件，获得 `auto`、`files`、`engines` 等全局对象的补全。
3. 手机 AutoJs6 开启“服务端模式”或“客户端模式”，在 VSCode 命令面板执行“AutoJs6: 建立设备连接”。
4. “运行项目”（`Alt+F6`）把 `bridge.js`、`wechat.js`、`connection.js` 发送到 AutoJs6 的缓存目录并运行，日志显示在 VSCode 的输出面板。新实例会先停止手机上正在运行的微信桥。

注意：

- 调试运行仍读取 `/sdcard/wechat-bridge/config.json`，手机上需要先用 `deploy-phone.sh` 部署过一次。
- 调试运行的代码只在缓存目录里，手机重启或再运行 `/sdcard/wechat-bridge/bridge.js` 后又是部署的版本。调试完成后用 `deploy-phone.sh` 正式部署。
- “保存项目到设备”保存到 AutoJs6 工作目录（默认 `/sdcard/脚本/wechat-bridge/`），不会更新部署目录里的代码。

## 配置

`config.json` 字段：`device_id`（ADB 序列号）、`phone_api_token`（至少 32 字符）、`phone_api_port`、`discovery_port`（默认 `39000`，`0` 关闭）、`wechat_version`、`profile`（控件编号，`message_id`、`list_id`、`input_id` 必须校准；可选 `image_id`、`sticker_id`、`sticker_desc`、`sender_id`、`account_id`）、`chat_aliases`（名称不一致时的别名）。

手机桥默认监听 `39000/udp`。收到电脑 v2 广播或单播发现请求后，主动向报文来源电脑建立 WSS 连接，固定电脑证书指纹。首次弹出 6 位验证码：在网页输入此码，并在手机点击“允许这台电脑”，两端均确认后才授权。验证码有效 3 分钟，网页最多尝试 5 次，配对框显示期间暂停微信界面自动操作；无需扫码或复制 Token。未授权的电脑被拒绝或配对超时后，再次弹框的间隔从 1 分钟起每次加倍，最长 30 分钟。

授权凭证和电脑上次的地址保存在 `/sdcard/wechat-bridge/trusted-computers.json`，以后按这个地址自动验证并重连，电脑关闭自动搜索也能连上（电脑换了 IP 时需要它的发现广播才能找到）。一台手机只信任一台电脑：与新电脑配对并连上后，旧电脑的授权自动删除，旧电脑需要重新配对才能再用。已授权电脑连不上时从 5 秒起加倍重试，最长 5 分钟一次，日志只记第一次中断；它换了 IP 或重新上线（收到它的广播）时马上重连。电脑撤销授权后需要重新配对。跨网段搜索由电脑端配置私有 IPv4 范围，网络必须允许电脑向手机发 UDP、手机向电脑接入端口发 TCP。电脑默认接入端口为 `8788`，可配置。

旧版 v1 发现仍可回复用原有 Token 签名的设备信息，原 HTTP 接口保留。未配置 `device_id` 时生成 UUID 并保存到 `/sdcard/wechat-bridge/device-id`。UDP 监听失败不会影响 HTTP 服务，错误记录在 `bridge.log`。

## 接口

除 `/health` 外都需要 `Authorization: Bearer <phone_api_token>`。

| 方法和路径 | 作用 |
| --- | --- |
| `GET /health` | 存活检查 |
| `GET /v1/device` | `online`（主循环 45 秒内有心跳，或正在执行未超时的任务）、`busy`（正在执行任务）和 `info.ready`、`info.reasons`、`info.account` |
| `POST /v1/messages/read` | `{chat, chat_type, account, limit, return_list}`，需要 `Idempotency-Key` |
| `POST /v1/messages/send` | `{chat, chat_type, account, text}` 或 `{chat, chat_type, account, image_base64}`，需要 `Idempotency-Key` |
| `GET /v1/tasks/{id}` | 任务状态和结果；最近 50 个任务 |
| `POST /v1/account/refresh` | 下次空闲时重新识别当前微信号（切换账号后调用） |
| `GET /v1/events?after=&limit=&wait=` | 长轮询消息事件：`notification`、`unread_chat`、`visible_snapshot` |

## 诊断

- `wechat.js` 在每次操作中记录步骤和降级（`steps`、`warnings`），`bridge.js` 把它们附在任务结果的 `diagnostics` 里。
- `bridge.js` 保留最近 50 条异常和降级事件，`GET /v1/device` 的 `diagnostics` 字段返回，电脑的诊断页展示。
- 截图授权申请失败（例如锁屏时重启）不会让脚本退出：状态报告 `CAPTURE_PERMISSION_REQUIRED`，解锁后每分钟自动重试。申请前先打开 AutoJs6，并自动点系统弹窗的“立即开始”；若系统阻止后台打开应用，请手动打开 AutoJs6，必要时允许其后台弹出界面。
  申请授权要打开 AutoJs6 的界面：MIUI 等系统需要给 AutoJs6 开启“后台弹出界面”权限，否则 AutoJs6 不在前台时申请会超时（`Start activity to request screen capture timeout`），自动重试也不会成功。没开这个权限时，用 `deploy-phone.sh` 重新部署即可（它会先把 AutoJs6 切到前台）。

## 排查

- **未就绪**：查看 `/v1/device` 的 `info.reasons`（无障碍、随选朗读、锁屏、微信版本、截图授权、控件校准）。
- **聊天不匹配**：检查完整名称、别名、群人数后缀。
- **发送结果未知**：先看手机，不要直接重发。
- 手机上的 `bridge.log` 记录任务开始、结束和错误码，不含消息正文。

### 最近历史消息开关

网页「手机连接」中的「读取最近历史消息」默认开启，允许读取最近消息并向上翻页。关闭后对所有手机和会话生效：读取聊天底部当前一屏，消息和原图均不回翻，也不自动加深读取。已有会话沿用已读边界；新会话根据未读数量或通知定位增量，无新消息提示时首次读取才建立基准。当前屏无法衔接时保留内容并标记缺口，不回翻补漏；不确定批次不触发自动回复或转发。设置和基准保存在电脑端，重启后保留，已有记录不删除。切换从下一次读取生效，执行中的结果保留可衔接增量并按需补读当前屏。旧手机桥不支持此模式时会提示更新脚本。

账号识别同时读取“我”页面的微信名，并以 `info.account.nickname` 上报。微信 8.0.78 默认昵称控件为 `com.tencent.mm:id/kbb`，其他版本可通过 `profile.nickname_id` 校准。昵称只用于展示，任务中的 `account` 仍必须是微信号。

读取任务携带 `identify_kind: true` 时，读完消息后打开「聊天信息」，根据微信的 `SingleChatInfoUI`（个人）或 `ChatroomInfoUI`（群聊）页面标识返回 `chat_type`，随后返回聊天。未知页面保持 `unknown`，识别失败不丢弃已读消息。电脑只对待分类会话请求识别；手机不会在后台监测中跳转详情页。

### 连接后自动准备微信

电脑授权连接成功后，手机端会安排在空闲时打开微信并重新识别微信号，已有任务执行期间不插入界面操作。指定 Activity 启动未成功时，会使用系统应用启动入口重试。锁屏、后台弹出界面权限或系统权限弹窗仍可能阻止启动；这些原因会显示在 Web 消息台、设备详情和诊断页。处理后可点击“打开微信并重新识别”。此行为需要一起更新 `bridge.js`、`connection.js` 和 `wechat.js`，然后重启手机端服务。
