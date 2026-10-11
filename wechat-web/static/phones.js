// 设备页：已接入的手机、发现与验证码配对、自动发现设置和全局读取模式。
// 搜索设置和读取模式一起编辑，保存前不生效；离开页面时提醒未保存的修改。
import { $, el, button, api, toast, accountLabel, accountName, app } from "./common.js";
import { deviceProblems, deviceStatus, deviceWarnings } from "./device-status.js";
import { registerPage, openDrawer, phoneName, navigate, markDirty, icon } from "./workspace.js";

const MAX_PHONE_NAME = 40; // 设备名称最多的字数，与服务端一致
const CODE_LENGTH = 6; // 配对验证码的位数
const COUNTDOWN_MS = 1000; // 配对倒计时的更新间隔

let systemDirty = false;
let discoveryDraft = null; // 编辑中的搜索设置，保存前不生效

// renderPhoneSettings 设备页随数据刷新重绘。
export function renderPhoneSettings() {
  renderDiscovery();
  renderPhones();
  renderReadingSettings();
}

// openPhoneSettings 进入设备页：草稿恢复为已保存的设置。
function openPhoneSettings() {
  fillDiscoverySettings(app.state.discovery.config);
  setSystemDirty(false);
  renderPhoneSettings();
}

// phoneAction 执行设备上的操作，完成后提示并刷新；失败时显示在设备列表下方。
async function phoneAction(run, done) {
  $("settings-error").textContent = "";
  try {
    await run();
    if (done) toast(done);
    await app.refresh();
  } catch (e) {
    $("settings-error").textContent = e.message;
  }
}

// ---------- 已接入的手机 ----------

// renderPhones 设备表格：名称、当前微信号、状态与任务、查看按钮；按搜索词和状态筛选。内容没变就不重建。
function renderPhones() {
  const query = $("phone-search").value.toLowerCase(),
    filter = $("phone-filter").value;
  const phones = app.state.phones.filter(
    (p) =>
      (phoneName(p) + p.id + p.device_id + accountLabel(p.account)).toLowerCase().includes(query) &&
      (filter === "all" ||
        (filter === "available" && p.available) ||
        (filter === "offline" && !p.available) ||
        (filter === "busy" && p.task_count > 0)),
  );
  const box = $("phone-list"),
    key = JSON.stringify(phones) + query + filter;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(phoneTable(phones));
  if (!phones.length)
    box.append(el("div", app.state.phones.length ? "没有匹配的设备" : "还没有接入设备，点击搜索设备开始连接", "empty-list"));
}

function phoneTable(phones) {
  const table = el("table", undefined, "data-table");
  const head = el("thead"),
    tr = el("tr");
  for (const t of ["设备", "当前微信号", "状态与任务", "操作"]) tr.append(el("th", t));
  head.append(tr);
  const body = el("tbody");
  body.append(...phones.map(phoneRow));
  table.append(head, body);
  return table;
}

function phoneRow(p) {
  const device = el("td"),
    account = el("td"),
    status = el("td"),
    actions = el("td");
  device.append(el("strong", phoneName(p)), el("small", p.device_id || p.id));
  account.append(el("span", accountName(p.account)), el("small", p.account || "账号未识别"));
  status.append(el("span", deviceStatus(p), p.available ? (p.task_count ? "status-warn" : "status-good") : "danger-text"));
  if (!p.available) status.append(el("small", deviceProblems(p).join("；"), "danger-text"));
  actions.append(button("查看", "text-button", () => showPhone(p)));
  const row = el("tr");
  row.append(device, account, status, actions);
  return row;
}

