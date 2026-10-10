import { deviceProblems, deviceStatus } from "./device-status.js";
// “手机连接”对话框：局域网搜索设置、验证码配对、已连接的手机、手动添加或修改，以及全局读取模式。
import {
  $,
  el,
  button,
  api,
  toast,
  hostOf,
  accountLabel,
  accountName,
  app,
} from "./common.js";

import {
  registerPage,
  openDrawer,
  phoneName,
  navigate,
  markDirty,
  icon,
} from "./workspace.js";

let editingPhone = null; // 正在修改的手机编号；null 表示添加新手机
let pairingDevice = null; // 首次连接已发现的手机，地址自动填写
let systemDirty = false;
let discoveryDraft = null; // 编辑中的搜索设置，保存前不生效

// renderPhoneSettings 对话框打开时随页面刷新重绘。
export function renderPhoneSettings() {
  renderPhones();
  renderReadingSettings();
}

// openPhoneSettings 打开对话框，并立即搜索一次附近的手机。
function openPhoneSettings() {
  editingPhone = null;
  pairingDevice = null;
  systemDirty = false;
  fillDiscoverySettings(app.state.discovery.config);
  setSystemDirty(false);
  renderPhoneSettings();
  resetPhoneForm();
}
registerPage("system", openPhoneSettings);
$("settings").onclick = () => navigate("system");
$("connection-card").onclick = () =>
  app.currentPhone ? showPhone(app.currentPhone) : navigate("system");
$("phone-search").oninput = renderPhones;
$("phone-filter").onchange = renderPhones;

// phoneAction 执行手机列表上的操作，完成后刷新；失败时显示在对话框里。
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

// ---------- 搜索范围与频率 ----------

function fillDiscoverySettings(config) {
  discoveryDraft = structuredClone(config);
  $("discovery-enabled").checked = discoveryDraft.enabled;
  $("discovery-local").checked = discoveryDraft.local_broadcast;
  $("discovery-interval").value = String(discoveryDraft.interval_seconds);
  $("discovery-form-error").textContent = "";
  renderNetworkRanges();
}

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
  const end =
    address.split(".").reduce((sum, n) => sum * 256 + Number(n), 0) + size - 1;
  return [24, 16, 8, 0].map((shift) => (end >>> shift) & 255).join(".");
}

// renderNetworkRanges 跨网段搜索范围列表和地址总数。
function renderNetworkRanges() {
  const box = $("network-list");
  box.replaceChildren();
  let count = 0;
  for (const network of discoveryDraft.networks) {
    const [address, prefix] = network.split("/");
    const size = 2 ** (32 - Number(prefix));
    count += size;
    const copy = el("span", network);
    copy.append(
      el(
        "small",
        `${address} ～ ${lastAddress(address, size)} · ${size.toLocaleString()} 个地址`,
      ),
    );
    const remove = button("移除", "text-button", () => {
      discoveryDraft.networks = discoveryDraft.networks.filter(
        (n) => n !== network,
      );
      renderNetworkRanges();
      setSystemDirty(true);
    });
    remove.setAttribute("aria-label", "移除网段 " + network);
    const row = el("div", undefined, "network-range");
    row.append(copy, remove);
    box.append(row);
  }
  if (!discoveryDraft.networks.length)
    box.append(el("p", "尚未添加跨网段范围", "muted"));
  $("network-count").textContent = `${count.toLocaleString()} / 4,096 个地址`;
  $("network-budget").value = count;
}

// 添加网段：先让服务端校验（私有地址、大小、重叠），通过后才加入草稿
$("network-add").onclick = async () => {
  const raw = $("network-address").value.trim();
  if (!raw) {
    $("network-address").focus();
    return;
  }
  const network = raw.includes("/")
    ? raw
    : raw + "/" + $("network-prefix").value;
  $("network-add").disabled = true;
  try {
    const preview = await api("discovery?preview=1", {
      ...readDiscoveryDraft(),
      networks: [...discoveryDraft.networks, network],
    });
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
};
$("network-address").onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("network-add").click();
  }
};
$("discovery-form").onsubmit = async (e) => {
  e.preventDefault();
  $("discovery-save").disabled = true;
  try {
    if ($("network-address").value.trim())
      throw Error("请先点击“添加”，将网段加入搜索范围。");
    const saved = await api("system-settings", {
      discovery: readDiscoveryDraft(),
      read_history: $("read-history").checked,
    });
    setSystemDirty(false);
    fillDiscoverySettings(saved.config);
    await app.refresh();
    toast("设备设置已保存");
  } catch (error) {
    $("discovery-form-error").textContent = error.message;
  } finally {
    $("discovery-save").disabled = !systemDirty;
  }
};

