import {
  $,
  el,
  button,
  api,
  toast,
  storage,
  app,
  accountLabel,
} from "./common.js";

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
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", icons[name] || icons.chat);
  svg.append(path);
  return svg;
}
const titles = {
  messages: "消息",
  ai: "AI 回复",
  forward: "转发",
  system: "设备",
  diagnostics: "诊断",
};
const hooks = {};
const dirty = new Map();
let page = "messages";
let started = false;
export function registerPage(name, enter) {
  hooks[name] = enter;
}
export function markDirty(key, value) {
  dirty.set(key, !!value);
}
export function hasDirty() {
  return [...dirty.values()].some(Boolean);
}
export function navigate(name) {
  if (!titles[name]) name = "messages";
  if (page === name && app.page === name && hasDirty()) return true;
  if (
    page !== name &&
    hasDirty() &&
    !confirm("有未保存的修改，放弃修改并离开？")
  )
    return false;
  if (page !== name) {
    dirty.clear();
    document.dispatchEvent(new CustomEvent("workspace-discard"));
  }
  page = name;
  app.page = name;
  for (const node of document.querySelectorAll("[data-page]"))
    node.hidden = node.dataset.page !== name;
  for (const node of document.querySelectorAll("[data-nav]")) {
    node.classList.toggle("selected", node.dataset.nav === name);
    node.setAttribute(
      "aria-current",
      node.dataset.nav === name ? "page" : "false",
    );
  }
  $("page-label").textContent = titles[name];
  document.title = titles[name] + " · 微信消息台";
  history.replaceState(null, "", "#" + name);
  document.querySelector(".app").classList.remove("nav-open");
  if (app.state) hooks[name]?.();
  return true;
}
app.navigate = navigate;
window.addEventListener("beforeunload", (e) => {
  if (hasDirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function buildShell() {
  const root = document.querySelector(".app"),
    side = $("system-sidebar");
  side.replaceChildren();
  const brand = el("div", undefined, "workspace-brand");
  brand.append(icon("chat"), el("strong", "微信消息台"));
  side.append(brand);
  const nav = el("nav", undefined, "system-nav");
  // 按使用频率分组：消息 | 自动处理（AI 回复、转发）| 设备与诊断，组之间有分隔线
  const names = [
    ["messages", "chat", "messages-nav"],
    ["ai", "ai", "ai-settings"],
    ["forward", "forward", "forward-settings"],
    ["system", "settings", "settings", true],
    ["diagnostics", "diagnostic", "diag-link"],
  ];
  for (const [name, glyph, id, groupStart] of names) {
    const b = button("", "system-item", () => navigate(name));
    if (groupStart) b.classList.add("nav-group-start");
    b.id = id;
    b.dataset.nav = name;
    b.title = titles[name];
    b.append(icon(glyph), el("span", titles[name], "system-label"));
    if (name === "diagnostics") {
      const badge = el("span", "", "alert-badge");
      badge.id = "diag-badge";
      badge.hidden = true;
      b.append(badge);
    }
    nav.append(b);
  }
  side.append(nav);
  const collapse = button("", "collapse-nav");
  collapse.id = "system-toggle";
  collapse.append(icon("menu"), el("span", "收起导航", "system-label"));
  side.append(collapse);
  const work = el("div", undefined, "workspace");
  root.append(work);
  const top = el("header", undefined, "workspace-top");
  const mobile = button("", "mobile-nav", () =>
    root.classList.toggle("nav-open"),
  );
  mobile.title = "展开导航";
  mobile.append(icon("menu"));
  const label = el("strong", "微信消息台");
  label.id = "page-label";
  const actions = el("div", undefined, "top-actions");
  const tasks = button("", "secondary", () => openTasks());
  tasks.id = "task-toggle";
  tasks.append(icon("task"), el("span", "任务"));
  const count = el("span", "", "badge");
  count.id = "task-count";
  count.hidden = true;
  tasks.append(count);
  const theme = button("", "secondary");
  theme.id = "theme-toggle";
  theme.append(icon("sun"), el("span", "外观"));
  theme.setAttribute("aria-expanded", "false");
  actions.append(tasks, theme);
  top.append(mobile, label, actions);
  work.append(top);
  const msg = el("section", undefined, "message-page");
  msg.id = "page-messages";
  msg.dataset.page = "messages";
  const context = el("div", undefined, "account-context");
  const nativeSelect = $("account-select");
  nativeSelect.size = 5;
  nativeSelect.className = "account-options";
  const accountBox = el("div", undefined, "account-picker");
  accountBox.append(el("span", "微信号", "muted"));
  const menu = document.createElement("details");
  menu.id = "account-menu";
  menu.className = "account-menu";
  const trigger = el("summary", "选择微信号");
  trigger.id = "account-trigger";
  const popover = el("div", undefined, "account-popover");
  const search = el("input");
  search.id = "account-search";
  search.type = "search";
  search.placeholder = "搜索昵称或微信号";
  search.setAttribute("aria-label", "搜索微信号");
  const online = el("label", undefined, "compact-check");
  const check = el("input");
  check.id = "account-online";
  check.type = "checkbox";
  online.append(check, "仅可用");
  popover.append(search, online, nativeSelect);
  menu.append(trigger, popover);
  accountBox.append(menu);
  document.querySelector(".account-switch").remove();
  document.addEventListener("click", (e) => {
    if (!accountBox.contains(e.target)) menu.open = false;
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      menu.open = false;
      trigger.focus();
    }
  });
  const devices = el("div", undefined, "device-picker");
  devices.append(el("span", "执行设备"));
  const select = el("select");
  select.id = "device-select";
  select.setAttribute("aria-label", "执行设备");
  const single = el("strong", "");
  single.id = "single-device";
  single.hidden = true;
  const deviceMenu = document.createElement("details");
  deviceMenu.className = "device-menu";
  deviceMenu.id = "device-menu";
  const deviceTrigger = el("summary", "自动选择");
  deviceTrigger.id = "device-trigger";
  const deviceOptions = el("div", undefined, "device-options");
  deviceOptions.id = "device-options";
  deviceOptions.setAttribute("role", "group");
  deviceOptions.setAttribute("aria-label", "选择执行设备");
  deviceMenu.append(deviceTrigger, deviceOptions);
  select.hidden = true;
  devices.append(select, deviceMenu, single);
  document.addEventListener("click", (e) => {
    if (!devices.contains(e.target)) deviceMenu.open = false;
  });
  deviceMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      deviceMenu.open = false;
      deviceTrigger.focus();
    }
  });
  const connection = $("connection-card");
  context.append(accountBox, devices, connection);
  const body = el("div", undefined, "message-body");
  const list = document.querySelector(".sidebar");
  list.querySelector(".brand").remove();
  body.append(list, document.querySelector(".chat-panel"));
  msg.append(context, body);
  work.append(msg);
  const sender = el("span", "", "sender-target");
  sender.id = "sender-target";
  const composer = document.querySelector(".composer");
  const composerRow = el("div", undefined, "composer-row");
  composerRow.append($("send-image"), $("message"), $("send"));
  composer.prepend(composerRow);
  $("send-image").replaceChildren(icon("image"));
  $("send-image").className = "secondary image-button";
  $("send-image").setAttribute("aria-label", "发送图片");
  $("send-image").title = "发送图片";
  $("send").textContent = "发送";
  $("message").placeholder = "输入消息…";
  $("message").setAttribute("aria-label", "消息内容");
  $("message").title = "Enter 发送，Shift + Enter 换行";
  $("char-count").before(sender);
  document.querySelector(".search-box > span").replaceWith(icon("search"));
  const chatHeading = el("div", undefined, "chat-heading");
  chatHeading.append($("chat-title"), $("read-gap-note"));
  document.querySelector(".chat-title").prepend(chatHeading);
  $("chat-settings").prepend(icon("settings"));
  $("export").className = "icon-button export-button";
  $("export").replaceChildren(icon("download"));
  $("export").setAttribute("aria-label", "导出会话");
  for (const [name, id] of [
    ["system", "settings-dialog"],
    ["ai", "ai-dialog"],
    ["forward", "forward-dialog"],
  ]) {
    const old = $(id),
      section = el("section", undefined, "management-page");
    section.id = id;
    section.dataset.page = name;
    section.hidden = true;
    section.append(...old.childNodes);
    old.replaceWith(section);
    work.append(section);
    for (const b of section.querySelectorAll(".close-dialog")) b.remove();
  }
  const system = $("settings-dialog");
  const head = system.querySelector(".dialog-heading");
  head.className = "page-heading";
  head.querySelector("h2").textContent = "设备";
  head.append($("phone-discover"));
  $("phone-discover").className = "primary";
  system.querySelector("p.muted").textContent =
    "管理多台设备及其当前微信号。首次连接需在手机确认授权。";
  head.nextElementSibling.className = "page-description";
  const card = el("section", undefined, "panel");
  const toolbar = el("div", undefined, "toolbar");
  const query = el("input");
  query.id = "phone-search";
  query.type = "search";
  query.placeholder = "搜索设备名称、编号或微信号";
  query.setAttribute("aria-label", query.placeholder);
  const status = el("select");
  status.id = "phone-filter";
  status.setAttribute("aria-label", "设备状态");
  for (const [v, t] of [
    ["all", "全部状态"],
    ["available", "可用"],
    ["offline", "离线"],
    ["busy", "忙碌"],
  ])
    status.append(new Option(t, v));
  const statusLabel = el("label", "状态：");
  statusLabel.append(status);
  const queryBox = el("div", undefined, "search-box device-search");
  queryBox.append(icon("search"), query);
  toolbar.append(queryBox, statusLabel);
  card.append(
    toolbar,
    el("h3", "已接入设备"),
    $("phone-list"),
    $("manual-phone"),
  );
  head.nextElementSibling.after(card);
  const found = el("section", undefined, "panel");
  found.id = "nearby-panel";
  found.append(
    el("h3", "发现与授权"),
    $("discovery-status"),
    $("phone-pairings"),
    $("discovered-phones"),
  );
  card.after(found);
  const former = [...system.querySelectorAll(".dialog-heading")];
  former.forEach((x) => x.remove());
  const discovery = $("discovery-settings");
  discovery.open = true;
  discovery.classList.add("panel");
  const discoveryHeading = el("h2", "自动发现");
  discovery.querySelector("summary").hidden = true;
  discovery.prepend(discoveryHeading);
  for (const id of ["discovery-enabled", "discovery-local"])
    $(id).setAttribute("role", "switch");
  const form = $("discovery-form"),
    advanced = document.createElement("details");
  advanced.className = "network-advanced";
  const summary = el("summary", "跨网段搜索");
  advanced.append(summary);
  const start = form.querySelector("h3");
  let cursor = start;
  while (cursor && !cursor.classList.contains("dialog-actions")) {
    const next = cursor.nextElementSibling;
    advanced.append(cursor);
    cursor = next;
  }
  form.insertBefore(advanced, form.querySelector(".dialog-actions"));
  const discoveryGrid = el("div", undefined, "discovery-grid");
  const toggleColumn = el("div");
  const rangeColumn = el("div");
  for (const [id, title, hint] of [
    ["discovery-enabled", "自动搜索", "自动在本地网络中搜索可连接的微信设备。"],
    ["discovery-local", "本地网络", "允许通过本地网络发现设备。"],
  ]) {
    const input = $(id),
      row = input.closest("label");
    row.replaceChildren(el("strong", title), input, el("small", hint));
    toggleColumn.append(row);
  }
  rangeColumn.append(form.querySelector("label.field"), advanced);
  discoveryGrid.append(toggleColumn, rangeColumn);
  form.prepend(discoveryGrid);
  advanced.querySelector("h3").remove();
  const save = form.querySelector(".dialog-actions");
  save.className = "save-bar";
  save.prepend(
    Object.assign(el("span", "已保存"), { id: "system-save-state" }),
  );
  $("discovery-save").textContent = "保存设置";
  $("discovery-save").disabled = true;
  save.insertBefore(
    button("放弃修改", "secondary", () =>
      document.dispatchEvent(new CustomEvent("system-discard")),
    ),
    $("discovery-save"),
  );
  save.children[1].id = "system-discard";
  save.children[1].hidden = true;
  system.append(save);
  const read = system.querySelector(".reading-settings");
  read.classList.add("panel");
  read.prepend(el("h2", "消息读取"));
  system.insertBefore(discovery, system.querySelector(".save-bar"));
  system.insertBefore(read, system.querySelector(".save-bar"));
  $("discovery-save").setAttribute("form", "discovery-form");
  const diag = el("section", undefined, "management-page");
  diag.dataset.page = "diagnostics";
  diag.id = "page-diagnostics";
  diag.hidden = true;
  work.append(diag);
  const drawer = document.createElement("dialog");
  drawer.id = "workspace-drawer";
  drawer.className = "drawer";
  drawer.innerHTML =
    '<div class="drawer-heading"><h2 id="drawer-title"></h2><button type="button" class="icon-button" id="drawer-close" aria-label="关闭">×</button></div><div id="drawer-body"></div>';
  document.body.append(drawer);
  $("drawer-close").onclick = () => drawer.close();
  // 只在按下和松开都位于面板外时关闭，避免在面板内拖选文本误关。
  const outsideDrawer = (event) => {
    const bounds = drawer.getBoundingClientRect();
    return (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );
  };
  let pressedOutside = false;
  drawer.addEventListener("pointerdown", (event) => {
    pressedOutside = event.isPrimary && outsideDrawer(event);
  });
  drawer.addEventListener("pointercancel", () => {
    pressedOutside = false;
  });
  drawer.addEventListener("click", (event) => {
    if (pressedOutside && outsideDrawer(event)) drawer.close();
    pressedOutside = false;
  });
  drawer.addEventListener("close", () => {
    pressedOutside = false;
  });
  buildTheme();
}

