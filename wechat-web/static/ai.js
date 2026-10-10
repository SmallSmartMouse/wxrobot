import { $, el, button, api, toast, app, accountLabel } from "./common.js";
import { registerPage, navigate, markDirty, hasDirty } from "./workspace.js";
let scope = "",
  rules = [],
  base = null,
  global = null,
  loading = 0,
  dirty = false;
const page = $("ai-dialog");
page.innerHTML = `<div class="page-heading"><h1>AI 回复</h1></div><p class="page-description">回复策略归属微信号，切换设备保持一致。</p>
<div class="panel scope-toolbar"><div class="scope-controls"><strong>规则作用范围</strong><div class="segmented" aria-label="规则作用范围"><button type="button" id="ai-scope-global" class="selected" aria-pressed="true">全局默认</button><button type="button" id="ai-scope-account" aria-pressed="false">微信号配置</button></div><select id="ai-scope" aria-label="微信号配置"><option value="">全局默认</option></select></div><p class="muted">优先级：会话设置 → 微信号规则 → 全局规则</p></div>
<form id="ai-form"><div class="ai-columns"><section class="panel"><h2>模型与角色</h2>
<label id="ai-inherit-row" class="switch-row"><span>使用全局模型</span><input id="ai-inherit" type="checkbox" role="switch"></label>
<label class="field">接口地址<input id="ai-url" placeholder="https://api.example.com/v1" required></label>
<label class="field">模型名称<input id="ai-model" required placeholder="模型名称"></label>
<label class="field" id="ai-key-row">API 密钥<input id="ai-key" type="password" autocomplete="new-password"><small class="muted">密钥不回显，留空保留已保存的值。</small></label>
<label id="ai-prompt-inherit-row" class="switch-row"><span>角色提示词跟随全局</span><input id="ai-prompt-inherit" type="checkbox" role="switch"></label>
<label class="field">角色提示词<textarea id="ai-prompt" rows="5" placeholder="描述助手的角色和回复风格"></textarea></label>
<label id="ai-vision-inherit-row" class="switch-row"><span>图片设置跟随全局</span><input id="ai-vision-inherit" type="checkbox" role="switch"></label>
<label class="switch-row"><span>发送聊天图片<small>将聊天图片缩略图提供给模型。</small></span><input id="ai-vision" type="checkbox" role="switch"></label></section>
<section class="panel"><div class="section-heading"><h2>名称回复规则</h2><button id="ai-rule-add" type="button" class="secondary">＋ 添加规则</button></div><p class="muted">从上到下首条匹配生效；未匹配时继续跟随上一级规则。</p><div id="ai-rules"></div><p class="muted">群聊自动回复需设置触发词。</p></section></div>
<div id="ai-error" class="form-error" role="alert"></div><div class="save-bar"><span id="ai-save-state">已保存</span><div><button id="ai-discard" type="button" class="secondary" hidden>放弃修改</button><button id="ai-save" type="submit" class="primary" disabled>保存设置</button></div></div></form>`;
function syncScope() {
  $("ai-scope").hidden = !scope;
  for (const [id, selected] of [
    ["ai-scope-global", !scope],
    ["ai-scope-account", !!scope],
  ]) {
    $(id).classList.toggle("selected", selected);
    $(id).setAttribute("aria-pressed", String(selected));
  }
  $("ai-scope-account").disabled = $("ai-scope").options.length < 2;
}
function changeScope(next) {
  if (next === scope) {
    syncScope();
    return;
  }
  if (dirty && !confirm("放弃当前未保存的修改并切换配置范围？")) {
    $("ai-scope").value = scope;
    return;
  }
  scope = next;
  $("ai-scope").value = scope;
  syncScope();
  void load();
}
$("ai-scope-global").onclick = () => changeScope("");
$("ai-scope-account").onclick = () =>
  changeScope(app.selectedAccount || $("ai-scope").options[1]?.value || "");
