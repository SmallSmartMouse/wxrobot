// 手机端微信桥（AutoJs6，ES5 语法）：一个脚本同时提供 HTTP 接口并操作微信。
//
//   HTTP 线程：电脑提交读写任务、查询任务结果、拉取消息事件。
//   主线程：  循环执行任务；空闲时监测当前聊天和未读会话，生成消息事件。
//   通知回调：微信通知生成消息事件。
//
// 任务和事件只保存在内存中。脚本重启后电脑查询不到原任务，会把发送标记为“结果未知”，不会重发。
// 代码和数据分开存放：
//   代码（bridge.js、wechat.js）从本脚本所在目录加载。ADB 部署时就是 BASE；
//   VSCode“运行项目”时是 AutoJs6 的缓存目录。
//   数据（config.json、锁、日志、原图）固定放在 BASE，无论从哪里运行都共用同一份配置和同一把锁。
var BASE = "/sdcard/wechat-bridge/";
var config = JSON.parse(files.read(BASE + "config.json"));
var ui = require(files.join(files.cwd(), "wechat.js"))(config, BASE);

var PORT = config.phone_api_port || 8766;
var TASK_TIMEOUT_MS = 150000; // 单个任务的界面操作上限（翻页读取 100 条可能较慢）
var QUEUE_TIMEOUT_MS = 60000; // 手机一直未就绪时，排队任务超过该时间视为失败
var MAX_FINISHED_TASKS = 50;
var MAX_EVENTS = 300;
var MAX_EVENT_RESPONSE_CHARS = 2000000;
var MAX_BODY_BYTES = 16000000;

// 没有足够长的接口凭证就拒绝启动，避免局域网内任何人都能调用
if (!config.phone_api_token || config.phone_api_token.length < 32)
    throw Error("config.json 需要至少 32 字符的 phone_api_token");

// ---------- 接管：停止正在运行的旧实例，拿到文件锁后才继续 ----------
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

// acquireProcessLock 等旧实例退出、释放 bridge.lock 后加锁，最多约 15 秒。
// 旧实例与本实例在同一进程（AutoJs6）里，它仍持有锁时 tryLock 会抛出异常而不是返回 null。
function acquireProcessLock(file) {
    for (var attempt = 0; attempt < 60; attempt++) {
        try {
            var acquired = file.getChannel().tryLock();
            if (acquired) return acquired;
        } catch (_) {}
        sleep(250);
    }
    throw Error("旧的微信桥仍未停止，请稍后重试");
}

stopOtherInstances();
var lockFile = new java.io.RandomAccessFile(BASE + "bridge.lock", "rw");
var processLock = acquireProcessLock(lockFile);

// ---------- 共享状态：HTTP 线程与主线程共用，读写都在 withLock 内 ----------

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

