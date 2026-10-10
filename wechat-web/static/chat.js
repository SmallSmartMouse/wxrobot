// 消息页：会话列表、当前聊天（标题、提示、按钮、消息列表）、输入框和发送，以及添加会话、会话设置对话框。
import { $, el, api, toast, handleForm, storage, accountName, accountLabel, timeLabel, emojify, KINDS, app } from "./common.js";
import { deviceProblems } from "./device-status.js";
import { navigate } from "./workspace.js";
import { currentAccount, phoneOf, chosenDevice } from "./accounts.js";
import { renderMessages, resetMessageList, conversationAvatar, STATUS } from "./message-list.js";
import { noteOperation } from "./operation-toasts.js";

const READ_EVERY = { 60: "每 1 分钟", 300: "每 5 分钟", 900: "每 15 分钟", 1800: "每 30 分钟", 3600: "每 1 小时" };

let active = null; // 当前会话 ID
let conversation = null; // 当前会话详情（含消息）
let filter = "all"; // 会话列表筛选：all | person | group | unread
let busy = false; // 正在提交读写任务
const dismissed = new Set(); // 已点掉的失败或降级提示（任务 ID）

// ---------- 数据 ----------

// loadActiveConversation 取当前会话的详情；等待期间切换了会话就丢弃旧会话的详情。
export async function loadActiveConversation() {
  const id = active;
  const detail = id ? await api("conversations/" + id) : null;
  if (id === active) conversation = detail;
}

// markActiveSeen 正在看的会话有未读，标记为已读。
export async function markActiveSeen() {
  if (conversation?.unread) await api("conversations/" + conversation.id + "/seen", {});
}

// operationsOfActive 当前会话的任务（新的在前）。
function operationsOfActive() {
  return app.state.operations.filter((op) => op.conversation_id === active);
}

function pendingOf(ops) {
  return ops.find((op) => ["queued", "running"].includes(op.status));
}

// ---------- 会话列表 ----------

// renderConversationList 当前账号的会话：按搜索词和筛选条件显示，每行头像、名称、时间、预览和未读数。
export function renderConversationList() {
  const account = currentAccount();
  $("list-account").textContent = account ? accountName(account) + " 的会话" : "还没有账号";
  $("list-account").title = accountLabel(account);
  const search = $("search").value.toLowerCase();
  const mine = app.state.conversations.filter((c) => c.account === account);
  const shown = mine.filter(
    (c) => c.title.toLowerCase().includes(search) && (filter === "all" || (filter === "unread" ? c.unread > 0 : c.kind === filter)),
  );
  $("conversations").replaceChildren(...shown.map(conversationRow));
  if (!shown.length) $("conversations").append(el("div", emptyListText(account, mine.length), "empty-list"));
}

function conversationRow(c) {
  const item = el("button", undefined, "conversation-item" + (c.id === active ? " active" : ""));
  const top = el("div", undefined, "conversation-top");
  top.append(el("strong", emojify(c.title)), el("time", timeLabel(c.updated)));
  const bottom = el("div", undefined, "conversation-bottom");
  bottom.append(el("small", c.preview ? emojify(c.preview) : KINDS[c.kind]));
  if (c.unread) bottom.append(el("span", c.unread > 99 ? "99+" : String(c.unread), "badge"));
  const text = el("div", undefined, "conversation-copy");
  text.append(top, bottom);
  item.append(conversationAvatar(c), text);
  item.onclick = () => selectChat(c.id);
  return item;
}

function emptyListText(account, count) {
  if (account === null) return "还没有账号\n先在“设备”页添加手机，等手机识别出微信号";
  return count ? "没有匹配的会话" : "还没有会话\n收到来信后自动添加，或点击 ＋ 新建";
}

// ---------- 当前聊天 ----------

