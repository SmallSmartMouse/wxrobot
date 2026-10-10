import { deviceProblems, deviceStatus } from "./device-status.js";
// 微信消息台前端：会话列表、聊天、会话设置和页面启动。设备、AI 回复、转发页面在各自的模块里。
// 数据全部来自 /api/state 和 /api/conversations/{id}；服务端有变化时通过 SSE 推送 refresh，页面重新拉取并重绘（消息列表增量更新）。
import {
  $,
  el,
  api,
  toast,
  handleForm,
  storage,
  hostOf,
  accountName,
  accountLabel,
  clock,
  dayLabel,
  timeLabel,
  emojify,
  KINDS,
  app,
} from "./common.js";
import { renderWorkspace, phoneName, navigate, icon } from "./workspace.js";
import "./diagnostics.js";
import { renderPhoneSettings } from "./phones.js";
import "./ai.js";
import "./forward.js";

const STATUS = {
  queued: "等待手机",
  running: "手机处理中",
  succeeded: "已完成",
  failed: "失败",
  unknown: "结果未知",
};
const READ_EVERY = {
  60: "每 1 分钟",
  300: "每 5 分钟",
  900: "每 15 分钟",
  1800: "每 30 分钟",
  3600: "每 1 小时",
};

let state = null; // GET /api/state，同时放在 app.state 供其他模块读取
let active = null; // 当前会话 ID
let conversation = null; // 当前会话详情
let filter = "all";
let selectedAccount = storage.get("account"); // 当前查看的微信号；"" 表示还没归属账号的旧会话
let busy = false; // 正在提交读写任务
const knownStatus = new Map(); // 任务 ID → 上次看到的状态，用于结束时提示
const dismissed = new Set(); // 已点掉的失败或降级提示（任务 ID）

// avatar 会话头像：群聊显示“群”，联系人显示名称的第一个字。
function avatar(c, className = "avatar") {
  const group = c.kind === "group";
  const face = el(
    "span",
    group ? undefined : Array.from(c.title)[0],
    className + (group ? " group" : ""),
  );
  if (group) face.append(icon("users"));
  return face;
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
    state = app.state = await api("state");
    document.dispatchEvent(new Event("workspace-state"));
    pickAccount();
    const detail = id ? await api("conversations/" + id) : null;
    if (id === active) conversation = detail;
    toastFinishedOperations();
    render();
    // 正在看的会话有未读，标记为已读
    if (conversation?.unread)
      await api("conversations/" + conversation.id + "/seen", {});
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

// toastFinishedOperations 任务从“进行中”变为结束时弹出提示（自动读取、转发成功不提示）。
function toastFinishedOperations() {
  for (const op of state.operations) {
    const before = knownStatus.get(op.id);
    knownStatus.set(op.id, op.status);
    if (
      !["queued", "running"].includes(before) ||
      ["queued", "running"].includes(op.status)
    )
      continue;
    if (op.forward_rule && op.status === "succeeded") continue; // 转发是自动的，成功不逐条提示
    if (op.status !== "succeeded")
      toast(
        (op.forward_rule ? "转发" : "") +
          STATUS[op.status] +
          "：" +
          (op.error || "请查看手机"),
      );
    else if (op.kind === "send") toast("手机已确认发送");
    else if (!op.auto) toast("手机消息已读取");
  }
}

// ---------- 渲染 ----------

// render 重绘账号、连接状态、会话列表和当前聊天。
function render() {
  renderAccounts();
  renderStatus();
  renderList();
  renderChat();
  if (app.page === "system") renderPhoneSettings();
  renderWorkspace();
}

// ---------- 账号 ----------

// accountList 网页上可选的账号：服务端列出的微信号；还有没归属账号的旧会话时，加一项“未归属账号”。
function accountList() {
  const list = [...state.accounts];
  if (state.conversations.some((c) => !c.account))
    list.push({ wechat_id: "", connection: "等待手机识别微信号" });
  return list;
}

// pickAccount 选中的账号不存在时，改选第一个在线的账号，没有就选第一个。
function pickAccount() {
  const list = accountList();
  if (list.some((a) => a.wechat_id === selectedAccount)) return;
  selectedAccount =
    (list.find((a) => a.connection === "在线") || list[0])?.wechat_id ?? null;
}

// phoneOf 负责某个账号的手机：登录着这个微信号的手机（在线的优先）；"" 对应还没识别出微信号的手机。
function phoneOf(account) {
  if (account === null) return null;
  const phones = state.phones.filter((p) => (p.account || "") === account);
  const chosen = storage.get("device:" + account);
  if (chosen) return phones.find((p) => p.id === chosen) || null;
  return (
    [...phones]
      .filter((p) => p.available)
      .sort((a, b) => a.task_count - b.task_count)[0] ||
    phones[0] ||
    null
  );
}

// renderAccounts 账号切换下拉框：微信名、微信号和手机状态。
function renderAccounts() {
  const select = $("account-select");
  const q = $("account-search").value.toLowerCase();
  const list = accountList().filter(
    (a) =>
      (!$("account-online").checked ||
        state.phones.some((p) => p.account === a.wechat_id && p.available)) &&
      accountLabel(a.wechat_id).toLowerCase().includes(q),
  );
  const options = list.map((a) => {
    const label =
      accountLabel(a.wechat_id) +
      (a.connection === "在线" ? "" : " · " + a.connection);
    const option = el("option", label);
    option.value = a.wechat_id;
    return option;
  });
  if (!options.length)
    options.push(
      el(
        "option",
        accountList().length ? "没有匹配的微信号" : "还没有账号，先连接手机",
      ),
    );
  // 内容没变就不重建，避免打开下拉框时被刷新打断
  const key = JSON.stringify(list) + selectedAccount;
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.replaceChildren(...options);
    select.value = selectedAccount ?? "";
  }
  select.disabled = !list.length;
  $("account-trigger").textContent =
    selectedAccount === null ? "连接微信号" : accountLabel(selectedAccount);
}

