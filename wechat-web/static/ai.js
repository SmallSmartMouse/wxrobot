// AI 回复页：全局默认或某个微信号的模型、角色提示词、看图设置和名称回复规则。
// 微信号的设置可以分别跟随全局：跟随的项显示全局的值并禁止编辑。
import { $, el, button, api, toast, app, accountLabel, DEFAULT_REPLY_INTERVAL } from "./common.js";
import { registerPage, markDirty } from "./workspace.js";

let scope = ""; // 编辑的范围：空为全局默认，否则是微信号
let rules = []; // 编辑中的名称规则
let base = null; // 最近一次加载的设置（放弃修改时恢复）
let global = null; // 全局设置（显示跟随的值）
let loading = 0; // 最近一次加载的序号，丢弃过时的响应
let dirty = false;
let editing = -1; // 正在编辑的规则序号，-1 为新规则

// ---------- 加载与填表 ----------

// load 加载全局设置；编辑微信号时再加载它的设置，然后填表。
async function load() {
  const request = ++loading;
  $("ai-save").disabled = true;
  try {
    global = await api("ai/config");
    const cfg = scope ? await api("ai/accounts/" + encodeURIComponent(scope)) : global;
    if (request === loading) fill(cfg);
  } catch (e) {
    $("ai-error").textContent = e.message;
  }
}

// fill 用设置填表：微信号范围显示“跟随全局”开关，模型显示实际生效的值，密钥不回显。
function fill(cfg) {
  syncScope();
  base = cfg;
  const account = !!scope,
    model = account ? cfg.effective : cfg;
  $("ai-inherit-row").hidden = $("ai-prompt-inherit-row").hidden = $("ai-vision-inherit-row").hidden = !account;
  $("ai-inherit").checked = account && cfg.config.inherit_model;
  $("ai-prompt-inherit").checked = account && cfg.config.prompt == null;
  $("ai-vision-inherit").checked = account && cfg.config.vision == null;
  $("ai-url").value = model.url || "";
  $("ai-model").value = model.model || "";
  $("ai-key").value = "";
  $("ai-key").placeholder = cfg.key_set ? "已保存，留空保留原值" : "可留空";
  $("ai-prompt").value = model.prompt || "";
  $("ai-vision").checked = !!model.vision;
  rules = structuredClone(account ? cfg.config.rules : cfg.rules) || [];
  renderRules();
  syncInheritance();
  $("ai-error").textContent = "";
  setDirty(false);
}

// syncInheritance 跟随全局的项显示全局的值并禁止编辑；跟随全局模型时隐藏密钥。
function syncInheritance() {
  const inherited = !!scope && $("ai-inherit").checked;
  for (const id of ["ai-url", "ai-model", "ai-key"]) $(id).disabled = inherited;
  if (inherited) {
    $("ai-url").value = global.url;
    $("ai-model").value = global.model;
  }
  $("ai-key-row").hidden = inherited;
  const prompt = !!scope && $("ai-prompt-inherit").checked;
  $("ai-prompt").disabled = prompt;
  if (prompt) $("ai-prompt").value = global.prompt || "";
  const vision = !!scope && $("ai-vision-inherit").checked;
  $("ai-vision").disabled = vision;
  if (vision) $("ai-vision").checked = global.vision;
}

// setDirty 有未保存的修改时显示保存和放弃按钮，离开页面前提醒。
function setDirty(value) {
  dirty = value;
  markDirty("ai", value);
  $("ai-save").disabled = $("ai-save").hidden = $("ai-discard").hidden = !value;
  $("ai-save-state").textContent = value ? "未保存的修改" : "已保存";
}

// save 保存当前范围的设置：微信号范围只保存覆盖的项（跟随的为 null）。
async function save() {
  $("ai-save").disabled = true;
  $("ai-error").textContent = "";
  const cfg = { url: $("ai-url").value, model: $("ai-model").value, key: $("ai-key").value, prompt: $("ai-prompt").value, vision: $("ai-vision").checked };
  try {
    if (scope)
      await api("ai/accounts/" + encodeURIComponent(scope), {
        inherit_model: $("ai-inherit").checked,
        model_config: cfg,
        prompt: $("ai-prompt-inherit").checked ? null : cfg.prompt,
        vision: $("ai-vision-inherit").checked ? null : cfg.vision,
        rules,
      });
    else await api("ai/config", { ...cfg, rules });
    await load();
    toast("AI 回复设置已保存");
  } catch (e) {
    $("ai-error").textContent = e.message;
    $("ai-save").disabled = false;
  }
}

// ---------- 作用范围 ----------

// fillScopes 微信号下拉：全局默认加上每个微信号；编辑的微信号已不存在时回到全局。
function fillScopes() {
  const select = $("ai-scope");
  select.replaceChildren(new Option("全局默认", ""));
  for (const a of app.state.accounts) select.append(new Option(accountLabel(a.wechat_id), a.wechat_id));
  if (!app.state.accounts.some((a) => a.wechat_id === scope)) scope = "";
  select.value = scope;
}