// renderChat 显示当前聊天：标题和设置摘要、读取提示、任务提示、按钮状态和消息列表。
export function renderChat() {
  $("welcome").hidden = !!conversation;
  $("chat").hidden = !conversation;
  if (!conversation) return;
  const ops = operationsOfActive();
  const pending = pendingOf(ops);
  $("chat-title").textContent = emojify(conversation.title);
  const head = conversationAvatar(conversation);
  head.id = "chat-avatar";
  $("chat-avatar").replaceWith(head);
  renderChatNote();
  renderReadWarning();
  renderOperationNote(ops, pending);
  renderChatButtons(pending);
  const pendingSends = ops.filter((op) => op.kind === "send" && ["queued", "running"].includes(op.status)).reverse();
  renderMessages(conversation, pendingSends);
}

// renderChatNote 标题下的设置摘要，例如：群聊 · 定时每 5 分钟 · 仅缩略图 · AI 关闭
function renderChatNote() {
  const c = conversation;
  const ai = c.ai_effective?.mode === "auto" ? "AI 自动回复" + (c.ai_effective.keyword ? "（" + c.ai_effective.keyword + "）" : "") : "AI 关闭";
  const parts = [
    KINDS[c.kind],
    READ_EVERY[c.read_every_seconds] ? "定时" + READ_EVERY[c.read_every_seconds] : "手动读取",
    (c.originals || "on") === "on" ? "取原图" : "仅缩略图",
    ai,
  ];
  $("chat-note").title = parts.join(" · ");
  $("chat-note").replaceChildren(...parts.map((text) => el("span", text)));
}

// renderReadWarning 读取提示（例如消息衔接有缺口），折叠显示在标题旁。
function renderReadWarning() {
  const warning = conversation.read_warning || "";
  $("read-gap-note").hidden = !warning;
  $("read-gap-note").title = $("read-gap-detail").textContent = warning;
  $("read-gap-summary").textContent = warning.includes("缺口") ? "消息有缺口" : "读取有提示";
  if (!warning) $("read-gap-note").open = false;
}

// renderChatButtons 有任务进行中、正在提交或设备不可用时禁用读取和发送，避免重复提交；仅新增模式不能选条数。
function renderChatButtons(pending) {
  const newOnly = app.state.read_history === false;
  const phone = phoneOf(currentAccount());
  const blocked = !!pending || busy || !phone?.available;
  $("limit").disabled = newOnly;
  $("read").textContent = newOnly ? "读取新增" : "读取消息";
  if (!phone?.available) $("read").title = deviceProblems(phone).join("；");
  else if (pending || busy) $("read").title = "当前会话正在执行任务，请等待完成";
  else $("read").title = newOnly ? "读取底部当前一屏，不向上翻页" : "读取最近的消息";
  $("read").disabled = $("send-image").disabled = blocked;
  $("send").disabled = blocked || !$("message").value.trim();
}

// renderOperationNote 消息下方的提示：进行中的任务；最近一次手动任务失败；最近一次任务的降级。失败和降级提示点 × 关闭。
// 内容没变就不重建，避免刷新时点击落空。
function renderOperationNote(ops, pending) {
  const shown = pending || failedManual(ops) || degradedLatest(ops);
  const note = $("operation-note");
  const key = shown ? shown.id + shown.status + [...dismissed].join() : "";
  if (note.dataset.key === key) return;
  note.dataset.key = key;
  note.className = "operation-note";
  note.hidden = !shown;
  note.replaceChildren();
  if (!shown) return;
  if (shown === pending) {
    note.append(el("span", (pending.kind === "send" ? "正在发送" : "正在读取") + " · " + STATUS[pending.status]));
    return;
  }
  note.append(...issueNote(note, shown));
}

// failedManual 最近一次手动任务失败或结果未知（没被点掉）。
function failedManual(ops) {
  const last = ops.find((op) => !op.auto);
  return last && ["failed", "unknown"].includes(last.status) && !dismissed.has(last.id) ? last : null;
}

// degradedLatest 最近结束的任务成功但有降级（没被点掉）。
function degradedLatest(ops) {
  const latest = ops.find((op) => op.status !== "queued" && op.status !== "running");
  return latest?.status === "succeeded" && latest.warnings?.length && !dismissed.has(latest.id) ? latest : null;
}

