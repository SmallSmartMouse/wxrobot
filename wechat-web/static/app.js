"use strict";
// 微信消息台前端。数据全部来自 /api/state 和 /api/conversations/{id}；
// 服务端有变化时通过 SSE 推送 refresh，页面重新拉取并整体重绘。

const $ = (id) => document.getElementById(id);
const STATUS = { queued: "等待手机", running: "手机处理中", succeeded: "已完成", failed: "失败", unknown: "结果未知" };
const KINDS = { unknown: "待分类", person: "联系人", group: "群聊" };

let state = null; // GET /api/state
let active = null; // 当前会话 ID
let conversation = null; // 当前会话详情
let filter = "all";
let busy = false; // 正在提交读写任务
const knownStatus = new Map(); // 任务 ID → 上次看到的状态，用于结束时提示
const dismissed = new Set(); // 已点掉的失败提示（任务 ID）

// ---------- 工具 ----------

function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

let toastTimer;
function toast(text) {
    $("toast").textContent = text;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}

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

function timeLabel(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toDateString() === new Date().toDateString()
        ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function avatar(c, className = "avatar") {
    const group = c.kind === "group";
    return el("span", group ? "群" : Array.from(c.title)[0], className + (group ? " group" : ""));
}

// 显示 hash 对应的图片；点击打开 fullHash（原图），没有原图时打开同一张。
function imageLink(hash, alt, fullHash) {
    const link = el("a");
    link.href = "/api/media/" + (fullHash || hash);
    link.target = "_blank";
    link.rel = "noopener";
    const img = el("img", undefined, "chat-image");
    img.src = "/api/media/" + hash;
    img.alt = alt;
    img.loading = "lazy";
    link.append(img);
    return link;
}

// ---------- 刷新 ----------

let refreshing = false;
let refreshAgain = false;

// 并发调用时合并为一次后续刷新，避免旧响应覆盖新数据。
async function refresh() {
    if (refreshing) {
        refreshAgain = true;
        return;
    }
    refreshing = true;
    try {
        const id = active;
        state = await api("state");
        const detail = id ? await api("conversations/" + id) : null;
        if (id === active) conversation = detail;
        toastFinishedOperations();
        render();
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

function render() {
    renderStatus();
    renderList();
    renderChat();
}

function renderStatus() {
    const online = state.connection === "在线";
    const broken = /失败|离线/.test(state.connection);
    $("connection").textContent = state.connection;
    $("phone-address").textContent = state.phone_url || "点击设置手机 IP";
    $("status-dot").className = "dot" + (online ? " online" : broken ? " error" : "");
    $("connection-card").title = state.error || state.connection;
}

function renderList() {
    const search = $("search").value.toLowerCase();
    const items = state.conversations.filter(
        (c) =>
            c.title.toLowerCase().includes(search) &&
            (filter === "all" || (filter === "unread" ? c.unread > 0 : c.kind === filter))
    );
    const list = $("conversations");
    list.replaceChildren();
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

function operationsOfActive() {
    return state.operations.filter((op) => op.conversation_id === active);
}

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
    $("kind").value = conversation.kind;
    $("read-every").value = String(conversation.read_every_seconds || 0);
    // 未单独设置时：联系人取原图，群聊只要缩略图
    $("originals").value = conversation.originals || (conversation.kind === "person" ? "on" : "off");
    $("chat-note").textContent =
        KINDS[conversation.kind] + " · " + (pending ? "手机处理中" : state.connection === "在线" ? "手机已连接" : "等待手机连接");

    const note = $("operation-note");
    // 失败提示：只看最近一次手动任务（自动读取失败会自动重试），点一下关闭。
    const lastManual = ops.find((op) => !op.auto);
    const failed = lastManual && ["failed", "unknown"].includes(lastManual.status) && !dismissed.has(lastManual.id);
    note.hidden = !pending && !failed;
    note.title = failed && !pending ? "点击关闭" : "";
    note.onclick = () => {
        if (failed && !pending) {
            dismissed.add(lastManual.id);
            renderChat();
        }
    };
    if (pending) note.textContent = (pending.kind === "send" ? "正在发送" : "正在读取") + " · " + STATUS[pending.status];
    else if (failed) note.textContent = STATUS[lastManual.status] + " · " + (lastManual.error || "请查看手机确认，不会自动重发") + "  ×";

    $("read").disabled = $("send-image").disabled = !!pending || busy;
    $("send").disabled = !!pending || busy || !$("message").value.trim();
    renderMessages(ops.filter((op) => op.kind === "send" && ["queued", "running"].includes(op.status)).reverse());
}

// 正文消息 + 尚未完成的发送任务（显示在末尾）。
function renderMessages(pendingSends) {
    const box = $("messages");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren();
    if (!conversation.messages.length && !pendingSends.length) {
        const empty = el("div", undefined, "messages-empty");
        empty.append(el("strong", "等待新消息"), el("span", "来信后会自动读取聊天正文，也可以主动从手机读取。"));
        box.append(empty);
    }
    for (const m of conversation.messages) {
        if (m.gap) box.append(el("div", "此处与之前的记录没能衔接，中间可能有遗漏或重复", "gap-note"));
        const preview = m.image_hash || m.original_hash;
        const bubble = el("div", preview ? undefined : m.text, "bubble");
        if (preview) bubble.append(imageLink(preview, "微信图片", m.original_hash));
        if (m.image_error && !preview) bubble.append(el("small", m.image_error));
        if (m.kind === "image" && !m.original_hash && m.original_error) bubble.append(el("small", "原图：" + m.original_error));
        const meta = [timeLabel(m.time)];
        if (m.original_hash) meta.push(m.original_note ? "大图截图" : "原图");
        if (m.original_note) bubble.append(el("small", m.original_note));
        if (m.direction === "unknown") meta.push("方向未识别");
        box.append(messageRow(m.direction === "outgoing", bubble, meta));
    }
    for (const op of pendingSends) {
        const bubble = el("div", op.text, "bubble");
        if (op.image_hash) bubble.append(imageLink(op.image_hash, "待发送图片"));
        box.append(messageRow(true, bubble, [STATUS[op.status]]));
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
}

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

async function selectChat(id) {
    active = id;
    conversation = null;
    document.querySelector(".app").classList.add("chat-open");
    await refresh();
}

// 提交读取或发送任务；每次点击生成新的请求编号，服务端据此防止重复提交。
async function submit(kind, body) {
    if (!active || busy) return;
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

function updateComposer() {
    $("char-count").textContent = Array.from($("message").value).length + " / 2000";
    if (conversation) renderChat();
}

$("read").onclick = () => {
    const limit = Number($("limit").value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return toast("读取数量必须为 1–100");
    submit("read", { limit });
};
$("send").onclick = () => submit("send", { text: $("message").value });
$("message").oninput = updateComposer;
$("message").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!$("send").disabled) $("send").click();
    }
};

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

$("originals").onchange = async () => {
    try {
        await api("conversations/" + active + "/originals", { originals: $("originals").value });
    } catch (e) {
        toast(e.message);
    }
    await refresh();
};

$("read-every").onchange = async () => {
    try {
        await api("conversations/" + active + "/schedule", { read_every_seconds: Number($("read-every").value) });
    } catch (e) {
        toast(e.message);
    }
    await refresh();
};

$("kind").onchange = async () => {
    try {
        await api("conversations/" + active + "/kind", { kind: $("kind").value });
    } catch (e) {
        toast(e.message);
    }
    await refresh();
};

$("export").onclick = () => {
    const blob = new Blob([JSON.stringify(conversation, null, 2)], { type: "application/json" });
    const link = el("a");
    link.href = URL.createObjectURL(blob);
    link.download = conversation.title.replace(/[\\/:*?"<>|]/g, "_") + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

$("back").onclick = () => document.querySelector(".app").classList.remove("chat-open");
$("search").oninput = renderList;
for (const button of document.querySelectorAll("[data-filter]")) {
    button.onclick = () => {
        filter = button.dataset.filter;
        for (const b of document.querySelectorAll("[data-filter]")) b.classList.toggle("selected", b === button);
        renderList();
    };
}

// ---------- 对话框 ----------

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

function readRules() {
    return [...$("ai-rules").children].map((row) => {
        const rule = {};
        for (const input of row.querySelectorAll("[data-key]")) {
            rule[input.dataset.key] = input.dataset.key === "interval_seconds" ? Number(input.value) : input.value;
        }
        return rule;
    });
}

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

// 当前会话 AI：mode 为空表示跟随名称规则。
$("ai-chat-settings").onclick = () => {
    const ai = conversation.ai;
    $("chat-ai-mode").value = ai.mode || "inherit";
    $("chat-ai-interval").value = ai.interval_seconds || 30;
    $("chat-ai-keyword").value = ai.keyword || "";
    $("chat-ai-error").textContent = "";
    $("chat-ai-dialog").showModal();
};
handleForm("chat-ai-form", "chat-ai-error", () =>
    api("conversations/" + active + "/ai", {
        mode: $("chat-ai-mode").value,
        interval_seconds: Number($("chat-ai-interval").value),
        keyword: $("chat-ai-keyword").value
    })
);

// ---------- 系统栏折叠（记在本地，浏览器禁用存储时也能切换） ----------

function setSystemCollapsed(collapsed) {
    $("system-sidebar").classList.toggle("collapsed", collapsed);
    $("system-toggle").setAttribute("aria-expanded", String(!collapsed));
    try {
        localStorage.setItem("system-sidebar-collapsed", String(collapsed));
    } catch (_) {}
}
try {
    setSystemCollapsed(localStorage.getItem("system-sidebar-collapsed") === "true");
} catch (_) {}
$("system-toggle").onclick = () => setSystemCollapsed(!$("system-sidebar").classList.contains("collapsed"));

// ---------- 启动 ----------

const stream = new EventSource("/api/stream");
stream.onmessage = () => void refresh();
stream.onerror = () => ($("connection").textContent = "实时连接恢复中");
setInterval(() => void refresh(), 20000);
void refresh();
