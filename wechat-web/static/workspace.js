// 工作台外壳：页面切换（未保存修改的提醒）、导航折叠、右侧抽屉、任务列表、外观设置和图标。
// 页面结构写在 index.html 里，这里只绑定行为。
import { $, el, button, storage, app, accountLabel } from "./common.js";

export const icons = {
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  ai: "M8 4h8v3h4v10h-4v3H8v-3H4V7h4zM9 10v4m6-4v4",
  forward: "M4 17v-4a5 5 0 0 1 5-5h11m-5-5 5 5-5 5",
  diagnostic: "M2 12h5l3-8 4 16 3-8h5",
  task: "M8 4h12v17H4V4h4m0-2h8v4H8zM8 11h8m-8 5h5",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1",
  menu: "M4 6h16M4 12h16M4 18h16",
  refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M18 18a8 8 0 0 1-14-6",
  search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  image: "M4 3h16v18H4zM4 17l5-6 5 6 3-4 3 4M8 7h.01",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  phone: "M7 2h10v20H7zM11 18h2",
  check: "m5 12 4 4 10-10",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M20 21v-2a4 4 0 0 0-3-4M16 3a4 4 0 0 1 0 8",
};

// icon 创建一个线条图标（SVG）。
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", icons[name] || icons.chat);
  svg.append(path);
  return svg;
}

// renderIcons 把页面中的 <span data-icon="名称"> 换成图标。
function renderIcons() {
  for (const node of document.querySelectorAll("[data-icon]"))
    node.replaceWith(icon(node.dataset.icon));
}

// ---------- 页面切换 ----------

const titles = {
  messages: "消息",
  ai: "AI 回复",
  forward: "转发",
  system: "设备",
  diagnostics: "诊断",
};
const hooks = {}; // 页面名 → 进入页面时调用
const dirty = new Map(); // 有未保存修改的区域
let page = "messages";
let started = false;

// registerPage 登记进入页面时要做的事（加载数据、重绘）。
export function registerPage(name, enter) {
  hooks[name] = enter;
}

// markDirty 记下某个区域是否有未保存的修改；离开页面前提醒。
export function markDirty(key, value) {
  dirty.set(key, !!value);
}

export function hasDirty() {
  return [...dirty.values()].some(Boolean);
}

// navigate 切换页面；有未保存的修改时先确认，放弃后通知各页面丢弃草稿。返回是否切换成功。
export function navigate(name) {
  if (!titles[name]) name = "messages";
  if (page === name && app.page === name && hasDirty()) return true;
  if (page !== name && hasDirty() && !confirm("有未保存的修改，放弃修改并离开？"))
    return false;
  if (page !== name) {
    dirty.clear();
    document.dispatchEvent(new CustomEvent("workspace-discard"));
  }
  page = app.page = name;
  showPage(name);
  if (app.state) hooks[name]?.();
  return true;
}
app.navigate = navigate;

// showPage 显示页面、高亮导航，并更新标题和地址栏。
function showPage(name) {
  for (const node of document.querySelectorAll("[data-page]"))
    node.hidden = node.dataset.page !== name;
  for (const node of document.querySelectorAll("[data-nav]")) {
    node.classList.toggle("selected", node.dataset.nav === name);
    node.setAttribute("aria-current", node.dataset.nav === name ? "page" : "false");
  }
  $("page-label").textContent = titles[name];
  document.title = titles[name] + " · 微信消息台";
  history.replaceState(null, "", "#" + name);
  document.querySelector(".app").classList.remove("nav-open");
}

// renderWorkspace 每次数据刷新后更新任务数；第一次刷新时按地址栏打开页面。
export function renderWorkspace() {
  const n = (app.state?.operations || []).filter((o) =>
    ["queued", "running"].includes(o.status),
  ).length;
  $("task-count").hidden = !n;
  $("task-count").textContent = n;
  if (!started) {
    started = true;
    app.diagnosticTask = new URLSearchParams(location.search).get("task");
    navigate(location.hash.slice(1) || "messages");
  }
  document.dispatchEvent(new CustomEvent("workspace-state"));
}

// ---------- 抽屉与任务 ----------

// openDrawer 在右侧抽屉中显示内容。
export function openDrawer(title, content) {
  $("drawer-title").textContent = title;
  $("drawer-body").replaceChildren(content);
  if (!$("workspace-drawer").open) $("workspace-drawer").showModal();
}

// closeOnOutsideClick 按下和松开都在对话框外时关闭，避免在面板内拖选文本误关。
export function closeOnOutsideClick(dialog, close = () => dialog.close()) {
  const outside = (e) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (e) => (pressedOutside = e.isPrimary && outside(e)));
  dialog.addEventListener("pointercancel", () => (pressedOutside = false));
  dialog.addEventListener("close", () => (pressedOutside = false));
  dialog.addEventListener("click", (e) => {
    if (pressedOutside && outside(e)) close();
    pressedOutside = false;
  });
}

