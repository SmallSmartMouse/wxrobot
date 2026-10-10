// 手机端微信桥（AutoJs6，ES5 语法）：一个脚本接收电脑的读写任务并操作微信。
//
//   连接线程（connection.js）：电脑经加密连接发来请求：提交读写任务、查询任务结果、拉取消息事件。
//   主线程：  循环执行任务；空闲时监测当前聊天和未读会话，生成消息事件。
//   通知回调：微信通知生成消息事件。
//
// 任务和事件只保存在内存中。脚本重启后电脑查询不到原任务，会把发送标记为“结果未知”，不会重发。
// 代码和数据分开存放：
//   代码（bridge.js、wechat.js、connection.js）从本脚本所在目录加载。ADB 部署时就是 BASE；
//   VSCode“运行项目”时是 AutoJs6 的缓存目录。
//   数据（config.json、锁、日志、状态、原图）固定放在 BASE，无论从哪里运行都共用同一份配置和同一把锁。
var BASE = "/sdcard/wechat-bridge/";
var config = JSON.parse(files.read(BASE + "config.json"));
var ui = require(files.join(files.cwd(), "wechat.js"))(config, BASE);

var TASK_TIMEOUT_MS = 150000; // 单个任务的界面操作上限（翻页读取 100 条可能较慢）
var QUEUE_TIMEOUT_MS = 60000; // 手机一直未就绪时，排队任务超过该时间视为失败
var MAX_FINISHED_TASKS = 50;
var MAX_EVENTS = 300;
var MAX_EVENT_RESPONSE_CHARS = 2000000;
var MAX_BODY_BYTES = 16000000;
var MAX_FILE_BYTES = 40 * 1024 * 1024; // 原图文件上限
var FILE_CHUNK_BYTES = 256 * 1024; // 原图分块发送，避免连接的发送队列一次装入大文件

// ---------- 共享状态：连接线程与主线程共用，读写都在 withLock 内 ----------

var lock = new java.util.concurrent.locks.ReentrantLock();
var taskQueued = lock.newCondition(); // 有新任务时唤醒主循环，不必等下一轮
var eventAdded = lock.newCondition(); // 有新事件时唤醒长轮询，不必轮询等待
var tasks = {}; // 任务编号 → 任务
var tasksByKey = {}; // Idempotency-Key → 任务
var taskOrder = []; // 任务编号，按创建顺序
var pendingTask = null; // 等待执行的任务；同一时刻最多一个
var eventLog = [];
var lastSeq = Date.now(); // 事件序号从启动时间开始，脚本重启后仍然递增
var deviceInfo = { ready: false, reasons: ["STARTING"] };
var heartbeat = 0; // 主线程最近一次循环的时间
var taskStarted = 0; // 正在执行的任务开始的时间，没有任务时为 0
var lastTaskEnded = 0; // 上一个任务结束的时间：排队超时从手机空闲下来时算起

// withLock 在共享锁内执行 fn 并返回其结果。
function withLock(fn) {
    lock.lock();
    try {
        return fn();
    } finally {
        lock.unlock();
    }
}

// awaitSignal 在 withLock 内调用：暂时释放锁，最多等 ms 毫秒或直到 condition 被唤醒。
function awaitSignal(condition, ms) {
    if (ms > 0) condition.awaitNanos(ms * 1000000);
}

// utf8 把字符串转成 UTF-8 字节数组（Java byte[]）。
function utf8(value) {
    return new java.lang.String(value).getBytes("UTF-8");
}

// sha256 返回字符串的 SHA-256（Base64），用作任务内容指纹。
function sha256(value) {
    var digest = java.security.MessageDigest.getInstance("SHA-256").digest(utf8(value));
    return String(android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP));
}

// log 同时输出到控制台和 bridge.log；日志超过 2 MB 时轮转为 bridge.log.1。
function log(message) {
    var line = new Date().toISOString() + " " + message;
    console.log(line);
    try {
        var path = BASE + "bridge.log";
        if (files.exists(path) && new java.io.File(path).length() > 2 * 1024 * 1024) {
            files.remove(path + ".1");
            files.rename(path, "bridge.log.1");
        }
        files.append(path, line + "\n");
    } catch (_) {}
}

// httpError 抛出带状态码和错误代码的异常，由 connection.js 转成给电脑的错误响应。
function httpError(status, code, message) {
    var e = new Error(message);
    e.status = status;
    e.code = code;
    throw e;
}

// ---------- 诊断事件 ----------
// 最近的异常（error）和降级（warning），通过 /v1/device 提供给电脑的诊断页。
// 同一问题（级别、代码、会话、内容相同）10 分钟内重复出现只累加次数，避免监测循环刷屏。
var diagnosticsLog = [];

// addDiagnostic 记录一条异常或降级，并写入日志。context 可带 task_id、operation、chat、source。
function addDiagnostic(level, code, message, context) {
    context = context || {};
    log((level === "error" ? "异常 " : "降级 ") + code + " " + (context.task_id || "") + " " + message);
    withLock(function () {
        var now = Date.now();
        // 从最新的往前找 10 分钟内的同一问题，找到就累计次数
        for (var i = diagnosticsLog.length - 1; i >= 0; i--) {
            var d = diagnosticsLog[i];
            if (now - d.last_ms > 600000) break;
            if (d.level === level && d.code === code && d.chat === (context.chat || "") && d.message === message) {
                d.count++;
                d.last_ms = now;
                d.last_at = new Date(now).toISOString();
                if (context.task_id) d.task_id = context.task_id;
                return;
            }
        }
        // 新问题：追加一条，最多保留 50 条
        diagnosticsLog.push({
            level: level,
            code: code,
            message: message,
            chat: context.chat || "",
            source: context.source || "task",
            task_id: context.task_id || "",
            operation: context.operation || "",
            count: 1,
            at: new Date(now).toISOString(),
            last_at: new Date(now).toISOString(),
            last_ms: now
        });
        if (diagnosticsLog.length > 50) diagnosticsLog.shift();
    });
}

