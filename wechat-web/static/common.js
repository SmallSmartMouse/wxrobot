// 网页公共工具：元素创建、接口调用、提示、浏览器本地存储和显示格式。

export const $ = (id) => document.getElementById(id);

// 与服务端、手机桥一致的上限
export const MAX_MESSAGE_LENGTH = 2000; // 一条消息最多的字数
export const MAX_READ_LIMIT = 100; // 一次读取最多的条数
export const DEFAULT_REPLY_INTERVAL = 30; // AI 回复默认的最短间隔（秒）

const TOAST_MS = 5000; // 提示显示的时长
const BADGE_MAX = 99; // 角标最多显示到 99，再多显示“99+”

// badgeText 角标文字：超过 99 显示“99+”。
export function badgeText(count) {
    return count > BADGE_MAX ? BADGE_MAX + "+" : String(count);
}
export const KINDS = { unknown: "待分类", person: "联系人", group: "群聊" };

// app 是各功能模块共享的数据和操作：app.js 启动时设置，其他模块只读取和调用。
//   state：GET /api/state 的最新结果；refresh：重新拉取并重绘；render：只按现有数据重绘；
//   page：当前页面；selectedAccount、currentPhone：消息页当前的微信号和手机（accounts.js 设置）；
//   showPhone：打开设备详情（phones.js）；diagnosticTask、diagnosticPhone：要在诊断页展开的任务、筛选的设备。
export const app = { state: null, refresh: async () => {}, render: () => {} };

// ---------- 元素 ----------

// el 创建元素；文字一律用 textContent 设置，消息内容不会被当作 HTML 执行。
export function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
}

// button 创建普通按钮（type="button"，不会提交所在的表单）。
export function button(text, className, onClick) {
    const node = el("button", text, className);
    node.type = "button";
    if (onClick) node.onclick = onClick;
    return node;
}

// checkbox 创建勾选框。
export function checkbox(checked, key) {
    const node = el("input");
    node.type = "checkbox";
    node.checked = !!checked;
    if (key) node.dataset.key = key;
    return node;
}

// ---------- 接口与提示 ----------

let toastTimer;
// toast 在页面底部显示提示，一会儿后消失。
export function toast(text) {
    $("toast").textContent = text;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($("toast").hidden = true), TOAST_MS);
}

// api 调用 /api/ 接口：有 body 时 POST JSON，否则 GET；失败时抛出带服务端说明的错误。
export async function api(path, body, idempotencyKey) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let response;
    try {
        response = await fetch("/api/" + path, {
            method: body === undefined ? "GET" : "POST",
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch (_) {
        throw Error("网页服务连接中断，请确认服务仍在运行");
    }
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "请求失败");
    return data;
}

// handleForm 提交对话框里的表单：失败时把错误显示在对话框里，成功后关闭并刷新。
export function handleForm(formId, errorId, save) {
    $(formId).onsubmit = async (e) => {
        e.preventDefault();
        e.submitter.disabled = true;
        try {
            await save();
            $(formId).closest("dialog").close();
            await app.refresh();
        } catch (error) {
            $(errorId).textContent = error.message;
        } finally {
            e.submitter.disabled = false;
        }
    };
}

// storage 浏览器本地存储：隐私模式或禁用存储时读写会抛错，这里忽略，页面照常工作（只是不记住选择）。
export const storage = {
    get(key) {
        try {
            return localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch (_) {}
    }
};

// ---------- 显示格式 ----------

// accountName 显示用的账号名称：有昵称显示昵称，否则显示微信号。选择、请求和存储仍使用微信号。
export function accountName(id) {
    return app.state.accounts.find((a) => a.wechat_id === id)?.nickname || id || "未选择账号";
}

// accountLabel 昵称和微信号都显示，例如“小明（wxid_abc）”。
export function accountLabel(id) {
    const name = accountName(id);
    return id && name !== id ? `${name}（${id}）` : name;
}

// clock 把时间格式化为“时:分”。
export function clock(value) {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
}

// dayLabel 消息日期分隔线：今天、昨天、10月7日、2025年12月31日。
export function dayLabel(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "";
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "今天";
    if (d.toDateString() === yesterday.toDateString()) return "昨天";
    const options = d.getFullYear() === today.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" };
    return d.toLocaleDateString("zh-CN", options);
}

// timeLabel 会话列表用：今天显示时间，其他显示日期。
export function timeLabel(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toDateString() === new Date().toDateString() ? clock(value) : dayLabel(value);
}

// 微信自带的小黄脸表情在无障碍文字里是“[得意]”这样的编码，显示时换成相近的 emoji；不认识的编码原样显示。
const WECHAT_EMOJI = {
    微笑: "🙂", 撇嘴: "😟", 色: "😍", 发呆: "😳", 得意: "😎", 流泪: "😢", 害羞: "😊", 闭嘴: "🤐", 睡: "😴", 大哭: "😭",
    尴尬: "😅", 发怒: "😡", 调皮: "😜", 呲牙: "😁", 惊讶: "😲", 难过: "🙁", 囧: "😳", 抓狂: "😫", 吐: "🤮", 偷笑: "🤭",
    愉快: "😊", 白眼: "🙄", 傲慢: "😤", 困: "😪", 惊恐: "😱", 憨笑: "😄", 悠闲: "😌", 咒骂: "🤬", 疑问: "🤔", 嘘: "🤫",
    晕: "😵", 衰: "😩", 骷髅: "💀", 敲打: "🔨", 再见: "👋", 擦汗: "😓", 鼓掌: "👏", 坏笑: "😏", 鄙视: "😒", 委屈: "🥺",
    快哭了: "🥺", 阴险: "😈", 亲亲: "😘", 可怜: "🥺", 笑脸: "😄", 生病: "😷", 脸红: "😳", 破涕为笑: "😂", 恐惧: "😨", 失望: "😞",
    无语: "😑", 嘿哈: "🤗", 捂脸: "🤦", 奸笑: "😏", 机智: "🤓", 皱眉: "😣", 耶: "✌️", 吃瓜: "🍉", 加油: "💪", 汗: "😓",
    天啊: "😱", Emm: "🤔", 社会社会: "🤙", 旺柴: "🐶", 好的: "👌", 打脸: "🤕", 哇: "😮", 翻白眼: "🙄", 让我看看: "👀", 叹气: "😮‍💨",
    苦涩: "😖", 裂开: "💔", 嘴唇: "💋", 爱心: "❤️", 心: "❤️", 心碎: "💔", 拥抱: "🤗", 强: "👍", 弱: "👎", 握手: "🤝",
    胜利: "✌️", 抱拳: "🙏", 拳头: "👊", OK: "👌", 合十: "🙏", 啤酒: "🍺", 咖啡: "☕", 蛋糕: "🎂", 玫瑰: "🌹", 凋谢: "🥀",
    菜刀: "🔪", 炸弹: "💣", 便便: "💩", 月亮: "🌙", 太阳: "☀️", 庆祝: "🎉", 礼物: "🎁", 红包: "🧧", 福: "🧧", 烟花: "🎆",
    爆竹: "🧨", 猪头: "🐷", 跳跳: "💃", 发抖: "🥶", 转圈: "💫"
};

// emojify 把文字中的微信表情编码换成 emoji（只用于显示，保存的文字不变）。
export function emojify(text) {
    return String(text).replace(/\[([^\[\]]{1,6})\]/g, (code, name) => WECHAT_EMOJI[name] || code);
}