$("account-select").onchange = () => {
  saveDraft();
  selectedAccount = $("account-select").value;
  storage.set("account", selectedAccount);
  $("account-menu").open = false;
  // 正在看的会话不属于新账号：关掉
  if (
    active &&
    (state.conversations.find((c) => c.id === active)?.account || "") !==
      selectedAccount
  ) {
    active = conversation = null;
    $("message").value = "";
    document.querySelector(".app").classList.remove("chat-open");
  }
  render();
  const previous = storage.get("last-chat:" + selectedAccount);
  if (
    previous &&
    state.conversations.some(
      (c) => c.id === previous && c.account === selectedAccount,
    )
  )
    void selectChat(previous);
};

// renderStatus 显示当前账号的手机连接状态、地址和未就绪原因，并更新诊断入口红点。
function renderStatus() {
  const phone = phoneOf(selectedAccount);
  renderDeviceSelect();
  app.currentPhone = phone;
  app.selectedAccount = selectedAccount;
  $("sender-target").textContent =
    "由 " + accountLabel(selectedAccount) + " · " + phoneName(phone) + " 发送";
  renderDiagBadge();
  let problem = $("device-problem");
  if (!problem) {
    problem = el("div", undefined, "info-strip warning");
    problem.id = "device-problem";
    problem.setAttribute("role", "status");
    document.querySelector(".account-context").after(problem);
  }
  problem.hidden = !!phone?.available;
  problem.textContent = deviceProblems(phone).join("；");
  if (!phone) {
    $("connection").textContent = state.phones.length
      ? "账号未连接"
      : "未连接手机";
    $("phone-address").textContent = state.phones.length
      ? "没有手机登录这个账号"
      : "点击添加手机";
    $("status-dot").className = "dot error";
    $("connection-card").title = state.error || "手机连接";
    return;
  }
  const online = phone.connection === "在线";
  const broken = /失败|离线/.test(phone.connection);
  $("connection").textContent = deviceStatus(phone);
  // 手机识别出的当前微信号（识别失败时显示原因），附在手机地址后面
  const account = phone.device?.info?.account;
  const address = hostOf(phone.phone_url);
  $("phone-address").textContent = "连接详情";
  $("status-dot").className = "dot" + (phone.available ? " online" : " error");
  $("connection-card").title = state.error || phone.error || phone.connection;
  if (account?.error)
    $("connection-card").title += "\n账号识别失败：" + account.error.message;
  // 手机未就绪时把原因放进提示，方便直接看出缺什么（例如截图授权、锁屏）。
  const reasons = phone.device?.info?.reasons || [];
  if (!online && reasons.length)
    $("connection-card").title += "：" + reasons.join("、");
}

