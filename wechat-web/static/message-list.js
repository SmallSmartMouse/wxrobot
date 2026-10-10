// 聊天消息列表：按消息编号复用已渲染的节点，只新增或替换有变化的消息：已加载的图片不会重新加载，滚动位置也不会跳。
// 停在底部时新消息自动跟随；往上翻看历史时不滚动，只提示有几条新消息。
import { $, el, accountName, clock, dayLabel, emojify } from "./common.js";
import { icon } from "./workspace.js";

export const STATUS = {
  queued: "等待手机",
  running: "手机处理中",
  succeeded: "已完成",
  failed: "失败",
  unknown: "结果未知",
};

const list = { conversationId: null, nodes: new Map(), stick: true, unseen: 0 };

// resetMessageList 重新打开会话时调用：下次渲染时跳到最新消息。
export function resetMessageList() {
  list.conversationId = null;
}

// conversationAvatar 会话头像：群聊显示群图标，联系人显示名称的第一个字。
export function conversationAvatar(c, className = "avatar") {
  const group = c.kind === "group";
  const face = el("span", group ? undefined : Array.from(c.title)[0], className + (group ? " group" : ""));
  if (group) face.append(icon("users"));
  return face;
}

// renderMessages 显示会话的正文消息，末尾是尚未完成的发送任务。
export function renderMessages(conversation, pendingSends) {
  const opened = list.conversationId !== conversation.id;
  if (opened) {
    list.conversationId = conversation.id;
    list.nodes = new Map();
  }
  const items = messageItems(conversation, pendingSends);
  const { children, added } = reuseNodes(items);
  if (!children.length) children.push(emptyNote());
  showChildren(children, opened, added);
}

// messageItems 要显示的条目：日期变化处插入分隔线，然后是消息，最后是还没完成的发送。
// sig 是条目内容的签名，签名不变就复用原节点。
function messageItems(conversation, pendingSends) {
  const items = [];
  let lastDay = "";
  for (const m of conversation.messages) {
    const day = dayLabel(m.time);
    if (day !== lastDay) items.push({ key: "d:" + day + ":" + m.id, sig: day, build: () => el("div", day, "day-divider") });
    lastDay = day;
    const face = conversation.members?.[m.sender] || "";
    items.push({
      key: "m:" + m.id,
      sig: JSON.stringify(m) + face + accountName(conversation.account) + conversation.title + conversation.kind,
      incoming: m.direction === "incoming",
      build: () => messageNode(conversation, m),
    });
  }
  for (const op of pendingSends)
    items.push({ key: "op:" + op.id, sig: op.status + accountName(conversation.account), build: () => pendingNode(conversation, op) });
  return items;
}

// reuseNodes 内容没变的条目复用原节点，变了才重建；同时统计新出现的来信条数。
function reuseNodes(items) {
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
  return { children, added };
}

// emptyNote 还没有消息时的提示。
function emptyNote() {
  const empty = el("div", undefined, "messages-empty");
  empty.append(el("strong", "等待新消息"), el("span", "来信后会自动读取聊天正文，也可以主动从手机读取。"));
  return empty;
}

// showChildren 换上新的条目：刚打开或停在底部时跟随到最新；否则保持原滚动位置，有新来信时显示提示。
function showChildren(children, opened, added) {
  const box = $("messages");
  const top = box.scrollTop;
  box.replaceChildren(...children);
  if (opened || list.stick) {
    scrollToLatest(false);
    return;
  }
  box.scrollTop = top;
  if (added) {
    list.unseen += added;
    $("new-messages").textContent = "↓ " + list.unseen + " 条新消息";
    $("new-messages").hidden = false;
  }
}

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

// ---------- 单条消息 ----------