// ---------- 搜索到的手机与验证码配对 ----------

$("phone-discover").onclick = async () => {
  $("phone-discover").disabled = true;
  await phoneAction(() => api("phones/discover", {}), "正在搜索附近的手机");
  $("phone-discover").disabled = !app.state.discovery_enabled;
};

// discoveryStatus 搜索状态说明：出错原因、暂停、搜索进度，或最近一次搜索的时间。
function discoveryStatus() {
  const { discovery, discovery_enabled: enabled, pairings } = app.state;
  const progress = discovery?.progress || {};
  if (discovery?.link_error || app.state.discovery_error)
    return discovery?.link_error || app.state.discovery_error;
  if (!enabled) return "自动搜索已暂停。可在“搜索范围与频率”中开启。";
  if (progress.searching)
    return `正在搜索 · 已发送 ${progress.sent} / ${progress.total} 个发现请求`;
  if (pairings?.length) return "已找到手机，请完成下方验证码配对。";
  const last = progress.last_scan
    ? new Date(progress.last_scan).toLocaleTimeString()
    : "尚未搜索";
  return `最近搜索 ${last}。手机打开桥接脚本后会主动连接；跨网段请在上方添加搜索范围。`;
}

// renderDiscoveredPhones 搜索状态、待配对的手机，以及搜索到但还没连接的手机。
function renderDiscoveredPhones() {
  const settings = app.state.discovery?.config;
  const searching = !!app.state.discovery?.progress?.searching;
  $("phone-discover").disabled = !app.state.discovery_enabled || searching;
  $("phone-discover").replaceChildren(
    icon("search"),
    el("span", searching ? "搜索中…" : "搜索设备"),
  );
  $("discovery-summary").textContent = settings
    ? `${settings.enabled ? "每 " + settings.interval_seconds + " 秒" : "已暂停"} · ${settings.local_broadcast ? "本地网络" : "仅指定网段"} · ${settings.networks.length} 个跨网段范围`
    : "";
  $("discovery-status").textContent = discoveryStatus();
  renderPairings();
  const nearby = (app.state.discovered_phones || []).filter((d) => !d.phone_id);
  $("nearby-panel").hidden =
    !nearby.length &&
    !app.state.pairings?.length &&
    !searching &&
    !app.state.discovery_error &&
    !app.state.discovery?.link_error;
  const box = $("discovered-phones");
  // 内容没变就不重建，避免刷新时点击落空
  const key = JSON.stringify(nearby);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren();
  for (const d of nearby) {
    const copy = el("div", undefined, "phone-copy");
    copy.append(
      el("strong", "手机 " + d.device_id),
      el("small", hostOf(d.phone_url)),
    );
    const connect = button("连接", "text-button", () => {
      editingPhone = null;
      pairingDevice = d;
      $("manual-phone").open = true;
      resetPhoneForm();
      $("phone-token").focus();
    });
    const row = el("div", undefined, "phone-row");
    row.append(copy, connect);
    box.append(row);
  }
}