// phoneName 设备显示名称：网页上起的名称 > 手机型号 > 设备编号 > 地址。
export function phoneName(p) {
  return p?.name || p?.device?.info?.device_name || p?.device_id || p?.address || "未分配设备";
}

// operationAccount 任务所属的微信号（任务没记录时取会话的）。
export function operationAccount(op) {
  return (
    op.account ||
    app.state?.conversations.find((c) => c.id === op.conversation_id)?.account ||
    ""
  );
}

// openTasks 在抽屉中列出进行中的任务。
function openTasks() {
  const box = el("div");
  const current = (app.state?.operations || []).filter((o) => ["queued", "running"].includes(o.status));
  box.append(el("p", "当前活动任务 · 每个任务绑定提交时的微信号和设备", "muted"));
  for (const op of current) box.append(taskCard(op));
  if (!current.length) box.append(el("div", "暂无活动任务", "empty-list"));
  box.append(
    button("查看全部任务与异常", "secondary", () => {
      $("workspace-drawer").close();
      navigate("diagnostics");
    }),
  );
  openDrawer("任务", box);
}

// taskCard 一个进行中的任务：类型、状态、微信号和设备。
function taskCard(op) {
  const row = el("div", undefined, "task-card");
  const p = app.state.phones.find((p) => p.id === op.phone_id);
  row.append(
    el("strong", (op.kind === "send" ? "发送消息" : "读取消息") + " · " + (op.status === "queued" ? "排队中" : "执行中")),
    el("p", accountLabel(operationAccount(op)) + " · " + phoneName(p), "muted"),
  );
  return row;
}

// ---------- 外观 ----------

// applyTheme 按保存的显示模式和主题色设置页面，并更新外观面板的选中状态。
function applyTheme() {
  const mode = storage.get("theme-mode") || "system",
    color = storage.get("theme-color") || "green";
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = mode === "system" ? (dark ? "dark" : "light") : mode;
  document.documentElement.dataset.accent = color;
  for (const b of document.querySelectorAll("[data-mode]"))
    b.classList.toggle("selected", b.dataset.mode === mode);
  for (const b of document.querySelectorAll("[data-color]"))
    b.setAttribute("aria-pressed", String(b.dataset.color === color));
}

// showThemePanel 显示或收起外观面板。
function showThemePanel(show) {
  $("theme-panel").hidden = !show;
  $("theme-toggle").setAttribute("aria-expanded", String(show));
}

// setNavCollapsed 折叠或展开导航，并记住选择。
function setNavCollapsed(collapsed) {
  $("system-sidebar").classList.toggle("collapsed", collapsed);
  $("system-toggle").setAttribute("aria-expanded", String(!collapsed));
  $("system-toggle").title = collapsed ? "展开侧边栏" : "折叠侧边栏";
  storage.set("system-sidebar-collapsed", collapsed);
}

// closeMenuOnOutsideClick 点到菜单外或按 Esc 时收起下拉菜单（details）。
export function closeMenuOnOutsideClick(menu, container = menu) {
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) menu.open = false;
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    menu.open = false;
    menu.querySelector("summary").focus();
  });
}

// ---------- 绑定 ----------

function bindShell() {
  for (const node of document.querySelectorAll("[data-nav]"))
    node.onclick = () => navigate(node.dataset.nav);
  $("mobile-nav").onclick = () => document.querySelector(".app").classList.toggle("nav-open");
  $("system-toggle").onclick = () => setNavCollapsed(!$("system-sidebar").classList.contains("collapsed"));
  setNavCollapsed(storage.get("system-sidebar-collapsed") === "true");
  $("task-toggle").onclick = openTasks;
  $("drawer-close").onclick = () => $("workspace-drawer").close();
  closeOnOutsideClick($("workspace-drawer"));
  for (const b of document.querySelectorAll("[data-mode]"))
    b.onclick = () => (storage.set("theme-mode", b.dataset.mode), applyTheme());
  for (const b of document.querySelectorAll("[data-color]"))
    b.onclick = () => (storage.set("theme-color", b.dataset.color), applyTheme());
  $("theme-toggle").onclick = () => showThemePanel($("theme-panel").hidden);
  document.addEventListener("click", (e) => {
    if (!$("theme-panel").contains(e.target) && !$("theme-toggle").contains(e.target)) showThemePanel(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") showThemePanel(false);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  window.addEventListener("beforeunload", (e) => {
    if (!hasDirty()) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

renderIcons();
bindShell();
applyTheme();
