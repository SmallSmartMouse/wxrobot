// 诊断页：按微信号与设备查看当前设备状态、最近手机任务和 AI 记录（按任务类型与显示范围筛选）、设备上报的异常和服务日志。
// 数据来自 /api/debug；手机或模型返回的内容都用 textContent 显示，不会作为 HTML 执行。
import { deviceProblems, deviceStatus, deviceWarnings } from "./device-status.js";
import { $, el, button, api, app, accountLabel, timeLabel, storage } from "./common.js";
import { registerPage, phoneName, operationAccount } from "./workspace.js";

const AUTO_REFRESH_MS = 5000; // 停在诊断页时的自动刷新间隔
const TASK_COLUMNS = ["时间", "操作与来源", "微信号 / 会话", "实际设备", "状态", "操作"];
const STATUS = { queued: "排队中", running: "执行中", succeeded: "已完成", failed: "失败", unknown: "结果未知" };
const AI_STATUS = { running: "生成中", sent: "已生成并排队发送", failed: "失败", draft: "已生成草稿", send_queued: "已生成并排队发送" };

let data = null; // GET /api/debug 的最新结果
let loading = false;
let filter = "issues"; // issues | all
let taskType = "all"; // all | read | send | ai
const opened = new Set(); // 展开详情的任务

// ---------- 数据 ----------

// refresh 重新拉取诊断数据并重绘；从别处带来的任务或设备先选中。打开诊断页即视为已查看（诊断红点清零）。
async function refresh() {
  if (loading) return;
  loading = true;
  $("diag-refresh").disabled = true;
  try {
    data = await api("debug");
    syncSelectors();
    applyRequestedFocus();
    render();
    $("diag-log").textContent = data.log || "暂无日志";
    $("diag-log-note").textContent = data.log_error || "最后 64 KB";
    $("diag-error").textContent = "";
    $("diag-status").textContent = "最近 100 个手机任务、50 条 AI 记录 · 更新于 " + new Date().toLocaleTimeString();
    storage.set("diag-seen-at", Date.now());
  } catch (e) {
    $("diag-error").textContent = e.message;
  } finally {
    loading = false;
    $("diag-refresh").disabled = false;
  }
}

// applyRequestedFocus 从消息页点“查看诊断”带来的任务：展开它；从设备详情带来的设备：只看这台设备。
function applyRequestedFocus() {
  if (app.diagnosticTask) {
    opened.add(app.diagnosticTask);
    taskType = "all";
    $("diag-task-type").value = taskType;
    setFilter("all");
    app.diagnosticTask = null;
  }
  if (app.diagnosticPhone) {
    $("diag-account").value = "";
    syncSelectors();
    $("diag-phone").value = app.diagnosticPhone;
    app.diagnosticPhone = null;
  }
}

// syncSelectors 微信号和设备筛选的选项；选了微信号时只列登录过它、或为它执行过任务的设备。保留原来的选择。
function syncSelectors() {
  const account = $("diag-account"),
    previousAccount = account.value;
  account.replaceChildren(new Option("全部微信号", ""), ...app.state.accounts.map((a) => new Option(accountLabel(a.wechat_id), a.wechat_id)));
  account.value = previousAccount;
  const phone = $("diag-phone"),
    previousPhone = phone.value;
  const related = app.state.phones.filter(
    (p) => !account.value || p.account === account.value || data?.operations.some((op) => op.phone_id === p.id && operationAccount(op) === account.value),
  );
  phone.replaceChildren(new Option("全部关联设备", ""), ...related.map((p) => new Option(phoneName(p), p.id)));
  phone.value = previousPhone;
}

// inScope 任务是否在当前的微信号和设备筛选范围内。
function inScope(op) {
  return (!$("diag-account").value || operationAccount(op) === $("diag-account").value) && (!$("diag-phone").value || op.phone_id === $("diag-phone").value);
}

// phonesInScope 当前筛选范围内的设备。
function phonesInScope(phones) {
  return phones.filter((p) => (!$("diag-phone").value || p.id === $("diag-phone").value) && (!$("diag-account").value || p.account === $("diag-account").value));
}

function setFilter(value) {
  filter = value;
  $("diag-task-scope").value = filter;
}

// ---------- 渲染 ----------

// render 重绘设备状态、待核对提醒、任务列表和设备异常。
function render() {
  if (!data) return;
  renderDeviceHealth();
  const ops = data.operations.filter(inScope);
  const unknown = ops.filter((o) => o.status === "unknown").length;
  $("diag-warning").hidden = !unknown;
  $("diag-warning").textContent = unknown + " 条发送结果待核对，请先查看手机，避免重复发送。";
  renderTaskLists(ops);
  renderEvents();
}