// httpError 抛出带 HTTP 状态码和错误代码的异常，由 serve 转成错误响应。
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
function validatePayload(operation, data) {
    if (!data || typeof data !== "object") httpError(400, "BAD_BODY", "需要 JSON 对象");
    var chat = data.chat;
    if (typeof chat !== "string" || !chat.trim() || chat.length > 128 || /[\x00-\x1f]/.test(chat))
        httpError(400, "BAD_CHAT", "需要明确聊天名称");
    if (data.chat_type !== undefined && data.chat_type !== "person" && data.chat_type !== "group")
        httpError(400, "BAD_CHAT_TYPE", "会话类型必须为 person 或 group");
    if (data.account !== undefined && (typeof data.account !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(data.account)))
        httpError(400, "BAD_ACCOUNT", "account 必须是微信号");
    // account：电脑预期手机登录的微信号，执行前核对
    var payload = { chat: chat.trim(), group: data.chat_type === "group", account: data.account || "" };
    // 读取：条数、读完是否回到首页、读到哪几条已知消息停止、最多取几张原图
    if (operation === "read") {
        var limit = data.limit === undefined ? 20 : data.limit;
        if (typeof limit !== "number" || limit % 1 !== 0 || limit < 1 || limit > 100)
            httpError(400, "BAD_LIMIT", "limit 必须为 1–100 的整数");
        payload.limit = limit;
        payload.return_list = data.return_list === true;
        // until：已记录的最后几条消息文字，翻页读到它们就停止。
        var until = data.until === undefined ? [] : data.until;
        var validUntil =
            Array.isArray(until) &&
            until.length <= 5 &&
            until.every(function (t) {
                return typeof t === "string" && t.length <= 10000;
            });
        if (!validUntil) httpError(400, "BAD_UNTIL", "until 必须是最多 5 条文字");
        payload.until = until;
        var originals = data.originals === undefined ? 0 : data.originals;
        if (typeof originals !== "number" || originals % 1 !== 0 || originals < 0 || originals > 3)
            httpError(400, "BAD_ORIGINALS", "originals 必须为 0–3 的整数");
        payload.originals = originals;
    // 发送图片：Base64 图片数据，不能同时带文字
    } else if (data.image_base64 !== undefined) {
        var image = data.image_base64;
        if (data.text !== undefined || typeof image !== "string" || image.length > 12000000 || !/^[A-Za-z0-9+/=]+$/.test(image))
            httpError(400, "BAD_IMAGE", "图片数据无效");
        payload.image_base64 = image;
    // 发送文字：1–2000 字
    } else {
        if (typeof data.text !== "string" || !data.text.trim() || data.text.length > 2000)
            httpError(400, "BAD_TEXT", "文本必须为 1–2000 字符");
        payload.text = data.text;
    }
    return payload;
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

// runTask 执行一个任务：打开聊天，读取或发送，记录执行步骤和降级，最后保存结果。
function runTask(task) {
    var p = task.payload,
        status,
        result;
    log("任务 " + task.id + " " + task.operation + " 开始");
    // 开始一次新操作：设置超时，清空执行记录
    ui.begin(TASK_TIMEOUT_MS);
    try {
        // 先打开目标聊天（核对标题），再按任务类型读取或发送
        if (p.account) verifyAccount(p.account, task.operation === "send");
        ui.openChat(p.chat, p.group);
        if (task.operation === "read") {
            // 读取完成后，自动读取会回到首页，方便继续发现其他未读会话
            result = ui.readMessages(p.chat, { limit: p.limit, until: p.until, originals: p.originals, tag: task.id });
            if (p.return_list) ui.returnToList();
        } else {
            // 发送并确认后，再补读一次当前屏幕，让电脑尽快看到刚发的消息
            if (p.image_base64) ui.sendImage(p.chat, p.group, p.image_base64, task.id);
            else ui.sendText(p.chat, p.group, p.text);
            result = { confirmation: "ui_observed" };
            // 发送已确认；补读失败不能把发送改成失败，只提示电脑稍后重读。
            try {
                result.snapshot = ui.snapshot(true);
            } catch (_) {
                result.sync_error = "发送已确认，但发送后补读失败";
            }
        }
        status = "succeeded";
        // 记住最近操作的聊天：后台监测时读不到标题，可以用它来识别当前聊天
        lastChat = { name: p.chat, group: p.group };
    } catch (e) {
        // 已点击发送后出错，结果只能是未知，避免电脑误判后重发。
        status = ui.clicked() ? "unknown" : "failed";
        result = { code: e.code || "UI_ERROR", message: String(e.message || e) };
    }
    // 执行步骤和降级随结果上报，诊断页可以看到每一步。
    result.account = currentAccountId(); // 执行时登录的微信号，电脑再核对一次
    result.diagnostics = ui.diagnostics();
    // 降级和失败同时记入诊断事件，诊断页可以集中查看
    var context = { task_id: task.id, operation: task.operation, chat: p.chat };
    result.diagnostics.warnings.forEach(function (w) {
        addDiagnostic("warning", w.code, w.message, context);
    });
    if (result.sync_error) addDiagnostic("warning", "SYNC_AFTER_SEND", result.sync_error, context);
    if (status !== "succeeded") addDiagnostic("error", result.code, result.message, context);
    finishTask(task, status, result);
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
        account = { wechat_id: found.wechat_id, identified_at: new Date().toISOString(), error: null };
        accountCheckedAt = Date.now();
        accountWanted = false;
    });
    return found.wechat_id;
}