// recentDiagnostics 返回诊断事件的副本，供 /v1/device 返回。
function recentDiagnostics() {
    return withLock(function () {
        return diagnosticsLog.slice();
    });
}

// ---------- 任务 ----------

// taskView 返回任务对外可见的字段（不含请求内容和指纹）。
function taskView(task) {
    return { id: task.id, operation: task.operation, status: task.status, result: task.result };
}

// validatePayload 校验读取或发送请求的参数，返回整理后的任务参数；不合法时抛出 400。
// account：电脑预期手机登录的微信号，执行前核对。
function validatePayload(operation, data) {
    if (!data || typeof data !== "object") httpError(400, "BAD_BODY", "需要 JSON 对象");
    var chat = data.chat;
    if (typeof chat !== "string" || !chat.trim() || chat.length > 128 || /[\x00-\x1f]/.test(chat))
        httpError(400, "BAD_CHAT", "需要明确聊天名称");
    if (data.chat_type !== undefined && data.chat_type !== "person" && data.chat_type !== "group")
        httpError(400, "BAD_CHAT_TYPE", "会话类型必须为 person 或 group");
    if (data.account !== undefined && (typeof data.account !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(data.account)))
        httpError(400, "BAD_ACCOUNT", "account 必须是微信号");
    var payload = { chat: chat.trim(), group: data.chat_type === "group", account: data.account || "" };
    if (operation === "read") addReadOptions(payload, data);
    else if (data.image_base64 !== undefined) addImage(payload, data);
    else addText(payload, data);
    return payload;
}

// addReadOptions 读取：条数、是否读历史、是否识别会话类型、读完是否回到首页、读到哪几条已知消息停止、最多取几张原图。
function addReadOptions(payload, data) {
    var limit = data.limit === undefined ? 20 : data.limit;
    if (typeof limit !== "number" || limit % 1 !== 0 || limit < 1 || limit > 100) httpError(400, "BAD_LIMIT", "limit 必须为 1–100 的整数");
    if (data.read_history !== undefined && typeof data.read_history !== "boolean") httpError(400, "BAD_READ_HISTORY", "read_history 必须是布尔值");
    var until = data.until === undefined ? [] : data.until;
    var validUntil = Array.isArray(until) && until.length <= 5 && until.every(function (t) {
        return typeof t === "string" && t.length <= 10000;
    });
    if (!validUntil) httpError(400, "BAD_UNTIL", "until 必须是最多 5 条文字");
    var originals = data.originals === undefined ? 0 : data.originals;
    if (typeof originals !== "number" || originals % 1 !== 0 || originals < 0 || originals > 3) httpError(400, "BAD_ORIGINALS", "originals 必须为 0–3 的整数");
    payload.limit = limit;
    payload.read_history = data.read_history !== false;
    payload.identify_kind = data.identify_kind === true;
    payload.return_list = data.return_list === true;
    payload.until = until; // 已记录的最后几条消息文字，翻页读到它们就停止
    payload.originals = originals;
}

// addImage 发送图片：Base64 图片数据，不能同时带文字。
function addImage(payload, data) {
    var image = data.image_base64;
    if (data.text !== undefined || typeof image !== "string" || image.length > 12000000 || !/^[A-Za-z0-9+/=]+$/.test(image))
        httpError(400, "BAD_IMAGE", "图片数据无效");
    payload.image_base64 = image;
}

// addText 发送文字：1–2000 字。
function addText(payload, data) {
    if (typeof data.text !== "string" || !data.text.trim() || data.text.length > 2000) httpError(400, "BAD_TEXT", "文本必须为 1–2000 字符");
    payload.text = data.text;
}

// 同一个 Idempotency-Key 重复提交相同内容时返回原任务，内容不同则拒绝。
function createTask(operation, data, key) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key || "")) httpError(400, "BAD_IDEMPOTENCY_KEY", "需要 Idempotency-Key");
    var payload = validatePayload(operation, data);
    // 任务内容指纹：同一个 key 再次提交时，用来判断内容是否相同
    var fingerprint = sha256(operation + JSON.stringify(payload));
    return withLock(function () {
        var existing = tasksByKey[key];
        if (existing) {
            if (existing.fingerprint !== fingerprint) httpError(409, "IDEMPOTENCY_CONFLICT", "同一 key 不能用于不同请求");
            return taskView(existing);
        }
        // 主循环 45 秒没有心跳或手机未就绪时，不接新任务
        if (!alive() || !deviceInfo.ready)
            httpError(409, "DEVICE_NOT_READY", "手机未就绪：" + (deviceInfo.reasons || []).join(", "));
        // 同一时刻只允许一个排队任务（电脑端本来就是逐个提交）
        if (pendingTask) httpError(429, "BUSY", "手机已有排队任务");
        var task = {
            id: String(java.util.UUID.randomUUID()),
            key: key,
            fingerprint: fingerprint,
            operation: operation,
            payload: payload,
            status: "queued",
            created: Date.now(),
            result: null
        };
        // 登记任务，成为待执行任务，并清理过多的旧任务
        tasks[task.id] = task;
        tasksByKey[key] = task;
        taskOrder.push(task.id);
        pendingTask = task;
        taskQueued.signal();
        forgetOldTasks();
        return taskView(task);
    });
}

