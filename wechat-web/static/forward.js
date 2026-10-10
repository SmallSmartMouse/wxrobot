import {
  $,
  el,
  button,
  api,
  toast,
  app,
  accountLabel,
  accountName,
  KINDS,
} from "./common.js";
import { registerPage, navigate, phoneName, markDirty } from "./workspace.js";
import { deviceStatus, deviceProblems } from "./device-status.js";
let rules = [],
  draft = null,
  saving = false;
$("forward-dialog").innerHTML =
  `<div class="page-heading"><div><h1>转发</h1><p class="page-description">按微信号配置来源与目标，设备按策略执行。</p></div><button id="forward-add" class="primary">＋ 添加规则</button></div><p class="page-footnote">仅转发保存后读到的新来信。源群需允许通知或开启定时读取。</p><div id="forward-error" class="form-error" role="alert"></div><section class="panel"><div id="forward-rules"></div></section>`;
const editor = document.createElement("dialog");
editor.id = "forward-editor";
editor.className = "drawer";
editor.setAttribute("aria-labelledby", "forward-editor-title");
editor.innerHTML = `<form id="forward-form" novalidate>
<div class="drawer-heading"><div><h2 id="forward-editor-title">编辑转发规则</h2><p class="muted">选择即时更新草稿，保存后生效</p></div><button type="button" id="forward-close" class="icon-button" aria-label="关闭规则编辑">×</button></div>
<div class="forward-editor-body" id="f-body"><div class="forward-basic"><label for="f-name">规则名称</label><input id="f-name" maxlength="40" placeholder="例如 客服通知"><label class="forward-enable">启用<input id="f-enabled" type="checkbox" role="switch"></label></div>
<section class="forward-group" id="f-sources-group"><div class="forward-section-heading"><h3>来源会话 <small id="f-sources-count"></small></h3><button type="button" class="text-button" data-picker="sources" aria-expanded="false" aria-controls="f-sources-picker">＋ 选择会话</button></div><div id="f-sources" class="forward-selected"></div><div id="f-sources-picker" class="forward-picker" hidden><div class="forward-filters"><input type="search" data-search="sources" placeholder="搜索会话或微信号" aria-label="搜索来源会话"><select data-account="sources" aria-label="筛选来源微信号"></select></div><div id="f-sources-choices" class="forward-choices"></div><div class="forward-selection-note"><span>勾选即加入草稿，点击其他区域收起</span><button type="button" class="text-button" data-collapse="sources">收起</button></div></div><div id="f-sources-error" class="forward-field-error" role="alert" hidden></div><p class="forward-hint">仅转发之后读到的新来信；来源需开启通知或定时读取。</p></section>
<section class="forward-group" id="f-targets-group"><div class="forward-section-heading"><h3>目标会话 <small id="f-targets-count"></small></h3><button type="button" class="text-button" data-picker="targets" aria-expanded="false" aria-controls="f-targets-picker">＋ 选择会话</button></div><div id="f-targets" class="forward-selected"></div><div id="f-targets-picker" class="forward-picker" hidden><div class="forward-filters"><input type="search" data-search="targets" placeholder="搜索会话或微信号" aria-label="搜索目标会话"><select data-account="targets" aria-label="筛选目标微信号"></select></div><div id="f-targets-choices" class="forward-choices"></div><div class="forward-selection-note"><span>来源会话和类型未识别的会话不可作为目标</span><button type="button" class="text-button" data-collapse="targets">收起</button></div></div><div id="f-targets-error" class="forward-field-error" role="alert" hidden></div></section>
<section class="forward-group"><h3>转发条件</h3><label class="field" for="f-include">包含任一关键词</label><div class="forward-tags"><span id="f-tags"></span><input id="f-include" placeholder="留空不限，输入后按回车添加" aria-label="添加包含关键词"></div><p id="f-keyword-note" class="forward-hint"></p><label class="forward-images"><input id="f-images" type="checkbox">同时转发图片</label><p id="f-image-note" class="forward-image-note" hidden>图片不检查关键词和正则，仅按发送人过滤。</p></section>
<details id="f-advanced"><summary>更多条件与消息格式 <span id="f-advanced-summary" class="muted"></span></summary><div class="forward-advanced-grid"><label class="field">排除任一关键词<input id="f-exclude" placeholder="逗号分隔，留空不限"></label><label class="field">相同文字去重（分钟）<input id="f-dedup" type="number" min="0" max="1440" value="30"></label></div><label class="field">只转发这些发送人<input id="f-senders" placeholder="完整群昵称，逗号分隔；留空不限"></label><label class="field">还须匹配正则表达式<input id="f-regex" placeholder="留空不限，保存时校验"></label><div class="forward-format"><span>文字格式</span><label><input type="radio" name="f-format" value="original" checked>原文</label><label><input type="radio" name="f-format" value="custom">自定义</label></div><div id="f-custom-format" hidden><label class="field">格式内容<textarea id="f-template" rows="2" maxlength="200" placeholder="[{chat}] {sender}：{text}"></textarea></label><p class="forward-hint">支持 {text}、{sender}、{chat}；必须保留 {text}。</p><div id="f-format-preview"></div><p class="forward-hint">示例文字预览，不发送消息。</p></div><p class="forward-hint">同规则跨来源按相同文字去重；图片不去重，跳过的消息不自动补发。</p></details><div id="f-error" class="form-error" role="alert"></div></div>
<div class="forward-editor-footer"><p id="f-summary"></p><div class="forward-footer-actions"><span id="f-dirty" class="muted">已保存</span><button type="button" id="f-cancel" class="secondary">取消</button><button id="f-save" type="submit" class="primary">保存规则</button></div></div></form>`;
document.body.append(editor);
function convLabel(id, detailed = true) {
  const c = app.state.conversations.find((c) => c.id === id);
  return c
    ? (detailed ? accountLabel(c.account) : accountName(c.account)) +
        " · " +
        c.title
    : "已删除的会话";
}
async function load() {
  try {
    rules = (await api("forward")).rules;
    render();
    $("forward-error").textContent = "";
  } catch (e) {
    $("forward-error").textContent = e.message;
  }
}
function render() {
  const table = el("table", undefined, "data-table");
  const head = el("thead"),
    h = el("tr");
  for (const t of ["规则", "来源", "目标", "状态", "操作"])
    h.append(el("th", t));
  head.append(h);
  table.append(head);
  const body = el("tbody");
  for (const rule of rules) {
    const tr = el("tr"),
      name = el("td"),
      source = el("td"),
      target = el("td"),
      state = el("td"),
      actions = el("td");
    name.append(el("strong", rule.name || "未命名规则"));
    if (rule.problem) name.append(el("small", rule.problem, "danger-text"));
    source.textContent = rule.sources
      .map((id) => convLabel(id, false))
      .join("、");
    target.textContent = rule.targets
      .map((id) => convLabel(id, false))
      .join("、");
    target.append(
      el(
        "small",
        Object.values(rule.target_phones || {}).some(Boolean)
          ? "含指定执行设备"
          : "自动选择设备",
      ),
    );
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
    state.append(toggle);
    const more = el("details", undefined, "row-menu");
    more.setAttribute("aria-label", "更多操作");
    more.append(
      el("summary", "···"),
      button("删除", "text-button danger-text", async () => {
        if (!confirm("删除规则「" + (rule.name || "未命名规则") + "」？"))
          return;
        try {
          await api("forward/" + rule.id + "/delete", {});
          await load();
        } catch (e) {
          toast(e.message);
        }
      }),
    );
    actions.append(
      button("编辑", "text-button", () => edit(rule)),
      more,
    );
    tr.append(name, source, target, state, actions);
    body.append(tr);
  }
  table.append(body);
  $("forward-rules").replaceChildren(table);
  if (!rules.length)
    $("forward-rules").append(
      el("div", "暂无转发规则，点击“添加规则”开始配置", "empty-list"),
    );
}
let baseline = "", includeWords = [], openPicker = null, healthKey = "";
const expanded = { sources: false, targets: false };
const conversations = () => app.state?.conversations || [];
const phones = () => app.state?.phones || [];
const conv = (id) => conversations().find((c) => c.id === id);
const listWords = (value) => [...new Set((Array.isArray(value) ? value : [value || ""]).flatMap((s) => s.split(/[,，、\n]/)).map((s) => s.trim()).filter(Boolean))];
function currentRule() {
  return {
    id: draft.id || "", name: $("f-name").value.trim(), enabled: $("f-enabled").checked,
    sources: [...draft.sources], targets: [...draft.targets],
    target_phones: Object.fromEntries(draft.targets.filter((id) => draft.target_phones[id]).map((id) => [id, draft.target_phones[id]])),
    include: listWords([...includeWords, $("f-include").value]),
    exclude: listWords($("f-exclude").value), senders: listWords($("f-senders").value),
    regex: $("f-regex").value.trim(), dedup_minutes: Number($("f-dedup").value), images: $("f-images").checked,
    template: editor.querySelector('[name="f-format"]:checked').value === "custom" ? $("f-template").value.trim() : "",
  };
}
function signature(rule) {
  return JSON.stringify({ ...rule, sources: [...rule.sources].sort(), targets: [...rule.targets].sort(), target_phones: Object.fromEntries(Object.entries(rule.target_phones).sort()) });
}
function updateFeedback() {
  const rule = currentRule(), changed = signature(rule) !== baseline;
  markDirty("forward", changed);
  $("forward-form").dataset.changed = String(changed);
  $("f-dirty").textContent = saving ? "正在保存…" : changed ? "未保存的修改" : "已保存";
  $("f-save").disabled = saving || (!changed && !!draft.id);
  $("f-save").textContent = saving ? "保存中…" : "保存规则";
  $("forward-close").disabled = $("f-cancel").disabled = saving;
  $("f-body").inert = saving;
  $("f-image-note").hidden = !rule.images;
  $("f-keyword-note").textContent = rule.include.length ? "命中任意一个关键词即满足；其他已配置条件仍同时生效。" : "不限制包含关键词；排除词、发送人、正则等条件仍同时生效。";
  const summary = `${rule.sources.length} 个来源 → ${rule.targets.length} 个目标 · ${rule.include.length ? "包含任一：" + rule.include.join("、") : "不限包含关键词"} · ${rule.images ? "文字及图片" : "仅文字"}${rule.enabled ? "" : " · 已停用"}`;
  $("f-summary").textContent = $("f-summary").title = summary;
  $("f-advanced-summary").textContent = [rule.exclude.length ? "排除词" : "", rule.senders.length ? "发送人" : "", rule.regex ? "正则" : "", rule.template ? "自定义格式" : "", rule.dedup_minutes ? `去重 ${rule.dedup_minutes} 分钟` : "不去重"].filter(Boolean).join(" · ") + "　⌄";
  $("f-custom-format").hidden = editor.querySelector('[name="f-format"]:checked').value !== "custom";
  $("f-format-preview").textContent = $("f-template").value.replace(/\{(text|sender|chat)\}/g, (_, key) => ({ text: "客户需要售后帮助，请尽快联系。", sender: "王宁", chat: "客户服务群" })[key]);
}
function renderTags() {
  $("f-tags").replaceChildren();
  includeWords.forEach((word, index) => {
    const chip = el("span", undefined, "forward-tag");
    const remove = button("×", "", () => { includeWords.splice(index, 1); renderTags(); updateFeedback(); });
    remove.setAttribute("aria-label", "移除关键词 " + word);
    chip.append(el("span", word), remove);
    $("f-tags").append(chip);
  });
}
function commitKeywords() {
  includeWords = listWords([...includeWords, $("f-include").value]);
  $("f-include").value = "";
  renderTags();
  updateFeedback();
}
function closePicker(focus = false) {
  if (!openPicker) return;
  const kind = openPicker, trigger = editor.querySelector(`[data-picker="${kind}"]`);
  $("f-" + kind + "-picker").hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  openPicker = null;
  if (focus) trigger.focus();
}
function showPicker(kind) {
  if (openPicker === kind) return closePicker(true);
  closePicker();
  editor.querySelectorAll(".forward-policy[open]").forEach((d) => d.open = false);
  openPicker = kind;
  const select = editor.querySelector(`[data-account="${kind}"]`), previous = select.value || "all";
  select.replaceChildren(new Option("全部微信号", "all"));
  const accounts = [...new Set(conversations().map((c) => c.account || ""))];
  for (const account of accounts) select.append(new Option(accountLabel(account), account || "unassigned"));
  select.value = [...select.options].some((o) => o.value === previous) ? previous : "all";
  $("f-" + kind + "-picker").hidden = false;
  editor.querySelector(`[data-picker="${kind}"]`).setAttribute("aria-expanded", "true");
  renderChoices(kind);
  editor.querySelector(`[data-search="${kind}"]`).focus();
}
function renderChoices(kind) {
  const box = $("f-" + kind + "-choices"), top = box.scrollTop;
  const query = editor.querySelector(`[data-search="${kind}"]`).value.toLowerCase();
  const account = editor.querySelector(`[data-account="${kind}"]`).value;
  const other = kind === "sources" ? "targets" : "sources";
  box.replaceChildren();
  const groups = new Map();
  for (const c of conversations()) {
    if (account !== "all" && (c.account || "unassigned") !== account) continue;
    if (!(c.title + " " + accountLabel(c.account)).toLowerCase().includes(query)) continue;
    if (!groups.has(c.account || "")) groups.set(c.account || "", []);
    groups.get(c.account || "").push(c);
  }
  for (const [account, items] of groups) {
    box.append(el("div", accountLabel(account), "forward-account-heading"));
    for (const c of items) {
      const row = el("label", undefined, "forward-choice"), input = el("input");
      const selected = draft[kind].includes(c.id), conflict = draft[other].includes(c.id), unknown = kind === "targets" && (!c.kind || c.kind === "unknown");
      input.type = "checkbox";
      input.value = c.id;
      input.checked = selected;
      // 既有无效选择仍能取消，未选项才禁选。
      input.disabled = !selected && (conflict || unknown);
      input.dataset.kind = kind;
      input.dataset.choice = c.id;
      row.classList.toggle("selected", selected);
      row.classList.toggle("unavailable", input.disabled);
      row.append(input, el("span", c.title), el("small", conflict ? (kind === "sources" ? "已是目标" : "已是来源") : unknown ? "请先设置会话类型" : KINDS[c.kind]));
      input.onchange = () => {
        draft[kind] = input.checked ? [...draft[kind], c.id] : draft[kind].filter((id) => id !== c.id);
        if (kind === "targets" && !input.checked) delete draft.target_phones[c.id];
        $("f-" + kind + "-error").hidden = true;
        renderSelected(kind); renderChoices(kind); updateFeedback();
        [...box.querySelectorAll("input")].find((node) => node.value === c.id)?.focus();
      };
      box.append(row);
    }
  }
  if (!groups.size) box.append(el("p", conversations().length ? "没有匹配的会话，试试其他关键词或微信号。" : "请先在消息台添加会话", "muted"));
  box.scrollTop = top;
}
function targetHealth(id) {
  const c = conv(id), requested = draft.target_phones[id];
  if (!c) return { text: "目标会话已删除，请重新选择", error: true };
  if (requested) {
    const p = phones().find((p) => p.id === requested);
    if (!p || p.account !== c.account) return { text: "指定设备已移除或换号，请重新选择", error: true };
    return { policy: phoneName(p) + " · " + deviceStatus(p), text: p.available ? "" : deviceProblems(p).join("；") + "。此目标将跳过，不会自动换用其他手机。" };
  }
  const matching = phones().filter((p) => p.account === c.account), available = matching.filter((p) => p.available);
  return { policy: `自动选择 · ${available.length} 台可用`, text: available.length ? "" : matching.length ? deviceProblems(matching[0]).join("；") + "。此目标暂不可执行。" : "此微信号没有接入设备，此目标将跳过。" };
}
function renderSelected(kind) {
  const box = $("f-" + kind), ids = draft[kind];
  box.tabIndex = -1;
  const opened = box.querySelector(".forward-policy[open]")?.dataset.target;
  box.replaceChildren();
  $("f-" + kind + "-count").textContent = ids.length + " 个";
  for (const id of expanded[kind] ? ids : ids.slice(0, 3)) {
    const c = conv(id), row = el("div", undefined, "forward-route"), content = el("div", undefined, "forward-route-content");
    row.dataset.conversation = id;
    row.append(el("div", c?.kind === "group" ? "群" : (c?.title || "?")[0], "forward-avatar"));
    content.append(el("strong", c?.title || "已删除的会话"), el("small", c ? accountLabel(c.account) + " · " + (KINDS[c.kind] || "待分类") : id));
    const remove = button("×", "forward-remove", () => {
      draft[kind] = draft[kind].filter((item) => item !== id);
      if (kind === "targets") delete draft.target_phones[id];
      renderSelected(kind); if (openPicker) renderChoices(openPicker); updateFeedback();
    });
    remove.setAttribute("aria-label", "移除 " + (c?.title || "失效会话"));
    if (!c) content.append(el("p", "会话已删除，请移除并重新选择。", "forward-warning"));
    else if (kind === "targets") {
      const health = targetHealth(id), details = el("details", undefined, "forward-policy"), summary = el("summary");
      details.dataset.target = id;
      summary.append(el("span", "执行设备", "muted"), el("span", health.policy || "设备策略无效", health.text ? "status-warn" : "status-good"), el("span", "⌄", "muted"));
      const options = el("div", undefined, "forward-policy-options");
      const choice = (text, value) => {
        const b = button(text, draft.target_phones[id] === value || (!value && !draft.target_phones[id]) ? "selected" : "", () => {
          if (value) draft.target_phones[id] = value; else delete draft.target_phones[id];
          details.open = false; renderSelected(kind); updateFeedback();
          [...box.querySelectorAll(".forward-policy")].find((d) => d.dataset.target === id)?.querySelector("summary").focus();
        });
        options.append(b);
      };
      choice("自动选择", "");
      phones().filter((p) => p.account === c.account).forEach((p) => choice(phoneName(p) + " · " + deviceStatus(p), p.id));
      details.append(summary, options); content.append(details);
      details.open = opened === id;
      details.addEventListener("toggle", () => {
        if (!details.open) return;
        closePicker();
        editor.querySelectorAll(".forward-policy[open]").forEach((d) => { if (d !== details) d.open = false; });
      });
      if (health.text) content.append(el("p", health.text, "forward-warning"));
      if (!c.kind || c.kind === "unknown") content.append(el("p", "会话类型未识别，请先在消息台设置类型。", "forward-warning"));
    } else {
      const matching = phones().filter((p) => p.account === c.account);
      if (!matching.some((p) => p.available)) content.append(el("p", (matching.length ? deviceProblems(matching[0]).join("；") : "该微信号没有接入设备") + "。当前无法读取来源消息。", "forward-warning"));
    }
    row.append(content, remove); box.append(row);
  }
  if (!ids.length) box.append(el("p", "尚未选择会话", "forward-empty"));
  if (ids.length > 3) box.append(button(expanded[kind] ? "收起列表" : `另有 ${ids.length - 3} 个，展开查看`, "forward-more", () => { expanded[kind] = !expanded[kind]; renderSelected(kind); }));
}
function edit(rule) {
  draft = structuredClone(rule || { enabled: true, sources: [], targets: [], dedup_minutes: 30 });
  draft.sources ||= []; draft.targets ||= []; draft.target_phones ||= {};
  expanded.sources = expanded.targets = false;
  closePicker();
  $("forward-editor-title").textContent = rule ? "编辑转发规则" : "添加转发规则";
  for (const key of ["name", "exclude", "senders", "regex", "template"]) $("f-" + key).value = Array.isArray(draft[key]) ? listWords(draft[key]).join("，") : draft[key] || "";
  $("f-dedup").value = draft.dedup_minutes || 0;
  $("f-enabled").checked = !!draft.enabled; $("f-images").checked = !!draft.images;
  includeWords = listWords(draft.include || []); $("f-include").value = "";
  editor.querySelector(`[name="f-format"][value="${draft.template ? "custom" : "original"}"]`).checked = true;
  $("f-advanced").open = false; $("f-error").textContent = "";
  for (const kind of ["sources", "targets"]) { $("f-" + kind + "-error").hidden = true; editor.querySelector(`[data-search="${kind}"]`).value = ""; }
  baseline = signature(currentRule()); healthKey = "";
  renderTags(); renderSelected("sources"); renderSelected("targets"); updateFeedback();
  editor.showModal(); $("f-body").scrollTop = 0;
}
const discard = document.createElement("dialog");
discard.id = "forward-discard"; discard.setAttribute("aria-labelledby", "forward-discard-title");
discard.innerHTML = '<h3 id="forward-discard-title">放弃未保存的修改？</h3><p class="muted">当前修改尚未生效，放弃后恢复上次保存的规则。</p><div class="forward-confirm-actions"><button type="button" id="f-keep" class="secondary">继续编辑</button><button type="button" id="f-discard" class="primary">放弃修改</button></div>';
document.body.append(discard);
function finishClose() { closePicker(); markDirty("forward", false); editor.close(); }
function close() {
  if (saving) return;
  closePicker();
  if (signature(currentRule()) !== baseline) { if (!discard.open) discard.showModal(); }
  else finishClose();
}
$("f-keep").onclick = () => discard.close();
$("f-discard").onclick = () => { discard.close(); finishClose(); };
$("forward-close").onclick = $("f-cancel").onclick = close;
editor.addEventListener("cancel", (e) => {
  e.preventDefault(); if (saving) return;
  if (openPicker) return closePicker(true);
  const policy = editor.querySelector(".forward-policy[open]");
  if (policy) { policy.open = false; policy.querySelector("summary").focus(); } else close();
});
let outsideDown = false;
const outside = (e) => { const r = editor.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
editor.addEventListener("pointerdown", (e) => outsideDown = e.isPrimary && outside(e));
editor.addEventListener("pointercancel", () => outsideDown = false);
editor.addEventListener("click", (e) => {
  if (outsideDown && outside(e)) close(); outsideDown = false;
  const picker = e.target.closest("[data-picker]");
  if (picker) { showPicker(picker.dataset.picker); return; }
  if (e.target.closest("[data-collapse]")) return closePicker(true);
  if (openPicker && !e.target.closest("#f-" + openPicker + "-picker") && !e.target.closest("#f-" + openPicker)) closePicker();
});
editor.querySelectorAll("[data-search]").forEach((input) => input.oninput = () => renderChoices(input.dataset.search));
editor.querySelectorAll("[data-account]").forEach((select) => select.onchange = () => renderChoices(select.dataset.account));
$("f-include").addEventListener("keydown", (e) => { if (!e.isComposing && ["Enter", ",", "，"].includes(e.key)) { e.preventDefault(); commitKeywords(); } });
$("f-include").addEventListener("blur", commitKeywords);
$("forward-form").addEventListener("input", (e) => { if (e.target.type !== "search") updateFeedback(); });
$("forward-form").addEventListener("change", (e) => { if (!e.target.dataset.account && !e.target.dataset.choice) updateFeedback(); });
function fieldError(message, field) {
  $("f-error").textContent = message;
  const node = $(field);
  if (node?.closest("#f-advanced")) $("f-advanced").open = true;
  node?.scrollIntoView({ block: "center" });
  if (saving) requestAnimationFrame(() => node?.focus());
  else node?.focus();
  return false;
}
function validate(rule) {
  for (const kind of ["sources", "targets"]) {
    const error = $("f-" + kind + "-error"); error.hidden = true;
    if (!rule[kind].length) {
      error.hidden = false; error.textContent = kind === "sources" ? "请选择至少一个来源会话" : "请选择至少一个目标会话";
      $("f-" + kind + "-group").scrollIntoView({ block: "center" }); editor.querySelector(`[data-picker="${kind}"]`).focus(); return false;
    }
    if (rule[kind].some((id) => !conv(id))) return fieldError("会话已被删除，请移除并重新选择。", "f-" + kind);
  }
  if (rule.targets.some((id) => rule.sources.includes(id))) return fieldError("来源和目标不能是同一个会话。", "f-targets");
  if (rule.targets.some((id) => !conv(id).kind || conv(id).kind === "unknown")) return fieldError("请先在消息台设置目标会话类型。", "f-targets");
  if (rule.targets.some((id) => targetHealth(id).error)) return fieldError("指定设备已移除或不属于目标微信号，请重新选择执行设备。", "f-targets");
  if (Array.from(rule.name).length > 40) return fieldError("规则名称最多 40 字", "f-name");
  if (Math.max(rule.include.length, rule.exclude.length, rule.senders.length) > 100) return fieldError("发送人和关键词各最多 100 个", "f-include");
  if (!$("f-dedup").value || !Number.isInteger(rule.dedup_minutes) || rule.dedup_minutes < 0 || rule.dedup_minutes > 1440) return fieldError("去重时间为 0–1440 的整数分钟", "f-dedup");
  if (editor.querySelector('[name="f-format"]:checked').value === "custom" && (!rule.template.includes("{text}") || Array.from(rule.template).length > 200)) return fieldError("自定义格式必须包含 {text}，最多 200 字", "f-template");
  return true;
}
$("forward-form").onsubmit = async (e) => {
  e.preventDefault(); if (saving) return;
  commitKeywords(); $("f-error").textContent = "";
  const rule = currentRule(); if (!validate(rule)) return;
  if (draft.id && signature(rule) === baseline) return;
  closePicker(); saving = true; updateFeedback();
  try {
    await api("forward/rule", rule);
    baseline = signature(rule); finishClose(); await load(); toast("转发规则已保存");
  } catch (error) {
    // 正则使用服务端 Go RE2 校验，避免用 JS 正则产生不同判定。
    if (/正则/.test(error.message)) fieldError(error.message, "f-regex");
    else if (/格式/.test(error.message)) fieldError(error.message, "f-template");
    else $("f-error").textContent = error.message;
  } finally { saving = false; updateFeedback(); }
};
document.addEventListener("workspace-discard", () => { if (discard.open) discard.close(); if (editor.open && !saving) finishClose(); });
document.addEventListener("workspace-state", () => {
  if (!editor.open || saving) return;
  const key = JSON.stringify([conversations().map((c) => [c.id, c.title, c.account, c.kind]), phones()]);
  if (key === healthKey) return; healthKey = key;
  renderSelected("sources"); renderSelected("targets"); if (openPicker) renderChoices(openPicker);
});
$("forward-add").onclick = () => edit(null);
registerPage("forward", load);
$("forward-settings").onclick = () => navigate("forward");