// identifyAccount 空闲时识别当前账号；日志只记操作流程、结果和耗时。
function identifyAccount() {
    ui.begin(15000);
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

var notificationsWatched = false;

// watchNotifications 开启微信通知监听，返回是否有通知使用权（只开启一次）。
function watchNotifications() {
    if (notificationsWatched) return true;
    // 检查系统设置里 AutoJs6 是否有通知使用权
    var listeners = String(
        android.provider.Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners") || ""
    );
    if (listeners.indexOf("org.autojs.autojs6") < 0) return false;
    events.observeNotification();
    // 只处理微信的通知：标题是会话名称，正文是消息预览。
    // 跳过公众号和标题为“微信”的系统通知（“你有1条消息未发送”等），它们不是聊天。
    events.onNotification(function (n) {
        if (String(n.getPackageName()) !== "com.tencent.mm") return;
        var chat = String(n.getTitle() || ""),
            body = String(n.getText() || "");
        if (chat && body && !ui.ignoredChat(chat)) pushEvent({ kind: "notification", chat: chat, text: body });
    });
    notificationsWatched = true;
    return true;
}

var unreadSeen = {},
    lastSignature = null,
    lastVisibleCheck = 0;

// 空闲时监测：首页有新的未读会话 → unread_chat；当前聊天内容变化 → visible_snapshot。
function monitor() {
    // 在首页时：比较每个未读会话的行内容，变化了说明有新消息
    ui.begin(5000);
    var unread = ui.unreadChats();
    if (unread) {
        for (var chat in unread) {
            if (unreadSeen[chat] !== unread[chat]) pushEvent({ kind: "unread_chat", chat: chat });
        }
        unreadSeen = unread;
    }

    // 当前聊天内容每 3 秒检查一次
    if (Date.now() - lastVisibleCheck < 3000) return;
    lastVisibleCheck = Date.now();
    // 识别当前打开的聊天：先看标题控件；当前微信没有标题控件，就看是否仍在最近操作的聊天里（屏幕内容接得上）。
    // 用户在手机上打开了别的聊天时内容接不上，不生成快照，避免把别的聊天的消息记错地方。
    var name = ui.currentChat();
    if (!name && lastChat && ui.stillInChat(lastChat.name)) name = lastChat.name;
    if (!name) {
        lastSignature = null;
        return;
    }
    // 先不截图比较屏幕内容，有变化才截图生成快照事件（截图较耗时）
    var signature = name + JSON.stringify(ui.snapshot(false).messages);
    if (signature === lastSignature) return;
    lastSignature = signature;
    var snapshot = ui.snapshot(true);
    if (snapshot.messages.length) pushEvent({ kind: "visible_snapshot", chat: name, snapshot: snapshot });
}

// ---------- HTTP ----------

// intParam 解析查询参数中的非负整数；缺省时返回 fallback，超出范围返回 400。
function intParam(raw, fallback, min, max) {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) httpError(400, "BAD_QUERY", "查询参数无效");
    return Number(raw);
}

// readLine 从输入流读一行（到 \n 为止，去掉 \r），单行最多 8 KB。
function readLine(input) {
    var bytes = new java.io.ByteArrayOutputStream(),
        b;
    while ((b = input.read()) !== 10) {
        if (b < 0) httpError(400, "BAD_HTTP", "请求不完整");
        if (b !== 13) bytes.write(b);
        if (bytes.size() > 8192) httpError(431, "HEADER_TOO_LARGE", "请求头过大");
    }
    return String(bytes.toString("UTF-8"));
}

// readRequest 解析一个 HTTP 请求：请求行、请求头和请求体（按 Content-Length 读取）。
function readRequest(socket) {
    // 5 秒内必须读完请求，防止慢速连接占住线程
    socket.setSoTimeout(5000);
    var input = new java.io.DataInputStream(new java.io.BufferedInputStream(socket.getInputStream()));
    var first = readLine(input).split(" ");
    if (first.length !== 3) httpError(400, "BAD_HTTP", "无效请求行");
    var headers = {},
        line;
    while ((line = readLine(input)) !== "") {
        var at = line.indexOf(":");
        if (at < 1) httpError(400, "BAD_HTTP", "无效请求头");
        headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    // 请求体大小有上限（发送图片时最大）
    var length = Number(headers["content-length"] || 0);
    if (!(length >= 0 && length <= MAX_BODY_BYTES)) httpError(413, "BODY_TOO_LARGE", "请求体过大");
    var body = "";
    if (length) {
        var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, length);
        input.readFully(buffer);
        body = String(new java.lang.String(buffer, "UTF-8"));
    }
    // 拆分路径和查询参数
    var target = first[1].split("?"),
        query = {};
    (target[1] || "").split("&").forEach(function (pair) {
        var kv = pair.split("=");
        if (kv[0]) query[kv[0]] = kv[1];
    });
    return { method: first[0], path: target[0], query: query, headers: headers, body: body };
}