// forgetOldTasks 任务数超过上限时，从最早的开始删除已结束的任务；遇到未结束的就停。
function forgetOldTasks() {
    while (taskOrder.length > MAX_FINISHED_TASKS) {
        var oldest = tasks[taskOrder[0]];
        if (oldest.status === "queued" || oldest.status === "running") return;
        taskOrder.shift();
        delete tasks[oldest.id];
        delete tasksByKey[oldest.key];
    }
}

// getTask 返回任务状态和结果；任务不存在（例如脚本重启过）时返回 404。
function getTask(taskId) {
    return withLock(function () {
        if (!tasks[taskId]) httpError(404, "NOT_FOUND", "任务不存在");
        return taskView(tasks[taskId]);
    });
}

// finishTask 记录任务结果并写日志。
function finishTask(task, status, result) {
    withLock(function () {
        task.status = status;
        task.result = result;
        task.payload = null; // 释放图片数据
    });
    var detail = "";
    if (status !== "succeeded") detail = result.code;
    else if (result.messages) detail = result.messages.length + " 条 " + result.stop_reason;
    log("任务 " + task.id + " " + task.operation + " " + status + " " + detail);
}

// alive 主线程是否在工作：最近 45 秒内有心跳，或者正在执行一个没超时的任务（任务期间主循环不转，不更新心跳）。
function alive() {
    var now = Date.now();
    return now - heartbeat < 45000 || (taskStarted > 0 && now - taskStarted < TASK_TIMEOUT_MS + 15000);
}

// 取出下一个可执行的任务；手机长时间未就绪时让排队任务失败（未执行，可安全重试）。
// 排队时间从手机空闲下来时算起：前一个任务执行得久不算未就绪。
function takeTask() {
    var expired = null;
    var task = withLock(function () {
        var next = pendingTask;
        if (!next) return null;
        if (Date.now() - Math.max(next.created, lastTaskEnded) > QUEUE_TIMEOUT_MS) {
            pendingTask = null;
            expired = next;
            return null;
        }
        if (!deviceInfo.ready) return null;
        pendingTask = null;
        next.status = "running";
        taskStarted = Date.now();
        return next;
    });
    if (expired) finishTask(expired, "failed", { code: "TASK_EXPIRED", message: "手机长时间未就绪，任务未执行" });
    return task;
}

// waitForTask 主循环的间歇：最多等 ms 毫秒，期间有可执行的任务就立即返回。
// 手机未就绪时排队任务暂不能执行，照常等待，避免空转。
function waitForTask(ms) {
    withLock(function () {
        if (!pendingTask || !deviceInfo.ready) awaitSignal(taskQueued, ms);
    });
}

var lastChat = null; // 最近一次任务操作的聊天，监测时用于识别读不到标题的当前聊天

// runTask 执行一个任务：在微信界面上执行 → 附上执行记录 → 记入诊断事件 → 保存结果。
function runTask(task) {
    log("任务 " + task.id + " " + task.operation + " 开始");
    ui.begin(TASK_TIMEOUT_MS); // 开始一次新操作：设置超时，清空执行记录
    var outcome = executeTask(task);
    attachExecutionRecord(outcome);
    reportDiagnostics(task, outcome);
    finishTask(task, outcome.status, outcome.result);
}

// executeTask 先打开目标聊天（核对账号和标题），再按任务类型读取或发送，返回 { status, result, warnings }。
// 已点击发送后出错，结果只能是未知，避免电脑误判为失败后重发。
function executeTask(task) {
    var p = task.payload;
    try {
        if (p.account) verifyAccount(p.account, task.operation === "send");
        ui.openChat(p.chat, p.group);
        var outcome = task.operation === "read" ? readChat(p, task.id) : sendToChat(p, task.id);
        // 记住最近操作的聊天：后台监测时读不到标题，可以用它来识别当前聊天
        lastChat = { name: p.chat, group: p.group };
        return outcome;
    } catch (e) {
        return {
            status: ui.clicked() ? "unknown" : "failed",
            result: { code: e.code || "UI_ERROR", message: String(e.message || e) },
            warnings: []
        };
    }
}

// readChat 读取当前聊天的消息。自动读取完成后回到首页，方便继续发现其他未读会话；
// 返回首页失败不影响已读到的结果，只记一条降级。
function readChat(p, taskId) {
    var result = ui.readMessages(p.chat, { limit: p.limit, until: p.until, originals: p.originals, readHistory: p.read_history, identifyKind: p.identify_kind, tag: taskId }),
        warnings = [];
    if (p.return_list) {
        try {
            ui.returnToList();
        } catch (e) {
            warnings.push({ code: "RETURN_LIST_FAILED", message: "消息已读取，但返回列表失败：" + String(e.message || e) });
        }
    }
    return { status: "succeeded", result: result, warnings: warnings };
}

// sendToChat 发送文字或图片。发送确认后再补读一次当前屏幕，让电脑尽快看到刚发的消息；
// 补读失败不能把发送改成失败，只提示电脑稍后重读。
function sendToChat(p, taskId) {
    if (p.image_base64) ui.sendImage(p.chat, p.group, p.image_base64, taskId);
    else ui.sendText(p.chat, p.group, p.text);
    var result = { confirmation: "ui_observed" };
    try {
        result.snapshot = ui.snapshot(true);
    } catch (_) {
        result.sync_error = "发送已确认，但发送后补读失败";
    }
    return { status: "succeeded", result: result, warnings: [] };
}

// attachExecutionRecord 给结果附上执行时登录的微信号（电脑再核对一次）和执行记录（步骤、降级），诊断页可以看到每一步。
function attachExecutionRecord(outcome) {
    var result = outcome.result;
    result.account = currentAccountId();
    result.diagnostics = ui.diagnostics();
    outcome.warnings.forEach(function (w) {
        result.diagnostics.warnings.push(w);
    });
}

