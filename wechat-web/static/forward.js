// 转发页：规则列表（启用开关、编辑、删除），以及右侧的规则编辑框。
// 编辑框里的选择即时更新草稿，保存后生效；规则逐条保存。
import { $, el, button, api, toast, app, accountLabel, accountName, KINDS } from "./common.js";
import { registerPage, phoneName, markDirty, closeOnOutsideClick } from "./workspace.js";
import { deviceStatus, deviceProblems } from "./device-status.js";

const editor = $("forward-editor");
const discard = $("forward-discard");
// 与服务端一致的规则上限
const MAX_NAME = 40; // 规则名称最多的字数
const MAX_FILTER_ITEMS = 100; // 发送人、包含词、排除词各自的上限
const MAX_DEDUP_MINUTES = 1440; // 去重时间最长一天
const MAX_TEMPLATE = 200; // 转发格式最多的字数
const DEFAULT_DEDUP_MINUTES = 30; // 新规则默认的去重时间
const SHOWN_ROUTES = 3; // 已选会话超过这么多时折叠
const SAMPLE = { text: "客户需要售后帮助，请尽快联系。", sender: "王宁", chat: "客户服务群" }; // 格式预览的示例

let rules = []; // 已保存的规则
let draft = null; // 编辑中的规则
let saving = false;
let baseline = ""; // 打开编辑框时规则的签名，用来判断有没有修改
let includeWords = []; // 编辑中的包含关键词
let openPicker = null; // 展开的会话选择：sources | targets
let healthKey = ""; // 会话和设备的快照，变了才重绘编辑框里的设备状态
const expanded = { sources: false, targets: false }; // 已选会话折叠时是否展开

const conversations = () => app.state?.conversations || [];
const phones = () => app.state?.phones || [];
const conv = (id) => conversations().find((c) => c.id === id);

// listWords 把文字或文字列表按逗号、顿号、换行拆开，去空白、去重。
function listWords(value) {
  const items = (Array.isArray(value) ? value : [value || ""]).flatMap((s) => s.split(/[,，、\n]/)).map((s) => s.trim());
  return [...new Set(items.filter(Boolean))];
}

// convLabel 会话的显示名称：微信号 · 会话名。
function convLabel(id, detailed = true) {
  const c = conv(id);
  return c ? (detailed ? accountLabel(c.account) : accountName(c.account)) + " · " + c.title : "已删除的会话";
}

// ---------- 规则列表 ----------

// load 读取规则并重绘列表。
async function load() {
  try {
    rules = (await api("forward")).rules;
    renderRules();
    $("forward-error").textContent = "";
  } catch (e) {
    $("forward-error").textContent = e.message;
  }
}

// renderRules 规则表格：名称和最近的问题、来源、目标和设备策略、启用开关、编辑与删除。
function renderRules() {
  const table = el("table", undefined, "data-table");
  const head = el("thead"),
    h = el("tr");
  for (const t of ["规则", "来源", "目标", "状态", "操作"]) h.append(el("th", t));
  head.append(h);
  const body = el("tbody");
  body.append(...rules.map(ruleRow));
  table.append(head, body);
  $("forward-rules").replaceChildren(table);
  if (!rules.length) $("forward-rules").append(el("div", "暂无转发规则，点击“添加规则”开始配置", "empty-list"));
}

function ruleRow(rule) {
  const name = el("td"),
    source = el("td"),
    target = el("td"),
    state = el("td"),
    actions = el("td");
  name.append(el("strong", rule.name || "未命名规则"));
  if (rule.problem) name.append(el("small", rule.problem, "danger-text"));
  source.textContent = rule.sources.map((id) => convLabel(id, false)).join("、");
  target.textContent = rule.targets.map((id) => convLabel(id, false)).join("、");
  target.append(el("small", Object.values(rule.target_phones || {}).some(Boolean) ? "含指定执行设备" : "自动选择设备"));
  state.append(enableSwitch(rule));
  const more = el("details", undefined, "row-menu");
  more.setAttribute("aria-label", "更多操作");
  more.append(el("summary", "···"), button("删除", "text-button danger-text", () => deleteRule(rule)));
  actions.append(button("编辑", "text-button", () => edit(rule)), more);
  const tr = el("tr");
  tr.append(name, source, target, state, actions);
  return tr;
}

