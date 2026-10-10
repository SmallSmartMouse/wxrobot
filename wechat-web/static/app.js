// 微信消息台前端入口：拉取数据并按区域重绘。各页面在各自的模块里：
//   accounts.js 微信号与执行设备、chat.js 会话和聊天、phones.js 设备、ai.js AI 回复、forward.js 转发、diagnostics.js 诊断。
// 数据来自 /api/state 和 /api/conversations/{id}；服务端有变化时通过 SSE 推送，页面重新拉取并重绘（消息列表增量更新）。
import { $, api, toast, app } from "./common.js";
import { renderWorkspace } from "./workspace.js";
import { pickAccount, renderAccountBar } from "./accounts.js";
import { loadActiveConversation, markActiveSeen, renderConversationList, renderChat } from "./chat.js";
import { toastFinishedOperations } from "./operation-toasts.js";
import { renderPhoneSettings } from "./phones.js";
import "./ai.js";
import "./forward.js";
import "./diagnostics.js";

let refreshing = false;
let refreshAgain = false;

// refresh 拉取总览和当前会话详情，然后重绘。并发调用时合并为一次后续刷新，避免旧响应覆盖新数据。
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    app.state = await api("state");
    pickAccount();
    await loadActiveConversation();
    toastFinishedOperations(app.state.operations);
    render();
    await markActiveSeen();
  } catch (e) {
    showOffline(e);
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  }
}

// render 按现有数据重绘：消息页顶部、会话列表、当前聊天；在设备页时重绘设备列表。
function render() {
  renderAccountBar();
  renderConversationList();
  renderChat();
  if (app.page === "system") renderPhoneSettings();
  renderWorkspace();
}

// showOffline 网页服务连不上时在连接卡片上提示。
function showOffline(e) {
  $("connection").textContent = "网页服务离线";
  $("status-dot").className = "dot error";
  toast(e.message);
}

// 其他模块通过 app 调用刷新和重绘。服务端数据变化时通过 SSE 通知刷新；另外每 20 秒兜底刷新一次。
app.refresh = refresh;
app.render = render;
const stream = new EventSource("/api/stream");
stream.onmessage = () => void refresh();
stream.onerror = () => ($("connection").textContent = "实时连接恢复中");
setInterval(() => void refresh(), 20000);
void refresh();