// reportDiagnostics 把降级和失败记入诊断事件，诊断页可以集中查看。
function reportDiagnostics(task, outcome) {
    var result = outcome.result,
        context = { task_id: task.id, operation: task.operation, chat: task.payload.chat };
    result.diagnostics.warnings.forEach(function (w) {
        addDiagnostic("warning", w.code, w.message, context);
    });
    if (result.sync_error) addDiagnostic("warning", "SYNC_AFTER_SEND", result.sync_error, context);
    if (outcome.status !== "succeeded") addDiagnostic("error", result.code, result.message, context);
}

// ---------- 当前账号 ----------
// 启动后先识别当前登录的微信号（在“我”页面读取），电脑按微信号区分各账号的聊天记录。
// 识别失败时报告错误、不沿用之前的账号，空闲时每分钟重试；成功后空闲时每 30 分钟重新识别一次，发现手机上换了账号。
// 电脑提交任务时带上预期的微信号，不一致时拒绝执行；发送前识别结果超过 5 分钟的先重新识别，避免用错账号发消息。
// POST /v1/account/refresh 要求下次空闲时重新识别。
var ACCOUNT_RECHECK_MS = 30 * 60 * 1000;
var ACCOUNT_FRESH_MS = 5 * 60 * 1000;
var account = { wechat_id: "", error: null };
var accountCheckedAt = 0, // 最近一次识别成功的时间
    accountWanted = true,
    lastAccountTry = 0;

// currentAccountId 当前识别出的微信号，没有为空字符串。
function currentAccountId() {
    return withLock(function () {
        return account.wechat_id;
    });
}

// accountDue 空闲时是否需要（重新）识别账号。
function accountDue() {
    return withLock(function () {
        var now = Date.now();
        return accountWanted ? now - lastAccountTry > 60000 : now - accountCheckedAt > ACCOUNT_RECHECK_MS;
    });
}

// requestAccountRefresh 要求下次空闲时重新识别账号。
function requestAccountRefresh() {
    withLock(function () {
        accountWanted = true;
        lastAccountTry = 0;
    });
    return { ok: true };
}

// readAccount 在当前操作中识别账号并记下结果（调用前须 ui.begin），返回微信号；失败时清空账号并抛出异常。
function readAccount() {
    withLock(function () {
        lastAccountTry = Date.now();
    });
    var found;
    try {
        found = ui.identifyAccount();
    } catch (e) {
        var error = { code: e.code || "UI_ERROR", message: String(e.message || e) };
        withLock(function () {
            account = { wechat_id: "", error: error }; // 不沿用上一次的结果
            accountWanted = true;
        });
        addDiagnostic("error", error.code, "识别当前微信账号失败：" + error.message, { source: "account" });
        throw e;
    }
    var before = currentAccountId();
    if (before && before !== found.wechat_id) log("当前账号变为 " + found.wechat_id + "（之前 " + before + "）");
    withLock(function () {
        account = { wechat_id: found.wechat_id, nickname: found.nickname || "", identified_at: new Date().toISOString(), error: null };
        accountCheckedAt = Date.now();
        accountWanted = false;
    });
    return found.wechat_id;
}

// identifyAccount 空闲时识别当前账号；日志只记操作流程、结果和耗时。
function identifyAccount() {
    ui.begin(25000);
    var id = "";
    try {
        id = readAccount();
    } catch (_) {}
    var d = ui.diagnostics();
    log(
        "识别账号 " + (id ? "微信号 " + id : "失败") + "，耗时 " + d.duration_ms + " 毫秒：" +
            d.steps
                .map(function (s) {
                    return s.step + (s.detail ? "（" + s.detail + "）" : "") + " " + s.ms + "ms";
                })
                .join(" → ")
    );
}

// taskError 返回带错误代码的异常（任务失败，未执行）。
function taskError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
}

// verifyAccount 任务开始前核对手机登录的就是电脑预期的账号；fresh 为 true（发送）时识别结果太旧就先重新识别。
function verifyAccount(expected, fresh) {
    var current = withLock(function () {
        return { id: account.wechat_id, age: Date.now() - accountCheckedAt };
    });
    if (fresh && (!current.id || current.age > ACCOUNT_FRESH_MS)) current.id = readAccount();
    if (!current.id) throw taskError("ACCOUNT_UNKNOWN", "手机还没识别出当前登录的微信号，任务未执行");
    if (current.id !== expected)
        throw taskError("ACCOUNT_MISMATCH", "手机当前登录的微信号是 " + current.id + "，不是 " + expected + "，任务未执行");
}

// ---------- 消息事件 ----------

// pushEvent 追加一条消息事件并分配递增序号；最多保留 300 条，超出时丢掉最早的。
function pushEvent(event) {
    withLock(function () {
        event.seq = ++lastSeq;
        event.account = account.wechat_id; // 事件发生时登录的微信号，电脑据此归到对应账号
        event.received_at = new Date().toISOString();
        eventLog.push(event);
        if (eventLog.length > MAX_EVENTS) eventLog.shift();
        eventAdded.signalAll();
    });
}

// 返回序号大于 after 的事件，同时限制条数和总大小（至少返回一条，避免游标卡住）。
function readEvents(after, limit) {
    return withLock(function () {
        var out = [],
            size = 0;
        for (var i = 0; i < eventLog.length && out.length < limit; i++) {
            if (eventLog[i].seq <= after) continue;
            size += JSON.stringify(eventLog[i]).length;
            if (out.length && size > MAX_EVENT_RESPONSE_CHARS) break;
            out.push(eventLog[i]);
        }
        return { events: out, cursor: out.length ? out[out.length - 1].seq : after, latest_cursor: lastSeq };
    });
}

