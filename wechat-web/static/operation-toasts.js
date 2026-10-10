// 任务结束提示：任务从“进行中”变为结束时弹出提示（自动读取、转发成功不提示）。
import { toast } from "./common.js";
import { STATUS } from "./message-list.js";

const knownStatus = new Map(); // 任务 ID → 上次看到的状态

// noteOperation 记下刚提交的任务，之后它结束时能弹出提示（即使在下次刷新前就已结束）。
export function noteOperation(op) {
  knownStatus.set(op.id, op.status);
}

// toastFinishedOperations 对比上次看到的状态，为刚结束的任务弹出提示。
export function toastFinishedOperations(operations) {
  for (const op of operations) {
    const before = knownStatus.get(op.id);
    knownStatus.set(op.id, op.status);
    if (!active(before) || active(op.status)) continue;
    const message = finishMessage(op);
    if (message) toast(message);
  }
}

function active(status) {
  return status === "queued" || status === "running";
}

// finishMessage 任务结束的提示文字；不需要提示时返回空字符串。
function finishMessage(op) {
  if (op.status !== "succeeded") return (op.forward_rule ? "转发" : "") + STATUS[op.status] + "：" + (op.error || "请查看手机");
  if (op.forward_rule) return ""; // 转发是自动的，成功不逐条提示
  if (op.kind === "send") return "手机已确认发送";
  return op.auto ? "" : "手机消息已读取";
}
