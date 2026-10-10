// 设备状态文字：连接状态（是否连上）和就绪状态（能否执行任务）分开判断。
const reasons = {
  ACCESSIBILITY_DISABLED: "无障碍服务未开启，请在手机设置中开启",
  READER_SERVICE_REQUIRED: "缺少屏幕朗读服务，请开启随选朗读或 TalkBack",
  SCREEN_LOCKED: "手机已锁屏，请先解锁",
  WECHAT_VERSION_MISMATCH: "微信版本与配置不一致，请检查手机端配置",
  CAPTURE_PERMISSION_REQUIRED: "截图权限未就绪，请解锁手机并允许截图授权",
  PROFILE_NOT_CALIBRATED: "微信控件配置未校准",
  PAIRING_CONFIRMATION_REQUIRED: "等待手机确认电脑授权",
  STARTING: "手机服务正在启动",
};
// deviceProblems 设备不能执行任务的原因（没有设备时提示检查连接）。
export function deviceProblems(p) {
  if (!p) return ["当前账号没有可用设备，请检查设备连接与微信号"];
  const result = [];
  if (p.connection !== "在线")
    result.push(p.error || p.connection || "设备未连接");
  if (p.device?.online === false)
    result.push("手机控制服务未响应，请检查手机端运行状态");
  for (const r of p.device?.info?.reasons || []) result.push(reasons[r] || r);
  const account = p.device?.info?.account;
  if (account?.error) {
    const error = account.error;
    result.push(
      error.code === "WECHAT_NOT_OPEN"
        ? "微信未打开：" +
            error.message +
            "。请检查手机是否解锁、是否允许后台弹出界面，再重新识别微信号"
        : "微信号识别失败：" + (error.message || error.code || String(error)),
    );
  } else if (account && !account.wechat_id)
    result.push("尚未识别当前微信号，请重新识别");
  if (!p.available && !result.length)
    result.push("设备尚未就绪，请重新识别微信号或查看设备诊断");
  return [...new Set(result)];
}
// deviceWarnings 不影响设备可用、但需要用户处理的问题。
export function deviceWarnings(p) {
  const result = [];
  if (p?.device?.info?.notification_permission === false)
    result.push("未开启 AutoJs6 的通知使用权，收不到微信通知，停在聊天页时其他会话的新消息会发现得慢。请在手机设置中搜索“通知使用权”，打开 AutoJs6");
  return result;
}
// deviceStatus 设备的简短状态：可用、忙碌（N 个任务）、已连接但不可用，或连接状态。
export function deviceStatus(p) {
  return p?.available
    ? p.task_count
      ? "忙碌 · " + p.task_count + " 个任务"
      : "可用"
    : p?.connection === "在线"
      ? "已连接 · 不可用"
      : p?.connection || "未连接";
}