for (const id of ["ai-url", "ai-model", "ai-key"]) {
  const label = $(id).closest("label");
  const title = el("span", label.firstChild.textContent);
  label.firstChild.replaceWith(title);
  label.classList.add("model-field");
}
const promptField = $("ai-prompt").closest("label");
const promptBlock = el("div", undefined, "field prompt-field");
const promptHeader = el("div", undefined, "field-header");
const promptTitle = el("label", "角色提示词");
promptTitle.htmlFor = "ai-prompt";
const promptInheritance = $("ai-prompt-inherit-row");
promptInheritance.className = "inherit-control";
promptInheritance.querySelector("span").textContent = "跟随全局";
$("ai-prompt-inherit").removeAttribute("role");
promptHeader.append(promptTitle, promptInheritance);
promptBlock.append(promptHeader, $("ai-prompt"));
promptField.replaceWith(promptBlock);
$("ai-vision-inherit-row").className = "inherit-control vision-inheritance";
$("ai-vision-inherit").removeAttribute("role");
const editor = document.createElement("dialog");
editor.className = "drawer";
editor.id = "ai-rule-editor";
editor.innerHTML = `<form id="ai-rule-form"><div class="drawer-heading"><h2>回复规则</h2><button type="button" class="icon-button" id="ai-rule-close" aria-label="关闭">×</button></div><label class="field">会话类型<select id="rule-kind"><option value="person">联系人</option><option value="group">群聊</option></select></label><label class="field">匹配方式<select id="rule-matcher"><option value="wildcard">通配符</option><option value="regex">正则表达式</option></select></label><label class="field">名称表达式<input id="rule-pattern" required placeholder="例如 客服*"><small>* 匹配任意字符，? 匹配单个字符。</small></label><label class="field">回复模式<select id="rule-mode"><option value="off">关闭</option><option value="auto">自动回复</option></select></label><label class="field">触发词<input id="rule-keyword" placeholder="群聊自动回复时必填"></label><label class="field">最短间隔（秒）<input id="rule-interval" type="number" min="5" max="86400" required value="30"></label><div id="rule-error" class="form-error"></div><div class="drawer-actions"><button type="submit" class="primary">完成</button></div></form>`;
document.body.append(editor);
let editing = -1;
function setDirty(value) {
  dirty = value;
  markDirty("ai", value);
  $("ai-save").disabled = !value;
  $("ai-save").hidden = !value;
  $("ai-discard").hidden = !value;
  $("ai-save-state").textContent = value ? "未保存的修改" : "已保存";
}
function syncInheritance() {
  const inherited = !!scope && $("ai-inherit").checked;
  for (const id of ["ai-url", "ai-model", "ai-key"]) $(id).disabled = inherited;
  if (inherited) {
    $("ai-url").value = global.url;
    $("ai-model").value = global.model;
  }
  $("ai-key-row").hidden = inherited;
  const p = !!scope && $("ai-prompt-inherit").checked;
  $("ai-prompt").disabled = p;
  if (p) $("ai-prompt").value = global.prompt || "";
  const v = !!scope && $("ai-vision-inherit").checked;
  $("ai-vision").disabled = v;
  if (v) $("ai-vision").checked = global.vision;
}
function fill(cfg) {
  syncScope();
  base = cfg;
  const account = !!scope,
    model = account ? cfg.effective : cfg;
  $("ai-inherit-row").hidden =
    $("ai-prompt-inherit-row").hidden =
    $("ai-vision-inherit-row").hidden =
      !account;
  $("ai-inherit").checked = account ? cfg.config.inherit_model : false;
  $("ai-prompt-inherit").checked = account ? cfg.config.prompt == null : false;
  $("ai-vision-inherit").checked = account ? cfg.config.vision == null : false;
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
async function load() {
  const request = ++loading;
  $("ai-save").disabled = true;
  try {
    global = await api("ai/config");
    const cfg = scope
      ? await api("ai/accounts/" + encodeURIComponent(scope))
      : global;
    if (request === loading) fill(cfg);
  } catch (e) {
    $("ai-error").textContent = e.message;
  }
}
function renderRules() {
  const box = $("ai-rules");
  box.replaceChildren();
  rules.forEach((r, i) => {
    const row = el("div", undefined, "ai-rule-card");
    const number = el("span", String(i + 1).padStart(2, "0"), "rule-number");
    const copy = el("div", undefined, "grow");
    copy.append(
      el("strong", r.pattern),
      el(
        "small",
        (r.kind === "group" ? "群聊" : "联系人") +
          " · " +
          (r.mode === "auto" ? "自动回复" : "关闭"),
      ),
    );
    const more = el("details", undefined, "row-menu");
    more.setAttribute("aria-label", "更多操作");
    more.append(el("summary", "···"));
    for (const [label, action] of [
      [
        "上移",
        () => {
          if (i > 0) {
            [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]];
            renderRules();
            setDirty(true);
          }
        },
      ],
      [
        "下移",
        () => {
          if (i < rules.length - 1) {
            [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]];
            renderRules();
            setDirty(true);
          }
        },
      ],
      [
        "删除",
        () => {
          rules.splice(i, 1);
          renderRules();
          setDirty(true);
        },
      ],
    ])
      more.append(button(label, "text-button", action));
    row.append(
      number,
      copy,
      button("编辑", "text-button", () => editRule(i)),
      more,
    );
    box.append(row);
  });
  if (!rules.length)
    box.append(
      el(
        "div",
        scope ? "暂无账号规则，将跟随全局规则" : "暂无规则，自动回复默认关闭",
        "empty-list",
      ),
    );
}
function editRule(i) {
  editing = i;
  const r = rules[i] || {
    kind: "person",
    matcher: "wildcard",
    pattern: "",
    mode: "off",
    keyword: "",
    interval_seconds: 30,
  };
  for (const k of ["kind", "matcher", "pattern", "mode", "keyword"])
    $("rule-" + k).value = r[k] || "";
  $("rule-interval").value = r.interval_seconds || 30;
  $("rule-error").textContent = "";
  editor.dataset.changed = "false";
  editor.showModal();
}
$("ai-rule-form").onsubmit = (e) => {
  e.preventDefault();
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
  if (editing < 0) rules.push(r);
  else rules[editing] = r;
  renderRules();
  setDirty(true);
  markDirty("ai-editor", false);
  editor.close();
};
editor.addEventListener("input", () => {
  editor.dataset.changed = "true";
  markDirty("ai-editor", true);
});
function closeRule() {
  if (editor.dataset.changed === "true" && !confirm("放弃当前规则的修改？"))
    return;
  markDirty("ai-editor", false);
  editor.close();
}
editor.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeRule();
});
$("ai-rule-close").onclick = closeRule;
$("ai-rule-add").onclick = () => editRule(-1);
$("ai-form").addEventListener("input", () => {
  syncInheritance();
  setDirty(true);
});
$("ai-scope").onchange = () => changeScope($("ai-scope").value);
$("ai-discard").onclick = () => fill(base);
$("ai-form").onsubmit = async (e) => {
  e.preventDefault();
  $("ai-save").disabled = true;
  $("ai-error").textContent = "";
  const cfg = {
    url: $("ai-url").value,
    model: $("ai-model").value,
    key: $("ai-key").value,
    prompt: $("ai-prompt").value,
    vision: $("ai-vision").checked,
  };
  try {
    if (scope) {
      await api("ai/accounts/" + encodeURIComponent(scope), {
        inherit_model: $("ai-inherit").checked,
        model_config: cfg,
        prompt: $("ai-prompt-inherit").checked ? null : cfg.prompt,
        vision: $("ai-vision-inherit").checked ? null : cfg.vision,
        rules,
      });
    } else await api("ai/config", { ...cfg, rules });
    await load();
    toast("AI 回复设置已保存");
  } catch (e) {
    $("ai-error").textContent = e.message;
    $("ai-save").disabled = false;
  }
};
registerPage("ai", () => {
  const select = $("ai-scope");
  select.replaceChildren(new Option("全局默认", ""));
  for (const a of app.state.accounts)
    select.append(new Option(accountLabel(a.wechat_id), a.wechat_id));
  if (!app.state.accounts.some((a) => a.wechat_id === scope)) scope = "";
  select.value = scope;
  void load();
});
$("ai-settings").onclick = () => navigate("ai");