// renderDeviceHealth 当前设备状态：可用的显示为小标签，不可用的显示问题和恢复入口。
function renderDeviceHealth() {
  const health = $("diag-device-health");
  health.replaceChildren(el("h2", "当前设备状态"));
  const phones = phonesInScope(app.state.phones || []);
  for (const p of phones) health.append(deviceHealthRow(p));
  if (!phones.length) health.append(el("p", "当前范围内没有设备", "muted"));
}

function deviceHealthRow(p) {
  const row = el("div", undefined, p.available ? "device-health-chip" : "task-card device-health-issue");
  row.append(el("strong", phoneName(p) + " · " + deviceStatus(p)));
  const problems = deviceProblems(p);
  if (problems.length) row.append(el("p", problems.join("；"), "danger-text"));
  const warnings = deviceWarnings(p);
  if (warnings.length) row.append(el("p", warnings.join("；"), "status-warn"));
  if (!p.available) row.append(button("查看连接与恢复操作", "text-button", () => app.showPhone(p)));
  return row;
}

// needsAttention 成功但有降级警告的任务也需要关注。
function needsAttention(task) {
  return ["failed", "unknown"].includes(task.status) || !!task.warnings?.length;
}

// aiOperation AI 生成记录关联的手机发送任务。
function aiOperation(job) {
  return data.operations.find((op) => op.id === job.operation_id);
}

// renderTaskLists 类型与关注范围分别筛选；全部类型同时展示手机任务和 AI 生成记录。
function renderTaskLists(ops) {
  const phoneTasks = ops.filter((op) => (taskType === "all" || taskType === op.kind)
    && (filter === "all" || needsAttention(op) || opened.has(op.id)));
  const aiJobs = (data.ai_jobs || []).filter((job) => {
    const op = aiOperation(job);
    return ["all", "ai"].includes(taskType)
      && inScope({ conversation_id: job.conversation_id, phone_id: op?.phone_id })
      && (filter === "all" || needsAttention(job) || (op && needsAttention(op)));
  });
  const box = $("diag-tasks");
  box.replaceChildren();
  if (phoneTasks.length) {
    box.append(el("h2", "手机读取与发送"));
    renderTasks(phoneTasks);
  }
  if (aiJobs.length) {
    box.append(el("h2", "AI 回复"));
    renderAIJobs(aiJobs);
  }
  if (!phoneTasks.length && !aiJobs.length)
    box.append(el("div", filter === "issues" ? "当前范围内没有需要关注的任务" : "暂无匹配任务", "empty-list"));
}

// renderAIJobs 显示生成结果和关联发送结果，避免把生成成功误认为发送成功。
function renderAIJobs(jobs) {
  const box = $("diag-tasks");
  for (const j of jobs) {
    const op = aiOperation(j);
    const row = el("div", undefined, "task-card");
    row.append(
      el("strong", data.conversations[j.conversation_id] || "会话"),
      el("small", timeLabel(j.created) + " · " + (AI_STATUS[j.status] || j.status)),
      el("p", j.error || j.reply || "正在生成回复…"),
    );
    if (op) {
      row.append(el("p", "发送结果：" + (STATUS[op.status] || op.status), statusClass(op.status)));
      if (op.error) row.append(el("p", op.error, "danger-text"));
      for (const warning of op.warnings || []) row.append(el("p", warning.message, "warning"));
      row.append(button("查看发送详情", "text-button", () => {
        opened.add(op.id);
        taskType = "all";
        $("diag-task-type").value = taskType;
        render();
      }));
    } else if (j.status === "sent") {
      row.append(el("p", "发送任务不在当前加载的记录中，无法确认发送结果。", "muted"));
    }
    box.append(row);
  }
}

// renderTasks 展示筛选后的手机任务；展开的任务下面显示详情。
function renderTasks(ops) {
  const table = el("table", undefined, "data-table");
  const head = el("thead"),
    tr = el("tr");
  for (const t of TASK_COLUMNS) tr.append(el("th", t));
  head.append(tr);
  const body = el("tbody");
  for (const op of ops) {
    body.append(taskRow(op));
    if (opened.has(op.id)) body.append(taskDetailRow(op));
  }
  table.append(head, body);
  $("diag-tasks").append(table);
}

// source 任务的来源：转发、AI 回复、自动读取或手动。
function source(op) {
  if (op.forward_rule) return "转发";
  if (op.id.startsWith("ai-")) return "AI 回复";
  return op.auto ? "自动读取" : "手动";
}

function statusClass(status) {
  if (["failed", "unknown"].includes(status)) return "status-warn";
  return status === "succeeded" ? "status-good" : "";
}