// messageNode 一条消息：缺口提示、气泡（文字或图片）以及时间等附加说明。
// 系统提示（例如“你的账号被限制与对方聊天”）像微信一样居中显示，没有气泡和头像。
function messageNode(conversation, m) {
  const node = el("div");
  if (m.gap) node.append(el("div", "此处与之前的记录没能衔接，中间可能有遗漏或重复", "gap-note"));
  if (m.kind === "system") {
    node.append(el("div", emojify(m.text), "system-note"));
    return node;
  }
  node.append(messageRow(conversation, m.direction === "outgoing", messageBubble(m), messageMeta(m), m.sender));
  return node;
}

// messageBubble 气泡：有原图就显示原图，否则显示聊天页面的缩略图（表情包只有缩略图），再附上图片的问题说明。
function messageBubble(m) {
  const image = m.original_hash || m.image_hash;
  const sticker = m.kind === "sticker";
  const bubble = el("div", image ? undefined : emojify(m.text), "bubble" + (sticker && image ? " sticker" : ""));
  if (image) bubble.append(imageLink(image, sticker ? "表情" : "微信图片"));
  if (m.image_error && !image) bubble.append(el("small", m.image_error));
  if (m.kind === "image" && !m.original_hash && m.original_error) bubble.append(el("small", "原图：" + m.original_error));
  if (m.original_note) bubble.append(el("small", m.original_note));
  return bubble;
}

// messageMeta 消息下方的说明：观察时间、图片清晰度、类型、方向未识别。
function messageMeta(m) {
  const meta = [clock(m.time)];
  if (m.kind === "image") meta.push(m.original_hash ? (m.original_note ? "大图截图" : "原图") : "缩略图");
  if (m.kind === "sticker") meta.push("表情");
  if (m.direction === "unknown") meta.push("方向未识别");
  return meta;
}

// pendingNode 还在发送中的消息，显示在列表末尾。
function pendingNode(conversation, op) {
  const bubble = el("div", op.text, "bubble");
  if (op.image_hash) bubble.append(imageLink(op.image_hash, "待发送图片"));
  return messageRow(conversation, true, bubble, [STATUS[op.status]]);
}

// messageRow 消息行：发出的消息靠右并显示“我”；收到的显示发送人头像（没截到时用会话头像），
// 群聊里在气泡上方显示发送人名称。
function messageRow(conversation, outgoing, bubble, meta, sender) {
  const row = el("div", undefined, "message-row" + (outgoing ? " outgoing" : ""));
  const content = el("div", undefined, "message-content");
  const metaLine = el("div", undefined, "message-meta");
  metaLine.append(...meta.map((text) => el("span", text)));
  const name = outgoing
    ? accountName(conversation.account) + "（我）"
    : sender || (conversation.kind === "person" ? conversation.title : "未识别发送人");
  content.append(el("div", emojify(name), "message-sender"), bubble, metaLine);
  row.append(outgoing ? el("span", "我", "avatar") : senderAvatar(conversation, sender), content);
  return row;
}

// senderAvatar 发送人头像：有截到的头像图片就显示图片，否则群聊显示名称第一个字，联系人显示会话头像。
function senderAvatar(conversation, sender) {
  const face = conversation.members?.[sender];
  if (face) {
    const img = el("img", undefined, "avatar photo");
    img.src = "/api/media/" + face;
    img.alt = img.title = sender;
    return img;
  }
  if (sender && conversation.kind === "group") {
    const letter = el("span", Array.from(sender)[0], "avatar");
    letter.title = sender;
    return letter;
  }
  return conversationAvatar(conversation);
}

// imageLink 显示图片，点击在新标签页打开。图片加载后内容变高：如果正停在底部，保持在底部。
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

// 用户滚动时更新“是否停在底部”；滚回底部就清除新消息提示。点“N 条新消息”平滑滚到底部。
$("messages").onscroll = () => {
  list.stick = atBottom();
  if (!list.stick) return;
  list.unseen = 0;
  $("new-messages").hidden = true;
};
$("new-messages").onclick = () => scrollToLatest(true);