// parseJSON 解析 JSON 请求体，格式错误时返回 400。
function parseJSON(body) {
    try {
        return JSON.parse(body);
    } catch (_) {
        httpError(400, "BAD_BODY", "需要有效 JSON 请求体");
    }
}

// 恒定时间比较凭证，避免泄露差异位置。
function tokenMatches(header) {
    return java.security.MessageDigest.isEqual(utf8(header || ""), utf8("Bearer " + config.phone_api_token));
}

// 返回 [状态码, 响应体]，或 [200, null, 文件路径] 表示下载文件。
function route(req) {
    // 存活检查不需要凭证，其余接口都要 Bearer Token
    if (req.method === "GET" && req.path === "/health") return [200, { ok: true, device_id: config.device_id }];
    if (!tokenMatches(req.headers.authorization)) httpError(401, "UNAUTHORIZED", "需要有效 Bearer Token");
    if (req.method === "GET" && req.path === "/v1/device")
        return [200, { online: alive(), busy: taskStarted > 0, info: deviceInfo, diagnostics: recentDiagnostics() }];
    if (req.method === "GET" && req.path === "/v1/events") return [200, waitEvents(req.query)];
    if (req.method === "GET" && req.path.indexOf("/v1/tasks/") === 0) return [200, getTask(req.path.slice(10))];
    if (req.method === "POST" && req.path === "/v1/account/refresh") return [202, requestAccountRefresh()];
    var file = /^\/v1\/files\/([A-Za-z0-9._-]+)$/.exec(req.path);
    if (req.method === "GET" && file) return [200, null, ui.originalsDir + file[1]];
    var create = /^\/v1\/messages\/(read|send)$/.exec(req.path);
    if (req.method === "POST" && create)
        return [202, createTask(create[1], parseJSON(req.body), req.headers["idempotency-key"])];
    httpError(404, "NOT_FOUND", "接口不存在");
}

// respond 写出 JSON 响应。每个请求一个连接，响应后关闭。
function respond(socket, status, value) {
    var body = utf8(JSON.stringify(value));
    var head =
        "HTTP/1.1 " + status + " OK\r\n" +
        "Content-Type: application/json; charset=utf-8\r\n" +
        "Content-Length: " + body.length + "\r\n" +
        "Connection: close\r\n\r\n";
    var out = socket.getOutputStream();
    out.write(utf8(head));
    out.write(body);
    out.flush();
}

// 发送原图文件，发送完删除（电脑已保存）。
function respondFile(socket, path) {
    var file = new java.io.File(path);
    if (!file.isFile()) return respond(socket, 404, { error: { code: "NOT_FOUND", message: "文件不存在" } });
    // 先写响应头，再分块写文件内容
    var out = socket.getOutputStream();
    out.write(utf8("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: " + file.length() + "\r\nConnection: close\r\n\r\n"));
    var input = new java.io.FileInputStream(file);
    try {
        var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 65536),
            n;
        while ((n = input.read(buffer)) > 0) out.write(buffer, 0, n);
        out.flush();
    } finally {
        input.close();
    }
    file.delete();
}

// handle 解析并分发请求，写出响应；出错时返回错误 JSON。
function handle(socket) {
    var reply;
    try {
        reply = route(readRequest(socket));
    } catch (e) {
        // 主动抛出的错误带状态码，原样返回；其他异常只返回笼统说明，不暴露内部信息
        var message = e.status ? e.message : "接口内部错误";
        reply = [e.status || 500, { error: { code: e.code || "INTERNAL_ERROR", message: message } }];
    }
    if (reply[2]) respondFile(socket, reply[2]);
    else respond(socket, reply[0], reply[1]);
}

// serve 处理一个连接，结束后关闭；写响应时连接已断开的异常直接忽略。
function serve(socket) {
    try {
        handle(socket);
    } catch (_) {
    } finally {
        try {
            socket.close();
        } catch (_) {}
    }
}

// 每个连接一个线程（事件长轮询会阻塞），最多同时 16 个。
var connections = new java.util.concurrent.Semaphore(16);