// 长轮询：有新事件立即返回（pushEvent 会唤醒），否则等到超时。
function waitEvents(query) {
    var after = intParam(query.after, 0, 0, 9007199254740991),
        limit = intParam(query.limit, 20, 1, 100),
        wait = intParam(query.wait, 25, 0, 25);
    var until = Date.now() + wait * 1000;
    return withLock(function () {
        var result;
        while (!(result = readEvents(after, limit)).events.length && Date.now() < until)
            awaitSignal(eventAdded, until - Date.now());
        return result;
    });
}

// ---------- 微信通知 ----------
// 监听直接挂在 AutoJs6 的通知监听服务上，不用 events.observeNotification：设置里已授权、系统却没连上这个服务时
// （MIUI 未允许自启动等），observeNotification 重试 2 秒就放弃并弹出设置页，之后服务连上也不会再挂上，一条通知都收不到。
// 这里每轮主循环检查一次，服务连上或被系统重建后挂到新的服务实例上。

// NOTIFICATION_PERMISSION_HINT 没有通知使用权时给用户的提示（网页 device-status.js、deploy-phone.sh 用同样的说法）。
var NOTIFICATION_PERMISSION_HINT = "未开启 AutoJs6 的通知使用权，收不到微信通知，停在聊天页时其他会话的新消息会发现得慢。请在手机设置中搜索“通知使用权”，打开 AutoJs6";

// NOTIFICATION_REBIND_MS 服务没连上时请求系统重新绑定、记诊断的间隔：与截图授权重试一致，不刷屏。
var NOTIFICATION_REBIND_MS = 60000;
var NotificationService = org.autojs.autojs.core.notification.NotificationListenerService;
var wechatNotifications = new JavaAdapter(org.autojs.autojs.core.accessibility.NotificationListener, { onNotification: onWechatNotification }),
    watchedService = null, // 已挂上监听的服务实例
    lastRebindRequest = 0;

// watchNotifications 确保微信通知监听挂在系统当前连着的通知服务上，返回现在能否收到通知。
function watchNotifications() {
    if (!notificationAccessGranted()) return false;
    var service = connectedNotificationService();
    if (!service) {
        requestNotificationRebind();
        return false;
    }
    if (!service.equals(watchedService)) {
        service.addListener(wechatNotifications);
        watchedService = service;
    }
    return true;
}

// connectedNotificationService 系统已连上的 AutoJs6 通知监听服务实例；没连上，或 AutoJs6 版本没有这个类时返回 null。
function connectedNotificationService() {
    return typeof NotificationService.getInstance === "function" ? NotificationService.getInstance() : null;
}

// unwatchNotifications 脚本退出时摘下监听：服务属于 AutoJs6 进程，不摘会继续回调已停止的脚本。
function unwatchNotifications() {
    if (watchedService) watchedService.removeListener(wechatNotifications);
    watchedService = null;
}

