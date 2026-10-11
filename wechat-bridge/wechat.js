// 微信界面操作（AutoJs6，ES5 语法）：打开聊天、读取可见消息、发送文字和图片。
// 只由 bridge.js 的主线程串行调用。无法核对目标或结果时抛出带 code 的错误并停止，不猜测着继续点击。
var PKG = "com.tencent.mm";

// 微信 8.0.78 的控件编号，config.json 的 profile 可以覆盖。
// message_id、list_id、input_id 没有默认值，必须在配置中校准。
var DEFAULT_PROFILE = {
    title_id: "android:id/text1",
    contact_id: "com.tencent.mm:id/kbq",
    search_contact_id: "com.tencent.mm:id/odf",
    avatar_id: "com.tencent.mm:id/bk1",
    nickname_id: "com.tencent.mm:id/kbb", // “我”页面的微信名，仅展示，不用作账号标识
    account_id: "com.tencent.mm:id/ouv", // “我”页面的“微信号：xxx”
    // 表情包消息的控件描述（正则）；也可以用 sticker_id 指定控件编号。
    // 群成员昵称默认取头像控件的描述“xxx头像”；微信显示群昵称时可以用 sender_id 指定昵称控件编号，优先使用。
    sticker_desc: "^\\[?(动画表情|表情|自定义表情)\\]?$"
};
var MAX_THUMBNAILS = 8; // 每次读取最多截取的图片、表情缩略图数量（整屏只截一次，裁剪很快）
var AVATAR_DESC = /^(.+?)\s*的?头像$/; // 聊天页头像的描述：“张三头像”
var WECHAT_ID = /^微信号\s*[:：]\s*([A-Za-z0-9_-]+)\s*$/; // “我”页面显示的微信号，不是内部的 wxid
var HOME_TABS = ["微信", "通讯录", "发现", "我"];
// 不处理的会话：公众号（旧版微信叫“订阅号消息”）是文章推送的汇总入口，不是聊天；“微信”是微信自己的系统通知。
var IGNORED_CHATS = ["公众号", "订阅号消息", "微信"];
var MAX_PAGES = 20; // 一次读取最多向上翻页次数
// 仅新增模式最多向上翻页次数：只为翻回上次读到的位置（until），让新的一屏能和已有记录接上，不读更早的历史
var NEW_ONLY_MAX_PAGES = 5;
var MAX_ORIGINAL_PAGES = 8; // 读完后为取原图回头找图片时最多向上翻页次数（电脑只要最近 10 条消息里的原图）
// 向上翻页：手指滑过消息列表高度的 80%，用时 500 毫秒。
// Mi Note 3（微信 8.0.78）实测：内容实际移动约 64% 屏（1006/1571 像素），没有惯性，350 毫秒内已停稳；
// 相邻两屏保留约三分之一屏的重叠，足够比对。原来的半屏滑动实际只移动约 37% 屏。
var PAGE_SPAN = 0.8;
var PAGE_SWIPE_MS = 500;
var PAGE_SETTLE_MS = 350; // 翻页后等列表停稳再读取
var ACTION_SCROLL_FORWARD = 4096;
var ACTION_SCROLL_BACKWARD = 8192; // 列表还能向上（更早的消息）滚动时，它的无障碍操作里才有这一项
var PERMISSION_UI = /packageinstaller|permissioncontroller|lbe\.security/; // 系统权限弹窗所属的包
// 读取提前停止的原因 → 降级说明（结果可能不完整）
// ---------- 界面等待 ----------
// 等待时间按实测微信 8.0.78（Mi Note 3）的反应速度留出余量；手机慢时宁可多等，不猜测着继续点击。
var POLL_MS = 150; // waitFor 检查条件的间隔
var SCREEN_SWITCH_MS = 1500; // 点击、返回后等页面切换（聊天信息页、首页标签、大图返回等）
var VERIFY_CHAT_MS = 1800; // 核对聊天前等消息列表出现
var PAGE_LOAD_MS = 3000; // 等页面或控件出现：进入聊天、搜索框和搜索结果、“我”页面、分享收件人、大图
var APP_LAUNCH_MS = 5000; // 等微信启动到前台
var TAB_SWITCH_MS = 800; // 返回后等首页标签出现
var BACK_SETTLE_MS = 350; // 按返回后等界面停稳
var RETURN_SETTLE_MS = 500; // 回到会话列表、关闭菜单后等界面停稳
var SEARCH_STABLE_MS = 180; // 搜索结果的位置连续这么久不变，才认为加载完成
var SEARCH_OPEN_MS = 2000; // 点搜索结果后等聊天页或资料页出现
var VIEWER_SETTLE_MS = 800; // 大图打开后等图片显示
var FULL_IMAGE_MS = 20000; // 等“查看原图”加载完：原图可能有几 MB
var LONG_PRESS_MS = 800; // 长按图片弹出菜单的按压时长
var MENU_OPEN_MS = 2500; // 等长按菜单或键盘输入框出现
var SAVED_FILE_MS = 8000; // 点“保存图片”后等新文件写入相册
var FILE_STABLE_MS = 300; // 文件大小这么久不变才算写完
var CLOCK_SKEW_MS = 2000; // 找新保存的图片时，容许文件时间与手机时钟的误差
var SEND_BUTTON_MS = 2000; // 填入文字后等“发送”按钮出现
var SEND_CONFIRM_MS = 5000; // 点发送后等界面出现新消息
var SHARE_PAGE_MS = 5000; // 等微信分享页出现（可能先弹出权限框）
var SHARE_BACK_SETTLE_MS = 600; // 退出分享页时每次返回后等界面停稳
var SCROLL_CHECK_MS = 250; // 判断能否继续上翻时，重新检查的间隔
var TOP_CONFIRM_MS = 1000; // 列表报告到顶后再等这么久确认（微信可能正在加载更早的消息）
var SCROLL_STEP_MS = 300; // 滑到底部时每滚一页后等列表停稳

// ---------- 界面上限 ----------
var MAX_BACK_STEPS = 6; // 回首页最多按几次返回
var MAX_VIEWER_BACKS = 3; // 退出大图最多按几次返回
var MAX_MESSAGE_ROW_HOPS = 6; // 从消息控件向上找所在行（消息列表的直接子控件）的层数
var MIN_IMAGE_TAP_PX = 60; // 图片露出的高度不到这么多就不点：点在边缘容易点到标题栏、输入框或旁边的消息，翻页后再点
var MAX_SHARE_BACKS = 3; // 退出分享页最多按几次返回（收起键盘、退出搜索、关闭分享页）
var MAX_SCROLL_STEPS = 80; // 滑到底部最多滚几页
var MAX_PARENT_HOPS = 8; // 点击时向上找可点击父控件的层数
var MAX_ROW_HOPS = 6; // 从会话名称向上找整行的层数
var MAX_ROW_DEPTH = 8; // 收集会话行文字时向下的层数
var SYSTEM_NOTICE_DEPTH = 3; // 系统提示挂在消息列表下几层以内（普通消息外面还有一层带头像的行）
var MIN_SHARED_MESSAGES = 2; // 两屏至少有这么多条连续相同的消息才算同一个聊天（消息少时 1 条）
var SENDER_LABEL_PX = 60; // 群昵称与头像顶部的最大距离
var AVATAR_ROW_PX = 80; // 消息与头像顶部的最大距离，超过就不算这个人发的
var BADGE_MAX_PX = 100; // 未读数字角标的最大宽度，用来和会话名称里的数字区分
var MAX_CLIP_CHARS = 500000; // 裁剪的图片（JPEG Base64）最大长度
var THUMBNAIL_QUALITY = 92; // 缩略图和大图截图的 JPEG 质量：尺寸受屏幕限制，质量尽量高
var AVATAR_QUALITY = 90; // 头像的 JPEG 质量
var SAMPLE_DESC_CHARS = 20; // 没识别的消息附近控件描述，每种最多的字数
var SAMPLE_DESC_KINDS = 3; // 最多附几种描述
var SAMPLE_ABOVE_PX = 10; // 从头像上方这么远开始找控件
var SAMPLE_BELOW_PX = 300; // 到头像下方这么远为止

var READ_STOP_WARNINGS = {
    unverified_overlap: "向上翻页时相邻两屏没能比对上，读取提前停止，更早的消息可能没读到",
    page_cap: "翻到 " + MAX_PAGES + " 页上限仍没读到已有记录，中间的消息可能没读到",
    scroll_failed: "消息列表滑动失败，读取提前停止",
    empty_screen: "向上翻到的一屏没有能识别的消息（链接卡片、语音等），无法和已读部分比对，读取提前停止"
};

