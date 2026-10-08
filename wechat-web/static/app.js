"use strict";
// 微信消息台前端。数据全部来自 /api/state 和 /api/conversations/{id}；
// 服务端有变化时通过 SSE 推送 refresh，页面重新拉取并重绘（消息列表增量更新）。

const $ = (id) => document.getElementById(id);
const STATUS = { queued: "等待手机", running: "手机处理中", succeeded: "已完成", failed: "失败", unknown: "结果未知" };
const KINDS = { unknown: "待分类", person: "联系人", group: "群聊" };

let state = null; // GET /api/state
let active = null; // 当前会话 ID
let conversation = null; // 当前会话详情
let filter = "all";
let busy = false; // 正在提交读写任务
const knownStatus = new Map(); // 任务 ID → 上次看到的状态，用于结束时提示
const dismissed = new Set(); // 已点掉的失败或降级提示（任务 ID）
const READ_EVERY = { 60: "每 1 分钟", 300: "每 5 分钟", 900: "每 15 分钟", 1800: "每 30 分钟", 3600: "每 1 小时" };

// ---------- 工具 ----------

// el 创建元素；文字一律用 textContent 设置，消息内容不会被当作 HTML 执行。
function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

let toastTimer;
// toast 在页面底部显示提示，5 秒后消失。
function toast(text) {
    $("toast").textContent = text;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}

