// 手机端微信桥（AutoJs6，ES5 语法）：一个脚本同时提供 HTTP 接口并操作微信。
//
//   HTTP 线程：电脑提交读写任务、查询任务结果、拉取消息事件。
//   主线程：  循环执行任务；空闲时监测当前聊天和未读会话，生成消息事件。
//   通知回调：微信通知生成消息事件。
//
// 任务和事件只保存在内存中。脚本重启后电脑查询不到原任务，会把发送标记为“结果未知”，不会重发。
var BASE = "/sdcard/wechat-bridge/";
var config = JSON.parse(files.read(BASE + "config.json"));
var ui = require(BASE + "wechat.js")(config, BASE);

var PORT = config.phone_api_port || 8766;
var TASK_TIMEOUT_MS = 150000; // 单个任务的界面操作上限（翻页读取 100 条可能较慢）
var QUEUE_TIMEOUT_MS = 60000; // 手机一直未就绪时，排队任务超过该时间视为失败
var MAX_FINISHED_TASKS = 50;
var MAX_EVENTS = 300;
var MAX_EVENT_RESPONSE_CHARS = 2000000;
var MAX_BODY_BYTES = 16000000;

if (!config.phone_api_token || config.phone_api_token.length < 32)
    throw Error("config.json 需要至少 32 字符的 phone_api_token");

// 文件锁防止重复启动。
var lockFile = new java.io.RandomAccessFile(BASE + "bridge.lock", "rw");
var processLock = lockFile.getChannel().tryLock();
if (!processLock) throw Error("微信桥已在运行");

// ---------- 共享状态：HTTP 线程与主线程共用，读写都在 withLock 内 ----------

var lock = threads.lock();
var tasks = {}; // 任务编号 → 任务
var tasksByKey = {}; // Idempotency-Key → 任务
var taskOrder = []; // 任务编号，按创建顺序
var pendingTask = null; // 等待执行的任务；同一时刻最多一个
var eventLog = [];
var lastSeq = Date.now(); // 事件序号从启动时间开始，脚本重启后仍然递增
var deviceInfo = { ready: false, reasons: ["STARTING"] };
var heartbeat = 0; // 主线程最近一次循环的时间

function withLock(fn) {
    lock.lock();
    try {
        return fn();
    } finally {
        lock.unlock();
    }
}

function utf8(value) {
    return new java.lang.String(value).getBytes("UTF-8");
}

function sha256(value) {
    var digest = java.security.MessageDigest.getInstance("SHA-256").digest(utf8(value));
    return String(android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP));
}

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

function httpError(status, code, message) {
    var e = new Error(message);
    e.status = status;
    e.code = code;
    throw e;
}

// ---------- 任务 ----------

function taskView(task) {
    return { id: task.id, operation: task.operation, status: task.status, result: task.result };
}

function validatePayload(operation, data) {
    if (!data || typeof data !== "object") httpError(400, "BAD_BODY", "需要 JSON 对象");
    var chat = data.chat;
    if (typeof chat !== "string" || !chat.trim() || chat.length > 128 || /[\x00-\x1f]/.test(chat))
        httpError(400, "BAD_CHAT", "需要明确聊天名称");
    if (data.chat_type !== undefined && data.chat_type !== "person" && data.chat_type !== "group")
        httpError(400, "BAD_CHAT_TYPE", "会话类型必须为 person 或 group");
    var payload = { chat: chat.trim(), group: data.chat_type === "group" };
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
    } else if (data.image_base64 !== undefined) {
        var image = data.image_base64;
        if (data.text !== undefined || typeof image !== "string" || image.length > 12000000 || !/^[A-Za-z0-9+/=]+$/.test(image))
            httpError(400, "BAD_IMAGE", "图片数据无效");
        payload.image_base64 = image;
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
    var fingerprint = sha256(operation + JSON.stringify(payload));
    return withLock(function () {
        var existing = tasksByKey[key];
        if (existing) {
            if (existing.fingerprint !== fingerprint) httpError(409, "IDEMPOTENCY_CONFLICT", "同一 key 不能用于不同请求");
            return taskView(existing);
        }
        if (Date.now() - heartbeat > 45000 || !deviceInfo.ready)
            httpError(409, "DEVICE_NOT_READY", "手机未就绪：" + (deviceInfo.reasons || []).join(", "));
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
        tasks[task.id] = task;
        tasksByKey[key] = task;
        taskOrder.push(task.id);
        pendingTask = task;
        forgetOldTasks();
        return taskView(task);
    });
}