// notificationAccessGranted 系统设置里 AutoJs6 是否有通知使用权（有权限不代表系统已连上服务）。
function notificationAccessGranted() {
    var listeners = String(android.provider.Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners") || "");
    return listeners.indexOf("org.autojs.autojs6") >= 0;
}

// requestNotificationRebind 有通知使用权但服务没连上：每分钟请求系统重新绑定一次，并记诊断提示在手机上处理。
function requestNotificationRebind() {
    if (Date.now() - lastRebindRequest < NOTIFICATION_REBIND_MS) return;
    lastRebindRequest = Date.now();
    if (typeof NotificationService.requestRebindIfPossible === "function") NotificationService.requestRebindIfPossible(context);
    addDiagnostic("warning", "NOTIFICATION_LISTENER_UNBOUND",
        "已开启通知使用权，但系统没有连上 AutoJs6 的通知监听，收不到微信通知，停在聊天页时其他会话的新消息会漏掉。" +
        "请在系统设置里关闭再打开 AutoJs6 的通知使用权（MIUI 还需在安全中心允许 AutoJs6 自启动）；仍不行就重启手机", { source: "monitor" });
}

// onWechatNotification 在通知服务的线程里调用。只处理微信的通知：标题是会话名称，正文是消息预览。
// 跳过公众号和标题为“微信”的系统通知（“你有1条消息未发送”等），它们不是聊天。
// 异常不能抛出：这里跑在 AutoJs6 的主线程上，抛出会让整个应用闪退。
function onWechatNotification(n) {
    try {
        if (String(n.getPackageName()) !== "com.tencent.mm") return;
        var chat = String(n.getTitle() || ""),
            body = String(n.getText() || "");
        if (chat && body && !ui.ignoredChat(chat)) pushEvent({ kind: "notification", chat: chat, text: body });
    } catch (e) {
        log("处理微信通知失败：" + e);
    }
}

var monitorAccount = "";
var unreadSeen = {},
    lastSignature = null,
    lastVisibleCheck = 0;

// 空闲时监测：首页有新的未读会话 → unread_chat；当前聊天内容变化 → visible_snapshot。
function monitor() {
    var owner = currentAccountId();
    if (!owner) return;
    if (owner !== monitorAccount) {
        monitorAccount = owner; unreadSeen = {}; lastSignature = null; lastChat = null;
    }
    // 在首页时：比较每个未读会话的行内容，变化了说明有新消息
    ui.begin(5000);
    var unread = ui.unreadChats();
    if (unread) {
        for (var chat in unread) {
            if (!unreadSeen[chat] || unreadSeen[chat].signature !== unread[chat].signature) pushEvent({ kind: "unread_chat", chat: chat, unread_count: unread[chat].count });
        }
        unreadSeen = unread;
    }

    // 当前聊天内容每 3 秒检查一次
    if (Date.now() - lastVisibleCheck < 3000) return;
    lastVisibleCheck = Date.now();
    // 识别当前打开的聊天：先看标题控件；当前微信没有标题控件，就看是否仍在最近操作的聊天里（屏幕内容接得上）。
    // 接不上时不生成快照，避免把别的聊天的消息记错地方，改为请电脑补读最近操作的聊天。
    var name = ui.currentChat();
    if (!name && lastChat) {
        if (ui.stillInChat(lastChat.name)) name = lastChat.name;
        else if (ui.inChat()) requestReadOfLostChat();
    }
    if (!name) {
        lastSignature = null;
        return;
    }
    // 先不截图比较屏幕内容，有变化才截图生成快照事件（截图较耗时）
    var observed = ui.snapshot(false);
    var signature = owner + "|" + name + JSON.stringify([observed.messages, observed.at_latest]);
    if (signature === lastSignature) return;
    var snapshot = ui.snapshot(true);
    // 截图/上报失败时不更新签名，下轮仍会重试；空聊天也上报，才能保住第一条增量。
    pushEvent({ kind: "visible_snapshot", chat: name, snapshot: snapshot });
    lastSignature = signature;
}

// requestReadOfLostChat 停在最近操作的聊天页里，屏幕却和上次接不上：3 秒内来了超过一屏的新消息，或者用户切到了别的聊天。
// 认不出屏幕属于哪个聊天，但也不能不管：停在聊天里时微信把新消息直接标为已读，之后不会再有未读标记或通知。
// 按“有未读”上报最近操作的聊天，由电脑安排一次正常读取（从首页按名称进入，读到已记录的消息为止）。
// 之后不再认这个聊天，只报一次；如果其实是切到了别的聊天，代价只是多读一次。
function requestReadOfLostChat() {
    pushEvent({ kind: "unread_chat", chat: lastChat.name, unread_count: 0 });
    lastChat = null;
}

// IDLE_CHAT_MS 收不到通知时，停在手机桥进入的聊天里多久回会话列表：
// 留出连续发送、对方马上回复的时间，又不让其他会话的新消息等太久。
var IDLE_CHAT_MS = 8000;

// leaveIdleChat 只在收不到微信通知时调用：停在聊天页时首页的未读标记看不到，其他会话的新消息就发现不了。
// 手机桥自己进入的聊天空闲满 8 秒后回到会话列表，靠未读标记发现新消息；用户自己打开的聊天（屏幕接不上）不动。
// 离开前先补查一次当前屏幕，免得最后几秒的新消息被微信标为已读后丢失；补查失败（抛出）就不离开，下轮再试。
function leaveIdleChat() {
    var idleSince = withLock(function () {
        return lastTaskEnded;
    });
    if (!lastChat || Date.now() - idleSince < IDLE_CHAT_MS || !ui.stillInChat(lastChat.name)) return;
    lastVisibleCheck = 0;
    monitor();
    ui.returnToList();
}

// ---------- 电脑的请求 ----------
// 电脑经加密连接发来的请求：{ method, path, body, key }，key 是 Idempotency-Key。返回 [状态码, 响应体]。

// handleComputerRequest 处理电脑的一个请求；原图文件按块返回，取完后电脑通知删除。
function handleComputerRequest(message) {
    var req = parseComputerRequest(message);
    var result = route(req);
    return result[2] ? fileChunk(result[2], req.query) : result;
}

// parseComputerRequest 检查请求格式，拆出路径和查询参数。
function parseComputerRequest(message) {
    if ((message.method !== "GET" && message.method !== "POST") || typeof message.path !== "string" || message.path.length > 4096)
        httpError(400, "BAD_REQUEST", "请求格式无效");
    if (message.body != null && JSON.stringify(message.body).length > MAX_BODY_BYTES) httpError(413, "BODY_TOO_LARGE", "请求体过大");
    var target = message.path.split("?"),
        query = {};
    (target[1] || "").split("&").forEach(function (pair) {
        var kv = pair.split("=");
        if (kv[0]) query[kv[0]] = kv[1];
    });
    return { method: message.method, path: target[0], query: query, body: message.body, key: message.key || "" };
}

// route 按路径分发请求，返回 [状态码, 响应体]，或 [200, null, 文件路径] 表示要下载的原图。
function route(req) {
    if (req.method === "GET" && req.path === "/v1/device") return [200, deviceStatus()];
    if (req.method === "GET" && req.path === "/v1/events") return [200, waitEvents(req.query)];
    if (req.method === "GET" && req.path.indexOf("/v1/tasks/") === 0) return [200, getTask(req.path.slice(10))];
    if (req.method === "POST" && req.path === "/v1/account/refresh") return [202, requestAccountRefresh()];
    var file = /^\/v1\/files\/([A-Za-z0-9._-]+)$/.exec(req.path);
    if (req.method === "GET" && file) return [200, null, ui.originalsDir + file[1]];
    var create = /^\/v1\/messages\/(read|send)$/.exec(req.path);
    if (req.method === "POST" && create) return [202, createTask(create[1], req.body, req.key)];
    httpError(404, "NOT_FOUND", "接口不存在");
}

// deviceStatus 手机状态：主线程是否在工作、是否正在执行任务、就绪状态和最近的诊断事件。
function deviceStatus() {
    return { online: alive(), busy: taskStarted > 0, info: deviceInfo, diagnostics: recentDiagnostics() };
}

// intParam 解析查询参数中的非负整数；缺省时返回 fallback，超出范围返回 400。
function intParam(raw, fallback, min, max) {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) httpError(400, "BAD_QUERY", "查询参数无效");
    return Number(raw);
}

