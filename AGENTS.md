# 编码规范

适用于所有开发者和 AI 编码助手（Claude、GPT/Codex 等），覆盖 Go（`wechat-web`）和 JS（手机端 `wechat-bridge`、网页前端 `wechat-web/static`）。

目标：打开任意一个函数，能快速看清这一层的业务流程；技术细节按需下钻。

## 1. 函数分层

一个函数只写同一层的内容：

| 层 | 内容 | 本项目的例子 |
|---|---|---|
| 流程编排 | 一串命名清楚的步骤，读起来像业务说明 | `eventLoop`、`runOperation`、`mergeLiveLocked`、gin 接口处理函数、`bridge.js` 的 `runTask` / `loopOnce`、前端 `app.js` 的 `render()` |
| 业务规则 | 判断与决策，尽量写成纯函数：输入数据、返回决定 | `operationBlocker`、`connectionStatus`、`unsettledStatus`、`ForwardRule.accepts`、`replyProblemLocked` |
| 技术能力 | IO、加解锁、序列化、协议、轮询重试 | `phoneRequest`、`commitLocked`、`recordWriter`、`withLock`、`ui.*` |

- 编排层不出现锁、JSON 解码、HTTP 细节、匿名结构体。
- 读一个流程，跳 1～2 层就应能看到关键业务规则，不要层层嵌套。
- 样板：`wechat-web/phone_events.go` 的 `eventLoop`、`operations.go` 的 `runOperation`，`wechat-bridge/bridge.js` 的 `runTask`。
- 按业务领域分文件：Go 的 `operations.go`、`auto_read.go`、`phone_events.go`……；前端的 `accounts.js`、`chat.js`、`message-list.js`……。不要建“杂项”文件。

## 2. 什么时候抽函数

- 抽出的函数要"深"：看名字和签名就知道它做什么，不必跳进去确认。只是挪几行代码、读者仍要进去看的，不抽，写一行注释。
- 名字写意图（做什么），不写实现（怎么做）：`pollEvents`，不是 `getWithLongPollAndUnmarshal`。
- 布尔参数控制多种模式（`f(x, true, false, true)`）时，按模式拆成不同函数，共用步骤再抽出。
- 需要拆分的信号：函数超过约 50 行；嵌套超过 3 层；需要用"第一步/第二步"注释分段；同时出现业务判断和协议细节。这是信号，不是硬性规定。
- 规则冲突时可读性优先。例如两三行、只用一次的技术细节可以留在编排层，加注释说明即可。

## 3. 不能藏的东西

- **业务规则**必须留在编排层可见，不能当作细节封装掉（见第 4 节）。
- **副作用和并发语义**要体现在名字或签名里：持锁调用的 Go 函数以 `Locked` 结尾；会落盘、会阻塞、会失败的，要能从名字或返回值看出来。
- **错误处理**不隐藏：Go 编排层保留 `if err != nil`，早返回，正常路径靠左。

## 4. 关键业务约束（改动时不得破坏）

- 发送出错、无法确定手机是否执行过时，记为"结果未知"（`unknown`），**不自动重发**。手机端在点击发送之后出错也一样。
- 任务 ID 同时作为手机的 `Idempotency-Key`。已提交（`running`）的任务在服务重启后按手机任务编号续查，不重新提交。
- 同一台手机同一时刻只执行一个任务。
- 读取结果的微信号与会话账号不一致时不保存；发送已经成功的，不能因补读失败或其他后续问题改成失败。
- 消息衔接有缺口的批次不触发 AI 回复和转发，防止重复处理。

## 5. Go 约定

- 编排函数不直接调用 `a.mu.Lock()`：需要加锁的一步封装成一个函数，在内部加锁。接口处理函数整体在锁内执行时，开头加锁、`defer` 解锁即可。
- 持锁期间不做网络请求、不等待手机。本地保存（`commitLocked`）可以。
- 返回到网页的错误信息用中文，写清结果和后果，例如"等待手机超时，结果未知；不会自动重发"。
- 超时、上限这类数值定义为具名常量，注释写清取这个值的原因。
- 函数注释以函数名开头，写"做什么、为什么"，不复述代码。
- 状态、类型等取值使用常量（`opQueued`、`kindGroup`、`connOnline`……），不在各处散写字符串。
- 提交前运行 `gofmt`、`go vet ./...`。`go.mod` 要求 Go 1.26 以上，本机没有时 `run.sh` 会用 `~/.cache/wechat-web-go/go/bin/go`。

## 6. JS 约定

**手机端 `wechat-bridge`（AutoJs6）**
- 只能用 ES5：`var`、`function`；不用 `let`/`const`、箭头函数、模板字符串、`class`、解构。
- 连接线程和主线程共享的状态，读写都放在 `withLock` 内。
- 手机不开放 HTTP 端口：电脑的请求都经 `connection.js` 的加密连接到达，由 `bridge.js` 的 `route` 分发。

**网页前端 `wechat-web/static`**
- 页面结构写在 `index.html`；脚本只填数据、绑定事件，不用 `innerHTML` 模板或在启动时搬动 DOM。图标写成 `<span data-icon="名称">`。
- 使用 ES 模块，公共工具放在 `common.js`；模块之间共享的数据放在 `app` 上，跨区域的通知用 DOM 事件（如 `account-change`）。
- 渲染函数按页面区域拆分：先算出要显示的数据，再构建 DOM，不要在拼 DOM 的过程中做业务判断。

## 7. 重构与提交

- 重构必须保持行为不变：改之前先跑通测试，改完再跑。
- 没有自动化测试的代码（手机端、网页前端），改动前后要在同样的输入下对比行为；Go 测试没有覆盖的路径先补测试。
- 重构和功能改动分开提交；只整理本次涉及的代码，不顺手大面积重构。
- 测试命令：
  - `wechat-web`：`go test ./...`（涉及并发时加 `-race`）
  - `wechat-bridge`：`node --check bridge.js wechat.js connection.js`（没有自动化测试，改动后部署到手机验证）
  - 网页前端：没有自动化测试，改动后在浏览器里打开各页面检查（控制台无报错）