function forgetOldTasks() {
    while (taskOrder.length > MAX_FINISHED_TASKS) {
        var oldest = tasks[taskOrder[0]];
        if (oldest.status === "queued" || oldest.status === "running") return;
        taskOrder.shift();
        delete tasks[oldest.id];
        delete tasksByKey[oldest.key];
    }
}

function getTask(taskId) {
    return withLock(function () {
        if (!tasks[taskId]) httpError(404, "NOT_FOUND", "任务不存在");
        return taskView(tasks[taskId]);
    });
}

function finishTask(task, status, result) {
    withLock(function () {
        task.status = status;
        task.result = result;
        task.payload = null; // 释放图片数据
    });
    var detail = status !== "succeeded" ? result.code : result.messages ? result.messages.length + " 条 " + result.stop_reason : "";
    log("任务 " + task.id + " " + task.operation + " " + status + " " + detail);
}

// 取出下一个可执行的任务；手机长时间未就绪时让排队任务失败（未执行，可安全重试）。
function takeTask() {
    var expired = null;
    var task = withLock(function () {
        var next = pendingTask;
        if (!next) return null;
        if (Date.now() - next.created > QUEUE_TIMEOUT_MS) {
            pendingTask = null;
            expired = next;
            return null;
        }
        if (!deviceInfo.ready) return null;
        pendingTask = null;
        next.status = "running";
        return next;
    });
    if (expired) finishTask(expired, "failed", { code: "TASK_EXPIRED", message: "手机长时间未就绪，任务未执行" });
    return task;
}

var lastChat = null; // 最近一次任务操作的聊天，监测时用于识别读不到标题的当前聊天