// serveInThread 在新线程中处理连接；同时处理的连接已满时直接关闭。
function serveInThread(socket) {
    if (!connections.tryAcquire()) {
        socket.close();
        return;
    }
    threads.start(function () {
        try {
            serve(socket);
        } finally {
            connections.release();
        }
    });
}

// 监听所有网卡，电脑通过局域网访问；接收连接的循环在独立线程中运行
var server = new java.net.ServerSocket(PORT, 16, java.net.InetAddress.getByName("0.0.0.0"));
threads.start(function () {
    while (true) {
        try {
            serveInThread(server.accept());
        } catch (e) {
            if (server.isClosed()) return;
        }
    }
});

// ---------- 启动与主循环 ----------

// 脚本退出时：取消常亮，关闭监听端口，释放文件锁
events.on("exit", function () {
    device.cancelKeepingAwake();
    try {
        server.close();
        processLock.release();
        lockFile.close();
    } catch (_) {}
});

// 让无障碍服务报告控件编号、不重要的控件和多窗口信息（2 | 16 | 64）。
auto.setMode("normal");
if (auto.service) {
    var serviceInfo = auto.service.getServiceInfo();
    serviceInfo.flags = serviceInfo.flags | 2 | 16 | 64;
    auto.service.setServiceInfo(serviceInfo);
}
// 清理上次运行遗留、电脑没取走的原图。
files.removeDir(ui.originalsDir);

// 截图用于图片缩略图、原图兜底，以及出错时附上屏幕画面。
// 手机锁屏时申请会失败（授权页打不开），不能因此退出：先照常运行并报告“需要截图授权”，解锁后每分钟重试一次。
var captureReady = false,
    lastCaptureRequest = 0;

// requestCapture 申请截图授权；失败时记一条诊断事件，不抛出异常。
function requestCapture() {
    lastCaptureRequest = Date.now();
    // 系统会弹出“AutoJs6 将开始截取屏幕”，在另一个线程里点“立即开始”。
    var clicker = threads.start(function () {
        for (var i = 0; i < 60; i++) {
            sleep(250);
            if (currentPackage() !== "com.android.systemui") continue;
            var start = text("立即开始").findOnce();
            if (start && textMatches(/AutoJs6.*截取.*屏幕.*/).exists()) {
                start.click();
                return;
            }
        }
    });
    try {
        captureReady = requestScreenCapture(false);
    } catch (e) {
        captureReady = false;
        addDiagnostic("warning", "CAPTURE_REQUEST_FAILED", "截图授权申请失败（手机锁屏或授权页打不开），解锁后自动重试：" + String(e.message || e).split("\n")[0], { source: "monitor" });
    } finally {
        clicker.interrupt();
    }
    // 申请成功：清除“截图失效”标记
    if (captureReady) {
        ui.captureRestored();
        log("截图授权已就绪");
    }
}

requestCapture();

log("微信桥已启动，端口 " + PORT);
// 主循环：更新就绪状态和心跳；有任务就执行，没有任务且就绪时做后台监测。
// 主循环不能因为一次异常退出，异常记入诊断后等 2 秒继续。
while (true) {
    try {
        var info = ui.status(captureReady);
        // 截图授权缺失或失效时，在解锁状态下每分钟重新申请一次
        var unlocked = info.reasons.indexOf("SCREEN_LOCKED") < 0;
        if ((!captureReady || ui.captureBroken()) && unlocked && Date.now() - lastCaptureRequest > 60000) {
            requestCapture();
            info = ui.status(captureReady);
        }
        info.notification_access = watchNotifications();
        info.account = withLock(function () {
            return account;
        });
        deviceInfo = info;
        heartbeat = Date.now();
        // 保持屏幕常亮，界面操作和截图都需要亮屏
        device.keepScreenOn(30 * 60 * 1000);
        var task = takeTask();
        if (task) {
            try {
                runTask(task);
            } finally {
                withLock(function () {
                    taskStarted = 0;
                    lastTaskEnded = Date.now();
                });
            }
        } else if (info.ready && accountDue()) identifyAccount();
        else if (info.ready) monitor();
    } catch (e) {
        addDiagnostic("error", e.code || "LOOP_ERROR", "监测或主循环异常：" + String(e.message || e), { source: "monitor" });
        sleep(2000);
    }
    // 间歇 400 毫秒；期间收到任务立即开始执行
    waitForTask(400);
}