// issueNote 失败或降级提示的内容：说明、“查看诊断”链接和关闭按钮。
function issueNote(note, op) {
  const failed = op.status !== "succeeded";
  note.classList.add(failed ? "error" : "degraded");
  const more = op.warnings?.length > 1 ? "（共 " + op.warnings.length + " 处）" : "";
  const text = failed
    ? STATUS[op.status] + " · " + (op.error || "请查看手机确认，不会自动重发")
    : "⚠ " + (op.kind === "send" ? "发送" : "读取") + "有降级：" + op.warnings[0].message + more;
  const link = el("a", "查看诊断");
  link.href = "#diagnostics";
  link.onclick = (e) => {
    e.preventDefault();
    app.diagnosticTask = op.id;
    navigate("diagnostics");
  };
  const close = el("button", "×", "note-close");
  close.title = "关闭提示";
  close.onclick = () => {
    dismissed.add(op.id);
    renderChat();
  };
  return [el("span", text), link, close];
}

// ---------- 会话操作 ----------

// selectChat 打开会话；手机窄屏时切换到聊天页面。
async function selectChat(id) {
  saveDraft();
  active = id;
  storage.set("last-chat:" + currentAccount(), id);
  $("message").value = storage.get("draft:" + id) || "";
  conversation = null;
  resetMessageList();
  document.querySelector(".app").classList.add("chat-open");
  await app.refresh();
}

// closeChat 关闭当前会话（切换到别的账号时）。
function closeChat() {
  active = conversation = null;
  $("message").value = "";
  document.querySelector(".app").classList.remove("chat-open");
}

// 切换账号：正在看的会话不属于新账号就关掉，然后打开新账号上次看的会话。
document.addEventListener("account-change", () => {
  saveDraft();
  const account = currentAccount();
  if (active && app.state.conversations.find((c) => c.id === active)?.account !== account) closeChat();
  app.render();
  const previous = storage.get("last-chat:" + account);
  if (previous && app.state.conversations.some((c) => c.id === previous && c.account === account)) void selectChat(previous);
});

// submit 提交读取或发送任务；每次提交生成新的请求编号，服务端据此防止重复提交。
async function submit(kind, body) {
  if (!active || busy || !phoneOf(currentAccount())?.available || pendingOf(operationsOfActive())) return;
  const submittedChat = active;
  busy = true;
  renderChat();
  try {
    const op = await api("conversations/" + submittedChat + "/" + kind, { ...body, phone_id: chosenDevice() }, crypto.randomUUID());
    noteOperation(op);
    if (kind === "send" && body.text) clearSentDraft(submittedChat, body.text);
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
    await app.refresh();
  }
}

// clearSentDraft 文字已提交：清掉草稿；还停在原会话、输入框没改过时清空输入框。
function clearSentDraft(chatId, text) {
  storage.set("draft:" + chatId, "");
  if (active !== chatId || $("message").value !== text) return;
  $("message").value = "";
  updateComposer();
}

