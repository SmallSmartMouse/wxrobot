import { deviceProblems, deviceStatus } from "./device-status.js";
import {
  $,
  el,
  button,
  api,
  app,
  accountLabel,
  timeLabel,
  storage,
} from "./common.js";
import {
  registerPage,
  navigate,
  phoneName,
  operationAccount,
  icon,
} from "./workspace.js";
let data = null,
  loading = false,
  filter = "issues";
const opened = new Set();
const status = {
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  unknown: "结果未知",
};
$("page-diagnostics").innerHTML =
  `<div class="page-heading"><div><h1>诊断</h1><p class="page-description">按微信号与设备查看任务执行情况。</p></div><div class="toolbar"><label class="compact-check"><input type="checkbox" id="diag-auto" checked>自动刷新</label><button class="secondary" id="diag-refresh" aria-label="刷新诊断">↻ 刷新</button></div></div><div class="panel toolbar"><label>微信号<select id="diag-account"><option value="">全部微信号</option></select></label><label>设备<select id="diag-phone"><option value="">全部设备</option></select></label><small id="diag-status" class="muted">最近 100 个任务，筛选仅作用于已加载数据</small></div><div id="diag-error" class="form-error" role="alert"></div><div id="diag-warning" class="info-strip warning" hidden></div><section id="diag-device-health" class="panel" aria-label="当前设备状态"></section><section class="panel"><nav class="tabs" aria-label="诊断分类"><button data-diag-filter="issues" class="selected">需要关注</button><button data-diag-filter="all">全部</button><button data-diag-filter="ai">AI 任务</button></nav><div id="diag-tasks"></div></section><details class="panel" id="diag-events"><summary>设备异常与降级</summary><div id="diag-event-list"></div></details><details class="panel"><summary>服务日志 <small id="diag-log-note" class="muted"></small></summary><pre id="diag-log"></pre></details>`;