// fileChunk 返回原图文件从 offset 开始的一块（Base64）和文件总大小；done=1 表示电脑已取完，删除文件。
function fileChunk(path, query) {
    var file = new java.io.File(path);
    if (!file.isFile()) httpError(404, "NOT_FOUND", "原图文件不存在");
    if (file.length() > MAX_FILE_BYTES) httpError(413, "FILE_TOO_LARGE", "原图文件过大");
    if (query.done === "1") {
        file.delete();
        return [200, { ok: true }];
    }
    var offset = intParam(query.offset, 0, 0, Number(file.length()));
    var input = new java.io.RandomAccessFile(file, "r");
    try {
        input.seek(offset);
        var bytes = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, Math.min(FILE_CHUNK_BYTES, Number(file.length()) - offset));
        input.readFully(bytes);
        return [200, { size: Number(file.length()), data: String(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)) }];
    } finally {
        input.close();
    }
}

// ---------- 截图授权 ----------
// 截图用于图片缩略图、原图兜底，以及出错时附上屏幕画面。
// 手机锁屏时申请会失败（授权页打不开），不能因此退出：先照常运行并报告“需要截图授权”，解锁后每分钟重试一次。
var CAPTURE_RETRY_MS = 60000;
var captureReady = false,
    lastCaptureRequest = 0;

// requestCapture 申请截图授权；失败时记一条诊断事件，不抛出异常。
function requestCapture() {
    lastCaptureRequest = Date.now();
    // 锁屏时无法显示授权 Activity；启动阶段也应等待解锁再申请。
    if (!device.isScreenOn() || context.getSystemService("keyguard").isKeyguardLocked()) return;
    var clicker = null;
    try {
        bringAutoJsForward();
        clicker = threads.start(clickStartCapture);
        captureReady = requestScreenCapture(false);
        if (!captureReady) throw new Error("截图授权未获允许，请在系统授权窗口允许截图");
    } catch (e) {
        captureReady = false;
        addDiagnostic("warning", "CAPTURE_REQUEST_FAILED", "截图授权申请失败，请解锁并打开 AutoJs6，允许截图授权；每分钟自动重试：" + String(e.message || e).split("\n")[0], { source: "monitor" });
    } finally {
        if (clicker) clicker.interrupt();
    }
    if (captureReady) {
        ui.captureRestored(); // 清除“截图失效”标记
        log("截图授权已就绪");
    }
}

// bringAutoJsForward Android 会限制后台启动授权 Activity：申请前先把运行脚本的应用切到前台。
function bringAutoJsForward() {
    var capturePackage = String(context.getPackageName());
    if (currentPackage() === capturePackage) return;
    app.launchPackage(capturePackage);
    for (var attempt = 0; attempt < 20 && currentPackage() !== capturePackage; attempt++) sleep(250);
    if (currentPackage() !== capturePackage)
        throw new Error("AutoJs6 未能进入前台，请手动打开 AutoJs6；若仍失败，请允许后台弹出界面，稍后自动重试");
}

// clickStartCapture 在另一个线程里等系统弹出“AutoJs6 将开始截取屏幕”，点“立即开始”。
function clickStartCapture() {
    for (var i = 0; i < 60; i++) {
        sleep(250);
        if (currentPackage() !== "com.android.systemui") continue;
        var start = text("立即开始").findOnce();
        if (start && textMatches(/AutoJs6.*截取.*屏幕.*/).exists()) {
            start.click();
            return;
        }
    }
}

// captureNeedsRetry 截图授权缺失或失效，且手机已解锁、距上次申请满 1 分钟。
function captureNeedsRetry(info) {
    var unlocked = info.reasons.indexOf("SCREEN_LOCKED") < 0;
    return (!captureReady || ui.captureBroken()) && unlocked && Date.now() - lastCaptureRequest > CAPTURE_RETRY_MS;
}

// ---------- 状态文件 ----------
// 部署脚本经 ADB 读取 status.json，确认新代码已运行并就绪。只含就绪状态，不含凭证和消息内容。
var STATUS_PATH = BASE + "status.json";
var STATUS_WRITE_MS = 5000;
var lastStatusWrite = 0;

// writeStatus 最多每 5 秒写一次状态文件；写失败不影响运行。
function writeStatus() {
    if (Date.now() - lastStatusWrite < STATUS_WRITE_MS) return;
    lastStatusWrite = Date.now();
    try {
        files.write(STATUS_PATH, JSON.stringify({ updated_at: new Date().toISOString(), online: alive(), info: deviceInfo }));
    } catch (_) {}
}

// ---------- 启动 ----------
// 部署和手动运行都直接启动本脚本，旧实例由新实例负责停止，不需要单独的重启脚本。

// isBridge 判断引擎运行的是否是微信桥：脚本名为 bridge.js，且同目录下有 wechat.js。
// 按文件名而不是目录名判断，ADB 部署的和 VSCode 运行的（在缓存目录里）都能认出来。
function isBridge(engine) {
    try {
        return /\/bridge\.js$/.test(String(engine.getSource())) && files.exists(files.join(String(engine.cwd()), "wechat.js"));
    } catch (_) {
        return false; // 引擎正在退出等情况下读不到路径，当作不是
    }
}

// stopOtherInstances 停止除自己以外正在运行的微信桥。
function stopOtherInstances() {
    var me = engines.myEngine(),
        running = engines.all();
    for (var i = 0; i < running.length; i++) {
        if (running[i].equals(me) || !isBridge(running[i])) continue;
        log("停止 " + running[i].getSource());
        running[i].forceStop();
    }
}