module.exports = function (config, workDir) {
    // 合并控件编号：默认值在前，配置中非空的值覆盖默认值
    var profile = {};
    [DEFAULT_PROFILE, config.profile || {}].forEach(function (source) {
        for (var key in source) if (source[key]) profile[key] = source[key];
    });
    // 聊天名称 → { query: 搜索使用的名称, title: 标题上显示的名称, list_name: 会话列表里的名称 }（都用于名称匹配）
    var aliases = config.chat_aliases || {};
    var deadline = 0;
    var clicked = false; // 本次任务是否已点击发送；点击后出错只能报告“结果未知”
    var captureFailed = false; // 截图授权失效（例如被其他脚本的截图申请顶掉），微信桥会重新申请
    var originalsDir = workDir + "originals/";

    // failWithScreen 先把当前屏幕截图（缩小一半）记入执行记录再报错，诊断页可以看到出错时手机上的画面。
    function failWithScreen(code, message) {
        try {
            var shot = capture(),
                small = images.scale(shot, 0.5, 0.5);
            step("出错时的屏幕", message, String(images.toBase64(small, "jpg", 50)));
            small.recycle();
            shot.recycle();
        } catch (_) {}
        fail(code, message);
    }

    // fail 抛出带错误代码的异常，由 bridge.js 记入任务结果。
    function fail(code, message) {
        var e = new Error(message);
        e.code = code;
        throw e;
    }

    // clock 返回开机以来的毫秒数，不受系统时间调整影响，用于计时和超时。
    function clock() {
        return android.os.SystemClock.elapsedRealtime();
    }

    // capture 截取整个屏幕并复制一份（调用方用完需 recycle）；失败时标记截图授权失效并抛出异常。
    function capture() {
        try {
            return images.copy(captureScreen());
        } catch (e) {
            captureFailed = true;
            fail("CAPTURE_FAILED", "截图失败，截图授权可能已失效，微信桥会在手机解锁时重新申请");
        }
    }

    // ---------- 执行记录 ----------
    // 每次操作记录执行步骤和降级（例如原图改用截图），随结果上报，供诊断页查看。
    var diag = { started: 0, steps: [], warnings: [] };

    // step 记录一个执行步骤及其距操作开始的毫秒数；image 是可选的截图（JPEG Base64），诊断页会显示。
    function step(name, detail, image) {
        var item = { ms: clock() - diag.started, step: name, detail: detail || "" };
        if (image) item.image = image;
        diag.steps.push(item);
    }

    // 降级：操作仍然完成了，但用了不太可靠的办法或结果不完整。同一次操作中相同的降级只记一次。
    function warn(code, message) {
        for (var i = 0; i < diag.warnings.length; i++) if (diag.warnings[i].code === code && diag.warnings[i].message === message) return;
        diag.warnings.push({ code: code, message: message });
        step("降级", message);
    }

    // diagnostics 返回本次操作的执行记录：总耗时、步骤和降级。
    function diagnostics() {
        return { duration_ms: clock() - diag.started, steps: diag.steps, warnings: diag.warnings };
    }

    // 开始一次新操作：重设超时、清除“已点击发送”标记和执行记录。
    function begin(timeoutMs) {
        deadline = clock() + timeoutMs;
        clicked = false;
        diag = { started: clock(), steps: [], warnings: [] };
    }

    // screenLocked 屏幕关闭或处于锁屏界面时返回 true。
    function screenLocked() {
        return !device.isScreenOn() || context.getSystemService("keyguard").isKeyguardLocked();
    }

    // 每个界面步骤前检查：未超时、无障碍开启、屏幕解锁。
    function check() {
        if (clock() > deadline) fail("UI_TIMEOUT", "界面操作超时");
        if (!auto.service) fail("ACCESSIBILITY_DISABLED", "无障碍服务已关闭");
        if (screenLocked()) fail("SCREEN_LOCKED", "请保持手机亮屏并解锁");
    }

    // waitFor 每 150 毫秒检查一次 condition，返回它第一次的真值；超时返回 null。每次检查前都会 check()。
    function waitFor(condition, timeoutMs) {
        var until = clock() + timeoutMs;
        do {
            check();
            var found = condition();
            if (found) return found;
            sleep(POLL_MS);
        } while (clock() < until);
        return null;
    }

    // ---------- 控件查找 ----------

    // all 返回微信中所有可见的匹配控件（转成普通数组）。
    function all(selector) {
        var found = selector.packageName(PKG).visibleToUser(true).find(),
            list = [];
        for (var i = 0; i < found.size(); i++) list.push(found.get(i));
        return list;
    }

    // one 返回微信中第一个可见的匹配控件，没有返回 null。
    function one(selector) {
        return selector.packageName(PKG).visibleToUser(true).findOnce();
    }

    // 同一控件可能被重复返回，按位置和文字去重。
    function unique(nodes) {
        var seen = {};
        return nodes.filter(function (n) {
            var key = String(n.bounds()) + String(n.text());
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });
    }

    // 前台应用：取获得焦点的应用窗口（TYPE_APPLICATION = 1）所属的包。
    // 不能只看 currentPackage()：它是最近一次无障碍事件的来源，通知栏、输入法、朗读服务都会把它改掉。
    function foregroundPackage() {
        if (auto.service) {
            var windows = auto.service.getWindows();
            for (var i = 0; i < windows.size(); i++) {
                var w = windows.get(i),
                    root = w.getType() === 1 && w.isFocused() ? w.getRoot() : null;
                if (root) return String(root.getPackageName());
            }
        }
        return currentPackage();
    }

    // inWechat 判断微信是否在前台。
    function inWechat() {
        return foregroundPackage() === PKG;
    }

    // 聊天页面的消息列表；不在聊天页面时返回 null。
    function messageList() {
        return inWechat() ? one(id(profile.list_id)) : null;
    }

    // tap 点击控件；控件本身不可点击时向上找最多 8 层可点击的父控件。点击前确认微信在前台。
    function tap(node) {
        check();
        if (!inWechat()) fail("WRONG_APP", "当前前台不是微信");
        for (var p = node, i = 0; p && i < MAX_PARENT_HOPS; i++, p = p.parent()) {
            if (p.clickable() && p.click()) return;
        }
        fail("NOT_CLICKABLE", "目标控件无法点击");
    }

    // 位于列表区域内（排除顶部标题栏和底部导航）且尺寸有效。
    function inListArea(b) {
        return (
            b.width() > 0 &&
            b.height() > 0 &&
            b.left >= 0 &&
            b.right <= device.width &&
            b.top > device.height * 0.12 &&
            b.bottom < device.height * 0.9
        );
    }

    // 去掉群人数后缀“(123)”（右括号可能被截断）。
    function withoutMemberCount(title) {
        return String(title).replace(/\s*[（(]\d{1,6}[）)]?\s*$/, "");
    }

    // 标题比较前的统一处理：去掉群人数后缀、空白和表情变体选择符，
    // 各种爱心写法（微信通知里的 [心]、❤、♥ 等）统一为 ♥，忽略大小写。
    function normalizeTitle(title) {
        return withoutMemberCount(title)
            .replace(/\[心\]|[❤♥♡❣]|\uD83D[\uDC93-\uDC9F]/g, "♥")
            .replace(/[\s\uFE0E\uFE0F]/g, "")
            .toLowerCase();
    }

    // 同一个聊天可能出现的所有写法：通知/会话名、搜索名、标题、会话列表名（别名配置中的 query、title、list_name）。
    function titleVariants(name) {
        var alias = aliases[name] || {};
        return [name, alias.query, alias.title, alias.list_name]
            .filter(function (t) {
                return t;
            })
            .map(normalizeTitle);
    }

    // chatName 把看到的名称换回配置中的聊天名称（匹配别名的任一写法），没有别名时原样返回。
    function chatName(label) {
        var key = normalizeTitle(label);
        for (var name in aliases) if (titleVariants(name).indexOf(key) >= 0) return name;
        return label;
    }

    // namedRows 会话行（首页列表、分享页搜索结果都是这种控件）中名称与 name 的某种写法一致的，按位置去重。
    // listAreaOnly 为 true 时排除标题栏、底部导航处的控件。
    function namedRows(name, listAreaOnly) {
        var variants = titleVariants(name);
        return unique(
            all(id(profile.contact_id)).filter(function (n) {
                return variants.indexOf(normalizeTitle(n.text())) >= 0 && (!listAreaOnly || inListArea(n.bounds()));
            })
        );
    }

    // searchFor 等搜索框出现并填入 query；成功返回 true。
    function searchFor(query) {
        var box = waitFor(function () {
            return one(className("android.widget.EditText"));
        }, PAGE_LOAD_MS);
        return !!box && box.setText(query);
    }

    // searchQuery 聊天在搜索时使用的名称（别名配置中的 query），没有就用聊天名称。
    function searchQuery(name) {
        return (aliases[name] || {}).query || name;
    }

    // ---------- 核对当前聊天 ----------
    // 当前微信（8.0.78）的聊天页不向无障碍服务提供标题控件，进入聊天后读不出“这是谁”。所以：
    //   - 进入前确认：首页会话列表或搜索结果中，名称与目标完全一致且唯一的那一项，点击它进入；
    //   - 进入后记下屏幕上的消息，之后（点发送前、读取前后）确认当前屏幕仍能和它接上，以发现中途被切到别的聊天。
    // 如果某个微信版本提供了标题控件，则优先用标题精确核对。

    var entered = { name: "", screen: [] }; // 最近一次确认进入的聊天，以及最近一次确认时屏幕上的消息

    // nativeTitle 读取聊天页标题控件的文字（只看屏幕顶部 20% 内的），没有返回 null。
    function nativeTitle() {
        var nodes = all(id(profile.title_id));
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].bounds().top < device.height * 0.2 && nodes[i].text()) return String(nodes[i].text());
        }
        return null;
    }

    // titleMatches 标题控件可用时返回标题是否就是 name；没有标题控件时返回 null（无法判断）。
    function titleMatches(name) {
        var title = nativeTitle();
        return title === null ? null : titleVariants(name).indexOf(normalizeTitle(title)) >= 0;
    }

    // sameChatScreen 两屏消息能否接上：有至少 2 条连续相同的消息（消息少时 1 条）。
    // 新消息把旧消息挤出屏幕、或稍微滚动过，都仍能接上；换成别的聊天则接不上。
    function sameChatScreen(before, now) {
        var need = Math.min(MIN_SHARED_MESSAGES, before.length, now.length);
        if (!need) return true; // 没有消息可比（例如刚开始的新聊天），无法判断，视为没有切换
        for (var i = 0; i < before.length; i++) {
            for (var j = 0; j < now.length; j++) {
                var k = 0;
                while (i + k < before.length && j + k < now.length && sameMessage(before[i + k], now[j + k])) k++;
                if (k >= need) return true;
            }
        }
        return false;
    }

    // chatProblem 检查当前是否仍在 name 的聊天里，没问题返回 null，否则返回 { code, message }。
    // 通过时用当前屏幕更新比对基准（屏幕会随新消息滚动）。
    function chatProblem(name) {
        if (!messageList()) return { code: "CHAT_MISMATCH", message: "已不在聊天页面，已停止操作" };
        var byTitle = titleMatches(name);
        if (byTitle === true) return null;
        if (byTitle === false) return { code: "CHAT_MISMATCH", message: "聊天标题「" + nativeTitle() + "」与「" + name + "」不一致，已停止操作" };
        // 没有标题控件：必须是刚确认进入的聊天，且屏幕内容和上次确认时接得上
        if (entered.name !== name) return { code: "CHAT_MISMATCH", message: "没有确认进入「" + name + "」，已停止操作" };
        var now = visibleMessages(null);
        if (!sameChatScreen(entered.screen, now))
            return { code: "CHAT_CHANGED", message: "当前屏幕的消息与进入「" + name + "」时接不上，可能被切换到了别的聊天，已停止操作" };
        entered.screen = now;
        return null;
    }

    // verifyChat 确认当前仍在 name 的聊天里（点发送前、读取前后调用），否则附上屏幕截图报错。
    function verifyChat(name) {
        waitFor(messageList, VERIFY_CHAT_MS);
        var problem = chatProblem(name);
        if (problem) failWithScreen(problem.code, problem.message);
    }

    // stillInChat 不报错的 verifyChat，供后台监测判断是否仍在最近操作的聊天里。
    function stillInChat(name) {
        return !chatProblem(name);
    }

    // confirmEntered 点击会话后等聊天页出现；有标题控件时再核对标题；然后记下当前屏幕作为比对基准。
    function confirmEntered(name, how) {
        if (!waitFor(messageList, PAGE_LOAD_MS)) failWithScreen("CHAT_NOT_OPENED", "点击「" + name + "」后没有进入聊天页面，已停止操作");
        if (titleMatches(name) === false)
            failWithScreen("CHAT_MISMATCH", "进入后的聊天标题「" + nativeTitle() + "」与「" + name + "」不一致，已停止操作");
        entered = { name: name, screen: visibleMessages(null) };
        step("打开聊天", how);
    }

    // inChat 当前是否在聊天页（不管是哪个聊天）。
    function inChat() {
        return !!messageList();
    }

    // currentChat 当前打开的聊天名称（来自标题控件），用于监测手动打开的聊天；读不到标题时返回 null。
    function currentChat() {
        if (!messageList()) return null;
        var title = nativeTitle();
        return title && title !== "微信" ? chatName(withoutMemberCount(title)) : null;
    }

    // 只在主动读取未分类会话时打开详情；不凭名称、消息人数或缺少群人数猜测。
    function identifyChatKind(name) {
        verifyChat(name);
        var button = one(desc("聊天信息"));
        if (!button) return "unknown";
        var opened = false;
        try {
            tap(button);
            opened = !!waitFor(function () { return !messageList(); }, SCREEN_SWITCH_MS);
            if (!opened) return "unknown";
            var kind = waitFor(function () {
                if (!inWechat()) return null;
                var activity = String(currentActivity());
                if (activity === "com.tencent.mm.ui.SingleChatInfoUI") return "person";
                if (activity === "com.tencent.mm.chatroom.ui.ChatroomInfoUI") return "group";
                return null;
            }, SCREEN_SWITCH_MS);
            return kind || "unknown";
        } finally {
            if (opened && inWechat()) {
                back();
                verifyChat(name);
            }
        }
    }

    // ---------- 打开聊天 ----------

    // 先恢复微信已有任务；部分系统会拦截指定 Activity，失败后用系统启动入口重试。
    function launchWechat() {
        if (inWechat()) return;
        var launchError = "";
        try {
            app.startActivity({
                packageName: PKG,
                className: "com.tencent.mm.ui.LauncherUI",
                flags: ["activity_new_task", "activity_reset_task_if_needed"]
            });
        } catch (e) { launchError = String(e.message || e); }
        if (waitFor(inWechat, APP_LAUNCH_MS)) return;
        step("重试启动微信", "使用系统应用启动入口");
        try {
            var intent = context.getPackageManager().getLaunchIntentForPackage(PKG);
            if (!intent) fail("WECHAT_NOT_INSTALLED", "未找到微信，请确认微信已安装在当前用户空间");
            intent.addFlags(0x10000000); // FLAG_ACTIVITY_NEW_TASK
            context.startActivity(intent);
        } catch (e) {
            if (e.code === "WECHAT_NOT_INSTALLED") throw e;
            launchError = String(e.message || e);
        }
        if (!waitFor(inWechat, APP_LAUNCH_MS)) {
            var front = foregroundPackage();
            var hint = PERMISSION_UI.test(front)
                ? "；系统权限弹窗挡在前面，请在手机上处理"
                : "；请解锁手机，并允许手机端服务在后台弹出界面";
            fail("WECHAT_NOT_OPEN", "自动打开微信失败，当前前台是 " + front + hint + (launchError ? "（" + launchError + "）" : ""));
        }
    }

    // 微信底部“微信”标签和顶部搜索按钮同时可见，说明在首页。
    function homeControls() {
        var tab = one(id("com.tencent.mm:id/icon_tv").text("微信"));
        var search = one(desc("搜索"));
        return tab && search && tab.bounds().top > device.height * 0.7 ? { tab: tab, search: search } : null;
    }

    // 连续返回直到出现首页，并切换到“微信”消息列表标签。
    function goHome() {
        for (var i = 0; i < MAX_BACK_STEPS; i++) {
            check();
            if (!inWechat()) fail("WRONG_APP", "导航期间微信失去前台，已停止操作");
            var home = homeControls();
            // 在首页但不在“微信”标签（例如在通讯录）：点底部“微信”标签
            if (home && nativeTitle() !== "微信") {
                tap(home.tab);
                home = waitFor(homeControls, SCREEN_SWITCH_MS);
            }
            if (home) return home;
            // 还没到首页：按一次返回
            back();
            sleep(BACK_SETTLE_MS);
        }
        fail("HOME_NOT_FOUND", "无法返回微信消息列表，请手动打开微信首页");
    }

    // ---------- 当前账号 ----------
    // 在“我”页面读取用户可见的“微信号”（不是内部的 wxid），用于区分登录的账号。不截图、不 OCR。

    // homeTabs 首页底部“微信、通讯录、发现、我”四个标签都可见时返回 {标签名: 控件}，否则返回 null。
    function homeTabs() {
        var tabs = {};
        for (var i = 0; i < HOME_TABS.length; i++) {
            var node = all(text(HOME_TABS[i])).filter(function (n) {
                return n.bounds().top > device.height * 0.8;
            })[0];
            if (!node) return null;
            tabs[HOME_TABS[i]] = node;
        }
        return tabs;
    }

    // backToTabs 在聊天页等有返回的页面时逐次返回，直到出现首页标签；每次返回后短间隔轮询等页面切换。
    // 刚启动微信时其他应用（例如刚部署完的 AutoJs6）可能短暂抢回前台：微信不在前台时重新启动一次。
    function backToTabs() {
        var relaunched = false;
        for (var i = 0; i < MAX_BACK_STEPS; i++) {
            check();
            if (!inWechat() && !relaunched) {
                relaunched = true;
                step("重新启动微信", "前台是 " + foregroundPackage());
                launchWechat();
            }
            if (!inWechat()) fail("WRONG_APP", "返回首页期间微信失去前台，已停止操作");
            var tabs = homeTabs();
            if (tabs) return tabs;
            back();
            waitFor(homeTabs, TAB_SWITCH_MS);
        }
        fail("HOME_NOT_FOUND", "无法返回微信首页（没有找到底部的微信、通讯录、发现、我）");
    }

    // wechatIdOf 从控件的文字或描述中提取微信号，不符合格式返回 null。
    function wechatIdOf(node) {
        var m = WECHAT_ID.exec(String(node.text() || "")) || WECHAT_ID.exec(String(node.desc() || ""));
        return m ? m[1] : null;
    }

    // 只在已核实“我”页面的微信号后读取昵称；读取不到留空，不猜测账号名称。
    function accountNickname() {
        var node = one(id(profile.nickname_id));
        return node ? String(node.text() || "").trim() : "";
    }

    // accountOnMePage 在“我”页面读取微信号，不在“我”页面或读不到返回 null。
    // “我”是四个标签中唯一顶部没有搜索按钮的页面；聊天列表里的“微信号：xxx”不会被误认为当前账号。
    function accountOnMePage() {
        if (!homeTabs() || one(desc("搜索"))) return null;
        // 优先按控件编号读取
        var byId = one(id(profile.account_id));
        var found = byId && wechatIdOf(byId);
        if (found) return { wechat_id: found, nickname: accountNickname(), source: "控件编号" };
        // 控件编号随微信版本失效时：在“我”页面上半部分找文字或描述符合格式的控件
        var nodes = all(textMatches(WECHAT_ID)).concat(all(descMatches(WECHAT_ID)));
        for (var i = 0; i < nodes.length; i++) {
            found = nodes[i].bounds().top < device.height * 0.5 && wechatIdOf(nodes[i]);
            if (found) return { wechat_id: found, nickname: accountNickname(), source: "文字匹配" };
        }
        return null;
    }

    // identifyAccount 识别当前登录账号：回到首页 → 点“我” → 读微信号 → 回到“微信”标签。
    // 识别失败时报错，不沿用之前的结果。
    function identifyAccount() {
        check();
        // 1. 当前窗口必须是微信，否则启动微信
        var root = auto.rootInActiveWindow;
        if (!root || String(root.getPackageName()) !== PKG) {
            step("启动微信", "当前窗口不是微信");
            launchWechat();
        }
        // 2. 回到首页，点“我”，等页面切换完成并读出微信号
        tap(backToTabs()["我"]);
        step("打开“我”页面");
        var found = waitFor(accountOnMePage, PAGE_LOAD_MS);
        try {
            if (!found) fail("ACCOUNT_NOT_FOUND", "“我”页面没有找到“微信号：xxx”，可能需要校准 profile.account_id");
            step("读取微信号", found.wechat_id + "（" + found.source + "）");
            return found;
        } finally {
            // 3. 无论成功与否都回到“微信”标签
            var tabs = homeTabs();
            if (tabs) {
                tap(tabs["微信"]);
                waitFor(homeControls, SCREEN_SWITCH_MS);
                step("回到“微信”标签");
            }
        }
    }

    // 用微信全局搜索打开聊天：搜索结果必须稳定且唯一。
    function searchChat(name, group, searchButton) {
        var query = searchQuery(name);
        tap(searchButton);
        if (!searchFor(query)) fail("SEARCH_FAILED", "无法输入联系人搜索名称");
        var candidates = [],
            lastKey = null,
            stableSince = 0;
        // 等搜索结果稳定：连续 180 毫秒结果的位置不变，才认为加载完成
        // 群聊按文字找，联系人按联系人结果控件找；排除搜索框本身和屏幕边缘的控件
        var settled = waitFor(function () {
            var selector = group ? text(query) : id(profile.search_contact_id).text(query);
            candidates = all(selector).filter(function (n) {
                return String(n.className()) !== "android.widget.EditText" && inListArea(n.bounds());
            });
            var key = candidates
                .map(function (n) {
                    return String(n.bounds());
                })
                .join("|");
            if (!candidates.length || key !== lastKey) {
                lastKey = key;
                stableSince = clock();
                return false;
            }
            return clock() - stableSince >= SEARCH_STABLE_MS;
        }, PAGE_LOAD_MS);
        // 结果必须唯一，否则停止，避免进错聊天
        if (!settled || candidates.length !== 1) failWithScreen("CONTACT_AMBIGUOUS", "未找到唯一精确联系人或群，请使用唯一备注名");
        tap(candidates[0]);
        // 联系人结果可能先打开资料页，需要再点“发消息”。
        if (
            !waitFor(function () {
                return messageList() || one(text("发消息"));
            }, SEARCH_OPEN_MS)
        )
            fail("CHAT_MISMATCH", "搜索结果未打开可确认的聊天页面");
        var sendButton = one(text("发消息"));
        if (sendButton && !messageList()) tap(sendButton);
        confirmEntered(name, "通过全局搜索「" + query + "」进入");
    }

    // 打开聊天：依次尝试 仍在该聊天里 → 首页会话列表 → 全局搜索。进入前都按名称精确匹配且必须唯一。
    function openChat(name, group) {
        check();
        // 微信不在前台就先启动
        if (!inWechat()) {
            step("启动微信", "前台是 " + foregroundPackage());
            launchWechat();
        }
        // 标题一致，或仍在上次确认进入的同一个聊天里（屏幕内容接得上）：不用重新进入
        if (messageList()) {
            if (titleMatches(name) === true) return step("打开聊天", "已在目标聊天（标题一致）");
            if (stillInChat(name)) return step("打开聊天", "仍在上次进入的聊天里（屏幕内容接得上）");
        }
        // 否则回首页，在会话列表里找名称完全一致的那一行；找到多个同名就停止
        var home = goHome();
        var rows = namedRows(name, true);
        if (rows.length > 1) failWithScreen("CONTACT_AMBIGUOUS", "消息列表存在多个同名目标，请使用唯一备注名");
        if (rows.length === 1) {
            var label = String(rows[0].text());
            tap(rows[0]);
            confirmEntered(name, "从首页会话列表点击「" + label + "」进入");
            return;
        }
        step("打开聊天", "首页没有该会话，使用全局搜索");
        searchChat(name, group, home.search);
    }

    // returnToList 在聊天页时按一次返回，回到首页会话列表。
    function returnToList() {
        if (messageList()) {
            back();
            sleep(RETURN_SETTLE_MS);
        }
    }

    // ---------- 读取消息 ----------

    // 头像控件：位置和发送人名称。名称优先取群昵称控件（配置了 sender_id 时），否则取头像描述“xxx头像”。
    function avatarsOnScreen() {
        var labels = profile.sender_id
            ? all(id(profile.sender_id)).filter(function (n) {
                  return n.text();
              })
            : [];
        return all(id(profile.avatar_id)).map(function (n) {
            var b = n.bounds(),
                sender = avatarName(n);
            // 群昵称显示在头像旁边、与头像顶部基本齐平
            labels.forEach(function (l) {
                var lb = l.bounds();
                if (Math.abs(lb.top - b.top) < SENDER_LABEL_PX && side(b) === side(lb)) sender = String(l.text());
            });
            return { bounds: b, sender: sender, used: false };
        });
    }

    // avatarName 头像描述“xxx头像”里的名称，没有返回空字符串。
    function avatarName(node) {
        var named = AVATAR_DESC.exec(String(node.desc() || ""));
        return named ? named[1] : "";
    }

    // messageRow 消息所在的行：消息列表的直接子控件，里面有这条消息和发送人的头像。找不到返回 null。
    function messageRow(node) {
        for (var p = node, i = 0; p && i < MAX_MESSAGE_ROW_HOPS; i++) {
            var parent = p.parent();
            if (parent && String(parent.id()) === profile.list_id) return p;
            p = parent;
        }
        return null;
    }

    // rowAvatar 和消息在同一行的头像。长消息停在屏幕顶部时头像已滚出屏幕，按位置找不到，
    // 但它仍在这一行的控件里，描述“xxx头像”照样能读到。
    // 屏幕上看得见的返回 avatars 里对应的那一项；看不见的返回 { bounds, sender, hidden: true }；行里没有头像返回 null。
    function rowAvatar(node, avatars) {
        var row = messageRow(node),
            found = row ? row.findOne(id(profile.avatar_id)) : null;
        if (!found) return null;
        var b = found.bounds();
        for (var i = 0; i < avatars.length; i++) if (avatars[i].bounds.equals(b)) return avatars[i];
        var label = profile.sender_id ? row.findOne(id(profile.sender_id)) : null;
        return { bounds: b, sender: label && label.text() ? String(label.text()) : avatarName(found), hidden: true };
    }

    // nearestAvatar 同一高度附近（80 像素内）的头像，没有返回 null。
    function nearestAvatar(bounds, avatars) {
        var best = AVATAR_ROW_PX,
            result = null;
        avatars.forEach(function (a) {
            var distance = Math.abs(a.bounds.top - bounds.top);
            if (distance < best) {
                best = distance;
                result = a;
            }
        });
        return result;
    }

    // side 控件在屏幕左半边为收到的消息，右半边为发出的消息。
    function side(bounds) {
        return bounds.centerX() < device.width / 2 ? "incoming" : "outgoing";
    }

    // systemNotice 没有头像的文字是否为系统提示（“你的账号被限制与对方聊天”“xx撤回了一条消息”等）：
    // 微信 8.0.78 的系统提示直接挂在消息列表下两层，普通消息外面还有一层带头像的行容器。
    function systemNotice(node) {
        for (var p = node.parent(), i = 0; p && i < SYSTEM_NOTICE_DEPTH; i++, p = p.parent()) {
            if (String(p.id()) === profile.list_id) return true;
        }
        return false;
    }

    // avatarSide 头像在哪一侧（incoming | outgoing）。看不见的头像位置不可靠，借用屏幕上同名头像的位置，没有返回 unknown。
    function avatarSide(who, avatars) {
        if (!who.hidden) return side(who.bounds);
        for (var i = 0; i < avatars.length; i++) {
            if (who.sender && avatars[i].sender === who.sender) return side(avatars[i].bounds);
        }
        return "unknown";
    }

    // withSender 记下发送这条消息的头像：发送人名称和头像位置（用于截取头像）。
    // 先找同一行里的头像，行结构认不出时再按位置找旁边的头像。
    // 文字消息的方向看头像在哪一侧，没有头像或判断不了时记为 unknown；
    // 图片、表情的方向看自身位置，只采用同一侧的头像。
    function withSender(item, node, avatars, byAvatar) {
        var bounds = node.bounds(),
            who = rowAvatar(node, avatars) || nearestAvatar(bounds, avatars),
            whoSide = who ? avatarSide(who, avatars) : "unknown";
        if (who && !byAvatar && whoSide !== "unknown" && whoSide !== item.direction) who = null;
        if (byAvatar) item.direction = who ? whoSide : "unknown";
        if (!who) return item;
        who.used = true;
        if (who.sender) item.sender = who.sender;
        if (!who.hidden) item.avatar_bounds = who.bounds;
        return item;
    }

    // 消息列表里的图片：微信 8.0.78 的图片消息是描述为“图片”、可点击的容器（里面才是 ImageView）。
    // 可以用 profile.image_id 指定控件编号。
    function imageNodes(area) {
        var nodes = profile.image_id ? all(id(profile.image_id)) : all(desc("图片"));
        return unique(
            nodes.filter(function (n) {
                var b = n.bounds();
                return b.bottom > area.top && b.top < area.bottom && b.width() > 0 && b.height() > 0;
            })
        );
    }

    // 表情包消息（自定义表情、动画表情）。可以用 profile.sticker_id 指定控件编号，否则按描述 profile.sticker_desc 匹配。
    function stickerNodes(area) {
        var nodes = profile.sticker_id ? all(id(profile.sticker_id)) : all(descMatches(new RegExp(profile.sticker_desc)));
        return unique(
            nodes.filter(function (n) {
                var b = n.bounds();
                return b.bottom > area.top && b.top < area.bottom && b.width() > 0 && b.height() > 0;
            })
        );
    }

    // clipJPEG 从整屏截图中裁剪一块，返回 JPEG Base64；失败或过大返回 null。
    function clipJPEG(shot, b, quality) {
        var crop = null;
        try {
            crop = images.clip(shot, b.left, b.top, b.width(), b.height());
            var data = String(images.toBase64(crop, "jpg", quality));
            return data.length > MAX_CLIP_CHARS ? null : data;
        } catch (_) {
            return null;
        } finally {
            if (crop) crop.recycle();
        }
    }

    // 从整屏截图中裁剪缩略图（JPEG Base64）。
    function attachThumbnail(item, shot, b) {
        // 缩略图尺寸受限于手机屏幕上的显示大小，压缩质量尽量高；清晰的图片靠“取原图”。
        var data = clipJPEG(shot, b, THUMBNAIL_QUALITY);
        if (data) item.thumbnail = data;
        else item.image_error = "缩略图获取失败";
    }

    // 读取当前屏幕上的消息，从上到下排序。
    // budget 为 null 时不截图；否则最多截取 budget.images 张缩略图（会递减），
    // 并为 budget.avatars 中还没有的发送人截取一次头像。整屏只截一次，用到时才截。
    function visibleMessages(budget) {
        var list = messageList();
        if (!list) fail("MESSAGE_LIST_MISSING", "消息列表不可用");
        var area = list.bounds(),
            avatars = avatarsOnScreen(), // 位置用来判断每条消息是收到的还是发出的，描述是发送人名称
            screen = { shot: null };
        try {
            var result = textMessages(area, avatars).concat(mediaMessages(area, avatars, budget, screen));
            if (budget) {
                clipAvatars(result, area, budget, screen);
                noteUnrecognized(avatars, area, budget);
            }
        } finally {
            if (screen.shot) screen.shot.recycle();
        }
        return result.sort(function (a, b) {
            return a.top - b.top || a.left - b.left;
        });
    }

    // screenShot 本次读取的整屏截图，第一次用到时才截。
    function screenShot(screen) {
        if (!screen.shot) screen.shot = capture();
        return screen.shot;
    }

    // textMessages 文字消息：有文字且与消息列表区域有交集的气泡；没有头像、挂在列表下的是系统提示。
    function textMessages(area, avatars) {
        var result = [];
        unique(all(id(profile.message_id))).forEach(function (n) {
            var b = n.bounds();
            if (!n.text() || b.bottom <= area.top || b.top >= area.bottom) return;
            var item = withSender({ text: String(n.text()), top: b.top, left: b.left }, n, avatars, true);
            if (item.direction === "unknown" && systemNotice(n)) item.kind = "system";
            result.push(item);
        });
        return result;
    }

    // mediaMessages 图片和表情：方向看控件在屏幕左半边还是右半边；有额度时截取缩略图。
    // 被屏幕边缘截断的只记录位置，不截缩略图（翻页时会在完整显示的那一屏补上）。
    function mediaMessages(area, avatars, budget, screen) {
        var media = imageNodes(area).map(function (n) {
            return { node: n, text: "[图片]", kind: "image" };
        }).concat(stickerNodes(area).map(function (n) {
            return { node: n, text: "[表情]", kind: "sticker" };
        }));
        return media.map(function (m) {
            var b = m.node.bounds();
            var item = withSender({ text: m.text, kind: m.kind, direction: side(b), top: b.top, left: b.left }, m.node, avatars, false);
            if (m.kind === "image") item.bounds = [b.left, Math.max(b.top, area.top), b.right, Math.min(b.bottom, area.bottom)]; // 可见部分，用于点开大图
            var clipped = b.top <= area.top || b.bottom >= area.bottom;
            if (!budget || clipped) return item;
            if (budget.images <= 0) item.image_error = "单次最多获取 " + MAX_THUMBNAILS + " 张图片";
            else {
                budget.images--;
                attachThumbnail(item, screenShot(screen), b);
            }
            return item;
        });
    }

    // clipAvatars 每个发送人每次读取截一次头像（完整显示在列表区域内的才截）。
    function clipAvatars(result, area, budget, screen) {
        result.forEach(function (item) {
            var b = item.avatar_bounds;
            if (!item.sender || budget.avatars[item.sender] || !b || b.top <= area.top || b.bottom >= area.bottom) return;
            var data = clipJPEG(screenShot(screen), b, AVATAR_QUALITY);
            if (data) item.avatar = data;
            budget.avatars[item.sender] = true;
        });
    }

    // noteUnrecognized 有头像却没有识别出内容的消息（语音、链接卡片、没认出的表情等），记下位置，之后附上控件描述供校准。
    function noteUnrecognized(avatars, area, budget) {
        avatars.forEach(function (a) {
            if (!a.used && a.bounds.top > area.top && a.bounds.bottom < area.bottom) budget.unrecognized.push(a.bounds);
        });
    }

    // 去掉只在手机上使用的坐标字段。
    function withoutPosition(messages) {
        return messages.map(function (m) {
            var copy = {};
            for (var key in m) if (key !== "top" && key !== "left" && key !== "bounds" && key !== "avatar_bounds") copy[key] = m[key];
            return copy;
        });
    }

    // 被屏幕边缘截断的消息看不到头像，方向会是 unknown、发送人为空，此时只比较文字和类型。
    function sameMessage(a, b) {
        var sameDirection = a.direction === b.direction || a.direction === "unknown" || b.direction === "unknown";
        var sameSender = !a.sender || !b.sender || a.sender === b.sender;
        return a.text === b.text && a.kind === b.kind && sameDirection && sameSender;
    }

    // 图片和表情的文字是固定的“[图片]”“[表情]”，系统提示常常重复出现，都不能用来定位。
    // 电脑端选停止点（lastTexts）时跳过同样的类型，两边必须一致。
    function isMedia(m) {
        return m.kind === "image" || m.kind === "sticker" || m.kind === "system";
    }

    // newBudget 一次读取的截图额度：缩略图张数、已截过头像的发送人、没识别出内容的消息位置。
    function newBudget() {
        return { images: MAX_THUMBNAILS, avatars: {}, unrecognized: [] };
    }

    // unrecognizedSample 没识别出内容的消息附近的控件描述（最多 3 种，每种最多 20 字），供校准控件编号。
    function unrecognizedSample(spots) {
        var seen = [];
        all(descMatches(/.+/)).forEach(function (n) {
            var b = n.bounds(),
                d = String(n.desc()).slice(0, SAMPLE_DESC_CHARS);
            if (seen.length >= SAMPLE_DESC_KINDS || seen.indexOf(d) >= 0 || AVATAR_DESC.test(d)) return;
            for (var i = 0; i < spots.length; i++) {
                if (b.top >= spots[i].top - SAMPLE_ABOVE_PX && b.top < spots[i].top + SAMPLE_BELOW_PX) return seen.push(d);
            }
        });
        return seen;
    }

    // older 的末尾与 newer 的开头重叠多少条。
    function overlap(older, newer) {
        // 从最大可能的重叠数往下试，第一个完全匹配的就是重叠条数
        for (var size = Math.min(older.length, newer.length); size > 0; size--) {
            var matched = true;
            for (var k = 0; k < size && matched; k++) matched = sameMessage(older[older.length - size + k], newer[k]);
            if (matched) return size;
        }
        return 0;
    }

    // pageUp 向上翻一页（看更早的消息）：慢速滑动，保证相邻两屏有重叠的消息可以比对。
    function pageUp() {
        var list = messageList();
        if (!list) return false;
        var b = list.bounds(),
            x = b.centerX(),
            margin = (b.height() * (1 - PAGE_SPAN)) / 2;
        var ok = swipe(x, Math.round(b.top + margin), x, Math.round(b.bottom - margin), PAGE_SWIPE_MS);
        sleep(PAGE_SETTLE_MS);
        return ok;
    }

    // canScrollUp 消息列表能否继续向上滚动：看列表报告的无障碍操作里有没有“向后滚动”。
    // 不比较屏幕内容，所以一条长消息占满整屏、或整屏没有能识别的消息时也能判断。
    // 到顶时微信可能正在加载更早的消息，暂时报告不能向上，所以最多再等 waitMs 毫秒确认。
    function canScrollUp(waitMs) {
        var until = clock() + waitMs;
        while (true) {
            var list = messageList();
            if (!list) return false;
            // 无障碍服务缓存的控件信息可能是旧的（实测进入聊天后操作列表里暂时没有“向后滚动”），先刷新
            try {
                list.refresh();
            } catch (_) {}
            var actions = list.getActionList();
            for (var i = 0; i < actions.size(); i++) if (actions.get(i).getId() === ACTION_SCROLL_BACKWARD) return true;
            if (clock() >= until) return false;
            sleep(SCROLL_CHECK_MS);
        }
    }

    // 滑到最新消息处，保证读取从聊天底部开始：用列表自己的“向前滚动”操作逐页向下，到底时操作返回 false。
    // 不用手势：没有惯性，正好停在底部，也不必比较屏幕内容判断是否到底。
    function scrollToLatest() {
        for (var i = 0; i < MAX_SCROLL_STEPS; i++) {
            var list = messageList();
            if (!list) return false;
            if (!list.scrollForward()) return true;
            sleep(SCROLL_STEP_MS);
        }
        return false;
    }

    // 在 messages 的文字消息（跳过图片、表情和系统提示）中找最后一次连续出现的 texts，返回其后第一条消息的位置；找不到返回 -1。
    function afterTexts(messages, texts) {
        if (!texts.length) return -1;
        // 只在文字消息中找（图片、表情的文字是固定的，无法区分）
        var positions = [];
        messages.forEach(function (m, i) {
            if (!isMedia(m)) positions.push(i);
        });
        // 从后往前找，返回最后一次出现的位置
        for (var i = positions.length - texts.length; i >= 0; i--) {
            var matched = true;
            for (var k = 0; k < texts.length && matched; k++) matched = messages[positions[i + k]].text === texts[k];
            if (matched) return positions[i + texts.length - 1] + 1;
        }
        return -1;
    }

    // 读取最近 limit 条消息：先滑到底部，屏幕不够时向上翻页，只有和已读部分确认重叠才拼接，结束后滑回底部。
    // until 是电脑已记录的最后几条消息，读到它们就停止（之前的消息电脑已有）。
    // 仅新增模式（readHistory 为 false）不受 limit 限制，只在有 until 时向上翻，最多 NEW_ONLY_MAX_PAGES 页：
    // 两次读取之间新消息多、上次读到的已被挤出屏幕时翻回去，避免接不上而整批跳过。
    // options：limit 条数；until 已记录的最后几条文字；originals 最多取几张原图（只取 until 之后的新图片）；tag 原图文件名前缀；
    //          identifyKind 读完后识别会话类型。
    function readMessages(name, options) {
        var allowHistory = options.readHistory !== false,
            until = options.until || [];
        verifyChat(name);
        startFromLatest();
        var budget = newBudget();
        var read = readUpward(budget, options.limit, until, allowHistory);
        reportReadQuality(read, budget);
        var capturedAt = new Date().toISOString();
        // 需要取原图时，只处理 until 之后的新图片
        // 回头找图片最多翻的页数：仅新增模式不读更早的历史，只翻回这次读取翻过的范围
        if (options.originals > 0) {
            var originalPages = allowHistory ? MAX_ORIGINAL_PAGES : Math.min(read.pages, MAX_ORIGINAL_PAGES);
            fetchOriginals(read.messages, Math.max(0, afterTexts(read.messages, until)), options.originals, options.tag, originalPages);
        }
        verifyChat(name); // 读完再核对一次，确保读取期间没有被切到别的聊天
        return {
            chat_type: options.identifyKind ? identifyKindKeepingMessages(name) : "unknown",
            messages: withoutPosition(allowHistory ? read.messages.slice(-options.limit) : read.messages),
            captured_at: capturedAt,
            at_latest: true,
            history_pages: read.pages,
            stop_reason: read.stopReason
        };
    }

    // startFromLatest 滑到聊天底部，从最新的消息开始读。滑到底部是自己的操作，和滑动前的屏幕接不上是正常的
    // （例如进入时停在较早的未读位置），所以改用底部这一屏作为读完后核对的基准：读完滑回底部后，两屏应当接得上。
    function startFromLatest() {
        if (!scrollToLatest()) fail("LATEST_NOT_REACHED", "未能到达聊天底部，保留待读取状态");
        entered.screen = visibleMessages(null);
    }

    // readUpward 从底部这一屏开始向上翻页拼接，直到读够、读到已有记录、到达最早或出现异常；翻过页就滑回底部。
    // 很长的消息一屏放不下，翻一页可能没有新消息，此时继续翻；列表报告不能再向上滚动才算到了最早。
    // 返回 { messages, pages, stopReason }。
    function readUpward(budget, limit, until, allowHistory) {
        var messages = visibleMessages(budget),
            pages = 0,
            stopReason = allowHistory ? "limit_reached" : "new_messages_only";
        try {
            while (allowHistory ? messages.length < limit : until.length > 0) {
                var stop = pageUpOrStop(messages, pages, until, allowHistory);
                if (stop !== null) {
                    if (stop) stopReason = stop;
                    break;
                }
                pages++;
                var older = visibleMessages(budget);
                // 这一屏没有能识别的消息：无法和已读部分比对，停止
                if (!older.length) {
                    stopReason = "empty_screen";
                    break;
                }
                // 新的一屏必须和已读部分有重叠，才能确定拼接位置；否则停止，避免拼错顺序
                var shared = overlap(older, messages);
                if (!shared) {
                    stopReason = "unverified_overlap";
                    break;
                }
                fillFromOverlap(messages, older, shared);
                messages = older.slice(0, older.length - shared).concat(messages);
            }
        } finally {
            if (pages) scrollToLatest(); // 下次操作仍从最新消息开始
        }
        return { messages: messages, pages: pages, stopReason: stopReason };
    }

    // pageUpOrStop 向上翻一页；该停时不翻，返回停止原因。仅新增模式翻到上限时返回空字符串（停止原因保持不变，
    // 由电脑按缺口处理）；翻页成功返回 null。
    function pageUpOrStop(messages, pages, until, allowHistory) {
        if (afterTexts(messages, until) >= 0) return "reached_known";
        if (pages >= (allowHistory ? MAX_PAGES : NEW_ONLY_MAX_PAGES)) return allowHistory ? "page_cap" : "";
        if (!canScrollUp(TOP_CONFIRM_MS)) return "history_start";
        if (!pageUp()) return "scroll_failed";
        return null;
    }

    // fillFromOverlap 重叠部分在上一屏可能被截断（看不到头像、图片没截全），用这一屏补上方向、发送人和缩略图。
    function fillFromOverlap(messages, older, shared) {
        for (var k = 0; k < shared; k++) {
            var seen = older[older.length - shared + k];
            if (messages[k].direction === "unknown") messages[k].direction = seen.direction;
            if (!messages[k].sender && seen.sender) messages[k].sender = seen.sender;
            if (!messages[k].avatar && seen.avatar) messages[k].avatar = seen.avatar;
            if (!messages[k].thumbnail && seen.thumbnail) {
                messages[k].thumbnail = seen.thumbnail;
                delete messages[k].image_error;
            }
        }
    }

    // reportReadQuality 记下读取结果；提前停止、缩略图失败、有没识别出内容的消息都记为降级：结果可能不完整。
    function reportReadQuality(read, budget) {
        step("读取消息", read.messages.length + " 条，翻页 " + read.pages + " 次，停止原因 " + read.stopReason);
        if (READ_STOP_WARNINGS[read.stopReason]) warn("READ_" + read.stopReason.toUpperCase(), READ_STOP_WARNINGS[read.stopReason]);
        var thumbFailed = read.messages.filter(function (m) {
            return m.image_error === "缩略图获取失败" || m.image_error === "缩略图超过大小限制";
        }).length;
        if (thumbFailed) warn("THUMBNAIL_FAILED", thumbFailed + " 张图片没能截取缩略图");
        if (budget.unrecognized.length) {
            var sample = unrecognizedSample(budget.unrecognized);
            warn("UNRECOGNIZED_MESSAGES", "有 " + budget.unrecognized.length + " 处消息没能识别内容（语音、链接卡片等）" + (sample.length ? "，附近控件描述：" + sample.join("、") : ""));
        }
    }

    // identifyKindKeepingMessages 读完后识别会话类型；识别失败时已读消息必须保留，下次读取重试。
    function identifyKindKeepingMessages(name) {
        try {
            var kind = identifyChatKind(name);
            if (kind !== "unknown") step("识别会话类型", kind === "group" ? "群聊" : "联系人");
            return kind;
        } catch (_) {
            warn("CHAT_KIND_UNAVAILABLE", "消息已读取，会话类型暂未识别");
            return "unknown";
        }
    }

    // ---------- 原图 ----------

    // 微信“保存图片”可能写入的目录。只取开始保存之后新出现的文件。
    var SAVE_DIRS = ["/sdcard/Pictures/WeiXin/", "/sdcard/DCIM/WeiXin/", "/sdcard/tencent/MicroMsg/WeiXin/", "/sdcard/Pictures/", "/sdcard/DCIM/Camera/"];

    // newestSavedImage 在保存目录中找 since 之后最新的图片文件，确认已写完后返回路径；没有返回 null。
    function newestSavedImage(since) {
        var best = null,
            bestTime = since - CLOCK_SKEW_MS;
        // 遍历所有可能的目录，挑出修改时间最新的图片（容许 2 秒时钟误差）
        SAVE_DIRS.forEach(function (dir) {
            if (!files.isDir(dir)) return;
            var names = files.listDir(dir);
            for (var i = 0; i < names.length; i++) {
                if (!/\.(jpe?g|png|gif|webp)$/i.test(names[i])) continue;
                var file = new java.io.File(dir + names[i]);
                if (file.lastModified() > bestTime) {
                    best = file;
                    bestTime = file.lastModified();
                }
            }
        });
        if (!best) return null;
        var size = best.length(); // 大小在 300 毫秒内不变才算写完
        sleep(FILE_STABLE_MS);
        return size > 0 && best.length() === size ? String(best.getPath()) : null;
    }

    // 微信能否把图片保存到手机（“读写设备上的照片及文件”权限）。没有权限时点“保存图片”会弹出授权框。
    function wechatCanSave() {
        var pm = context.getPackageManager();
        return pm.checkPermission("android.permission.WRITE_EXTERNAL_STORAGE", PKG) === android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    // 逐次按返回直到回到聊天页；每次等页面切换完成，避免多按退出聊天。
    function leaveViewer() {
        for (var i = 0; i < MAX_VIEWER_BACKS && !messageList(); i++) {
            back();
            waitFor(messageList, SCREEN_SWITCH_MS);
        }
    }

    // 点开图片 → 等待加载 → 有“查看原图”就加载原图 → 长按“保存图片”取原图文件 → 返回聊天。
    // 微信没有存储权限或保存失败时，截取大图页面代替（清晰度高于聊天缩略图）。
    // 结果写在 message 上：original_file（original_source 为 screenshot 表示截图）或 original_error。
    function saveOriginal(message, b, fileName) {
        var started = Date.now();
        new java.io.File(originalsDir).mkdirs();
        try {
            openViewer(b);
            loadFullImage();
            var saved = saveViaWechat(started);
            if (saved) keepSavedImage(message, saved, fileName);
            else screenshotInstead(message, fileName);
        } catch (e) {
            message.original_error = String(e.message || e);
            warn("ORIGINAL_FAILED", "取原图失败：" + message.original_error);
        } finally {
            leaveViewer(); // 无论成功与否都返回聊天页
        }
    }

    // openViewer 点击图片可见部分的中心，等聊天列表消失（大图页面已打开）。
    // 按坐标点击没有反应时，再对图片控件做一次无障碍点击（两次间隔 3 秒，不会变成双击）。
    function openViewer(b) {
        var x = Math.round((b[0] + b[2]) / 2),
            y = Math.round((b[1] + b[3]) / 2);
        check();
        click(x, y);
        if (viewerOpened()) return;
        var node = imageNodeAt(x, y);
        if (!messageList() || !node || !node.click() || !viewerOpened()) fail("VIEWER_NOT_OPEN", "大图没有打开");
        step("取原图", "按坐标点击图片没有反应，改用无障碍点击打开了大图");
    }

    // viewerOpened 等聊天列表消失（大图页面已打开），再等图片显示；3 秒内没打开返回 false。
    function viewerOpened() {
        var opened = waitFor(function () {
            return inWechat() && !messageList();
        }, PAGE_LOAD_MS);
        if (opened) sleep(VIEWER_SETTLE_MS);
        return !!opened;
    }

    // imageNodeAt 聊天列表中包含坐标 (x, y) 的图片控件，没有返回 null。
    function imageNodeAt(x, y) {
        var list = messageList();
        if (!list) return null;
        var found = imageNodes(list.bounds()).filter(function (n) {
            return n.bounds().contains(x, y);
        });
        return found.length ? found[0] : null;
    }

    // tapOrTouch 点击大图页上的按钮、菜单项：控件和父控件都不接受无障碍点击时，按控件中心的坐标点击。
    function tapOrTouch(node) {
        try {
            tap(node);
        } catch (e) {
            if (e.code !== "NOT_CLICKABLE") throw e;
            var b = node.bounds();
            click(b.centerX(), b.centerY());
        }
    }

    // loadFullImage 有“查看原图”按钮就点开，等按钮和加载进度消失，最多 20 秒。没加载完也继续，后面保存或截图。
    function loadFullImage() {
        var full = one(textStartsWith("查看原图"));
        if (!full) return;
        tapOrTouch(full);
        waitFor(function () {
            return !one(textStartsWith("查看原图")) && !one(textMatches(/^\d{1,3}%$/));
        }, FULL_IMAGE_MS);
        sleep(RETURN_SETTLE_MS);
    }

    // saveViaWechat 微信有存储权限时，长按图片，在菜单中点“保存图片”，等新文件出现；返回文件路径，没取到返回 null。
    function saveViaWechat(started) {
        if (!wechatCanSave()) return null;
        press(Math.round(device.width / 2), Math.round(device.height / 2), LONG_PRESS_MS);
        var save = waitFor(function () {
            return one(text("保存图片"));
        }, MENU_OPEN_MS);
        if (!save) return null;
        tapOrTouch(save);
        return waitFor(function () {
            return newestSavedImage(started);
        }, SAVED_FILE_MS);
    }

    // keepSavedImage 把微信保存的原图复制到原图目录等电脑来取，并删除微信存进相册的副本。
    function keepSavedImage(message, saved, fileName) {
        var ext = saved.slice(saved.lastIndexOf(".")).toLowerCase();
        files.copy(saved, originalsDir + fileName + ext);
        files.remove(saved);
        media.scanFile(saved);
        message.original_file = fileName + ext;
        step("取原图", "已保存原图文件");
    }

    // screenshotInstead 没取到原图文件：关闭可能还开着的长按菜单，截取大图页面代替，并记一条降级。
    function screenshotInstead(message, fileName) {
        if (one(text("取消"))) {
            back();
            sleep(RETURN_SETTLE_MS);
        }
        var shot = capture();
        try {
            images.save(shot, originalsDir + fileName + ".jpg", "jpg", THUMBNAIL_QUALITY);
        } finally {
            shot.recycle();
        }
        message.original_file = fileName + ".jpg";
        message.original_source = "screenshot";
        message.original_note = wechatCanSave() ? "没能保存原图文件，用大图截图代替" : "微信没有“读写照片及文件”权限，用大图截图代替原图";
        warn("ORIGINAL_SCREENSHOT", message.original_note);
    }

    // 为 messages[from:] 中的图片取原图，从最早的开始最多 max 张（电脑把 from 设在最早一张还没有原图的图片处）。
    // 每点开一张前都重新确定当前屏幕对应 messages 的哪一段：群里新消息不断，退出大图后列表常被顶动，
    // 按旧位置点会点错。当前屏幕没有要取的图片时向上翻页，最多 maxPages 页。
    function fetchOriginals(messages, from, max, tag, maxPages) {
        var targets = [];
        for (var i = from; i < messages.length && targets.length < max; i++) {
            if (messages[i].kind === "image") targets.push(i);
        }
        var pages = 0;
        try {
            while (targets.length) {
                var place = locateScreen(messages);
                if (!place) break;
                var hit = targetOnScreen(targets, place);
                if (hit) {
                    targets.splice(targets.indexOf(hit.index), 1);
                    saveOriginal(messages[hit.index], hit.bounds, tag + "-" + hit.index);
                    continue;
                }
                // 最早一张在当前屏幕上方（或在顶部只露出一点）才向上翻；都在屏幕下方（列表被新消息顶得太远）就停止
                if (targets[0] >= place.offset + place.screen.length || pages >= maxPages || !canScrollUp(TOP_CONFIRM_MS) || !pageUp()) break;
                pages++;
            }
        } finally {
            if (pages) scrollToLatest();
        }
        // 没找到的图片没有点开过，不算取原图失败，电脑下次读取还会再取
        targets.forEach(function (i) {
            messages[i].original_skipped = "没能在屏幕上定位这张图片";
        });
        if (targets.length) warn("ORIGINAL_NOT_LOCATED", "有 " + targets.length + " 张图片没能在屏幕上定位，未取原图");
    }

    // locateScreen 当前屏幕在 messages 中的位置：屏幕上第 k 条对应 messages[offset + k]（k < screen.length）。
    // 底部可能有读取之后才到的新消息，所以从屏幕最上面开始，找最长的一段在 messages 中唯一出现的连续消息；
    // 这一段必须含文字（图片、表情的文字都一样，单靠它们对不准）。对不上或不在聊天页返回 null。
    function locateScreen(messages) {
        if (!messageList()) return null;
        var screen = visibleMessages(null);
        for (var size = screen.length; size > 0; size--) {
            var head = screen.slice(0, size),
                at = uniqueRun(messages, head);
            if (at === -2) return null; // 重复内容，位置不唯一
            if (at >= 0 && !head.every(isMedia)) return { screen: head, offset: at };
        }
        return null;
    }

    // uniqueRun run 在 messages 中连续出现的位置：只出现一次返回位置，没有返回 -1，多次返回 -2。
    function uniqueRun(messages, run) {
        var found = -1;
        for (var p = 0; p + run.length <= messages.length; p++) {
            var matched = true;
            for (var k = 0; k < run.length && matched; k++) matched = sameMessage(messages[p + k], run[k]);
            if (!matched) continue;
            if (found >= 0) return -2;
            found = p;
        }
        return found;
    }

    // targetOnScreen 当前屏幕上第一张要取原图、露出足够高度可以点开的图片：{ index, bounds }，没有返回 null。
    function targetOnScreen(targets, place) {
        for (var t = 0; t < targets.length; t++) {
            var m = place.screen[targets[t] - place.offset];
            if (m && m.kind === "image" && m.bounds[3] - m.bounds[1] >= MIN_IMAGE_TAP_PX) return { index: targets[t], bounds: m.bounds };
        }
        return null;
    }

    // 只读检查当前是否在底部，不滑动用户界面；不能判断时按非底部处理。
    function isAtLatest() {
        var list = messageList();
        if (!list) return false;
        try {
            list.refresh();
            var actions = list.getActionList();
            for (var i = 0; i < actions.size(); i++) if (actions.get(i).getId() === ACTION_SCROLL_FORWARD) return false;
            return true;
        } catch (_) { return false; }
    }

    // 当前屏幕的消息快照；withImages 为 true 时附带图片缩略图。
    function snapshot(withImages) {
        return {
            messages: withoutPosition(visibleMessages(withImages ? newBudget() : null)),
            at_latest: isAtLatest(),
            captured_at: new Date().toISOString()
        };
    }

    // ---------- 发送 ----------

    // 唯一的聊天输入框（排除内部再嵌套一个输入框的外层容器）。
    function input() {
        var nodes = all(profile.input_id ? id(profile.input_id) : className("android.widget.EditText"));
        // 有的版本输入框外面还包着一个同编号的容器，只保留最内层
        var leaves = nodes.filter(function (n) {
            for (var j = 0; j < n.childCount(); j++) {
                var child = n.child(j);
                if (child && String(child.id()) === profile.input_id) return false;
            }
            return true;
        });
        return leaves.length === 1 ? leaves[0] : null;
    }

    // 语音模式下先切回键盘输入。
    function textInput() {
        var box = input();
        if (box) return box;
        var keyboard = one(desc("切换到键盘"));
        if (!keyboard) return null;
        tap(keyboard);
        return waitFor(input, MENU_OPEN_MS);
    }

    // countText 统计当前屏幕上文字为 content 的消息条数，用来确认发送后多了一条。
    function countText(content) {
        var list = messageList();
        if (!list) fail("MESSAGE_LIST_MISSING", "消息列表不可用");
        var area = list.bounds();
        return all(id(profile.message_id).text(content)).filter(function (n) {
            var b = n.bounds();
            return b.top >= area.top && b.bottom <= area.bottom;
        }).length;
    }

    // 填入文字并核对后只点击一次发送；之后以“输入框清空且出现新的同文消息”作为确认。
    function sendText(name, group, content) {
        verifyChat(name);
        // 1. 记下发送前同样文字的消息数，找到输入框；输入框里已有草稿时不覆盖
        var before = countText(content);
        var box = textInput();
        if (!box) fail("INPUT_NOT_FOUND", "未找到唯一聊天输入框，请切换到文字输入模式");
        if (box.text() && String(box.text()).trim()) fail("DRAFT_EXISTS", "聊天中有未发送草稿，未覆盖");
        // 2. 填入文字，等“发送”按钮出现
        if (!box.setText(content)) fail("INPUT_FAILED", "无法输入消息");
        var sendButton = waitFor(function () {
            return one(text("发送"));
        }, SEND_BUTTON_MS);
        // 3. 点发送前再核对一次聊天和输入框内容，防止期间界面被切换
        verifyChat(name);
        box = input();
        if (!sendButton || !box || String(box.text()) !== content) fail("INPUT_MISMATCH", "输入内容或发送按钮不匹配");
        // 4. 只点一次发送；从这里开始出错只能报告“结果未知”
        clicked = true;
        tap(sendButton);
        // 5. 确认：输入框已清空，且同样文字的消息多了一条
        var confirmed = waitFor(function () {
            var current = input();
            return current && !String(current.text() || "") && countText(content) > before;
        }, SEND_CONFIRM_MS);
        if (!confirmed) failWithScreen("SEND_UNCONFIRMED", "已尝试点击发送，但未确认新增消息；请核对手机，不要直接重发");
        step("发送文字", "界面已出现新消息");
        // 已确认本聊天多了这条消息，不再比对屏幕：长消息会把旧消息挤出屏幕，比对会误报“被切换”。
        // 只更新比对基准，供之后的操作核对
        entered.screen = visibleMessages(null);
    }

    // outgoingImageCount 统计发出的图片条数，用来确认发图后多了一张。
    function outgoingImageCount(messages) {
        return messages.filter(function (m) {
            return m.kind === "image" && m.direction === "outgoing";
        }).length;
    }

    // 在微信“选择聊天”页搜索并选中唯一的目标，返回确认弹窗里的“发送”按钮。
    function pickShareTarget(name) {
        // 等分享页的搜索按钮出现；如果弹出了系统权限框，说明微信缺少存储权限
        var search = waitFor(function () {
            if (PERMISSION_UI.test(foregroundPackage())) return "permission";
            return one(descMatches(/搜索/)) || one(text("搜索"));
        }, SHARE_PAGE_MS);
        if (search === "permission")
            fail("WECHAT_STORAGE_PERMISSION", "微信需要“读取设备上的照片及文件”权限才能发送图片，请在手机上允许后重试");
        if (!search) fail("SHARE_PICKER_UNSUPPORTED", "未识别微信分享联系人选择页");
        // 点搜索，输入聊天的搜索名称
        tap(search);
        if (!searchFor(searchQuery(name))) fail("SHARE_SEARCH_UNSUPPORTED", "未找到分享搜索框");

        // 搜索结果是会话行，名称必须与目标的某种写法一致且唯一。
        // 不能按搜索词找文字：搜索框本身、“包含: xxx”的群聊行都会误中。
        var rows = [];
        waitFor(function () {
            rows = namedRows(name, false);
            return rows.length === 1;
        }, PAGE_LOAD_MS);
        if (rows.length !== 1) fail("AMBIGUOUS_SHARE_TARGET", "分享页中没有找到唯一的「" + name + "」");
        tap(rows[0]);

        // 确认弹窗：有“发送”按钮，并且能看到收件人名称。
        var confirm = waitFor(function () {
            return one(textMatches(/^发送(\(1\))?$/));
        }, PAGE_LOAD_MS);
        var variants = titleVariants(name);
        var recipientShown = all(className("android.widget.TextView")).some(function (n) {
            return variants.indexOf(normalizeTitle(n.text())) >= 0;
        });
        if (!confirm || !recipientShown) fail("SHARE_CONFIRM_UNSUPPORTED", "无法核对分享确认页的收件人");
        return confirm;
    }

    // 通过系统分享把图片发给微信：分享页搜索唯一收件人，发送后回到聊天确认出现新的发出图片。
    function sendImage(name, group, base64, fileTag) {
        var path = writeOutgoingImage(base64, fileTag);
        verifyChat(name);
        var before = outgoingImageCount(visibleMessages(null)); // 发送前发出的图片数
        shareToWechat(path);
        var confirm = pickShareTargetOrLeave(name);
        // 点发送；从这里开始出错只能报告“结果未知”
        step("分享图片", "已核对收件人，点击发送");
        clicked = true;
        tap(confirm);
        stayInWechat();
        confirmImageSent(name, group, before);
        files.remove(path);
    }

    // writeOutgoingImage 解码图片并确认是有效图片，写成临时文件供分享，返回路径。
    function writeOutgoingImage(base64, fileTag) {
        var bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        var decoded = images.fromBytes(bytes);
        if (!decoded) fail("BAD_IMAGE", "图片解码失败");
        decoded.recycle();
        var path = workDir + "outgoing-" + fileTag + ".jpg";
        files.writeBytes(path, bytes);
        return path;
    }

    // shareToWechat 用系统分享把图片交给微信的分享页面（允许以 file:// 地址分享文件）。
    function shareToWechat(path) {
        android.os.StrictMode.setVmPolicy(new android.os.StrictMode.VmPolicy.Builder().build());
        var intent = new android.content.Intent(android.content.Intent.ACTION_SEND);
        intent.setType("image/jpeg");
        intent.putExtra(android.content.Intent.EXTRA_STREAM, android.net.Uri.fromFile(new java.io.File(path)));
        intent.setClassName(PKG, "com.tencent.mm.ui.tools.ShareImgUI");
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    // pickShareTargetOrLeave 在分享页选中唯一的收件人，返回“发送”按钮。失败时还没点发送：退出分享页，
    // 避免手机停在选择聊天页面（依次收起键盘、退出搜索、关闭分享页，最多按 3 次返回）；
    // 权限弹窗除外：按返回等于替用户拒绝授权。
    function pickShareTargetOrLeave(name) {
        try {
            return pickShareTarget(name);
        } catch (e) {
            for (var i = 0; i < MAX_SHARE_BACKS && e.code !== "WECHAT_STORAGE_PERMISSION"; i++) {
                if (!one(text("选择聊天")) && !one(className("android.widget.EditText"))) break;
                back();
                sleep(SHARE_BACK_SETTLE_MS);
            }
            throw e;
        }
    }

    // stayInWechat 外部分享成功后微信会问“返回 xxx / 留在微信”，留在微信才能继续确认结果；弹窗一出现就点，最多等 1.5 秒。
    function stayInWechat() {
        var stay = waitFor(function () {
            return one(text("留在微信"));
        }, SCREEN_SWITCH_MS);
        if (stay) tap(stay);
    }

    // confirmImageSent 回到聊天确认：发出的图片多了一张，且最后一条就是发出的图片。
    function confirmImageSent(name, group, before) {
        openChat(name, group);
        var confirmed = waitFor(function () {
            var now = visibleMessages(null),
                last = now[now.length - 1];
            return outgoingImageCount(now) > before && last && last.kind === "image" && last.direction === "outgoing";
        }, SEND_CONFIRM_MS);
        if (!confirmed) failWithScreen("SEND_UNCONFIRMED", "已点击图片发送，尚未确认新增图片，请检查手机，不要重发");
        step("发送图片", "聊天中已出现新发出的图片");
    }

    // ---------- 未读监测 ----------

    // collectRow 递归收集会话行内的文字（最多 8 层），拼成签名；
    // 描述含“未读”或有 1–3 位数字的小角标时，标记为未读。
    function collectRow(node, depth, info) {
        if (!node || depth > MAX_ROW_DEPTH) return;
        var t = String(node.text() || ""),
            d = String(node.desc() || "");
        if (/未读|unread/i.test(d) || (/^\d{1,3}\+?$/.test(t) && node.bounds().width() < BADGE_MAX_PX)) info.unread = true;
        var count = /^(\d{1,3})$/.exec(t), described = /(\d{1,3})\s*(?:条)?\s*未读|未读\s*(\d{1,3})/.exec(d);
        if (count && node.bounds().width() < BADGE_MAX_PX) info.count = Math.max(info.count, Number(count[1]));
        if (described) info.count = Math.max(info.count, Number(described[1] || described[2]));
        info.signature += t + "|" + d;
        for (var i = 0; i < node.childCount(); i++) collectRow(node.child(i), depth + 1, info);
    }

    // 首页消息列表中带未读标记的会话：聊天名称 → 行内文字签名（签名变化说明有新消息）。
    // 不在微信首页时返回 null。
    function unreadChats() {
        if (!inWechat() || messageList()) return null;
        var result = {};
        // 每个会话名称控件：向上找到整行，收集行内文字判断是否有未读
        all(id(profile.contact_id)).forEach(function (n) {
            var b = n.bounds(),
                label = String(n.text() || "");
            if (!label || b.left < 0 || b.right > device.width || ignoredChat(label)) return;
            var row = n; // 向上找到整行：高度不超过屏幕四分之一的最外层
            for (var i = 0; i < MAX_ROW_HOPS && row.parent() && row.parent().bounds().height() <= device.height / 4; i++)
                row = row.parent();
            var info = { unread: false, count: 0, signature: "" };
            collectRow(row, 0, info);
            if (info.unread) result[chatName(label)] = { signature: info.signature, count: info.count };
        });
        return result;
    }

    // ignoredChat 是否为不处理的会话（公众号、微信系统通知）。
    function ignoredChat(name) {
        return IGNORED_CHATS.indexOf(String(name)) >= 0;
    }

    // ---------- 就绪状态 ----------

    // wechatVersion 返回已安装微信的版本号，读不到返回 null。
    function wechatVersion() {
        try {
            return String(context.getPackageManager().getPackageInfo(PKG, 0).versionName);
        } catch (_) {
            return null;
        }
    }

    // 当前微信需要随选朗读或 TalkBack 开启，否则可能返回空控件树。
    function readerService() {
        var services = context.getSystemService("accessibility").getEnabledAccessibilityServiceList(-1);
        for (var i = 0; i < services.size(); i++) {
            var info = services.get(i).getResolveInfo().serviceInfo;
            if (String(info.packageName) !== "com.google.android.marvin.talkback") continue;
            if (String(info.name).indexOf("SelectToSpeakService") >= 0) return "select_to_speak";
            if (String(info.name).indexOf("TalkBackService") >= 0) return "talkback";
        }
        return null;
    }

    // status 汇总就绪状态：ready 为 true 才能执行任务；reasons 列出所有未满足的条件。
    function status(captureReady) {
        var reasons = [],
            version = wechatVersion(),
            reader = readerService();
        if (!auto.service) reasons.push("ACCESSIBILITY_DISABLED");
        if (!reader) reasons.push("READER_SERVICE_REQUIRED");
        if (screenLocked()) reasons.push("SCREEN_LOCKED");
        if (version !== config.wechat_version) reasons.push("WECHAT_VERSION_MISMATCH");
        if (!captureReady || captureFailed) reasons.push("CAPTURE_PERMISSION_REQUIRED");
        if (!profile.message_id || !profile.list_id || !profile.input_id) reasons.push("PROFILE_NOT_CALIBRATED");
        return {
            ready: !reasons.length,
            reasons: reasons,
            wechat_version: version,
            reader_service: reader,
            wechat_storage_permission: wechatCanSave() // 影响发送图片和保存原图，不影响读写文字
        };
    }

    // 提供给 bridge.js 使用的接口
    return {
        begin: begin,
        clicked: function () {
            return clicked;
        },
        status: status,
        ignoredChat: ignoredChat,
        stillInChat: stillInChat,
        currentChat: currentChat,
        inChat: inChat,
        openChat: openChat,
        returnToList: returnToList,
        identifyAccount: identifyAccount,
        readMessages: readMessages,
        diagnostics: diagnostics,
        // 截图授权是否失效（失效后由 bridge.js 重新申请，成功后调用 captureRestored）
        captureBroken: function () {
            return captureFailed;
        },
        captureRestored: function () {
            captureFailed = false;
        },
        originalsDir: originalsDir,
        snapshot: snapshot,
        sendText: sendText,
        sendImage: sendImage,
        unreadChats: unreadChats
    };
};
