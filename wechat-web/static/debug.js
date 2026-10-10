"use strict";
// 执行诊断页：数据来自 /api/debug。文本都用 textContent 展示，手机或模型返回的内容不会作为 HTML 执行。

const $ = (id) => document.getElementById(id);
const STATUS = { queued: "排队", running: "执行中", succeeded: "成功", failed: "失败", unknown: "结果未知" };
const REASONS = { notification: "通知触发", schedule: "定时", originals: "补取原图", deep: "加深读取" };
const READY_REASONS = {
    ACCESSIBILITY_DISABLED: "无障碍服务未开启",
    READER_SERVICE_REQUIRED: "随选朗读未开启",
    SCREEN_LOCKED: "屏幕锁定",
    WECHAT_VERSION_MISMATCH: "微信版本与配置不符",
    CAPTURE_PERMISSION_REQUIRED: "需要截图授权（重启微信桥）",
    PROFILE_NOT_CALIBRATED: "控件编号未校准",
    STARTING: "启动中"
};

let data = null;
let filter = "issues";
const opened = new Set(location.hash ? [location.hash.slice(1)] : []); // 展开的任务

// el 创建元素，文字用 textContent 设置。
function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
}

// time 格式化时间：今天只显示时分秒，其他日期带月日。
function time(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "";
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
        ? d.toLocaleTimeString("zh-CN", { hour12: false })
        : d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

// seconds 毫秒转为“x.x 秒”（10 秒以上取整）。
function seconds(ms) {
    return ms ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " 秒" : "";
}

// chip 状态标签；kind 为 good / warn / bad 时分别显示绿、黄、红。
function chip(text, kind) {
    return el("span", text, "chip " + (kind || ""));
}

// isIssue 失败、结果未知或有降级的任务。
function isIssue(op) {
    return ["failed", "unknown"].includes(op.status) || op.warnings?.length > 0;
}

// ---------- 概况卡片 ----------

// card 填充一张概况卡片：标题、主数值、说明，左边框颜色表示状态。
function card(id, title, value, detail, kind) {
    const box = $(id);
    box.className = "card " + (kind || "");
    box.replaceChildren(el("small", title), el("strong", value), el("span", detail));
}

// renderCards 三张概况卡片：手机状态、最近 24 小时任务、最近 1 小时手机事件。
function renderCards() {
    // 手机：每台一行（没连上 / 微信桥离线 / 未就绪并列出原因 / 就绪），卡片颜色取最差的一台
    const phones = data.phones || [];
    const lines = phones.map((p) => {
        const device = p.device || {};
        const info = device.info || {};
        const name = p.phone_url.replace(/^https?:\/\//, "") + (p.account ? "（" + p.account + "）" : "");
        if (!device.info) return [name + "：" + (p.error || p.connection), "bad"];
        if (!device.online) return [name + "：微信桥离线，超过 45 秒没有心跳", "bad"];
        if (!info.ready) return [name + "：未就绪，" + (info.reasons || []).map((r) => READY_REASONS[r] || r).join("、"), "warn"];
        const account = info.account?.wechat_id ? "微信号 " + info.account.wechat_id : info.account?.error ? "账号未识别：" + info.account.error.message : "账号识别中";
        return [`${name}：就绪 · 微信 ${info.wechat_version || ""} · ${account} · ${info.wechat_storage_permission === false ? "微信无存储权限（原图改用截图）" : "存储权限正常"}`, "good"];
    });
    const worst = lines.some((l) => l[1] === "bad") ? "bad" : lines.some((l) => l[1] === "warn") ? "warn" : "good";
    const ready = lines.filter((l) => l[1] === "good").length;
    if (!phones.length) card("card-phone", "手机", "未连接", "还没有添加手机", "bad");
    else card("card-phone", "手机", `${ready} / ${phones.length} 台就绪`, lines.map((l) => l[0]).join("\n"), worst);

    // 任务：最近 24 小时的总数、失败数、有降级的成功数
    const day = Date.now() - 86400000;
    const recent = data.operations.filter((op) => new Date(op.created).getTime() > day);
    const failed = recent.filter((op) => ["failed", "unknown"].includes(op.status)).length;
    const degraded = recent.filter((op) => op.status === "succeeded" && op.warnings?.length).length;
    const capped = recent.length >= 100 ? "+" : ""; // 诊断接口最多返回 100 个任务
    card("card-tasks", "最近 24 小时任务", recent.length + capped, `失败 ${failed} · 有降级 ${degraded}`, failed ? "bad" : degraded ? "warn" : "good");

    // 手机事件：最近 1 小时内出现过的异常和降级
    const events = phoneEvents();
    const hour = Date.now() - 3600000;
    const lastHour = events.filter((e) => new Date(e.last_at).getTime() > hour);
    const errors = lastHour.filter((e) => e.level === "error").length;
    card("card-events", "最近 1 小时手机事件", String(lastHour.length), `异常 ${errors} · 降级 ${lastHour.length - errors}`, errors ? "bad" : lastHour.length ? "warn" : "good");
}

// ---------- 手机事件 ----------

// phoneEvents 所有手机上报的异常与降级（标上是哪台手机），按时间从旧到新。
function phoneEvents() {
    const multiple = (data.phones || []).length > 1;
    return (data.phones || [])
        .flatMap((p) => (p.device?.diagnostics || []).map((e) => ({ ...e, phone: multiple ? p.account || p.phone_url.replace(/^https?:\/\//, "") : "" })))
        .sort((a, b) => (a.last_at < b.last_at ? -1 : 1));
}

// renderEvents 手机上报的异常与降级，新的在前；属于某个任务的可以点击跳到该任务。
function renderEvents() {
    const events = phoneEvents().reverse();
    const box = $("events");
    box.replaceChildren();
    for (const e of events) {
        const row = el("div", undefined, "row event");
        row.append(
            el("time", time(e.last_at)),
            chip(e.level === "error" ? "异常" : "降级", e.level === "error" ? "bad" : "warn"),
            el("span", (e.phone ? e.phone + " · " : "") + (e.chat || (e.source === "monitor" ? "后台监测" : e.source === "account" ? "账号识别" : "")), "who"),
            el("span", e.message, "what"),
            el("span", e.count > 1 ? "×" + e.count : "", "count")
        );
        if (e.task_id) {
            row.classList.add("clickable");
            row.title = "查看对应任务";
            row.onclick = () => openTask(e.task_id);
        }
        box.append(row);
    }
    if (!events.length) box.append(el("p", (data.phones || []).some((p) => p.device) ? "最近没有异常或降级" : "还没有连上手机", "empty"));
}

// ---------- 任务 ----------

// openTask 按手机任务编号或网页任务编号展开对应任务，并滚动到它（切换到“全部”以确保能看到）。
function openTask(phoneTaskID) {
    const op = data.operations.find((o) => o.phone_task_id === phoneTaskID || o.id === phoneTaskID);
    if (!op) return;
    filter = "all";
    syncTabs();
    opened.add(op.id);
    renderTasks();
    document.getElementById("task-" + op.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

// taskSummary 任务摘要行：时间、状态、会话、类型、问题说明、耗时。
function taskSummary(op) {
    const row = el("div", undefined, "row task clickable");
    const kind = op.kind === "send" ? (op.image_hash ? "发送图片" : "发送") : op.auto ? "读取 · " + (REASONS[op.reason] || "自动") : "读取";
    const statusKind = op.status === "succeeded" ? (op.warnings?.length ? "warn" : "good") : ["failed", "unknown"].includes(op.status) ? "bad" : "";
    const problem = op.error || op.warnings?.map((w) => w.message).join("；") || "";
    row.append(
        el("time", time(op.created)),
        chip(STATUS[op.status] + (op.status === "succeeded" && op.warnings?.length ? " · 降级" : ""), statusKind),
        el("span", data.conversations[op.conversation_id] || "已删除的会话", "who"),
        el("span", kind, "kind"),
        el("span", problem, "what"),
        el("span", seconds(op.duration_ms), "count")
    );
    return row;
}

// taskDetail 任务详情：错误、降级、发送内容、每一步的时间线和任务编号。
function taskDetail(op) {
    const box = el("div", undefined, "detail");
    if (op.error) box.append(el("p", "错误：" + op.error, "error-text"));
    for (const w of op.warnings || []) box.append(el("p", "降级 " + w.code + "：" + w.message, "warn-text"));
    if (op.text) box.append(el("p", "发送内容：" + op.text));
    if (op.steps?.length) {
        const steps = el("ol", undefined, "steps");
        for (const s of op.steps) {
            const item = el("li", undefined, s.step === "降级" ? "warn-text" : "");
            item.append(el("span", "+" + seconds(s.ms || 1).replace(" 秒", "s"), "ms"), el("strong", s.step), el("span", s.detail || ""));
            steps.append(item);
            // 步骤附带的截图（例如出错时的屏幕画面），点击打开原图
            if (s.image) {
                const shot = el("li", undefined, "step-shot");
                const link = el("a");
                link.href = "/api/media/" + s.image;
                link.target = "_blank";
                link.rel = "noopener";
                const img = el("img");
                img.src = link.href;
                img.alt = s.step + "截图";
                link.append(img);
                shot.append(link);
                steps.append(shot);
            }
        }
        box.append(steps);
    } else {
        box.append(el("p", "没有执行步骤记录（旧版本手机桥，或任务没有到达手机）", "empty"));
    }
    const ids = el("small", `网页任务 ${op.id}` + (op.phone_task_id ? ` · 手机任务 ${op.phone_task_id}` : ""), "ids");
    box.append(ids);
    return box;
}

// renderTasks 任务列表；“有问题的”只显示失败、结果未知、有降级的任务（已展开的始终显示）。
function renderTasks() {
    const box = $("tasks");
    box.replaceChildren();
    const tasks = data.operations.filter((op) => filter === "all" || isIssue(op) || opened.has(op.id));
    for (const op of tasks) {
        const wrap = el("div", undefined, "task-wrap" + (opened.has(op.id) ? " open" : ""));
        wrap.id = "task-" + op.id;
        const row = taskSummary(op);
        row.onclick = () => {
            opened.has(op.id) ? opened.delete(op.id) : opened.add(op.id);
            renderTasks();
        };
        wrap.append(row);
        if (opened.has(op.id)) wrap.append(taskDetail(op));
        box.append(wrap);
    }
    if (!tasks.length) box.append(el("p", filter === "issues" ? "最近的任务都正常完成" : "暂无任务", "empty"));
}

// syncTabs 让筛选按钮的选中状态与 filter 一致。
function syncTabs() {
    for (const b of document.querySelectorAll("[data-filter]")) b.classList.toggle("selected", b.dataset.filter === filter);
}

for (const b of document.querySelectorAll("[data-filter]")) {
    b.onclick = () => {
        filter = b.dataset.filter;
        syncTabs();
        renderTasks();
    };
}

// ---------- AI ----------

// renderJobs AI 自动回复记录：状态、会话、回复内容或失败原因。
function renderJobs() {
    const box = $("jobs");
    box.replaceChildren();
    for (const j of data.ai_jobs) {
        const row = el("div", undefined, "row");
        const kind = j.status === "sent" ? "good" : j.status === "failed" ? "bad" : "";
        row.append(
            el("time", time(j.created)),
            chip({ running: "生成中", sent: "已发送", failed: "失败" }[j.status] || j.status, kind),
            el("span", data.conversations[j.conversation_id] || "", "who"),
            el("span", j.error || j.reply || "", "what")
        );
        box.append(row);
    }
    if (!data.ai_jobs.length) box.append(el("p", "暂无 AI 自动回复记录", "empty"));
}

// ---------- 刷新 ----------

let loading = false;
// refresh 拉取诊断数据并重绘整页；正在加载时忽略新的刷新请求。
async function refresh() {
    if (loading) return;
    loading = true;
    try {
        const response = await fetch("/api/debug");
        if (!response.ok) throw new Error("诊断接口请求失败");
        data = await response.json();
        renderCards();
        renderEvents();
        renderTasks();
        renderJobs();
        $("log").textContent = data.log || "暂无日志";
        $("log-note").textContent = data.log_error || "最后 64 KB";
        $("status").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
        // 看过诊断页后，消息台的诊断红点清零。
        try {
            localStorage.setItem("diag-seen-at", String(Date.now()));
        } catch (_) {}
    } catch (error) {
        $("status").textContent = error.message;
    } finally {
        loading = false;
    }
}

$("refresh").onclick = refresh;
$("log-box").ontoggle = () => {
    if ($("log-box").open) $("log").scrollTop = $("log").scrollHeight;
};
setInterval(() => {
    if ($("auto").checked) void refresh();
}, 5000);
void refresh().then(() => {
    if (location.hash) openTask(location.hash.slice(1));
});