// taskRow 任务一行：时间、类型和来源、微信号和会话、执行设备、状态、展开按钮。
function taskRow(op) {
  const kind = el("td"),
    account = el("td"),
    device = el("td"),
    state = el("td"),
    action = el("td");
  kind.append(el("strong", op.kind === "send" ? "发送消息" : "读取消息"), el("small", source(op)));
  account.append(el("span", accountLabel(operationAccount(op))), el("small", data.conversations[op.conversation_id] || ""));
  const p = app.state.phones.find((p) => p.id === op.phone_id);
  device.append(el("span", phoneName(p)), el("small", p?.device_id || op.phone_id || "等待分配"));
  state.append(el("span", STATUS[op.status] || op.status, "status-chip " + statusClass(op.status)));
  action.append(
    button(opened.has(op.id) ? "收起" : "查看", "text-button", () => {
      opened.has(op.id) ? opened.delete(op.id) : opened.add(op.id);
      render();
    }),
  );
  const row = el("tr");
  row.append(el("td", timeLabel(op.created)), kind, account, device, state, action);
  return row;
}

// taskDetailRow 任务详情：执行进度、任务记录、错误和降级、发送内容、手机上报的执行步骤（含截图）。
function taskDetailRow(op) {
  const detail = el("div", undefined, "task-detail");
  const overview = el("div", undefined, "task-overview");
  overview.append(taskProgress(op), taskRecord(op));
  const owner = "微信号 " + (operationAccount(op) || "未归属") + " · 执行设备 " + (op.phone_id || "未分配");
  detail.append(overview, el("strong", "任务详情"), el("p", owner, "muted"));
  if (op.error) detail.append(el("p", op.error, "danger-text"));
  if (op.status === "unknown") detail.append(el("p", "请在原设备上确认是否已发出，勿重复发送。", "warning"));
  if (op.text) detail.append(el("p", op.text));
  for (const w of op.warnings || []) detail.append(el("p", w.message, "warning"));
  detail.append(taskSteps(op), el("small", "任务 " + op.id, "muted"));
  const cell = el("td");
  cell.colSpan = TASK_COLUMNS.length;
  cell.append(detail);
  const row = el("tr");
  row.append(cell);
  return row;
}

// taskProgress 执行进度：已创建 → 手机已接收 → 结果。
function taskProgress(op) {
  const progress = el("div", undefined, "task-progress");
  const timeline = el("ol", undefined, "progress-timeline");
  for (const [title, done, warn] of [
    ["已创建任务", true, false],
    [op.phone_task_id ? "手机已接收" : "等待设备执行", !!op.phone_task_id, false],
    [STATUS[op.status] || op.status, op.status === "succeeded", ["failed", "unknown"].includes(op.status)],
  ]) {
    const item = el("li", undefined, done ? "done" : warn ? "attention" : "");
    item.append(el("span", done ? "✓" : warn ? "!" : "…", "progress-node"), el("span", title));
    timeline.append(item);
  }
  progress.append(el("strong", "执行进度"), timeline);
  return progress;
}

function taskRecord(op) {
  const record = el("div", undefined, "task-record");
  record.append(el("strong", "任务记录"), el("p", "微信号 · " + (operationAccount(op) || "未归属")), el("p", "执行设备 · " + (op.phone_id || "未分配")));
  return record;
}

// taskSteps 手机上报的执行步骤：步骤名、距开始的秒数、说明，有截图时可以打开查看。
function taskSteps(op) {
  const steps = el("ol", undefined, "steps");
  for (const s of op.steps || []) {
    const item = el("li");
    item.append(el("strong", s.step), el("span", " · " + (s.ms / 1000).toFixed(1) + " 秒 · " + (s.detail || "")));
    if (s.image) {
      const link = el("a", "查看截图");
      link.href = "/api/media/" + s.image;
      link.target = "_blank";
      link.rel = "noopener";
      item.append(link);
    }
    steps.append(item);
  }
  if (!steps.children.length) steps.append(el("li", "暂无手机执行步骤"));
  return steps;
}

// renderEvents 设备上报的异常和降级。
function renderEvents() {
  const events = $("diag-event-list");
  events.replaceChildren();
  for (const p of phonesInScope(data.phones)) {
    for (const e of p.device?.diagnostics || []) {
      const row = el("div", undefined, "task-card");
      row.append(el("strong", phoneName(p) + " · " + (e.level === "error" ? "异常" : "降级")), el("p", e.message), el("small", timeLabel(e.last_at)));
      events.append(row);
    }
  }
  if (!events.children.length) events.append(el("p", "暂无设备异常", "muted"));
}

// ---------- 绑定 ----------

registerPage("diagnostics", refresh);
$("diag-account").onchange = () => {
  syncSelectors();
  render();
};
$("diag-phone").onchange = render;
$("diag-refresh").onclick = refresh;
$("diag-task-type").onchange = () => {
  taskType = $("diag-task-type").value;
  render();
};
$("diag-task-scope").onchange = () => {
  setFilter($("diag-task-scope").value);
  render();
};
// 停在诊断页且开启自动刷新时，定时刷新
setInterval(() => {
  if (app.page === "diagnostics" && $("diag-auto").checked) void refresh();
}, AUTO_REFRESH_MS);