// 诊断入口红点：最近 24 小时内、上次打开诊断页之后新出现的失败任务、降级任务和手机上报的异常。
function renderDiagBadge() {
  const seenAt = Math.max(
    Number(storage.get("diag-seen-at")) || 0,
    Date.now() - 86400000,
  );
  const fresh = (time) => new Date(time).getTime() > seenAt;
  const opIssues = state.operations.filter(
    (op) =>
      fresh(op.created) &&
      (["failed", "unknown"].includes(op.status) || op.warnings?.length),
  );
  const phoneIssues = state.phones
    .flatMap((p) => p.device?.diagnostics || [])
    .filter((d) => fresh(d.last_at) && !d.task_id);
  const count = opIssues.length + phoneIssues.length;
  $("diag-badge").hidden = !count;
  $("diag-badge").textContent = count > 99 ? "99+" : String(count);
  $("diag-link").title = count
    ? "执行诊断：" + count + " 条新的异常或降级"
    : "执行诊断";
}

// renderList 按搜索词和筛选条件显示会话列表。
function renderList() {
  $("list-account").textContent = selectedAccount
    ? accountName(selectedAccount) + " 的会话"
    : "未归属账号的会话";
  $("list-account").title = accountLabel(selectedAccount);
  const search = $("search").value.toLowerCase();
  // 只显示当前账号的会话
  const items = state.conversations.filter(
    (c) =>
      (c.account || "") === selectedAccount &&
      c.title.toLowerCase().includes(search) &&
      (filter === "all" ||
        (filter === "unread" ? c.unread > 0 : c.kind === filter)),
  );
  const list = $("conversations");
  list.replaceChildren();
  // 每个会话一行：头像、名称、时间、预览和未读数
  for (const c of items) {
    const item = el(
      "button",
      undefined,
      "conversation-item" + (c.id === active ? " active" : ""),
    );
    const top = el("div", undefined, "conversation-top");
    top.append(
      el("strong", emojify(c.title)),
      el("time", timeLabel(c.updated)),
    );
    const bottom = el("div", undefined, "conversation-bottom");
    bottom.append(el("small", c.preview ? emojify(c.preview) : KINDS[c.kind]));
    if (c.unread)
      bottom.append(
        el("span", c.unread > 99 ? "99+" : String(c.unread), "badge"),
      );
    const text = el("div", undefined, "conversation-copy");
    text.append(top, bottom);
    item.append(avatar(c), text);
    item.onclick = () => selectChat(c.id);
    list.append(item);
  }
  if (!items.length) {
    const mine = state.conversations.some(
      (c) => (c.account || "") === selectedAccount,
    );
    const empty =
      selectedAccount === null
        ? "还没有账号\n先在“设备”页添加手机，等手机识别出微信号"
        : mine
          ? "没有匹配的会话"
          : "还没有会话\n收到来信后自动添加，或点击 ＋ 新建";
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

  $("chat-title").textContent = emojify(conversation.title);
  const head = avatar(conversation);
  head.id = "chat-avatar";
  $("chat-avatar").replaceWith(head);
  renderChatNote(pending);
  $("read-gap-note").hidden = !conversation.read_warning;
  $("read-gap-detail").textContent = conversation.read_warning || "";
  $("read-gap-summary").textContent = conversation.read_warning?.includes(
    "缺口",
  )
    ? "消息有缺口"
    : "读取有提示";
  $("read-gap-note").title = conversation.read_warning || "";
  if (!conversation.read_warning) $("read-gap-note").open = false;
  renderOperationNote(ops, pending);

  // 有任务进行中时禁用读取和发送，避免重复提交
  $("limit").disabled = state.read_history === false;
  $("read").textContent =
    state.read_history === false ? "读取新增" : "读取消息";
  $("read").title =
    state.read_history === false
      ? "读取底部当前一屏，不向上翻页"
      : "读取最近的消息";
  const unavailable = !phoneOf(selectedAccount)?.available;
  if (unavailable)
    $("read").title = deviceProblems(phoneOf(selectedAccount)).join("；");
  else if (pending || busy)
    $("read").title = "当前会话正在执行任务，请等待完成";
  $("read").disabled = $("send-image").disabled =
    !!pending || busy || unavailable;
  $("send").disabled =
    !!pending || busy || unavailable || !$("message").value.trim();
  renderMessages(
    ops
      .filter(
        (op) => op.kind === "send" && ["queued", "running"].includes(op.status),
      )
      .reverse(),
  );
}

// 标题下的状态和设置摘要，例如：群聊 · 手机已连接 · 定时每 5 分钟 · 仅缩略图 · AI 关闭
function renderChatNote(pending) {
  const c = conversation;
  const originals = c.originals || "on";
  const ai =
    c.ai_effective?.mode === "auto"
      ? "AI 自动回复" +
        (c.ai_effective.keyword ? "（" + c.ai_effective.keyword + "）" : "")
      : "AI 关闭";
  const parts = [
    KINDS[c.kind],
    READ_EVERY[c.read_every_seconds]
      ? "定时" + READ_EVERY[c.read_every_seconds]
      : "手动读取",
    originals === "on" ? "取原图" : "仅缩略图",
    ai,
  ];
  $("chat-note").title = parts.join(" · ");
  $("chat-note").replaceChildren(...parts.map((text, i) => el("span", text)));
}

// 消息下方的提示：进行中的任务；最近一次手动任务失败；最近一次任务的降级。失败和降级提示点 × 关闭。
function renderOperationNote(ops, pending) {
  const note = $("operation-note");
  const lastManual = ops.find((op) => !op.auto);
  const failed =
    lastManual &&
    ["failed", "unknown"].includes(lastManual.status) &&
    !dismissed.has(lastManual.id)
      ? lastManual
      : null;
  const degraded = ops.find(
    (op) => op.status === "succeeded" && op.warnings?.length,
  );
  const warned =
    degraded &&
    !dismissed.has(degraded.id) &&
    degraded ===
      ops.find((op) => op.status !== "queued" && op.status !== "running")
      ? degraded
      : null;
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
    note.append(
      el(
        "span",
        (pending.kind === "send" ? "正在发送" : "正在读取") +
          " · " +
          STATUS[pending.status],
      ),
    );
    return;
  }
  if (failed) {
    note.classList.add("error");
    note.append(
      el(
        "span",
        STATUS[failed.status] +
          " · " +
          (failed.error || "请查看手机确认，不会自动重发"),
      ),
    );
  } else {
    note.classList.add("degraded");
    const more =
      warned.warnings.length > 1
        ? "（共 " + warned.warnings.length + " 处）"
        : "";
    note.append(
      el(
        "span",
        "⚠ " +
          (warned.kind === "send" ? "发送" : "读取") +
          "有降级：" +
          warned.warnings[0].message +
          more,
      ),
    );
  }
  const link = el("a", "查看诊断");
  link.href = "#diagnostics";
  link.onclick = (e) => {
    e.preventDefault();
    app.diagnosticTask = (failed || warned).id;
    navigate("diagnostics");
  };
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
    if (day !== lastDay)
      items.push({
        key: "d:" + day + ":" + m.id,
        sig: day,
        build: () => el("div", day, "day-divider"),
      });
    lastDay = day;
    const face = conversation.members?.[m.sender] || "";
    items.push({
      key: "m:" + m.id,
      sig:
        JSON.stringify(m) +
        face +
        accountName(conversation.account) +
        conversation.title +
        conversation.kind,
      incoming: m.direction === "incoming",
      build: () => messageNode(m),
    });
  }
  for (const op of pendingSends)
    items.push({
      key: "op:" + op.id,
      sig: op.status + accountName(conversation.account),
      build: () => pendingNode(op),
    });
  // 内容没变的条目复用原节点，变了才重建；同时统计新出现的来信条数
  const nodes = new Map();
  let added = 0;
  const children = items.map((item) => {
    let entry = list.nodes.get(item.key);
    if (!entry && item.incoming) added++;
    if (!entry || entry.sig !== item.sig)
      entry = { sig: item.sig, node: item.build() };
    nodes.set(item.key, entry);
    return entry.node;
  });
  list.nodes = nodes;
  if (!children.length) {
    const empty = el("div", undefined, "messages-empty");
    empty.append(
      el("strong", "等待新消息"),
      el("span", "来信后会自动读取聊天正文，也可以主动从手机读取。"),
    );
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
  if (m.gap)
    node.append(
      el("div", "此处与之前的记录没能衔接，中间可能有遗漏或重复", "gap-note"),
    );
  // 系统提示（例如“你的账号被限制与对方聊天”）像微信一样居中显示，没有气泡和头像
  if (m.kind === "system") {
    node.append(el("div", emojify(m.text), "system-note"));
    return node;
  }
  // 有原图就直接显示原图，否则显示聊天页面的缩略图（表情包只有缩略图）。
  const image = m.original_hash || m.image_hash;
  const sticker = m.kind === "sticker";
  const bubble = el(
    "div",
    image ? undefined : emojify(m.text),
    "bubble" + (sticker && image ? " sticker" : ""),
  );
  if (image) bubble.append(imageLink(image, sticker ? "表情" : "微信图片"));
  if (m.image_error && !image) bubble.append(el("small", m.image_error));
  if (m.kind === "image" && !m.original_hash && m.original_error)
    bubble.append(el("small", "原图：" + m.original_error));
  if (m.original_note) bubble.append(el("small", m.original_note));
  const meta = [clock(m.time)];
  if (m.kind === "image")
    meta.push(
      m.original_hash ? (m.original_note ? "大图截图" : "原图") : "缩略图",
    );
  if (sticker) meta.push("表情");
  if (m.direction === "unknown") meta.push("方向未识别");
  node.append(messageRow(m.direction === "outgoing", bubble, meta, m.sender));
  return node;
}