// enableSwitch 启用开关：切换后立即保存，失败时恢复。
function enableSwitch(rule) {
  const toggle = el("input");
  toggle.type = "checkbox";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", "启用 " + (rule.name || "规则"));
  toggle.checked = rule.enabled;
  toggle.onchange = async () => {
    toggle.disabled = true;
    try {
      await api("forward/rule", { ...rule, enabled: toggle.checked });
      await load();
    } catch (e) {
      toggle.checked = rule.enabled;
      toast(e.message);
    } finally {
      toggle.disabled = false;
    }
  };
  return toggle;
}

async function deleteRule(rule) {
  if (!confirm("删除规则「" + (rule.name || "未命名规则") + "」？")) return;
  try {
    await api("forward/" + rule.id + "/delete", {});
    await load();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- 编辑框：草稿 ----------

// edit 打开编辑框；rule 为 null 时新建。
function edit(rule) {
  draft = structuredClone(rule || { enabled: true, sources: [], targets: [], dedup_minutes: DEFAULT_DEDUP_MINUTES });
  draft.sources ||= [];
  draft.targets ||= [];
  draft.target_phones ||= {};
  fillEditor(rule);
  baseline = signature(currentRule());
  healthKey = "";
  renderTags();
  renderSelected("sources");
  renderSelected("targets");
  updateFeedback();
  editor.showModal();
  $("f-body").scrollTop = 0;
}

// fillEditor 用草稿填编辑框的输入项。
function fillEditor(rule) {
  expanded.sources = expanded.targets = false;
  closePicker();
  $("forward-editor-title").textContent = rule ? "编辑转发规则" : "添加转发规则";
  for (const key of ["name", "exclude", "senders", "regex", "template"])
    $("f-" + key).value = Array.isArray(draft[key]) ? listWords(draft[key]).join("，") : draft[key] || "";
  $("f-dedup").value = draft.dedup_minutes || 0;
  $("f-enabled").checked = !!draft.enabled;
  $("f-images").checked = !!draft.images;
  includeWords = listWords(draft.include || []);
  $("f-include").value = "";
  editor.querySelector(`[name="f-format"][value="${draft.template ? "custom" : "original"}"]`).checked = true;
  $("f-advanced").open = false;
  $("f-error").textContent = "";
  for (const kind of ["sources", "targets"]) {
    $("f-" + kind + "-error").hidden = true;
    editor.querySelector(`[data-search="${kind}"]`).value = "";
  }
}

function customFormat() {
  return editor.querySelector('[name="f-format"]:checked').value === "custom";
}

// currentRule 编辑框当前的规则（还没提交的关键词输入也算上）。
function currentRule() {
  return {
    id: draft.id || "",
    name: $("f-name").value.trim(),
    enabled: $("f-enabled").checked,
    sources: [...draft.sources],
    targets: [...draft.targets],
    target_phones: Object.fromEntries(draft.targets.filter((id) => draft.target_phones[id]).map((id) => [id, draft.target_phones[id]])),
    include: listWords([...includeWords, $("f-include").value]),
    exclude: listWords($("f-exclude").value),
    senders: listWords($("f-senders").value),
    regex: $("f-regex").value.trim(),
    dedup_minutes: Number($("f-dedup").value),
    images: $("f-images").checked,
    template: customFormat() ? $("f-template").value.trim() : "",
  };
}

// signature 规则的签名：会话顺序不同视为相同。
function signature(rule) {
  return JSON.stringify({
    ...rule,
    sources: [...rule.sources].sort(),
    targets: [...rule.targets].sort(),
    target_phones: Object.fromEntries(Object.entries(rule.target_phones).sort()),
  });
}

// updateFeedback 按草稿更新保存状态、按钮、提示和底部摘要。
function updateFeedback() {
  const rule = currentRule(),
    changed = signature(rule) !== baseline;
  markDirty("forward", changed);
  $("forward-form").dataset.changed = String(changed);
  $("f-dirty").textContent = saving ? "正在保存…" : changed ? "未保存的修改" : "已保存";
  $("f-save").disabled = saving || (!changed && !!draft.id);
  $("f-save").textContent = saving ? "保存中…" : "保存规则";
  $("forward-close").disabled = $("f-cancel").disabled = saving;
  $("f-body").inert = saving;
  $("f-image-note").hidden = !rule.images;
  $("f-keyword-note").textContent = rule.include.length
    ? "命中任意一个关键词即满足；其他已配置条件仍同时生效。"
    : "不限制包含关键词；排除词、发送人、正则等条件仍同时生效。";
  $("f-summary").textContent = $("f-summary").title = ruleSummary(rule);
  $("f-advanced-summary").textContent = advancedSummary(rule) + "　⌄";
  $("f-custom-format").hidden = !customFormat();
  $("f-format-preview").textContent = $("f-template").value.replace(/\{(text|sender|chat)\}/g, (_, key) => SAMPLE[key]);
}

function ruleSummary(rule) {
  return (
    `${rule.sources.length} 个来源 → ${rule.targets.length} 个目标 · ` +
    (rule.include.length ? "包含任一：" + rule.include.join("、") : "不限包含关键词") +
    " · " + (rule.images ? "文字及图片" : "仅文字") + (rule.enabled ? "" : " · 已停用")
  );
}

function advancedSummary(rule) {
  return [
    rule.exclude.length ? "排除词" : "",
    rule.senders.length ? "发送人" : "",
    rule.regex ? "正则" : "",
    rule.template ? "自定义格式" : "",
    rule.dedup_minutes ? `去重 ${rule.dedup_minutes} 分钟` : "不去重",
  ].filter(Boolean).join(" · ");
}

// ---------- 编辑框：关键词 ----------

// renderTags 包含关键词标签，点 × 移除。
function renderTags() {
  $("f-tags").replaceChildren(
    ...includeWords.map((word, index) => {
      const chip = el("span", undefined, "forward-tag");
      const remove = button("×", "", () => {
        includeWords.splice(index, 1);
        renderTags();
        updateFeedback();
      });
      remove.setAttribute("aria-label", "移除关键词 " + word);
      chip.append(el("span", word), remove);
      return chip;
    }),
  );
}

// commitKeywords 把输入框里的关键词加入标签。
function commitKeywords() {
  includeWords = listWords([...includeWords, $("f-include").value]);
  $("f-include").value = "";
  renderTags();
  updateFeedback();
}

// ---------- 编辑框：选择会话 ----------

function closePicker(focus = false) {
  if (!openPicker) return;
  const trigger = editor.querySelector(`[data-picker="${openPicker}"]`);
  $("f-" + openPicker + "-picker").hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  openPicker = null;
  if (focus) trigger.focus();
}

// showPicker 展开来源或目标的会话选择（再点一次收起），按微信号分组列出会话。
function showPicker(kind) {
  if (openPicker === kind) return closePicker(true);
  closePicker();
  closePolicies();
  openPicker = kind;
  fillAccountFilter(kind);
  $("f-" + kind + "-picker").hidden = false;
  editor.querySelector(`[data-picker="${kind}"]`).setAttribute("aria-expanded", "true");
  renderChoices(kind);
  editor.querySelector(`[data-search="${kind}"]`).focus();
}

// fillAccountFilter 会话选择的微信号筛选，保留之前的选择。
function fillAccountFilter(kind) {
  const select = editor.querySelector(`[data-account="${kind}"]`),
    previous = select.value || "all";
  select.replaceChildren(new Option("全部微信号", "all"));
  for (const account of new Set(conversations().map((c) => c.account))) select.append(new Option(accountLabel(account), account));
  select.value = [...select.options].some((o) => o.value === previous) ? previous : "all";
}

// renderChoices 可选的会话：已是另一边的会话、类型未识别的目标不可选（已选的仍能取消）。保留滚动位置。
function renderChoices(kind) {
  const box = $("f-" + kind + "-choices"),
    top = box.scrollTop;
  const query = editor.querySelector(`[data-search="${kind}"]`).value.toLowerCase();
  const account = editor.querySelector(`[data-account="${kind}"]`).value;
  const groups = new Map();
  for (const c of conversations()) {
    if (account !== "all" && c.account !== account) continue;
    if (!(c.title + " " + accountLabel(c.account)).toLowerCase().includes(query)) continue;
    if (!groups.has(c.account)) groups.set(c.account, []);
    groups.get(c.account).push(c);
  }
  box.replaceChildren();
  for (const [groupAccount, items] of groups) {
    box.append(el("div", accountLabel(groupAccount), "forward-account-heading"));
    for (const c of items) box.append(choiceRow(kind, c));
  }
  if (!groups.size) box.append(el("p", conversations().length ? "没有匹配的会话，试试其他关键词或微信号。" : "请先在消息台添加会话", "muted"));
  box.scrollTop = top;
}

function choiceRow(kind, c) {
  const other = kind === "sources" ? "targets" : "sources";
  const selected = draft[kind].includes(c.id),
    conflict = draft[other].includes(c.id),
    unknown = kind === "targets" && (!c.kind || c.kind === "unknown");
  const row = el("label", undefined, "forward-choice"),
    input = el("input");
  input.type = "checkbox";
  input.value = c.id;
  input.checked = selected;
  input.disabled = !selected && (conflict || unknown);
  input.dataset.kind = kind;
  input.dataset.choice = c.id;
  row.classList.toggle("selected", selected);
  row.classList.toggle("unavailable", input.disabled);
  const note = conflict ? (kind === "sources" ? "已是目标" : "已是来源") : unknown ? "请先设置会话类型" : KINDS[c.kind];
  row.append(input, el("span", c.title), el("small", note));
  input.onchange = () => {
    toggleChoice(kind, c.id, input.checked);
    $("f-" + kind + "-choices").querySelector(`input[value="${c.id}"]`)?.focus();
  };
  return row;
}

// toggleChoice 选中或取消一个会话；取消目标时一并去掉它的设备策略。
function toggleChoice(kind, id, checked) {
  draft[kind] = checked ? [...draft[kind], id] : draft[kind].filter((x) => x !== id);
  if (kind === "targets" && !checked) delete draft.target_phones[id];
  $("f-" + kind + "-error").hidden = true;
  renderSelected(kind);
  renderChoices(kind);
  updateFeedback();
}

// ---------- 编辑框：已选会话与设备策略 ----------

// targetHealth 目标会话的执行设备策略和问题：指定设备不可用时跳过，不会换用其他手机。
function targetHealth(id) {
  const c = conv(id),
    requested = draft.target_phones[id];
  if (!c) return { text: "目标会话已删除，请重新选择", error: true };
  if (requested) {
    const p = phones().find((p) => p.id === requested);
    if (!p || p.account !== c.account) return { text: "指定设备已移除或换号，请重新选择", error: true };
    return { policy: phoneName(p) + " · " + deviceStatus(p), text: p.available ? "" : deviceProblems(p).join("；") + "。此目标将跳过，不会自动换用其他手机。" };
  }
  const matching = phones().filter((p) => p.account === c.account),
    available = matching.filter((p) => p.available);
  const text = available.length ? "" : matching.length ? deviceProblems(matching[0]).join("；") + "。此目标暂不可执行。" : "此微信号没有接入设备，此目标将跳过。";
  return { policy: `自动选择 · ${available.length} 台可用`, text };
}

// renderSelected 已选的来源或目标（较多时折叠），目标附带设备策略，来源附带能否读取的提示。
function renderSelected(kind) {
  const box = $("f-" + kind),
    ids = draft[kind];
  box.tabIndex = -1;
  const openedPolicy = box.querySelector(".forward-policy[open]")?.dataset.target;
  $("f-" + kind + "-count").textContent = ids.length + " 个";
  box.replaceChildren(...(expanded[kind] ? ids : ids.slice(0, SHOWN_ROUTES)).map((id) => selectedRow(kind, id, openedPolicy)));
  if (!ids.length) box.append(el("p", "尚未选择会话", "forward-empty"));
  if (ids.length > SHOWN_ROUTES)
    box.append(
      button(expanded[kind] ? "收起列表" : `另有 ${ids.length - SHOWN_ROUTES} 个，展开查看`, "forward-more", () => {
        expanded[kind] = !expanded[kind];
        renderSelected(kind);
      }),
    );
}

function selectedRow(kind, id, openedPolicy) {
  const c = conv(id),
    row = el("div", undefined, "forward-route"),
    content = el("div", undefined, "forward-route-content");
  row.dataset.conversation = id;
  row.append(el("div", c?.kind === "group" ? "群" : (c?.title || "?")[0], "forward-avatar"));
  content.append(el("strong", c?.title || "已删除的会话"), el("small", c ? accountLabel(c.account) + " · " + (KINDS[c.kind] || "待分类") : id));
  if (!c) content.append(el("p", "会话已删除，请移除并重新选择。", "forward-warning"));
  else if (kind === "targets") content.append(...targetDetails(c, id, openedPolicy));
  else content.append(...sourceWarnings(c));
  const remove = button("×", "forward-remove", () => {
    draft[kind] = draft[kind].filter((item) => item !== id);
    if (kind === "targets") delete draft.target_phones[id];
    renderSelected(kind);
    if (openPicker) renderChoices(openPicker);
    updateFeedback();
  });
  remove.setAttribute("aria-label", "移除 " + (c?.title || "失效会话"));
  row.append(content, remove);
  return row;
}

// targetDetails 目标的设备策略菜单（自动选择或指定设备）和问题提示。
function targetDetails(c, id, openedPolicy) {
  const health = targetHealth(id);
  const details = el("details", undefined, "forward-policy");
  details.dataset.target = id;
  const summary = el("summary");
  summary.append(el("span", "执行设备", "muted"), el("span", health.policy || "设备策略无效", health.text ? "status-warn" : "status-good"), el("span", "⌄", "muted"));
  const options = el("div", undefined, "forward-policy-options");
  options.append(policyChoice(details, id, "自动选择", ""));
  for (const p of phones().filter((p) => p.account === c.account)) options.append(policyChoice(details, id, phoneName(p) + " · " + deviceStatus(p), p.id));
  details.append(summary, options);
  details.open = openedPolicy === id;
  details.addEventListener("toggle", () => {
    if (!details.open) return;
    closePicker();
    closePolicies(details);
  });
  const out = [details];
  if (health.text) out.push(el("p", health.text, "forward-warning"));
  if (!c.kind || c.kind === "unknown") out.push(el("p", "会话类型未识别，请先在消息台设置类型。", "forward-warning"));
  return out;
}

// policyChoice 设备策略菜单的一项；value 为空表示自动选择。
function policyChoice(details, id, text, value) {
  const current = draft.target_phones[id] || "";
  return button(text, current === value ? "selected" : "", () => {
    if (value) draft.target_phones[id] = value;
    else delete draft.target_phones[id];
    details.open = false;
    renderSelected("targets");
    updateFeedback();
    [...$("f-targets").querySelectorAll(".forward-policy")].find((d) => d.dataset.target === id)?.querySelector("summary").focus();
  });
}

// sourceWarnings 来源的微信号没有可用设备时，读不到来源消息。
function sourceWarnings(c) {
  const matching = phones().filter((p) => p.account === c.account);
  if (matching.some((p) => p.available)) return [];
  return [el("p", (matching.length ? deviceProblems(matching[0]).join("；") : "该微信号没有接入设备") + "。当前无法读取来源消息。", "forward-warning")];
}

// closePolicies 收起其他展开的设备策略菜单。
function closePolicies(except) {
  editor.querySelectorAll(".forward-policy[open]").forEach((d) => {
    if (d !== except) d.open = false;
  });
}

// ---------- 编辑框：校验、保存与关闭 ----------

// fieldError 显示错误并定位到出错的输入项（在“更多条件”里时先展开）。
function fieldError(message, field) {
  $("f-error").textContent = message;
  const node = $(field);
  if (node?.closest("#f-advanced")) $("f-advanced").open = true;
  node?.scrollIntoView({ block: "center" });
  if (saving) requestAnimationFrame(() => node?.focus());
  else node?.focus();
  return false;
}

// validate 保存前在网页上先检查一遍（正则交给服务端的 Go RE2 校验，避免 JS 正则判定不同）。
function validate(rule) {
  for (const kind of ["sources", "targets"]) {
    const error = $("f-" + kind + "-error");
    error.hidden = true;
    if (!rule[kind].length) {
      error.hidden = false;
      error.textContent = kind === "sources" ? "请选择至少一个来源会话" : "请选择至少一个目标会话";
      $("f-" + kind + "-group").scrollIntoView({ block: "center" });
      editor.querySelector(`[data-picker="${kind}"]`).focus();
      return false;
    }
    if (rule[kind].some((id) => !conv(id))) return fieldError("会话已被删除，请移除并重新选择。", "f-" + kind);
  }
  if (rule.targets.some((id) => rule.sources.includes(id))) return fieldError("来源和目标不能是同一个会话。", "f-targets");
  if (rule.targets.some((id) => !conv(id).kind || conv(id).kind === "unknown")) return fieldError("请先在消息台设置目标会话类型。", "f-targets");
  if (rule.targets.some((id) => targetHealth(id).error)) return fieldError("指定设备已移除或不属于目标微信号，请重新选择执行设备。", "f-targets");
  if (Array.from(rule.name).length > MAX_NAME) return fieldError(`规则名称最多 ${MAX_NAME} 字`, "f-name");
  if (Math.max(rule.include.length, rule.exclude.length, rule.senders.length) > MAX_FILTER_ITEMS) return fieldError(`发送人和关键词各最多 ${MAX_FILTER_ITEMS} 个`, "f-include");
  if (!$("f-dedup").value || !Number.isInteger(rule.dedup_minutes) || rule.dedup_minutes < 0 || rule.dedup_minutes > MAX_DEDUP_MINUTES)
    return fieldError(`去重时间为 0–${MAX_DEDUP_MINUTES} 的整数分钟`, "f-dedup");
  if (customFormat() && (!rule.template.includes("{text}") || Array.from(rule.template).length > MAX_TEMPLATE))
    return fieldError(`自定义格式必须包含 {text}，最多 ${MAX_TEMPLATE} 字`, "f-template");
  return true;
}

// saveRule 校验并保存规则；服务端报正则或格式错误时定位到对应输入项。
async function saveRule() {
  if (saving) return;
  commitKeywords();
  $("f-error").textContent = "";
  const rule = currentRule();
  if (!validate(rule) || (draft.id && signature(rule) === baseline)) return;
  closePicker();
  saving = true;
  updateFeedback();
  try {
    await api("forward/rule", rule);
    baseline = signature(rule);
    finishClose();
    await load();
    toast("转发规则已保存");
  } catch (error) {
    if (/正则/.test(error.message)) fieldError(error.message, "f-regex");
    else if (/格式/.test(error.message)) fieldError(error.message, "f-template");
    else $("f-error").textContent = error.message;
  } finally {
    saving = false;
    updateFeedback();
  }
}

function finishClose() {
  closePicker();
  markDirty("forward", false);
  editor.close();
}

// close 关闭编辑框；有未保存的修改时先确认。
function close() {
  if (saving) return;
  closePicker();
  if (signature(currentRule()) === baseline) finishClose();
  else if (!discard.open) discard.showModal();
}

// handleEditorClick 编辑框内的点击：展开、收起会话选择；点到选择区外时收起。
function handleEditorClick(e) {
  const picker = e.target.closest("[data-picker]");
  if (picker) return showPicker(picker.dataset.picker);
  if (e.target.closest("[data-collapse]")) return closePicker(true);
  if (openPicker && !e.target.closest("#f-" + openPicker + "-picker") && !e.target.closest("#f-" + openPicker)) closePicker();
}

// handleEditorCancel 按 Esc：先收起会话选择或设备策略菜单，最后才关闭编辑框。
function handleEditorCancel(e) {
  e.preventDefault();
  if (saving) return;
  if (openPicker) return closePicker(true);
  const policy = editor.querySelector(".forward-policy[open]");
  if (!policy) return close();
  policy.open = false;
  policy.querySelector("summary").focus();
}

// refreshEditorHealth 数据刷新时，会话或设备有变化才重绘编辑框里的已选会话和设备状态。
function refreshEditorHealth() {
  if (!editor.open || saving) return;
  const key = JSON.stringify([conversations().map((c) => [c.id, c.title, c.account, c.kind]), phones()]);
  if (key === healthKey) return;
  healthKey = key;
  renderSelected("sources");
  renderSelected("targets");
  if (openPicker) renderChoices(openPicker);
}

// ---------- 绑定 ----------

registerPage("forward", load);
$("forward-add").onclick = () => edit(null);
$("forward-close").onclick = $("f-cancel").onclick = close;
$("f-keep").onclick = () => discard.close();
$("f-discard").onclick = () => {
  discard.close();
  finishClose();
};
closeOnOutsideClick(editor, close);
editor.addEventListener("click", handleEditorClick);
editor.addEventListener("cancel", handleEditorCancel);
editor.querySelectorAll("[data-search]").forEach((input) => (input.oninput = () => renderChoices(input.dataset.search)));
editor.querySelectorAll("[data-account]").forEach((select) => (select.onchange = () => renderChoices(select.dataset.account)));
$("f-include").addEventListener("keydown", (e) => {
  if (e.isComposing || !["Enter", ",", "，"].includes(e.key)) return;
  e.preventDefault();
  commitKeywords();
});
$("f-include").addEventListener("blur", commitKeywords);
$("forward-form").addEventListener("input", (e) => {
  if (e.target.type !== "search") updateFeedback();
});
$("forward-form").addEventListener("change", (e) => {
  if (!e.target.dataset.account && !e.target.dataset.choice) updateFeedback();
});
$("forward-form").onsubmit = (e) => {
  e.preventDefault();
  saveRule();
};
document.addEventListener("workspace-discard", () => {
  if (discard.open) discard.close();
  if (editor.open && !saving) finishClose();
});
document.addEventListener("workspace-state", refreshEditorHealth);