// showPhone 在抽屉中显示设备详情：改名、状态、问题，以及重新识别、查看诊断、撤销授权。
function showPhone(p) {
  const box = el("div");
  box.append(renameRow(p));
  for (const [title, value] of [
    ["状态", deviceStatus(p)],
    ["微信号", accountLabel(p.account)],
    ["设备编号", p.device_id || p.id],
    ["连接地址", p.address || "未连接"],
    ["活动任务", p.task_count || 0],
  ]) {
    const row = el("div", undefined, "detail-line");
    row.append(el("span", title, "muted"), el("strong", String(value)));
    box.append(row);
  }
  for (const problem of deviceProblems(p)) box.append(el("p", problem, "form-error"));
  for (const warning of deviceWarnings(p)) box.append(el("p", warning, "status-warn"));
  box.append(
    button("打开微信并重新识别", "secondary full", () =>
      phoneAction(() => api("phones/" + p.id + "/refresh-account", {}), "已请求打开微信并重新识别，设备将在空闲时执行"),
    ),
    button("查看设备诊断", "secondary full", () => {
      $("workspace-drawer").close();
      app.diagnosticPhone = p.id;
      navigate("diagnostics");
    }),
    button("撤销授权", "text-button danger-text", () => revokePhone(p)),
  );
  openDrawer("当前设备 · " + phoneName(p), box);
}
app.showPhone = showPhone;

// renameRow 设备别名输入框和保存按钮。
function renameRow(p) {
  const name = el("input");
  name.value = p.name || "";
  name.maxLength = MAX_PHONE_NAME;
  name.placeholder = phoneName(p);
  name.setAttribute("aria-label", "设备别名");
  const rename = button("保存名称", "secondary", async () => {
    rename.disabled = true;
    try {
      await api("phones/" + p.id + "/name", { name: name.value });
      await app.refresh();
      toast("设备名称已保存");
    } catch (e) {
      toast(e.message);
    } finally {
      rename.disabled = false;
    }
  });
  const row = el("div", undefined, "toolbar");
  row.append(name, rename);
  return row;
}