// sendImageFile 发送图片：读成 Base64 上传保存，再用返回的图片哈希建立发送任务。
// 上传期间切换了会话或设备时不发送，免得发错地方。
async function sendImageFile(file) {
  if (file.size > 8 * 1024 * 1024) return toast("图片最多 8 MB");
  const imageChat = active,
    imageDevice = chosenDevice();
  try {
    const saved = await api("media", { data: await readAsDataURL(file) });
    if (active !== imageChat || chosenDevice() !== imageDevice) return toast("会话或设备已切换，请在目标会话重新选择图片");
    await submit("send", { image_hash: saved.image_hash });
  } catch (e) {
    toast(e.message);
  }
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// exportConversation 把当前会话（含消息）导出为 JSON 文件。
function exportConversation() {
  const blob = new Blob([JSON.stringify(conversation, null, 2)], { type: "application/json" });
  const link = el("a");
  link.href = URL.createObjectURL(blob);
  link.download = conversation.title.replace(/[\\/:*?"<>|]/g, "_") + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// updateComposer 保存草稿，更新字数统计和发送按钮状态。
function updateComposer() {
  saveDraft();
  $("char-count").textContent = Array.from($("message").value).length + " / 2000";
  if (conversation) renderChat();
}

function saveDraft() {
  if (active) storage.set("draft:" + active, $("message").value);
}

// ---------- 对话框 ----------

// openNewChat 打开“添加会话”对话框。
function openNewChat() {
  const account = currentAccount();
  $("new-error").textContent = "";
  $("new-account").textContent = account ? "添加到账号 " + accountLabel(account) : "请先连接手机，等手机识别出微信号后再添加会话";
  $("new-dialog").showModal();
  $("new-title").focus();
}

// openChatSettings 会话设置：类型、定时读取、图片、AI 回复，按当前设置填好。
function openChatSettings() {
  const c = conversation;
  $("set-kind").value = c.kind;
  $("set-read-every").value = String(c.read_every_seconds || 0);
  $("set-originals").value = c.originals || "on";
  $("set-ai-mode").value = c.ai.mode || "inherit";
  $("set-ai-interval").value = c.ai.interval_seconds || c.ai_effective?.interval_seconds || 30;
  $("set-ai-keyword").value = c.ai.keyword || "";
  $("chat-settings-error").textContent = "";
  $("chat-settings-dialog").showModal();
}

// saveChatSettings 只提交有变化的项。
async function saveChatSettings() {
  const c = conversation;
  const path = "conversations/" + active + "/";
  const kind = $("set-kind").value;
  if (kind !== c.kind) await api(path + "kind", { kind });
  const readEvery = Number($("set-read-every").value);
  if (readEvery !== (c.read_every_seconds || 0)) await api(path + "schedule", { read_every_seconds: readEvery });
  const originals = $("set-originals").value;
  if (originals !== (c.originals || "on")) await api(path + "originals", { originals });
  const ai = { mode: $("set-ai-mode").value, interval_seconds: Number($("set-ai-interval").value), keyword: $("set-ai-keyword").value };
  if (ai.mode !== (c.ai.mode || "inherit") || ai.interval_seconds !== c.ai.interval_seconds || ai.keyword !== (c.ai.keyword || ""))
    await api(path + "ai", ai);
}

// clearHistory 删除电脑上的聊天记录（手机微信不受影响），确认后执行。
async function clearHistory() {
  const c = conversation;
  if (!confirm(`删除「${emojify(c.title)}」在电脑上的 ${c.messages.length} 条聊天记录和相关图片？\n手机微信里的聊天不受影响，删除后不能恢复。`)) return;
  $("clear-history").disabled = true;
  try {
    await api("conversations/" + c.id + "/clear", {});
    $("chat-settings-dialog").close();
    toast("已删除电脑上的聊天记录");
    await app.refresh();
  } catch (e) {
    $("chat-settings-error").textContent = e.message;
  } finally {
    $("clear-history").disabled = false;
  }
}

// ---------- 绑定 ----------

$("read").onclick = () => {
  const limit = Number($("limit").value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return toast("读取数量必须为 1–100");
  submit("read", { limit });
};
$("send").onclick = () => submit("send", { text: $("message").value });
$("message").oninput = updateComposer;
// Enter 发送，Shift+Enter 换行（输入法组字时不发送）
$("message").onkeydown = (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  if (!$("send").disabled) $("send").click();
};
$("send-image").onclick = () => $("image-file").click();
$("image-file").onchange = () => {
  const file = $("image-file").files[0];
  $("image-file").value = "";
  if (file) void sendImageFile(file);
};
$("export").onclick = exportConversation;
$("back").onclick = () => document.querySelector(".app").classList.remove("chat-open");
$("search").oninput = renderConversationList;
for (const b of document.querySelectorAll("[data-filter]")) {
  b.onclick = () => {
    filter = b.dataset.filter;
    for (const other of document.querySelectorAll("[data-filter]")) other.classList.toggle("selected", other === b);
    renderConversationList();
  };
}
for (const b of document.querySelectorAll(".close-dialog")) b.onclick = () => b.closest("dialog").close();
$("new-chat").onclick = $("welcome-new").onclick = openNewChat;
handleForm("new-form", "new-error", async () => {
  const c = await api("conversations", { account: currentAccount() || "", title: $("new-title").value, kind: $("new-kind").value });
  $("new-title").value = "";
  await selectChat(c.id);
});
$("chat-settings").onclick = openChatSettings;
$("clear-history").onclick = clearHistory;
handleForm("chat-settings-form", "chat-settings-error", saveChatSettings);