// acquireProcessLock 等旧实例退出、释放 bridge.lock 后加锁，最多约 15 秒，返回 { file, lock }。
// 旧实例与本实例在同一进程（AutoJs6）里，它仍持有锁时 tryLock 会抛出异常而不是返回 null。
function acquireProcessLock() {
    var file = new java.io.RandomAccessFile(BASE + "bridge.lock", "rw");
    for (var attempt = 0; attempt < 60; attempt++) {
        try {
            var acquired = file.getChannel().tryLock();
            if (acquired) return { file: file, lock: acquired };
        } catch (_) {}
        sleep(250);
    }
    throw Error("旧的微信桥仍未停止，请稍后重试");
}

// ensureDeviceId 没有配置设备编号时生成一次并持久保存；IP 变化和脚本重启不会改变这个编号。
function ensureDeviceId() {
    if (config.device_id) return;
    var path = BASE + "device-id";
    config.device_id = files.exists(path) ? String(files.read(path)).trim() : "";
    if (!config.device_id) config.device_id = String(java.util.UUID.randomUUID());
    files.write(path, config.device_id);
}

// configureAccessibility 让无障碍服务报告控件编号、不重要的控件和多窗口信息（2 | 16 | 64）。
function configureAccessibility() {
    auto.setMode("normal");
    if (!auto.service) return;
    var serviceInfo = auto.service.getServiceInfo();
    serviceInfo.flags = serviceInfo.flags | 2 | 16 | 64;
    auto.service.setServiceInfo(serviceInfo);
}

// startComputerLinks 启动局域网发现与电脑主动连接（connection.js）：回应电脑的发现请求，授权后经加密连接接收请求。
// 连上电脑后安排空闲时打开微信、重新识别账号。
function startComputerLinks() {
    var links = require(files.join(files.cwd(), "connection.js"))({
        config: config, base: BASE, handle: handleComputerRequest, log: log, diagnostic: addDiagnostic, onReady: requestAccountRefresh
    });
    links.startDiscovery();
    return links;
}

// ---------- 主循环 ----------

// mainLoop 主循环：每轮更新就绪状态，执行任务或做空闲时的工作，然后间歇 400 毫秒（期间收到任务立即开始）。
// 主循环不能因为一次异常退出，异常记入诊断后等 2 秒继续。
function mainLoop() {
    while (true) {
        try {
            loopOnce();
        } catch (e) {
            addDiagnostic("error", e.code || "LOOP_ERROR", "监测或主循环异常：" + String(e.message || e), { source: "monitor" });
            sleep(2000);
        }
        waitForTask(400);
    }
}

// loopOnce 一轮主循环：配对框显示期间只报告等待确认；否则更新就绪状态，有任务就执行，
// 没有任务且就绪时先识别账号，再做后台监测。
function loopOnce() {
    if (computerLinks.isPairing()) {
        deviceInfo = { ready: false, reasons: ["PAIRING_CONFIRMATION_REQUIRED"] };
        heartbeat = Date.now();
        return;
    }
    var info = refreshDeviceInfo();
    device.keepScreenOn(30 * 60 * 1000); // 界面操作和截图都需要亮屏
    var task = takeTask();
    if (task) runTaskOnMainThread(task);
    else if (info.ready && accountDue()) identifyAccount();
    else if (info.ready) monitorIdle(info);
}

// refreshDeviceInfo 汇总就绪状态（截图授权缺失时顺带重新申请）、通知权限和当前账号，更新心跳和状态文件。
function refreshDeviceInfo() {
    var info = ui.status(captureReady);
    if (captureNeedsRetry(info)) {
        requestCapture();
        info = ui.status(captureReady);
    }
    info.notification_permission = notificationAccessGranted(); // 没有时电脑和部署脚本会提示去开启
    info.notification_access = watchNotifications();
    info.account = withLock(function () {
        return account;
    });
    deviceInfo = info;
    heartbeat = Date.now();
    writeStatus();
    return info;
}

// runTaskOnMainThread 执行任务，结束后记下空闲的开始时间（排队超时、离开空闲聊天都从这里算起）。
function runTaskOnMainThread(task) {
    try {
        runTask(task);
    } finally {
        withLock(function () {
            taskStarted = 0;
            lastTaskEnded = Date.now();
        });
    }
}

// monitorIdle 空闲时监测新消息；收不到微信通知时，手机桥进入的聊天空闲久了回到会话列表。
function monitorIdle(info) {
    monitor();
    if (!info.notification_access) leaveIdleChat();
}

// shutdown 脚本退出时：摘下通知监听、断开电脑连接、取消常亮、释放文件锁。
function shutdown() {
    unwatchNotifications();
    if (computerLinks) computerLinks.close();
    device.cancelKeepingAwake();
    try {
        processLock.lock.release();
        processLock.file.close();
    } catch (_) {}
}

var processLock = null,
    computerLinks = null;

// start 启动：停止旧实例并拿到文件锁 → 准备设备编号和无障碍服务 → 连接电脑 → 申请截图授权 → 进入主循环。
function start() {
    stopOtherInstances();
    processLock = acquireProcessLock();
    ensureDeviceId();
    events.on("exit", shutdown);
    configureAccessibility();
    files.removeDir(ui.originalsDir); // 清理上次运行遗留、电脑没取走的原图
    computerLinks = startComputerLinks();
    requestCapture();
    log("微信桥已启动");
    if (!notificationAccessGranted()) log(NOTIFICATION_PERMISSION_HINT);
    mainLoop();
}

start();