export function openDrawer(title, content) {
  const d = $("workspace-drawer");
  $("drawer-title").textContent = title;
  $("drawer-body").replaceChildren(content);
  if (!d.open) d.showModal();
}
export function phoneName(p) {
  return (
    p?.name ||
    p?.device?.info?.device_name ||
    p?.device_id ||
    p?.phone_url?.replace(/^https?:\/\//, "") ||
    "未分配设备"
  );
}
export function operationAccount(op) {
  return (
    op.account ||
    app.state?.conversations.find((c) => c.id === op.conversation_id)
      ?.account ||
    ""
  );
}
export function openTasks() {
  const box = el("div");
  const ops = app.state?.operations || [];
  const current = ops.filter((o) => ["queued", "running"].includes(o.status));
  box.append(
    el("p", "当前活动任务 · 每个任务绑定提交时的微信号和设备", "muted"),
  );
  for (const op of current) {
    const row = el("div", undefined, "task-card");
    const p = app.state.phones.find((p) => p.id === op.phone_id);
    row.append(
      el(
        "strong",
        (op.kind === "send" ? "发送消息" : "读取消息") +
          " · " +
          (op.status === "queued" ? "排队中" : "执行中"),
      ),
      el(
        "p",
        accountLabel(operationAccount(op)) + " · " + phoneName(p),
        "muted",
      ),
    );
    box.append(row);
  }
  if (!current.length) box.append(el("div", "暂无活动任务", "empty-list"));
  box.append(
    button("查看全部任务与异常", "secondary", () => {
      $("workspace-drawer").close();
      navigate("diagnostics");
    }),
  );
  openDrawer("任务", box);
}
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
function buildTheme() {
  const panel = el("div", undefined, "theme-popover");
  panel.id = "theme-panel";
  panel.hidden = true;
  panel.append(el("h3", "外观设置"), el("p", "显示模式", "muted"));
  const modes = el("div", undefined, "segmented");
  for (const [value, label] of [
    ["light", "浅色"],
    ["dark", "深色"],
    ["system", "跟随系统"],
  ]) {
    const b = button(label, "", () => {
      storage.set("theme-mode", value);
      applyTheme();
    });
    b.dataset.mode = value;
    modes.append(b);
  }
  panel.append(modes, el("p", "主题色", "muted"));
  const colors = el("div", undefined, "theme-colors");
  for (const [value, label] of [
    ["green", "绿"],
    ["blue", "蓝"],
    ["purple", "紫"],
    ["orange", "橙"],
  ]) {
    const b = button(label, "swatch swatch-" + value, () => {
      storage.set("theme-color", value);
      applyTheme();
    });
    b.dataset.color = value;
    b.setAttribute("aria-label", label + "色主题");
    colors.append(b);
  }
  panel.append(colors);
  document.querySelector(".workspace-top").append(panel);
  $("theme-toggle").onclick = () => {
    panel.hidden = !panel.hidden;
    $("theme-toggle").setAttribute("aria-expanded", String(!panel.hidden));
  };
  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target) && !$("theme-toggle").contains(e.target)) {
      panel.hidden = true;
      $("theme-toggle").setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      panel.hidden = true;
      $("theme-toggle").setAttribute("aria-expanded", "false");
    }
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener(
    "change",
    applyTheme,
  );
  applyTheme();
}
function applyTheme() {
  const mode = storage.get("theme-mode") || "system",
    color = storage.get("theme-color") || "green";
  document.documentElement.dataset.theme =
    mode === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode;
  document.documentElement.dataset.accent = color;
  for (const b of document.querySelectorAll("[data-mode]"))
    b.classList.toggle("selected", b.dataset.mode === mode);
  for (const b of document.querySelectorAll("[data-color]"))
    b.setAttribute("aria-pressed", String(b.dataset.color === color));
}
buildShell();
