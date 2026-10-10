// 消息页顶部：当前查看的微信号、执行设备、手机连接状态和设备问题提示，以及诊断入口的红点。
// 切换微信号时发出 account-change 事件（聊天区据此关闭不属于新账号的会话）。
import { $, el, storage, accountLabel, app } from "./common.js";
import { deviceProblems, deviceStatus, deviceWarnings } from "./device-status.js";
import { phoneName, icon, closeMenuOnOutsideClick } from "./workspace.js";

let selectedAccount = storage.get("account"); // 当前查看的微信号

// currentAccount 当前查看的微信号；还没有任何账号时为 null。
export function currentAccount() {
  return selectedAccount;
}

// pickAccount 选中的账号不存在时，改选第一个在线的账号，没有就选第一个。
export function pickAccount() {
  const accounts = app.state.accounts;
  if (accounts.some((a) => a.wechat_id === selectedAccount)) return;
  selectedAccount = (accounts.find((a) => a.connection === "在线") || accounts[0])?.wechat_id ?? null;
}

// accountPhones 登录着这个微信号的手机。
function accountPhones(account) {
  return app.state.phones.filter((p) => p.account === account);
}

// leastBusy 可用的手机中排队任务最少的一台，没有返回 undefined。
function leastBusy(phones) {
  return [...phones].filter((p) => p.available).sort((a, b) => a.task_count - b.task_count)[0];
}

// chosenDevice 当前微信号手动指定的执行设备编号，自动选择时为空字符串。
export function chosenDevice() {
  return storage.get("device:" + selectedAccount) || "";
}

// phoneOf 负责某个账号的手机：手动指定的那台；否则可用的手机中最空闲的，再否则任意一台。
export function phoneOf(account) {
  if (account === null) return null;
  const phones = accountPhones(account);
  const chosen = storage.get("device:" + account);
  if (chosen) return phones.find((p) => p.id === chosen) || null;
  return leastBusy(phones) || phones[0] || null;
}

// renderAccountBar 重绘消息页顶部：账号、执行设备、连接状态和问题提示，以及诊断红点。
export function renderAccountBar() {
  const phone = phoneOf(selectedAccount);
  app.currentPhone = phone;
  app.selectedAccount = selectedAccount;
  renderAccountPicker();
  renderDevicePicker();
  renderConnection(phone);
  renderDeviceNotes(phone);
  renderDiagBadge();
  $("sender-target").textContent = "由 " + accountLabel(selectedAccount) + " · " + phoneName(phone) + " 发送";
}

// ---------- 微信号 ----------

// renderAccountPicker 微信号下拉：按搜索词和“仅可用”筛选；内容没变就不重建，避免打开下拉框时被刷新打断。
function renderAccountPicker() {
  const select = $("account-select");
  const q = $("account-search").value.toLowerCase();
  const onlyAvailable = $("account-online").checked;
  const shown = app.state.accounts.filter(
    (a) =>
      (!onlyAvailable || accountPhones(a.wechat_id).some((p) => p.available)) &&
      accountLabel(a.wechat_id).toLowerCase().includes(q),
  );
  const key = JSON.stringify(shown) + selectedAccount;
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.replaceChildren(...accountOptions(shown));
    select.value = selectedAccount ?? "";
  }
  select.disabled = !shown.length;
  $("account-trigger").textContent = selectedAccount === null ? "连接微信号" : accountLabel(selectedAccount);
}

// accountOptions 下拉选项：昵称、微信号和不在线时的连接状态。
function accountOptions(shown) {
  if (!shown.length)
    return [el("option", app.state.accounts.length ? "没有匹配的微信号" : "还没有账号，先连接手机")];
  return shown.map((a) => {
    const option = el("option", accountLabel(a.wechat_id) + (a.connection === "在线" ? "" : " · " + a.connection));
    option.value = a.wechat_id;
    return option;
  });
}

// selectAccount 切换查看的微信号。
function selectAccount(account) {
  selectedAccount = account;
  storage.set("account", account);
  $("account-menu").open = false;
  document.dispatchEvent(new CustomEvent("account-change"));
}

// ---------- 执行设备 ----------

// renderDevicePicker 执行设备菜单：自动选择，或指定一台登录着当前微信号的手机。只有一台可用设备时只显示名称。
function renderDevicePicker() {
  const phones = accountPhones(selectedAccount);
  const chosen = chosenDevice();
  const key = JSON.stringify(phones) + chosen;
  if ($("device-options").dataset.key === key) return;
  $("device-options").dataset.key = key;
  const choices = deviceChoices(phones, chosen);
  const single = phones.length === 1 && phones[0].available && (!chosen || chosen === phones[0].id);
  $("device-menu").hidden = single;
  $("single-device").hidden = !single;
  $("single-device").textContent = single ? phoneName(phones[0]) : "";
  $("device-trigger").textContent = choices.find((c) => c.id === chosen)?.label || "自动选择";
  $("device-options").replaceChildren(...choices.map((c) => deviceOption(c, chosen)));
}