// pendingNode 还在发送中的消息，显示在列表末尾。
function pendingNode(op) {
  const bubble = el("div", op.text, "bubble");
  if (op.image_hash) bubble.append(imageLink(op.image_hash, "待发送图片"));
  return messageRow(true, bubble, [STATUS[op.status]]);
}

// messageRow 消息行：发出的消息靠右并显示“我”；收到的显示发送人头像（没截到时用会话头像），
// 群聊里在气泡上方显示发送人名称。
function messageRow(outgoing, bubble, meta, sender) {
  const row = el(
    "div",
    undefined,
    "message-row" + (outgoing ? " outgoing" : ""),
  );
  const content = el("div", undefined, "message-content");
  const metaLine = el("div", undefined, "message-meta");
  metaLine.append(...meta.map((text) => el("span", text)));
  const name = outgoing
    ? accountName(conversation.account) + "（我）"
    : sender ||
      (conversation.kind === "person" ? conversation.title : "未识别发送人");
  content.append(el("div", emojify(name), "message-sender"));
  content.append(bubble, metaLine);
  row.append(
    outgoing ? el("span", "我", "avatar") : senderAvatar(sender),
    content,
  );
  return row;
}

// senderAvatar 发送人头像：有截到的头像图片就显示图片，否则群聊显示名称第一个字，联系人显示会话头像。
function senderAvatar(sender) {
  const face = conversation.members?.[sender];
  if (face) {
    const img = el("img", undefined, "avatar photo");
    img.src = "/api/media/" + face;
    img.alt = sender;
    img.title = sender;
    return img;
  }
  if (sender && conversation.kind === "group") {
    const letter = el("span", Array.from(sender)[0], "avatar");
    letter.title = sender;
    return letter;
  }
  return avatar(conversation);
}