function runTask(task) {
    var p = task.payload,
        status,
        result;
    log("任务 " + task.id + " " + task.operation + " 开始");
    ui.begin(TASK_TIMEOUT_MS);
    try {
        ui.openChat(p.chat, p.group);
        if (task.operation === "read") {
            result = ui.readMessages(p.chat, { limit: p.limit, until: p.until, originals: p.originals, tag: task.id });
            if (p.return_list) ui.returnToList();
        } else {
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
        lastChat = { name: p.chat, group: p.group };
    } catch (e) {
        // 已点击发送后出错，结果只能是未知，避免电脑误判后重发。
        status = ui.clicked() ? "unknown" : "failed";
        result = { code: e.code || "UI_ERROR", message: String(e.message || e) };
    }
    finishTask(task, status, result);
}

// ---------- 消息事件 ----------

function pushEvent(event) {
    withLock(function () {
        event.seq = ++lastSeq;
        event.received_at = new Date().toISOString();
        eventLog.push(event);
        if (eventLog.length > MAX_EVENTS) eventLog.shift();
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

// 长轮询：有新事件或等待超时才返回。
function waitEvents(query) {
    var after = intParam(query.after, 0, 0, 9007199254740991),
        limit = intParam(query.limit, 20, 1, 100),
        wait = intParam(query.wait, 25, 0, 25);
    var until = Date.now() + wait * 1000,
        result;
    while (!(result = readEvents(after, limit)).events.length && Date.now() < until) sleep(200);
    return result;
}

var notificationsWatched = false;

function watchNotifications() {
    if (notificationsWatched) return true;
    var listeners = String(
        android.provider.Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners") || ""
    );
    if (listeners.indexOf("org.autojs.autojs6") < 0) return false;
    events.observeNotification();
    events.onNotification(function (n) {
        if (String(n.getPackageName()) !== "com.tencent.mm") return;
        var chat = String(n.getTitle() || ""),
            body = String(n.getText() || "");
        if (chat && body) pushEvent({ kind: "notification", chat: chat, text: body });
    });
    notificationsWatched = true;
    return true;
}

var unreadSeen = {},
    lastSignature = null,
    lastVisibleCheck = 0;

// 空闲时监测：首页有新的未读会话 → unread_chat；当前聊天内容变化 → visible_snapshot。
function monitor() {
    ui.begin(5000);
    var unread = ui.unreadChats();
    if (unread) {
        for (var chat in unread) {
            if (unreadSeen[chat] !== unread[chat]) pushEvent({ kind: "unread_chat", chat: chat });
        }
        unreadSeen = unread;
    }

    if (Date.now() - lastVisibleCheck < 3000) return;
    lastVisibleCheck = Date.now();
    var name = ui.currentChat();
    if (!name && lastChat && ui.chatIs(lastChat.name)) name = lastChat.name;
    if (!name) {
        lastSignature = null;
        return;
    }
    var signature = name + JSON.stringify(ui.snapshot(false).messages);
    if (signature === lastSignature) return;
    lastSignature = signature;
    var snapshot = ui.snapshot(true);
    if (snapshot.messages.length) pushEvent({ kind: "visible_snapshot", chat: name, snapshot: snapshot });
}

// ---------- HTTP ----------

function intParam(raw, fallback, min, max) {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) httpError(400, "BAD_QUERY", "查询参数无效");
    return Number(raw);
}

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

function readRequest(socket) {
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
    var length = Number(headers["content-length"] || 0);
    if (!(length >= 0 && length <= MAX_BODY_BYTES)) httpError(413, "BODY_TOO_LARGE", "请求体过大");
    var body = "";
    if (length) {
        var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, length);
        input.readFully(buffer);
        body = String(new java.lang.String(buffer, "UTF-8"));
    }
    var target = first[1].split("?"),
        query = {};
    (target[1] || "").split("&").forEach(function (pair) {
        var kv = pair.split("=");
        if (kv[0]) query[kv[0]] = kv[1];
    });
    return { method: first[0], path: target[0], query: query, headers: headers, body: body };
}

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
    if (req.method === "GET" && req.path === "/health") return [200, { ok: true, device_id: config.device_id }];
    if (!tokenMatches(req.headers.authorization)) httpError(401, "UNAUTHORIZED", "需要有效 Bearer Token");
    if (req.method === "GET" && req.path === "/v1/device")
        return [200, { online: Date.now() - heartbeat < 45000, info: deviceInfo }];
    if (req.method === "GET" && req.path === "/v1/events") return [200, waitEvents(req.query)];
    if (req.method === "GET" && req.path.indexOf("/v1/tasks/") === 0) return [200, getTask(req.path.slice(10))];
    var file = /^\/v1\/files\/([A-Za-z0-9._-]+)$/.exec(req.path);
    if (req.method === "GET" && file) return [200, null, ui.originalsDir + file[1]];
    var create = /^\/v1\/messages\/(read|send)$/.exec(req.path);
    if (req.method === "POST" && create)
        return [202, createTask(create[1], parseJSON(req.body), req.headers["idempotency-key"])];
    httpError(404, "NOT_FOUND", "接口不存在");
}

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

function serve(socket) {
    try {
        var reply;
        try {
            reply = route(readRequest(socket));
            if (reply[2]) return respondFile(socket, reply[2]);
        } catch (e) {
            var message = e.status ? e.message : "接口内部错误";
            reply = [e.status || 500, { error: { code: e.code || "INTERNAL_ERROR", message: message } }];
        }
        respond(socket, reply[0], reply[1]);
    } catch (_) {
        // 连接已断开
    } finally {
        try {
            socket.close();
        } catch (_) {}
    }
}

// 每个连接一个线程（事件长轮询会阻塞），最多同时 16 个。
var connections = new java.util.concurrent.Semaphore(16);

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

// 截图用于图片缩略图和标题 OCR。
var captureReady = requestScreenCapture(false);

log("微信桥已启动，端口 " + PORT);
while (true) {
    try {
        var info = ui.status(captureReady);
        info.notification_access = watchNotifications();
        deviceInfo = info;
        heartbeat = Date.now();
        device.keepScreenOn(30 * 60 * 1000);
        var task = takeTask();
        if (task) runTask(task);
        else if (info.ready) monitor();
    } catch (e) {
        log("主循环异常：" + (e.code || e.message || e));
        sleep(2000);
    }
    sleep(400);
}