// pairingCard 一个待配对手机的验证码输入卡片；状态文字由 renderPairings 每秒更新。
function pairingCard(p) {
  const card = el("form", undefined, "pairing-card");
  card.dataset.id = p.id;
  const input = el("input", undefined, "pairing-code");
  Object.assign(input, {
    type: "text",
    inputMode: "numeric",
    autocomplete: "one-time-code",
    maxLength: 6,
    pattern: "[0-9]{6}",
    required: true,
    placeholder: "000000",
  });
  input.setAttribute("aria-label", "手机验证码");
  input.oninput = () =>
    (input.value = input.value.replace(/[^0-9]/g, "").slice(0, 6));
  const label = el("label", "输入手机上显示的 6 位验证码", "field");
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
  actions.append(
    button("取消配对", "secondary", () =>
      phoneAction(() => api("pairings/" + p.id + "/cancel", {})),
    ),
    verify,
  );
  card.append(
    el("h3", p.name || p.device_id),
    el("p", hostOf(p.phone_url)),
    label,
    checks,
    expires,
    error,
    actions,
  );
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

// renderPairings 待配对的手机：新出现的加卡片、结束的移除，已有卡片只更新状态（保留正在输入的验证码）。
function renderPairings() {
  const box = $("phone-pairings");
  const pending = app.state.pairings || [];
  for (const node of [...box.children])
    if (!pending.some((p) => p.id === node.dataset.id)) node.remove();
  for (const p of pending) {
    let card = [...box.children].find((n) => n.dataset.id === p.id);
    if (!card) {
      card = pairingCard(p);
      box.append(card);
    }
    const seconds = Math.max(
      0,
      Math.ceil((Date.parse(p.expires_at) - Date.now()) / 1000),
    );
    card.querySelector('[data-role="checks"]').textContent =
      (p.web_confirmed ? "✓ 网页已验证" : "○ 等待网页验证") +
      "　" +
      (p.phone_confirmed ? "✓ 手机已确认" : "○ 请在手机点击允许");
    card.querySelector('[data-role="expires"]').textContent =
      `剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · 还可尝试 ${p.attempts_left} 次`;
    const closed = p.web_confirmed || seconds === 0;
    card.querySelector("input").disabled = closed;
    card.querySelector('button[type="submit"]').disabled = closed;
  }
}
// 配对倒计时每秒更新
setInterval(() => {
  if (app.state && app.page === "system") renderPairings();
}, 1000);

// ---------- 已连接的手机 ----------

// phoneDot 连接状态圆点：在线绿色，失败或离线红色，其他（连接中等）灰色。
function phoneDot(connection) {
  return el(
    "span",
    undefined,
    "dot" +
      (connection === "在线"
        ? " online"
        : /失败|离线/.test(connection)
          ? " error"
          : ""),
  );
}

// renderPhones 手机列表：地址、登录的微信号、连接状态，以及重新识别账号、修改、删除。
function renderPhones() {
  renderDiscoveredPhones();
  const query = $("phone-search").value.toLowerCase(),
    filter = $("phone-filter").value;
  const phones = app.state.phones.filter(
    (p) =>
      (phoneName(p) + p.id + p.device_id + accountLabel(p.account))
        .toLowerCase()
        .includes(query) &&
      (filter === "all" ||
        (filter === "available" && p.available) ||
        (filter === "offline" && !p.available) ||
        (filter === "busy" && p.task_count > 0)),
  );
  const box = $("phone-list"),
    key = JSON.stringify(phones) + query + filter;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const table = el("table", undefined, "data-table");
  const head = el("thead"),
    tr = el("tr");
  for (const t of ["设备", "当前微信号", "状态与任务", "连接方式", "操作"])
    tr.append(el("th", t));
  head.append(tr);
  table.append(head);
  const body = el("tbody");
  for (const p of phones) {
    const row = el("tr"),
      device = el("td"),
      account = el("td"),
      status = el("td"),
      actions = el("td");
    device.append(el("strong", phoneName(p)), el("small", p.device_id || p.id));
    account.append(
      el("span", accountName(p.account)),
      el("small", p.account || "账号未识别"),
    );
    status.append(
      el(
        "span",
        deviceStatus(p),
        p.available
          ? p.task_count
            ? "status-warn"
            : "status-good"
          : "danger-text",
      ),
    );
    if (!p.available)
      status.append(el("small", deviceProblems(p).join("；"), "danger-text"));
    actions.append(button("查看", "text-button", () => showPhone(p)));
    row.append(
      device,
      account,
      status,
      el("td", p.transport === "reverse" ? "加密连接" : "手动连接"),
      actions,
    );
    body.append(row);
  }
  table.append(body);
  box.replaceChildren(table);
  if (!phones.length)
    box.append(
      el(
        "div",
        app.state.phones.length
          ? "没有匹配的设备"
          : "还没有接入设备，点击搜索设备开始连接",
        "empty-list",
      ),
    );
}
app.showPhone = showPhone;
function showPhone(p) {
  const box = el("div");
  const name = el("input");
  name.value = p.name || "";
  name.maxLength = 40;
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
  const nameRow = el("div", undefined, "toolbar");
  nameRow.append(name, rename);
  box.append(nameRow);
  for (const [title, value] of [
    ["状态", deviceStatus(p)],
    ["微信号", accountLabel(p.account)],
    ["设备编号", p.device_id || p.id],
    ["连接地址", hostOf(p.phone_url)],
    ["连接方式", p.transport === "reverse" ? "已授权 · 加密连接" : "手动连接"],
    ["活动任务", p.task_count || 0],
  ]) {
    const row = el("div", undefined, "detail-line");
    row.append(el("span", title, "muted"), el("strong", String(value)));
    box.append(row);
  }
  for (const problem of deviceProblems(p))
    box.append(el("p", problem, "form-error"));
  box.append(
    button("打开微信并重新识别", "secondary full", () =>
      phoneAction(
        () => api("phones/" + p.id + "/refresh-account", {}),
        "已请求打开微信并重新识别，设备将在空闲时执行",
      ),
    ),
    button("查看设备诊断", "secondary full", () => {
      $("workspace-drawer").close();
      app.diagnosticPhone = p.id;
      navigate("diagnostics");
    }),
  );
  if (p.transport !== "reverse")
    box.append(
      button("修改连接", "secondary full", () => {
        $("workspace-drawer").close();
        navigate("system");
        editingPhone = p.id;
        pairingDevice = null;
        $("manual-phone").open = true;
        resetPhoneForm();
        $("manual-phone").scrollIntoView({ block: "center" });
      }),
    );
  box.append(
    button(
      p.transport === "reverse" ? "撤销授权" : "删除连接",
      "text-button danger-text",
      async () => {
        if (!confirm("移除「" + phoneName(p) + "」的连接？聊天记录将保留。"))
          return;
        try {
          await api("phones/" + p.id + "/delete", {});
          $("workspace-drawer").close();
          await app.refresh();
        } catch (e) {
          toast(e.message);
        }
      },
    ),
  );
  openDrawer("当前设备 · " + phoneName(p), box);
}

// ---------- 手动添加、修改，或用 Token 连接搜索到的手机 ----------

// resetPhoneForm 表单切换为添加、修改或连接；Token 不回显，修改时留空表示保留原值。
function resetPhoneForm() {
  const phone = app.state.phones.find((p) => p.id === editingPhone);
  $("phone-form-title").textContent = phone
    ? "修改手机 " + hostOf(phone.phone_url)
    : pairingDevice
      ? "连接手机 " + pairingDevice.device_id
      : "手动添加手机";
  $("phone-url").value = phone
    ? phone.phone_url
    : pairingDevice?.phone_url || "";
  $("phone-url").readOnly = !!pairingDevice;
  $("phone-save").textContent = pairingDevice ? "连接" : "保存";
  $("phone-token").value = "";
  $("phone-token").placeholder = phone
    ? "已保存，留空保留原值"
    : "手机 config.json 中的 phone_api_token";
  $("phone-token").required = !phone;
  $("phone-cancel-edit").hidden = !phone && !pairingDevice;
  $("settings-error").textContent = "";
}
$("phone-cancel-edit").onclick = () => {
  editingPhone = null;
  pairingDevice = null;
  resetPhoneForm();
};

// 保存手机：添加、修改或连接，保存后留在对话框里查看连接状态。
$("settings-form").onsubmit = async (e) => {
  e.preventDefault();
  e.submitter.disabled = true;
  const body = {
    phone_url: $("phone-url").value,
    token: $("phone-token").value,
  };
  if (pairingDevice) body.device_id = pairingDevice.device_id;
  const path = editingPhone
    ? "phones/" + editingPhone
    : pairingDevice
      ? "phones/pair"
      : "phones";
  await phoneAction(
    () => api(path, body),
    editingPhone ? "已保存修改" : "已添加手机，等待连接",
  );
  if (!$("settings-error").textContent) {
    editingPhone = null;
    pairingDevice = null;
    resetPhoneForm();
  }
  e.submitter.disabled = false;
};

// ---------- 全局读取模式 ----------

let readingSaving = false; // 保存期间不按旧数据重绘开关

function renderReadingSettings() {
  if (readingSaving || systemDirty || !app.state) return;
  const enabled = app.state.read_history !== false;
  $("read-history").checked = enabled;
  $("reading-hint").textContent = enabled
    ? "开启：读取最近消息，可翻页。"
    : "关闭：只收新增消息，仅在需要时翻回上次读到的位置。";
}

// 切换读取模式：请求完成后再确认开关状态，保存失败恢复原值。
$("read-history").onchange = () => setSystemDirty(true);
function setSystemDirty(value) {
  systemDirty = value;
  markDirty("discovery", value);
  $("discovery-save").disabled = !value;
  $("discovery-save").hidden = !value;
  $("system-discard").hidden = !value;
  $("system-save-state").textContent = value ? "未保存的修改" : "已保存";
}
$("discovery-form").addEventListener("input", () => setSystemDirty(true));
document.addEventListener("system-discard", () => {
  systemDirty = false;
  fillDiscoverySettings(app.state.discovery.config);
  renderReadingSettings();
  setSystemDirty(false);
});