// ---------- 会话操作 ----------

// selectChat 打开会话；手机窄屏时切换到聊天页面。
async function selectChat(id) {
  saveDraft();
  active = id;
  storage.set("last-chat:" + selectedAccount, id);
  $("message").value = storage.get("draft:" + id) || "";
  conversation = null;
  list.conversationId = null; // 重新打开会话时跳到最新消息
  document.querySelector(".app").classList.add("chat-open");
  await refresh();
}

// 提交读取或发送任务；每次点击生成新的请求编号，服务端据此防止重复提交。
async function submit(kind, body) {
  if (
    !active ||
    busy ||
    !phoneOf(selectedAccount)?.available ||
    operationsOfActive().some((op) => ["queued", "running"].includes(op.status))
  )
    return;
  const submittedChat = active;
  const submittedText = body.text;
  body.phone_id = storage.get("device:" + selectedAccount) || "";
  // 提交期间禁用按钮；发送成功后清空输入框
  busy = true;
  renderChat();
  try {
    const op = await api(
      "conversations/" + submittedChat + "/" + kind,
      body,
      crypto.randomUUID(),
    );
    knownStatus.set(op.id, op.status);
    if (kind === "send" && body.text) {
      storage.set("draft:" + submittedChat, "");
      if (active !== submittedChat || $("message").value !== submittedText)
        return;
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
  saveDraft();
  $("char-count").textContent =
    Array.from($("message").value).length + " / 2000";
  if (conversation) renderChat();
}

// 从手机读取最近 N 条（1–100）
$("read").onclick = () => {
  const limit = Number($("limit").value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return toast("读取数量必须为 1–100");
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
  const imageChat = active;
  const imageDevice = storage.get("device:" + selectedAccount) || "";
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
    if (
      active !== imageChat ||
      (storage.get("device:" + selectedAccount) || "") !== imageDevice
    ) {
      toast("会话或设备已切换，请在目标会话重新选择图片");
      return;
    }
    await submit("send", { image_hash: saved.image_hash });
  } catch (e) {
    toast(e.message);
  }
};

// 把当前会话（含消息）导出为 JSON 文件
$("export").onclick = () => {
  const blob = new Blob([JSON.stringify(conversation, null, 2)], {
    type: "application/json",
  });
  const link = el("a");
  link.href = URL.createObjectURL(blob);
  link.download = conversation.title.replace(/[\\/:*?"<>|]/g, "_") + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

// 手机窄屏：返回会话列表；搜索框输入时实时过滤
$("back").onclick = () =>
  document.querySelector(".app").classList.remove("chat-open");
$("search").oninput = renderList;
// 筛选按钮：全部 / 联系人 / 群聊 / 未读
for (const button of document.querySelectorAll("[data-filter]")) {
  button.onclick = () => {
    filter = button.dataset.filter;
    for (const b of document.querySelectorAll("[data-filter]"))
      b.classList.toggle("selected", b === button);
    renderList();
  };
}

// ---------- 对话框 ----------

// 所有对话框的关闭按钮
for (const button of document.querySelectorAll(".close-dialog")) {
  button.onclick = () => button.closest("dialog").close();
}

// openNewChat 打开“添加会话”对话框。
function openNewChat() {
  $("new-error").textContent = "";
  $("new-account").textContent = selectedAccount
    ? "添加到账号 " + accountLabel(selectedAccount)
    : "请先连接手机，等手机识别出微信号后再添加会话";
  $("new-dialog").showModal();
  $("new-title").focus();
}
$("new-chat").onclick = openNewChat;
$("welcome-new").onclick = openNewChat;
handleForm("new-form", "new-error", async () => {
  const c = await api("conversations", {
    account: selectedAccount || "",
    title: $("new-title").value,
    kind: $("new-kind").value,
  });
  $("new-title").value = "";
  await selectChat(c.id);
});

// 会话设置：类型、定时读取、图片、AI 回复。只提交有变化的项。
$("chat-settings").onclick = () => {
  const c = conversation;
  $("set-kind").value = c.kind;
  $("set-read-every").value = String(c.read_every_seconds || 0);
  $("set-originals").value = c.originals || "on";
  $("set-ai-mode").value = c.ai.mode || "inherit";
  $("set-ai-interval").value =
    c.ai.interval_seconds || c.ai_effective?.interval_seconds || 30;
  $("set-ai-keyword").value = c.ai.keyword || "";
  $("chat-settings-error").textContent = "";
  $("chat-settings-dialog").showModal();
};
// 删除聊天记录：只删电脑上的，确认后执行。
$("clear-history").onclick = async () => {
  const c = conversation;
  const count = c.messages.length;
  if (
    !confirm(
      `删除「${emojify(c.title)}」在电脑上的 ${count} 条聊天记录和相关图片？\n手机微信里的聊天不受影响，删除后不能恢复。`,
    )
  )
    return;
  $("clear-history").disabled = true;
  try {
    await api("conversations/" + c.id + "/clear", {});
    $("chat-settings-dialog").close();
    toast("已删除电脑上的聊天记录");
    await refresh();
  } catch (e) {
    $("chat-settings-error").textContent = e.message;
  } finally {
    $("clear-history").disabled = false;
  }
};
handleForm("chat-settings-form", "chat-settings-error", async () => {
  const c = conversation;
  const path = "conversations/" + active + "/";
  const kind = $("set-kind").value;
  if (kind !== c.kind) await api(path + "kind", { kind });
  const readEvery = Number($("set-read-every").value);
  if (readEvery !== (c.read_every_seconds || 0))
    await api(path + "schedule", { read_every_seconds: readEvery });
  const originals = $("set-originals").value;
  if (originals !== (c.originals || "on"))
    await api(path + "originals", { originals });
  const ai = {
    mode: $("set-ai-mode").value,
    interval_seconds: Number($("set-ai-interval").value),
    keyword: $("set-ai-keyword").value,
  };
  if (
    ai.mode !== (c.ai.mode || "inherit") ||
    ai.interval_seconds !== c.ai.interval_seconds ||
    ai.keyword !== (c.ai.keyword || "")
  )
    await api(path + "ai", ai);
});

// ---------- 系统侧边栏折叠（记在浏览器本地，禁用存储时也能切换） ----------

// setSystemCollapsed 折叠或展开系统侧边栏，并记住选择。
function setSystemCollapsed(collapsed) {
  $("system-sidebar").classList.toggle("collapsed", collapsed);
  $("system-toggle").setAttribute("aria-expanded", String(!collapsed));
  $("system-toggle").title = collapsed ? "展开侧边栏" : "折叠侧边栏";
  storage.set("system-sidebar-collapsed", collapsed);
}
setSystemCollapsed(storage.get("system-sidebar-collapsed") === "true");
$("system-toggle").onclick = () =>
  setSystemCollapsed(!$("system-sidebar").classList.contains("collapsed"));

// ---------- 启动 ----------

// 其他模块通过 app 调用刷新和重绘
app.refresh = refresh;
app.render = render;
// 服务端数据变化时通过 SSE 通知刷新；另外每 20 秒兜底刷新一次
const stream = new EventSource("/api/stream");
stream.onmessage = () => void refresh();
stream.onerror = () => ($("connection").textContent = "实时连接恢复中");
setInterval(() => void refresh(), 20000);
void refresh();

function saveDraft() {
  if (active) storage.set("draft:" + active, $("message").value);
}
function renderDeviceSelect() {
  const select = $("device-select"),
    phones = state.phones.filter((p) => (p.account || "") === selectedAccount),
    chosen = storage.get("device:" + selectedAccount) || "";
  const key = JSON.stringify(phones) + chosen;
  if (select.dataset.key === key) return;
  select.dataset.key = key;
  const automatic = [...phones]
    .filter((p) => p.available)
    .sort((a, b) => a.task_count - b.task_count)[0];
  select.replaceChildren(
    new Option(
      "自动选择" + (automatic ? " · " + phoneName(automatic) : " · 无可用设备"),
      "",
    ),
  );
  for (const p of phones) {
    const option = new Option(
      phoneName(p) +
        " · " +
        (p.available
          ? p.task_count
            ? "忙碌 · " + p.task_count + " 个任务"
            : "可用"
          : p.connection),
      p.id,
    );
    option.disabled = !p.available;
    select.append(option);
  }
  if (chosen && !phones.some((p) => p.id === chosen))
    select.append(new Option("指定设备已移除", chosen));
  select.value = chosen;
  select.disabled = !phones.length;
  const single =
    phones.length === 1 &&
    phones[0].available &&
    (!chosen || chosen === phones[0].id);
  select.hidden = true;
  $("device-menu").hidden = single;
  $("device-trigger").textContent =
    select.selectedOptions[0]?.textContent || "自动选择";
  const options = $("device-options");
  options.replaceChildren();
  for (const option of select.options) {
    const target = phones.find((p) => p.id === option.value);
    const row = el("button", undefined, "device-option");
    row.type = "button";
    row.disabled = option.disabled;
    row.classList.toggle("selected", option.value === chosen);
    row.setAttribute("aria-pressed", String(option.value === chosen));
    row.append(icon(option.value ? "phone" : "check"));
    const copy = el("span", undefined, "grow");
    copy.append(
      el(
        "strong",
        target
          ? phoneName(target) + " · " + (target.device_id || target.id)
          : "自动选择",
      ),
    );
    copy.append(
      el(
        "small",
        target
          ? deviceStatus(target)
          : automatic
            ? "当前使用 " + phoneName(automatic)
            : "无可用设备",
      ),
    );
    row.append(copy);
    row.onclick = () => {
      select.value = option.value;
      $("device-menu").open = false;
      select.dispatchEvent(new Event("change"));
    };
    options.append(row);
  }
  $("single-device").hidden = !single;
  $("single-device").textContent = single ? phoneName(phones[0]) : "";
}
$("device-select").onchange = () => {
  storage.set("device:" + selectedAccount, $("device-select").value);
  render();
};
$("account-search").oninput = renderAccounts;
$("account-online").onchange = renderAccounts;