// deviceChoices 可选的执行设备：自动选择、每台手机；指定的手机已移除时也列出来，提醒用户重新选择。
function deviceChoices(phones, chosen) {
  const automatic = leastBusy(phones);
  const choices = [{
    id: "",
    label: "自动选择" + (automatic ? " · " + phoneName(automatic) : " · 无可用设备"),
    title: "自动选择",
    detail: automatic ? "当前使用 " + phoneName(automatic) : "无可用设备",
  }];
  for (const p of phones)
    choices.push({ id: p.id, label: phoneName(p) + " · " + deviceStatus(p), title: phoneName(p) + " · " + (p.device_id || p.id), detail: deviceStatus(p), disabled: !p.available });
  if (chosen && !phones.some((p) => p.id === chosen))
    choices.push({ id: chosen, label: "指定设备已移除", title: "指定设备已移除", detail: "请重新选择", disabled: true });
  return choices;
}

// deviceOption 菜单中的一项，点击后记住选择。
function deviceOption(choice, chosen) {
  const row = el("button", undefined, "device-option");
  row.type = "button";
  row.disabled = !!choice.disabled;
  row.classList.toggle("selected", choice.id === chosen);
  row.setAttribute("aria-pressed", String(choice.id === chosen));
  const copy = el("span", undefined, "grow");
  copy.append(el("strong", choice.title), el("small", choice.detail));
  row.append(icon(choice.id ? "phone" : "check"), copy);
  row.onclick = () => {
    storage.set("device:" + selectedAccount, choice.id);
    $("device-menu").open = false;
    app.render();
  };
  return row;
}

// ---------- 连接状态 ----------

// renderConnection 连接卡片：状态文字和圆点；鼠标悬停显示连接错误、账号识别失败和未就绪原因。
function renderConnection(phone) {
  if (!phone) {
    $("connection").textContent = app.state.phones.length ? "账号未连接" : "未连接手机";
    $("phone-address").textContent = app.state.phones.length ? "没有手机登录这个账号" : "点击添加手机";
    $("status-dot").className = "dot error";
    $("connection-card").title = app.state.error || "手机连接";
    return;
  }
  $("connection").textContent = deviceStatus(phone);
  $("phone-address").textContent = "连接详情";
  $("status-dot").className = "dot" + (phone.available ? " online" : " error");
  $("connection-card").title = connectionTitle(phone);
}

// connectionTitle 连接卡片的悬停说明。
function connectionTitle(phone) {
  let title = app.state.error || phone.error || phone.connection;
  const account = phone.device?.info?.account;
  if (account?.error) title += "\n账号识别失败：" + account.error.message;
  const reasons = phone.device?.info?.reasons || [];
  if (phone.connection !== "在线" && reasons.length) title += "：" + reasons.join("、");
  return title;
}

// renderDeviceNotes 设备不可用时显示原因；可用时只显示需要处理的提醒（例如没开通知使用权）。
function renderDeviceNotes(phone) {
  const notes = phone?.available ? deviceWarnings(phone) : deviceProblems(phone);
  $("device-problem").hidden = !notes.length;
  $("device-problem").textContent = notes.join("；");
}

// renderDiagBadge 诊断入口红点：最近 24 小时内、上次打开诊断页之后新出现的失败任务、降级任务和手机上报的异常。
function renderDiagBadge() {
  const seenAt = Math.max(Number(storage.get("diag-seen-at")) || 0, Date.now() - 86400000);
  const fresh = (time) => new Date(time).getTime() > seenAt;
  const opIssues = app.state.operations.filter(
    (op) => fresh(op.created) && (["failed", "unknown"].includes(op.status) || op.warnings?.length),
  );
  const phoneIssues = app.state.phones.flatMap((p) => p.device?.diagnostics || []).filter((d) => fresh(d.last_at) && !d.task_id);
  const count = opIssues.length + phoneIssues.length;
  $("diag-badge").hidden = !count;
  $("diag-badge").textContent = count > 99 ? "99+" : String(count);
  $("diag-link").title = count ? "执行诊断：" + count + " 条新的异常或降级" : "执行诊断";
}

// ---------- 绑定 ----------

$("account-select").onchange = () => selectAccount($("account-select").value);
$("account-search").oninput = renderAccountPicker;
$("account-online").onchange = renderAccountPicker;
closeMenuOnOutsideClick($("account-menu"), document.querySelector(".account-picker"));
closeMenuOnOutsideClick($("device-menu"), document.querySelector(".device-picker"));