// syncScope 范围切换按钮和微信号下拉的显示。
function syncScope() {
  $("ai-scope").hidden = !scope;
  for (const [id, selected] of [["ai-scope-global", !scope], ["ai-scope-account", !!scope]]) {
    $(id).classList.toggle("selected", selected);
    $(id).setAttribute("aria-pressed", String(selected));
  }
  $("ai-scope-account").disabled = $("ai-scope").options.length < 2; // 只有“全局默认”一项：还没有微信号
}

// changeScope 切换编辑范围；有未保存的修改时先确认。
function changeScope(next) {
  if (next === scope) return syncScope();
  if (dirty && !confirm("放弃当前未保存的修改并切换配置范围？")) {
    $("ai-scope").value = scope;
    return;
  }
  scope = next;
  $("ai-scope").value = scope;
  syncScope();
  void load();
}

// ---------- 名称规则 ----------

// renderRules 规则列表：序号、名称表达式、类型和回复方式，以及编辑、上移、下移、删除。
function renderRules() {
  $("ai-rules").replaceChildren(...rules.map(ruleCard));
  if (!rules.length)
    $("ai-rules").append(el("div", scope ? "暂无账号规则，将跟随全局规则" : "暂无规则，自动回复默认关闭", "empty-list"));
}

function ruleCard(r, i) {
  const row = el("div", undefined, "ai-rule-card");
  const copy = el("div", undefined, "grow");
  copy.append(el("strong", r.pattern), el("small", (r.kind === "group" ? "群聊" : "联系人") + " · " + (r.mode === "auto" ? "自动回复" : "关闭")));
  const more = el("details", undefined, "row-menu");
  more.setAttribute("aria-label", "更多操作");
  more.append(
    el("summary", "···"),
    button("上移", "text-button", () => moveRule(i, i - 1)),
    button("下移", "text-button", () => moveRule(i, i + 1)),
    button("删除", "text-button", () => changeRules(() => rules.splice(i, 1))),
  );
  row.append(el("span", String(i + 1).padStart(2, "0"), "rule-number"), copy, button("编辑", "text-button", () => editRule(i)), more);
  return row;
}

// moveRule 调整规则顺序（从上到下第一条匹配的生效）。
function moveRule(from, to) {
  if (to < 0 || to >= rules.length) return;
  changeRules(() => ([rules[from], rules[to]] = [rules[to], rules[from]]));
}

// changeRules 修改规则列表后重绘并标记未保存。
function changeRules(change) {
  change();
  renderRules();
  setDirty(true);
}

// editRule 打开规则编辑框；i 为 -1 时新建。
function editRule(i) {
  editing = i;
  const r = rules[i] || { kind: "person", matcher: "wildcard", pattern: "", mode: "off", keyword: "", interval_seconds: DEFAULT_REPLY_INTERVAL };
  for (const k of ["kind", "matcher", "pattern", "mode", "keyword"]) $("rule-" + k).value = r[k] || "";
  $("rule-interval").value = r.interval_seconds || DEFAULT_REPLY_INTERVAL;
  $("rule-error").textContent = "";
  $("ai-rule-editor").dataset.changed = "false";
  $("ai-rule-editor").showModal();
}

// finishRule 规则编辑完成：群聊自动回复必须有触发词。规则随整页设置一起保存。
function finishRule() {
  const r = {
    kind: $("rule-kind").value,
    matcher: $("rule-matcher").value,
    pattern: $("rule-pattern").value.trim(),
    mode: $("rule-mode").value,
    keyword: $("rule-keyword").value.trim(),
    interval_seconds: Number($("rule-interval").value),
  };
  if (r.kind === "group" && r.mode === "auto" && !r.keyword) {
    $("rule-error").textContent = "群聊自动回复需要触发词";
    return;
  }
  changeRules(() => (editing < 0 ? rules.push(r) : (rules[editing] = r)));
  markDirty("ai-editor", false);
  $("ai-rule-editor").close();
}

// closeRule 关闭规则编辑框；有修改时先确认。
function closeRule() {
  if ($("ai-rule-editor").dataset.changed === "true" && !confirm("放弃当前规则的修改？")) return;
  markDirty("ai-editor", false);
  $("ai-rule-editor").close();
}

// ---------- 绑定 ----------

registerPage("ai", () => {
  fillScopes();
  void load();
});
$("ai-scope-global").onclick = () => changeScope("");
$("ai-scope-account").onclick = () => changeScope(app.selectedAccount || $("ai-scope").options[1]?.value || "");
$("ai-scope").onchange = () => changeScope($("ai-scope").value);
$("ai-form").addEventListener("input", () => {
  syncInheritance();
  setDirty(true);
});
$("ai-form").onsubmit = (e) => {
  e.preventDefault();
  save();
};
$("ai-discard").onclick = () => fill(base);
$("ai-rule-add").onclick = () => editRule(-1);
$("ai-rule-form").onsubmit = (e) => {
  e.preventDefault();
  finishRule();
};
$("ai-rule-editor").addEventListener("input", () => {
  $("ai-rule-editor").dataset.changed = "true";
  markDirty("ai-editor", true);
});
$("ai-rule-editor").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeRule();
});
$("ai-rule-close").onclick = closeRule;