// revokePhone 撤销授权：断开连接、删除电脑端凭证，之后连接必须重新双端确认。聊天记录保留。
async function revokePhone(p) {
  if (!confirm("撤销「" + phoneName(p) + "」的授权？聊天记录将保留，之后需要重新配对。")) return;
  try {
    await api("phones/" + p.id + "/delete", {});
    $("workspace-drawer").close();
    await app.refresh();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- 发现与验证码配对 ----------

// renderDiscovery 搜索按钮和状态说明、待配对的手机；没有内容时隐藏“发现与授权”面板。
function renderDiscovery() {
  const searching = !!app.state.discovery?.progress?.searching;
  $("phone-discover").disabled = !app.state.discovery_enabled || searching;
  $("phone-discover").replaceChildren(icon("search"), el("span", searching ? "搜索中…" : "搜索设备"));
  $("discovery-status").textContent = discoveryStatus();
  renderPairings();
  $("nearby-panel").hidden =
    !app.state.pairings?.length && !searching && !app.state.discovery_error && !app.state.discovery?.link_error;
}

// discoveryStatus 搜索状态说明：出错原因、暂停、搜索进度，或最近一次搜索的时间。
function discoveryStatus() {
  const { discovery, discovery_enabled: enabled, pairings } = app.state;
  const progress = discovery?.progress || {};
  if (discovery?.link_error || app.state.discovery_error) return discovery?.link_error || app.state.discovery_error;
  if (!enabled) return "自动搜索已暂停，可在下方“自动发现”中开启。";
  if (progress.searching) return `正在搜索 · 已发送 ${progress.sent} / ${progress.total} 个发现请求`;
  if (pairings?.length) return "已找到手机，请完成下方验证码配对。";
  const last = progress.last_scan ? new Date(progress.last_scan).toLocaleTimeString() : "尚未搜索";
  return `最近搜索 ${last}。手机打开桥接脚本后会主动连接；跨网段请在下方添加搜索范围。`;
}

// renderPairings 待配对的手机：新出现的加卡片、结束的移除，已有卡片只更新状态（保留正在输入的验证码）。
function renderPairings() {
  const box = $("phone-pairings");
  const pending = app.state.pairings || [];
  for (const node of [...box.children]) if (!pending.some((p) => p.id === node.dataset.id)) node.remove();
  for (const p of pending) {
    let card = [...box.children].find((n) => n.dataset.id === p.id);
    if (!card) {
      card = pairingCard(p);
      box.append(card);
    }
    updatePairingCard(card, p);
  }
}

// pairingCard 一个待配对手机的验证码输入卡片。
function pairingCard(p) {
  const card = el("form", undefined, "pairing-card");
  card.dataset.id = p.id;
  const input = el("input", undefined, "pairing-code");
  Object.assign(input, { type: "text", inputMode: "numeric", autocomplete: "one-time-code", maxLength: CODE_LENGTH, pattern: `[0-9]{${CODE_LENGTH}}`, required: true, placeholder: "000000" });
  input.setAttribute("aria-label", "手机验证码");
  input.oninput = () => (input.value = input.value.replace(/[^0-9]/g, "").slice(0, CODE_LENGTH));
  const label = el("label", `输入手机上显示的 ${CODE_LENGTH} 位验证码`, "field");
  label.append(input);
  const checks = el("p", "", "pairing-checks");
  checks.dataset.role = "checks";
  const expires = el("p", "", "muted");
  expires.dataset.role = "expires";
  const error = el("div", "", "form-error");
  error.setAttribute("role", "alert");
  const verify = el("button", "验证并连接", "primary");
  verify.type = "submit";
  const actions = el("div", undefined, "dialog-actions");
  actions.append(button("取消配对", "secondary", () => phoneAction(() => api("pairings/" + p.id + "/cancel", {}))), verify);
  card.append(el("h3", p.name || p.device_id), el("p", p.address), label, checks, expires, error, actions);
  card.onsubmit = async (e) => {
    e.preventDefault();
    verify.disabled = true;
    error.textContent = "";
    try {
      await api("pairings/" + p.id + "/verify", { code: input.value });
      input.value = "";
      await app.refresh();
    } catch (err) {
      error.textContent = err.message;
      verify.disabled = false;
    }
  };
  return card;
}

// updatePairingCard 更新两边的确认状态、剩余时间和尝试次数；网页已验证或已过期时不能再输入。
function updatePairingCard(card, p) {
  const seconds = Math.max(0, Math.ceil((Date.parse(p.expires_at) - Date.now()) / 1000));
  card.querySelector('[data-role="checks"]').textContent =
    (p.web_confirmed ? "✓ 网页已验证" : "○ 等待网页验证") + "　" + (p.phone_confirmed ? "✓ 手机已确认" : "○ 请在手机点击允许");
  card.querySelector('[data-role="expires"]').textContent =
    `剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · 还可尝试 ${p.attempts_left} 次`;
  const closed = p.web_confirmed || seconds === 0;
  card.querySelector("input").disabled = closed;
  card.querySelector('button[type="submit"]').disabled = closed;
}

// ---------- 自动发现设置 ----------

// fillDiscoverySettings 用已保存的设置填表单和网段草稿。
function fillDiscoverySettings(config) {
  discoveryDraft = structuredClone(config);
  $("discovery-enabled").checked = discoveryDraft.enabled;
  $("discovery-local").checked = discoveryDraft.local_broadcast;
  $("discovery-interval").value = String(discoveryDraft.interval_seconds);
  $("discovery-form-error").textContent = "";
  renderNetworkRanges();
}

// readDiscoveryDraft 表单当前的搜索设置。
function readDiscoveryDraft() {
  return {
    enabled: $("discovery-enabled").checked,
    local_broadcast: $("discovery-local").checked,
    interval_seconds: Number($("discovery-interval").value),
    networks: discoveryDraft.networks,
  };
}

// lastAddress 网段的最后一个地址，例如 192.168.1.0/24 → 192.168.1.255。
function lastAddress(address, size) {
  const end = address.split(".").reduce((sum, n) => sum * 256 + Number(n), 0) + size - 1;
  return [24, 16, 8, 0].map((shift) => (end >>> shift) & 255).join(".");
}

// renderNetworkRanges 跨网段搜索范围列表和地址总数。
function renderNetworkRanges() {
  let count = 0;
  const rows = discoveryDraft.networks.map((network) => {
    const [address, prefix] = network.split("/");
    const size = 2 ** (32 - Number(prefix));
    count += size;
    return networkRow(network, address, size);
  });
  $("network-list").replaceChildren(...rows);
  if (!rows.length) $("network-list").append(el("p", "尚未添加跨网段范围", "muted"));
  $("network-count").textContent = `${count.toLocaleString()} / ${app.state.discovery.max_addresses.toLocaleString()} 个地址`;
  $("network-budget").value = count;
}

function networkRow(network, address, size) {
  const copy = el("span", network);
  copy.append(el("small", `${address} ～ ${lastAddress(address, size)} · ${size.toLocaleString()} 个地址`));
  const remove = button("移除", "text-button", () => {
    discoveryDraft.networks = discoveryDraft.networks.filter((n) => n !== network);
    renderNetworkRanges();
    setSystemDirty(true);
  });
  remove.setAttribute("aria-label", "移除网段 " + network);
  const row = el("div", undefined, "network-range");
  row.append(copy, remove);
  return row;
}

// addNetwork 添加网段：先让服务端校验（私有地址、大小、重叠），通过后才加入草稿。
async function addNetwork() {
  const raw = $("network-address").value.trim();
  if (!raw) return $("network-address").focus();
  const network = raw.includes("/") ? raw : raw + "/" + $("network-prefix").value;
  $("network-add").disabled = true;
  try {
    const preview = await api("discovery/preview", { ...readDiscoveryDraft(), networks: [...discoveryDraft.networks, network] });
    discoveryDraft.networks = preview.config.networks;
    setSystemDirty(true);
    $("network-address").value = "";
    $("discovery-form-error").textContent = "";
    renderNetworkRanges();
  } catch (e) {
    $("discovery-form-error").textContent = e.message;
  } finally {
    $("network-add").disabled = false;
  }
}

// saveSystemSettings 一起保存搜索设置和读取模式。
async function saveSystemSettings() {
  $("discovery-save").disabled = true;
  try {
    if ($("network-address").value.trim()) throw Error("请先点击“添加”，将网段加入搜索范围。");
    const saved = await api("system-settings", { discovery: readDiscoveryDraft(), read_history: $("read-history").checked });
    setSystemDirty(false);
    fillDiscoverySettings(saved.config);
    await app.refresh();
    toast("设备设置已保存");
  } catch (error) {
    $("discovery-form-error").textContent = error.message;
  } finally {
    $("discovery-save").disabled = !systemDirty;
  }
}

// ---------- 读取模式与保存状态 ----------

// renderReadingSettings 读取模式开关；有未保存的修改时不按服务端数据重绘。
function renderReadingSettings() {
  if (systemDirty || !app.state) return;
  const enabled = app.state.read_history !== false;
  $("read-history").checked = enabled;
  $("reading-hint").textContent = enabled ? "开启：读取最近消息，可翻页。" : "关闭：只收新增消息，仅在需要时翻回上次读到的位置。";
}

// setSystemDirty 有未保存的修改时显示保存和放弃按钮，离开页面前提醒。
function setSystemDirty(value) {
  systemDirty = value;
  markDirty("discovery", value);
  $("discovery-save").disabled = $("discovery-save").hidden = !value;
  $("system-discard").hidden = !value;
  $("system-save-state").textContent = value ? "未保存的修改" : "已保存";
}

// discardSystemSettings 放弃修改，恢复已保存的设置。
function discardSystemSettings() {
  systemDirty = false;
  fillDiscoverySettings(app.state.discovery.config);
  renderReadingSettings();
  setSystemDirty(false);
}

// ---------- 绑定 ----------

registerPage("system", openPhoneSettings);
$("connection-card").onclick = () => (app.currentPhone ? showPhone(app.currentPhone) : navigate("system"));
$("phone-search").oninput = renderPhones;
$("phone-filter").onchange = renderPhones;
$("phone-discover").onclick = async () => {
  $("phone-discover").disabled = true;
  await phoneAction(() => api("phones/discover", {}), "正在搜索附近的手机");
};
$("network-add").onclick = addNetwork;
$("network-address").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  addNetwork();
};
$("discovery-form").onsubmit = (e) => {
  e.preventDefault();
  saveSystemSettings();
};
$("discovery-form").addEventListener("input", () => setSystemDirty(true));
$("read-history").onchange = () => setSystemDirty(true);
$("system-discard").onclick = discardSystemSettings;
// 配对倒计时每秒更新
setInterval(() => {
  if (app.state && app.page === "system") renderPairings();
}, COUNTDOWN_MS);