// api 调用 /api/ 接口：有 body 时 POST JSON，否则 GET；失败时抛出带服务端说明的错误。
async function api(path, body, idempotencyKey) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let response;
    try {
        response = await fetch("/api/" + path, {
            method: body === undefined ? "GET" : "POST",
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch (_) {
        throw Error("网页服务连接中断，请确认服务仍在运行");
    }
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "请求失败");
    return data;
}

// 会话列表用：今天显示时间，其他显示日期。
function timeLabel(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toDateString() === new Date().toDateString() ? clock(value) : dayLabel(value);
}

// clock 把时间格式化为“时:分”。
function clock(value) {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
}

// 消息日期分隔线：今天、昨天、10月7日、2025年12月31日。
function dayLabel(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "";
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "今天";
    if (d.toDateString() === yesterday.toDateString()) return "昨天";
    const options = d.getFullYear() === today.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" };
    return d.toLocaleDateString("zh-CN", options);
}

// avatar 会话头像：群聊显示“群”，联系人显示名称的第一个字。
function avatar(c, className = "avatar") {
    const group = c.kind === "group";
    return el("span", group ? "群" : Array.from(c.title)[0], className + (group ? " group" : ""));
}

// 显示图片，点击在新标签页打开。图片加载后内容变高：如果正停在底部，保持在底部。
function imageLink(hash, alt) {
    const link = el("a");
    link.href = "/api/media/" + hash;
    link.target = "_blank";
    link.rel = "noopener";
    const img = el("img", undefined, "chat-image");
    img.src = link.href;
    img.alt = alt;
    img.onload = () => {
        if (list.stick) scrollToLatest(false);
    };
    link.append(img);
    return link;
}

// ---------- 刷新 ----------

let refreshing = false;
let refreshAgain = false;

// 并发调用时合并为一次后续刷新，避免旧响应覆盖新数据。
async function refresh() {
    // 正在刷新时只记一下，等这次结束后再刷新一次
    if (refreshing) {
        refreshAgain = true;
        return;
    }
    refreshing = true;
    try {
        // 先取总览，再取当前会话详情；等待期间切换了会话就丢弃旧会话的详情
        const id = active;
        state = await api("state");
        const detail = id ? await api("conversations/" + id) : null;
        if (id === active) conversation = detail;
        toastFinishedOperations();
        render();
        // 正在看的会话有未读，标记为已读
        if (conversation?.unread) await api("conversations/" + conversation.id + "/seen", {});
    } catch (e) {
        $("connection").textContent = "网页服务离线";
        $("status-dot").className = "dot error";
        toast(e.message);
    } finally {
        refreshing = false;
        if (refreshAgain) {
            refreshAgain = false;
            void refresh();
        }
    }
}

// toastFinishedOperations 任务从“进行中”变为结束时弹出提示（自动读取成功不提示）。
function toastFinishedOperations() {
    for (const op of state.operations) {
        const before = knownStatus.get(op.id);
        knownStatus.set(op.id, op.status);
        if (!["queued", "running"].includes(before) || ["queued", "running"].includes(op.status)) continue;
        if (op.status !== "succeeded") toast(STATUS[op.status] + "：" + (op.error || "请查看手机"));
        else if (op.kind === "send") toast("手机已确认发送");
        else if (!op.auto) toast("手机消息已读取");
    }
}

// ---------- 渲染 ----------

// render 重绘连接状态、会话列表和当前聊天。
function render() {
    renderStatus();
    renderList();
    renderChat();
}

// renderStatus 显示手机连接状态、地址和未就绪原因，并更新诊断入口红点。
function renderStatus() {
    const online = state.connection === "在线";
    const broken = /失败|离线/.test(state.connection);
    $("connection").textContent = state.connection;
    $("phone-address").textContent = state.phone_url ? state.phone_url.replace(/^https?:\/\//, "") : "点击设置手机 IP";
    $("status-dot").className = "dot" + (online ? " online" : broken ? " error" : "");
    $("connection-card").title = state.error || state.connection;
    // 手机未就绪时把原因放进提示，方便直接看出缺什么（例如截图授权、锁屏）。
    const reasons = state.device?.info?.reasons || [];
    if (!online && reasons.length) $("connection-card").title += "：" + reasons.join("、");
    renderDiagBadge();
}

// 诊断入口红点：最近 24 小时内、上次打开诊断页之后新出现的失败任务、降级任务和手机上报的异常。
function renderDiagBadge() {
    let seenAt = 0;
    try {
        seenAt = Number(localStorage.getItem("diag-seen-at")) || 0;
    } catch (_) {}
    seenAt = Math.max(seenAt, Date.now() - 86400000);
    const fresh = (time) => new Date(time).getTime() > seenAt;
    const opIssues = state.operations.filter((op) => fresh(op.created) && (["failed", "unknown"].includes(op.status) || op.warnings?.length));
    const phoneIssues = (state.device?.diagnostics || []).filter((d) => fresh(d.last_at) && !d.task_id);
    const count = opIssues.length + phoneIssues.length;
    $("diag-badge").hidden = !count;
    $("diag-badge").textContent = count > 99 ? "99+" : String(count);
    $("diag-link").title = count ? "执行诊断：" + count + " 条新的异常或降级" : "执行诊断";
}

// renderList 按搜索词和筛选条件显示会话列表。
function renderList() {
    const search = $("search").value.toLowerCase();
    const items = state.conversations.filter(
        (c) =>
            c.title.toLowerCase().includes(search) &&
            (filter === "all" || (filter === "unread" ? c.unread > 0 : c.kind === filter))
    );
    const list = $("conversations");
    list.replaceChildren();
    // 每个会话一行：头像、名称、时间、预览和未读数
    for (const c of items) {
        const item = el("button", undefined, "conversation-item" + (c.id === active ? " active" : ""));
        const top = el("div", undefined, "conversation-top");
        top.append(el("strong", c.title), el("time", timeLabel(c.updated)));
        const bottom = el("div", undefined, "conversation-bottom");
        bottom.append(el("small", c.preview || KINDS[c.kind]));
        if (c.unread) bottom.append(el("span", c.unread > 99 ? "99+" : String(c.unread), "badge"));
        const text = el("div", undefined, "conversation-copy");
        text.append(top, bottom);
        item.append(avatar(c), text);
        item.onclick = () => selectChat(c.id);
        list.append(item);
    }
    if (!items.length) {
        const empty = state.conversations.length ? "没有匹配的会话" : "还没有会话\n收到来信后自动添加，或点击 ＋ 新建";
        list.append(el("div", empty, "empty-list"));
    }
}

// operationsOfActive 当前会话的任务（新的在前）。
function operationsOfActive() {
    return state.operations.filter((op) => op.conversation_id === active);
}

// renderChat 显示当前聊天：标题和设置摘要、任务提示、按钮状态和消息列表。
function renderChat() {
    $("welcome").hidden = !!conversation;
    $("chat").hidden = !conversation;
    if (!conversation) return;
    const ops = operationsOfActive(); // 新的在前
    const pending = ops.find((op) => ["queued", "running"].includes(op.status));

    $("chat-title").textContent = conversation.title;
    const head = avatar(conversation);
    head.id = "chat-avatar";
    $("chat-avatar").replaceWith(head);
    renderChatNote(pending);
    renderOperationNote(ops, pending);

    // 有任务进行中时禁用读取和发送，避免重复提交
    $("read").disabled = $("send-image").disabled = !!pending || busy;
    $("send").disabled = !!pending || busy || !$("message").value.trim();
    renderMessages(ops.filter((op) => op.kind === "send" && ["queued", "running"].includes(op.status)).reverse());
}

// 标题下的状态和设置摘要，例如：群聊 · 手机已连接 · 定时每 5 分钟 · 仅缩略图 · AI 关闭
function renderChatNote(pending) {
    const c = conversation;
    const connection = pending ? "手机处理中" : state.connection === "在线" ? "手机已连接" : "等待手机连接";
    const originals = c.originals || (c.kind === "person" ? "on" : "off");
    const ai = c.ai_effective?.mode === "auto" ? "AI 自动回复" + (c.ai_effective.keyword ? "（" + c.ai_effective.keyword + "）" : "") : "AI 关闭";
    const parts = [KINDS[c.kind], connection, READ_EVERY[c.read_every_seconds] ? "定时" + READ_EVERY[c.read_every_seconds] : "不定时读取", originals === "on" ? "取原图" : "仅缩略图", ai];
    $("chat-note").replaceChildren(...parts.map((text, i) => el("span", text, i === 1 && state.connection !== "在线" ? "warn" : "")));
}

// 消息下方的提示：进行中的任务；最近一次手动任务失败；最近一次任务的降级。失败和降级提示点 × 关闭。
function renderOperationNote(ops, pending) {
    const note = $("operation-note");
    const lastManual = ops.find((op) => !op.auto);
    const failed = lastManual && ["failed", "unknown"].includes(lastManual.status) && !dismissed.has(lastManual.id) ? lastManual : null;
    const degraded = ops.find((op) => op.status === "succeeded" && op.warnings?.length);
    const warned = degraded && !dismissed.has(degraded.id) && degraded === ops.find((op) => op.status !== "queued" && op.status !== "running") ? degraded : null;
    const shown = pending || failed || warned;
    // 内容没变就不重建，避免刷新时点击落空。
    const key = shown ? shown.id + shown.status + [...dismissed].join() : "";
    if (note.dataset.key === key) return;
    note.dataset.key = key;
    note.replaceChildren();
    note.className = "operation-note";
    note.hidden = !shown;
    if (!shown) return;
    if (pending) {
        note.append(el("span", (pending.kind === "send" ? "正在发送" : "正在读取") + " · " + STATUS[pending.status]));
        return;
    }
    if (failed) {
        note.classList.add("error");
        note.append(el("span", STATUS[failed.status] + " · " + (failed.error || "请查看手机确认，不会自动重发")));
    } else {
        note.classList.add("degraded");
        const more = warned.warnings.length > 1 ? "（共 " + warned.warnings.length + " 处）" : "";
        note.append(el("span", "⚠ " + (warned.kind === "send" ? "发送" : "读取") + "有降级：" + warned.warnings[0].message + more));
    }
    const link = el("a", "查看诊断");
    link.href = "/debug.html#" + (failed || warned).id;
    const close = el("button", "×", "note-close");
    close.title = "关闭提示";
    close.onclick = () => {
        dismissed.add((failed || warned).id);
        renderChat();
    };
    note.append(link, close);
}

// ---------- 消息列表 ----------
// 按消息编号复用已渲染的节点，只新增或替换有变化的消息：已加载的图片不会重新加载，滚动位置也不会跳。
// 停在底部时新消息自动跟随；往上翻看历史时不滚动，只提示有几条新消息。
const list = { conversationId: null, nodes: new Map(), stick: true, unseen: 0 };

// atBottom 消息列表是否停在底部（距底部 80 像素以内）。
function atBottom() {
    const box = $("messages");
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

// scrollToLatest 滚到最新消息，并清除新消息提示。
function scrollToLatest(smooth) {
    const box = $("messages");
    box.scrollTo({ top: box.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    list.stick = true;
    list.unseen = 0;
    $("new-messages").hidden = true;
}

// 用户滚动时更新“是否停在底部”；滚回底部就清除新消息提示
$("messages").onscroll = () => {
    list.stick = atBottom();
    if (list.stick) {
        list.unseen = 0;
        $("new-messages").hidden = true;
    }
};
// 点“N 条新消息”平滑滚到底部
$("new-messages").onclick = () => scrollToLatest(true);

// 正文消息 + 尚未完成的发送任务（显示在末尾）。
function renderMessages(pendingSends) {
    const box = $("messages");
    // 切换了会话：清空已渲染的节点，渲染后跳到最新消息
    const opened = list.conversationId !== conversation.id;
    if (opened) {
        list.conversationId = conversation.id;
        list.nodes = new Map();
    }
    // 组装要显示的条目：日期变化处插入分隔线，然后是消息，最后是还没完成的发送
    const items = [];
    let lastDay = "";
    for (const m of conversation.messages) {
        const day = dayLabel(m.time);
        if (day !== lastDay) items.push({ key: "d:" + day + ":" + m.id, sig: day, build: () => el("div", day, "day-divider") });
        lastDay = day;
        items.push({ key: "m:" + m.id, sig: JSON.stringify(m), incoming: m.direction !== "outgoing", build: () => messageNode(m) });
    }
    for (const op of pendingSends) items.push({ key: "op:" + op.id, sig: op.status, build: () => pendingNode(op) });
    // 内容没变的条目复用原节点，变了才重建；同时统计新出现的来信条数
    const nodes = new Map();
    let added = 0;
    const children = items.map((item) => {
        let entry = list.nodes.get(item.key);
        if (!entry && item.incoming) added++;
        if (!entry || entry.sig !== item.sig) entry = { sig: item.sig, node: item.build() };
        nodes.set(item.key, entry);
        return entry.node;
    });
    list.nodes = nodes;
    if (!children.length) {
        const empty = el("div", undefined, "messages-empty");
        empty.append(el("strong", "等待新消息"), el("span", "来信后会自动读取聊天正文，也可以主动从手机读取。"));
        children.push(empty);
    }
    // 停在底部时跟随到最新；否则保持原滚动位置，有新来信时显示提示
    const top = box.scrollTop;
    box.replaceChildren(...children);
    if (opened || list.stick) {
        scrollToLatest(false);
    } else {
        box.scrollTop = top;
        if (added) {
            list.unseen += added;
            $("new-messages").textContent = "↓ " + list.unseen + " 条新消息";
            $("new-messages").hidden = false;
        }
    }
}

// messageNode 一条消息：缺口提示、气泡（文字或图片）以及时间等附加说明。
function messageNode(m) {
    const node = el("div");
    if (m.gap) node.append(el("div", "此处与之前的记录没能衔接，中间可能有遗漏或重复", "gap-note"));
    // 有原图就直接显示原图，否则显示聊天页面的缩略图。
    const image = m.original_hash || m.image_hash;
    const bubble = el("div", image ? undefined : m.text, "bubble");
    if (image) bubble.append(imageLink(image, "微信图片"));
    if (m.image_error && !image) bubble.append(el("small", m.image_error));
    if (m.kind === "image" && !m.original_hash && m.original_error) bubble.append(el("small", "原图：" + m.original_error));
    if (m.original_note) bubble.append(el("small", m.original_note));
    const meta = [clock(m.time)];
    if (m.kind === "image") meta.push(m.original_hash ? (m.original_note ? "大图截图" : "原图") : "缩略图");
    if (m.direction === "unknown") meta.push("方向未识别");
    node.append(messageRow(m.direction === "outgoing", bubble, meta));
    return node;
}

// pendingNode 还在发送中的消息，显示在列表末尾。
function pendingNode(op) {
    const bubble = el("div", op.text, "bubble");
    if (op.image_hash) bubble.append(imageLink(op.image_hash, "待发送图片"));
    return messageRow(true, bubble, [STATUS[op.status]]);
}

// messageRow 消息行：发出的消息靠右并显示“我”，收到的显示会话头像。
function messageRow(outgoing, bubble, meta) {
    const row = el("div", undefined, "message-row" + (outgoing ? " outgoing" : ""));
    const content = el("div", undefined, "message-content");
    const metaLine = el("div", undefined, "message-meta");
    metaLine.append(...meta.map((text) => el("span", text)));
    content.append(bubble, metaLine);
    row.append(outgoing ? el("span", "我", "avatar") : avatar(conversation), content);
    return row;
}

// ---------- 会话操作 ----------

// selectChat 打开会话；手机窄屏时切换到聊天页面。
async function selectChat(id) {
    active = id;
    conversation = null;
    list.conversationId = null; // 重新打开会话时跳到最新消息
    document.querySelector(".app").classList.add("chat-open");
    await refresh();
}

// 提交读取或发送任务；每次点击生成新的请求编号，服务端据此防止重复提交。
async function submit(kind, body) {
    if (!active || busy) return;
    // 提交期间禁用按钮；发送成功后清空输入框
    busy = true;
    renderChat();
    try {
        const op = await api("conversations/" + active + "/" + kind, body, crypto.randomUUID());
        knownStatus.set(op.id, op.status);
        if (kind === "send" && body.text) {
            $("message").value = "";
            updateComposer();
        }
    } catch (e) {
        toast(e.message);
    } finally {
        busy = false;
        await refresh();
    }
}

// updateComposer 更新字数统计和发送按钮状态。
function updateComposer() {
    $("char-count").textContent = Array.from($("message").value).length + " / 2000";
    if (conversation) renderChat();
}

// 从手机读取最近 N 条（1–100）
$("read").onclick = () => {
    const limit = Number($("limit").value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return toast("读取数量必须为 1–100");
    submit("read", { limit });
};
// 发送文字；Enter 发送，Shift+Enter 换行（输入法组字时不发送）
$("send").onclick = () => submit("send", { text: $("message").value });
$("message").oninput = updateComposer;
$("message").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!$("send").disabled) $("send").click();
    }
};

// 发送图片：选择文件 → 读成 Base64 上传保存 → 用返回的图片哈希建立发送任务
$("send-image").onclick = () => $("image-file").click();
$("image-file").onchange = async () => {
    const file = $("image-file").files[0];
    $("image-file").value = "";
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast("图片最多 8 MB");
    try {
        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        const saved = await api("media", { data });
        await submit("send", { image_hash: saved.image_hash });
    } catch (e) {
        toast(e.message);
    }
};

// 把当前会话（含消息）导出为 JSON 文件
$("export").onclick = () => {
    const blob = new Blob([JSON.stringify(conversation, null, 2)], { type: "application/json" });
    const link = el("a");
    link.href = URL.createObjectURL(blob);
    link.download = conversation.title.replace(/[\\/:*?"<>|]/g, "_") + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

// 手机窄屏：返回会话列表；搜索框输入时实时过滤
$("back").onclick = () => document.querySelector(".app").classList.remove("chat-open");
$("search").oninput = renderList;
// 筛选按钮：全部 / 联系人 / 群聊 / 未读
for (const button of document.querySelectorAll("[data-filter]")) {
    button.onclick = () => {
        filter = button.dataset.filter;
        for (const b of document.querySelectorAll("[data-filter]")) b.classList.toggle("selected", b === button);
        renderList();
    };
}

// ---------- 对话框 ----------

// 所有对话框的关闭按钮
for (const button of document.querySelectorAll(".close-dialog")) {
    button.onclick = () => button.closest("dialog").close();
}

// 提交表单：失败时把错误显示在对话框里，成功后关闭并刷新。
function handleForm(formId, errorId, save) {
    $(formId).onsubmit = async (e) => {
        e.preventDefault();
        e.submitter.disabled = true;
        try {
            await save();
            $(formId).closest("dialog").close();
            await refresh();
        } catch (error) {
            $(errorId).textContent = error.message;
        } finally {
            e.submitter.disabled = false;
        }
    };
}

// openNewChat 打开“添加会话”对话框。
function openNewChat() {
    $("new-error").textContent = "";
    $("new-dialog").showModal();
    $("new-title").focus();
}
$("new-chat").onclick = openNewChat;
$("welcome-new").onclick = openNewChat;
handleForm("new-form", "new-error", async () => {
    const c = await api("conversations", { title: $("new-title").value, kind: $("new-kind").value });
    $("new-title").value = "";
    await selectChat(c.id);
});

// openSettings 打开“手机连接”对话框；Token 不回显，留空表示保留原值。
function openSettings() {
    $("phone-url").value = state?.phone_url || "";
    $("phone-token").value = "";
    $("phone-token").placeholder = state?.token_set ? "已保存，留空保留原值" : "手机 config.json 中的 phone_api_token";
    $("settings-error").textContent = "";
    $("settings-dialog").showModal();
}
$("settings").onclick = openSettings;
$("connection-card").onclick = openSettings;
handleForm("settings-form", "settings-error", () =>
    api("config", { phone_url: $("phone-url").value, token: $("phone-token").value })
);

// 全局 AI：模型设置 + 名称规则列表。
const RULE_FIELDS = [
    ["kind", { person: "联系人", group: "群聊" }],
    ["matcher", { wildcard: "通配符", regex: "正则" }],
    ["pattern", "名称表达式"],
    ["mode", { off: "关闭", auto: "自动回复" }],
    ["keyword", "触发词"],
    ["interval_seconds", "间隔秒"]
];

// ruleRow 名称规则编辑行：按 RULE_FIELDS 生成输入框或下拉框，末尾是删除按钮。
function ruleRow(rule) {
    const row = el("div", undefined, "rule-row");
    for (const [key, options] of RULE_FIELDS) {
        let input;
        if (typeof options === "string") {
            input = el("input");
            input.placeholder = options;
            if (key === "interval_seconds") input.type = "number";
        } else {
            input = el("select");
            for (const [value, label] of Object.entries(options)) input.append(Object.assign(el("option", label), { value }));
        }
        input.dataset.key = key;
        input.value = rule[key] ?? "";
        row.append(input);
    }
    const remove = el("button", "删除", "text-button");
    remove.type = "button";
    remove.onclick = () => row.remove();
    row.append(remove);
    return row;
}

// readRules 从编辑行读出全部名称规则（间隔转为数字）。
function readRules() {
    return [...$("ai-rules").children].map((row) => {
        const rule = {};
        for (const input of row.querySelectorAll("[data-key]")) {
            rule[input.dataset.key] = input.dataset.key === "interval_seconds" ? Number(input.value) : input.value;
        }
        return rule;
    });
}

// 打开全局 AI 设置：读取当前配置和名称规则填入表单（密钥不回显）
$("ai-settings").onclick = async () => {
    try {
        const cfg = await api("ai/config");
        $("ai-url").value = cfg.url;
        $("ai-model").value = cfg.model;
        $("ai-key").value = "";
        $("ai-key").placeholder = cfg.key_set ? "已保存，留空保留原值" : "本地模型可留空";
        $("ai-prompt").value = cfg.prompt || "你是友好的聊天助手。回复简短自然，不要编造事实。";
        $("ai-vision").checked = cfg.vision;
        $("ai-rules").replaceChildren(...cfg.rules.map(ruleRow));
        $("ai-error").textContent = "";
        $("ai-dialog").showModal();
    } catch (e) {
        toast(e.message);
    }
};
// 添加一条名称规则（默认关闭，避免一加就开始自动回复）
$("ai-rule-add").onclick = () =>
    $("ai-rules").append(ruleRow({ kind: "person", matcher: "wildcard", mode: "off", interval_seconds: 30 }));
handleForm("ai-form", "ai-error", () =>
    api("ai/config", {
        url: $("ai-url").value,
        model: $("ai-model").value,
        key: $("ai-key").value,
        prompt: $("ai-prompt").value,
        vision: $("ai-vision").checked,
        rules: readRules()
    })
);

// 会话设置：类型、定时读取、图片、AI 回复。只提交有变化的项。
$("chat-settings").onclick = () => {
    const c = conversation;
    $("set-kind").value = c.kind;
    $("set-read-every").value = String(c.read_every_seconds || 0);
    $("set-originals").value = c.originals || (c.kind === "person" ? "on" : "off");
    $("set-ai-mode").value = c.ai.mode || "inherit";
    $("set-ai-interval").value = c.ai.interval_seconds || c.ai_effective?.interval_seconds || 30;
    $("set-ai-keyword").value = c.ai.keyword || "";
    $("chat-settings-error").textContent = "";
    $("chat-settings-dialog").showModal();
};
handleForm("chat-settings-form", "chat-settings-error", async () => {
    const c = conversation;
    const path = "conversations/" + active + "/";
    const kind = $("set-kind").value;
    if (kind !== c.kind) await api(path + "kind", { kind });
    const readEvery = Number($("set-read-every").value);
    if (readEvery !== (c.read_every_seconds || 0)) await api(path + "schedule", { read_every_seconds: readEvery });
    const originals = $("set-originals").value;
    if (originals !== (c.originals || (c.kind === "person" ? "on" : "off"))) await api(path + "originals", { originals });
    const ai = { mode: $("set-ai-mode").value, interval_seconds: Number($("set-ai-interval").value), keyword: $("set-ai-keyword").value };
    if (ai.mode !== (c.ai.mode || "inherit") || ai.interval_seconds !== c.ai.interval_seconds || ai.keyword !== (c.ai.keyword || ""))
        await api(path + "ai", ai);
});

// ---------- 系统侧边栏折叠（记在浏览器本地，禁用存储时也能切换） ----------

// setSystemCollapsed 折叠或展开系统侧边栏，并记住选择。
function setSystemCollapsed(collapsed) {
    $("system-sidebar").classList.toggle("collapsed", collapsed);
    $("system-toggle").setAttribute("aria-expanded", String(!collapsed));
    $("system-toggle").title = collapsed ? "展开侧边栏" : "折叠侧边栏";
    try {
        localStorage.setItem("system-sidebar-collapsed", String(collapsed));
    } catch (_) {}
}
try {
    setSystemCollapsed(localStorage.getItem("system-sidebar-collapsed") === "true");
} catch (_) {}
$("system-toggle").onclick = () => setSystemCollapsed(!$("system-sidebar").classList.contains("collapsed"));

// ---------- 启动 ----------

// 服务端数据变化时通过 SSE 通知刷新；另外每 20 秒兜底刷新一次
const stream = new EventSource("/api/stream");
stream.onmessage = () => void refresh();
stream.onerror = () => ($("connection").textContent = "实时连接恢复中");
setInterval(() => void refresh(), 20000);
void refresh();