const refreshControls = $("diag-refresh").closest(".toolbar");
refreshControls.classList.add("diagnostic-refresh");
$("diag-status").before(refreshControls);
$("diag-auto").setAttribute("role", "switch");
$("diag-refresh").replaceChildren(icon("refresh"));
$("diag-refresh").title = "刷新诊断";
function syncSelectors() {
  const account = $("diag-account"),
    old = account.value;
  account.replaceChildren(new Option("全部微信号", ""));
  for (const a of app.state.accounts)
    account.append(new Option(accountLabel(a.wechat_id), a.wechat_id));
  account.value = old;
  const phone = $("diag-phone"),
    previous = phone.value;
  phone.replaceChildren(new Option("全部关联设备", ""));
  for (const p of app.state.phones.filter(
    (p) =>
      !account.value ||
      p.account === account.value ||
      data?.operations.some(
        (op) => op.phone_id === p.id && operationAccount(op) === account.value,
      ),
  ))
    phone.append(new Option(phoneName(p), p.id));
  phone.value = previous;
}
function matches(op) {
  return (
    (!$("diag-account").value ||
      operationAccount(op) === $("diag-account").value) &&
    (!$("diag-phone").value || op.phone_id === $("diag-phone").value)
  );
}
function source(op) {
  return op.forward_rule
    ? "转发"
    : op.id.startsWith("ai-")
      ? "AI 回复"
      : op.auto
        ? "自动读取"
        : "手动";
}
function render() {
  if (!data) return;
  const health = $("diag-device-health");
  health.replaceChildren(el("h2", "当前设备状态"));
  const phones = (app.state.phones || []).filter(
    (p) =>
      (!$("diag-phone").value || p.id === $("diag-phone").value) &&
      (!$("diag-account").value || p.account === $("diag-account").value),
  );
  for (const p of phones) {
    const row = el(
      "div",
      undefined,
      p.available ? "device-health-chip" : "task-card device-health-issue",
    );
    row.append(el("strong", phoneName(p) + " · " + deviceStatus(p)));
    const problems = deviceProblems(p);
    if (problems.length)
      row.append(el("p", problems.join("；"), "danger-text"));
    if (!p.available)
      row.append(
        button("查看连接与恢复操作", "text-button", () => app.showPhone(p)),
      );
    health.append(row);
  }
  if (!phones.length) health.append(el("p", "当前范围内没有设备", "muted"));
  const ops = data.operations.filter(matches);
  const unknown = ops.filter((o) => o.status === "unknown").length;
  $("diag-warning").hidden = !unknown;
  $("diag-warning").textContent =
    unknown + " 条发送结果待核对，请先查看手机，避免重复发送。";
  const box = $("diag-tasks");
  box.replaceChildren();
  if (filter === "ai") {
    for (const j of data.ai_jobs || []) {
      const op = data.operations.find((o) => o.id === j.operation_id);
      const fake = {
        conversation_id: j.conversation_id,
        phone_id: op?.phone_id,
      };
      if (!matches(fake)) continue;
      const row = el("div", undefined, "task-card");
      row.append(
        el("strong", data.conversations[j.conversation_id] || "会话"),
        el(
          "small",
          timeLabel(j.created) +
            " · " +
            ({ running: "生成中", sent: "已生成并排队发送", failed: "失败" }[
              j.status
            ] || j.status),
        ),
        el("p", j.error || j.reply || "正在生成回复…"),
      );
      box.append(row);
    }
    if (!box.children.length)
      box.append(el("div", "暂无匹配的 AI 任务", "empty-list"));
  } else {
    const table = el("table", undefined, "data-table");
    const head = el("thead"),
      tr = el("tr");
    for (const t of [
      "时间",
      "操作与来源",
      "微信号 / 会话",
      "实际设备",
      "状态",
      "操作",
    ])
      tr.append(el("th", t));
    head.append(tr);
    table.append(head);
    const body = el("tbody");
    for (const op of ops.filter(
      (o) =>
        filter === "all" ||
        ["failed", "unknown"].includes(o.status) ||
        o.warnings?.length ||
        opened.has(o.id),
    )) {
      const row = el("tr"),
        kind = el("td"),
        account = el("td"),
        device = el("td"),
        action = el("td");
      kind.append(
        el("strong", op.kind === "send" ? "发送消息" : "读取消息"),
        el("small", source(op)),
      );
      account.append(
        el("span", accountLabel(operationAccount(op))),
        el("small", data.conversations[op.conversation_id] || ""),
      );
      const p = app.state.phones.find((p) => p.id === op.phone_id);
      device.append(
        el("span", phoneName(p)),
        el("small", p?.device_id || op.phone_id || "等待分配"),
      );
      action.append(
        button(opened.has(op.id) ? "收起" : "查看", "text-button", () => {
          opened.has(op.id) ? opened.delete(op.id) : opened.add(op.id);
          render();
        }),
      );
      const state = el("td");
      state.append(
        el(
          "span",
          status[op.status] || op.status,
          "status-chip " +
            (["failed", "unknown"].includes(op.status)
              ? "status-warn"
              : op.status === "succeeded"
                ? "status-good"
                : ""),
        ),
      );
      row.append(
        el("td", timeLabel(op.created)),
        kind,
        account,
        device,
        state,
        action,
      );
      body.append(row);
      if (opened.has(op.id)) {
        const detailRow = el("tr"),
          cell = el("td");
        cell.colSpan = 6;
        const detail = el("div", undefined, "task-detail");
        const progress = el("div", undefined, "task-progress");
        progress.append(el("strong", "执行进度"));
        const timeline = el("ol", undefined, "progress-timeline");
        for (const [title, done, warn] of [
          ["已创建任务", true, false],
          [
            op.phone_task_id ? "手机已接收" : "等待设备执行",
            !!op.phone_task_id,
            false,
          ],
          [
            status[op.status] || op.status,
            op.status === "succeeded",
            ["failed", "unknown"].includes(op.status),
          ],
        ]) {
          const item = el(
            "li",
            undefined,
            done ? "done" : warn ? "attention" : "",
          );
          item.append(
            el("span", done ? "✓" : warn ? "!" : "…", "progress-node"),
            el("span", title),
          );
          timeline.append(item);
        }
        progress.append(timeline);
        const record = el("div", undefined, "task-record");
        record.append(
          el("strong", "任务记录"),
          el("p", "微信号 · " + (operationAccount(op) || "未归属")),
          el("p", "执行设备 · " + (op.phone_id || "未分配")),
        );
        const overview = el("div", undefined, "task-overview");
        overview.append(progress, record);
        detail.append(overview);
        detail.append(
          el("strong", "任务详情"),
          el(
            "p",
            "微信号 " +
              (operationAccount(op) || "未归属") +
              " · 执行设备 " +
              (op.phone_id || "未分配"),
            "muted",
          ),
        );
        if (op.error) detail.append(el("p", op.error, "danger-text"));
        if (op.status === "unknown")
          detail.append(
            el("p", "请在原设备上确认是否已发出，勿重复发送。", "warning"),
          );
        if (op.text) detail.append(el("p", op.text));
        for (const w of op.warnings || [])
          detail.append(el("p", w.message, "warning"));
        const steps = el("ol", undefined, "steps");
        for (const s of op.steps || []) {
          const item = el("li");
          item.append(
            el("strong", s.step),
            el(
              "span",
              " · " + (s.ms / 1000).toFixed(1) + " 秒 · " + (s.detail || ""),
            ),
          );
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
        detail.append(steps, el("small", "任务 " + op.id, "muted"));
        cell.append(detail);
        detailRow.append(cell);
        body.append(detailRow);
      }
    }
    table.append(body);
    box.append(table);
    if (!body.children.length)
      box.append(
        el(
          "div",
          filter === "issues" ? "当前范围内没有需要关注的任务" : "暂无匹配任务",
          "empty-list",
        ),
      );
  }
  const events = $("diag-event-list");
  events.replaceChildren();
  for (const p of data.phones.filter(
    (p) =>
      (!$("diag-phone").value || p.id === $("diag-phone").value) &&
      (!$("diag-account").value || p.account === $("diag-account").value),
  )) {
    for (const e of p.device?.diagnostics || []) {
      const row = el("div", undefined, "task-card");
      row.append(
        el(
          "strong",
          phoneName(p) + " · " + (e.level === "error" ? "异常" : "降级"),
        ),
        el("p", e.message),
        el("small", timeLabel(e.last_at)),
      );
      events.append(row);
    }
  }
  if (!events.children.length) events.append(el("p", "暂无设备异常", "muted"));
}
async function refresh() {
  if (loading) return;
  loading = true;
  $("diag-refresh").disabled = true;
  try {
    data = await api("debug");
    syncSelectors();
    if (app.diagnosticTask) {
      opened.add(app.diagnosticTask);
      filter = "all";
      app.diagnosticTask = null;
    }
    if (app.diagnosticPhone) {
      $("diag-account").value = "";
      syncSelectors();
      $("diag-phone").value = app.diagnosticPhone;
      app.diagnosticPhone = null;
    }
    for (const b of document.querySelectorAll("[data-diag-filter]"))
      b.classList.toggle("selected", b.dataset.diagFilter === filter);
    render();
    $("diag-log").textContent = data.log || "暂无日志";
    $("diag-log-note").textContent = data.log_error || "最后 64 KB";
    $("diag-error").textContent = "";
    $("diag-status").textContent =
      "最近 100 个任务 · 更新于 " + new Date().toLocaleTimeString();
    storage.set("diag-seen-at", Date.now());
  } catch (e) {
    $("diag-error").textContent = e.message;
  } finally {
    loading = false;
    $("diag-refresh").disabled = false;
  }
}
$("diag-account").onchange = () => {
  syncSelectors();
  render();
};
$("diag-phone").onchange = render;
$("diag-refresh").onclick = refresh;
for (const b of document.querySelectorAll("[data-diag-filter]"))
  b.onclick = () => {
    filter = b.dataset.diagFilter;
    for (const x of document.querySelectorAll("[data-diag-filter]"))
      x.classList.toggle("selected", x === b);
    render();
  };
registerPage("diagnostics", refresh);
$("diag-link").onclick = () => navigate("diagnostics");
setInterval(() => {
  if (app.page === "diagnostics" && $("diag-auto").checked) void refresh();
}, 5000);
