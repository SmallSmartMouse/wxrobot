// 微信界面操作（AutoJs6，ES5 语法）：打开聊天、读取可见消息、发送文字和图片。
// 只由 bridge.js 的主线程串行调用。无法核对目标或结果时抛出带 code 的错误并停止，不猜测着继续点击。
var PKG = "com.tencent.mm";

// 微信 8.0.78 的控件编号，config.json 的 profile 可以覆盖。
// message_id、list_id、input_id 没有默认值，必须在配置中校准。
var DEFAULT_PROFILE = {
    title_id: "android:id/text1",
    contact_id: "com.tencent.mm:id/kbq",
    search_contact_id: "com.tencent.mm:id/odf",
    avatar_id: "com.tencent.mm:id/bk1"
};
var MAX_THUMBNAILS = 3; // 每次读取最多截取的图片缩略图数量

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
            sleep(150);
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
        for (var p = node, i = 0; p && i < 8; i++, p = p.parent()) {
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

    // 标题比较前的统一处理：去掉群人数后缀“(123)”、空白和表情变体选择符，
    // 各种爱心写法（微信通知里的 [心]、❤、♥ 等）统一为 ♥，忽略大小写。
    function normalizeTitle(title) {
        return String(title)
            .replace(/\s*[（(]\d{1,6}[）)]?\s*$/, "")
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
        var need = Math.min(2, before.length, now.length);
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
        waitFor(messageList, 1800);
        var problem = chatProblem(name);
        if (problem) failWithScreen(problem.code, problem.message);
    }

    // stillInChat 不报错的 verifyChat，供后台监测判断是否仍在最近操作的聊天里。
    function stillInChat(name) {
        return !chatProblem(name);
    }

    // confirmEntered 点击会话后等聊天页出现；有标题控件时再核对标题；然后记下当前屏幕作为比对基准。
    function confirmEntered(name, how) {
        if (!waitFor(messageList, 3000)) failWithScreen("CHAT_NOT_OPENED", "点击「" + name + "」后没有进入聊天页面，已停止操作");
        if (titleMatches(name) === false)
            failWithScreen("CHAT_MISMATCH", "进入后的聊天标题「" + nativeTitle() + "」与「" + name + "」不一致，已停止操作");
        entered = { name: name, screen: visibleMessages(null) };
        step("打开聊天", how);
    }

    // currentChat 当前打开的聊天名称（来自标题控件），用于监测手动打开的聊天；读不到标题时返回 null。
    function currentChat() {
        if (!messageList()) return null;
        var title = nativeTitle();
        return title && title !== "微信" ? chatName(title.replace(/\s*[（(]\d{1,6}[）)]\s*$/, "")) : null;
    }

    // ---------- 打开聊天 ----------

    // launchWechat 启动微信并等它到前台；5 秒内没有到前台就报告当前前台是哪个应用。
    function launchWechat() {
        app.startActivity({
            packageName: PKG,
            className: "com.tencent.mm.ui.LauncherUI",
            flags: ["activity_new_task", "activity_reset_task_if_needed"]
        });
        if (!waitFor(inWechat, 5000)) {
            var front = foregroundPackage();
            var hint = /packageinstaller|permissioncontroller|lbe\.security/.test(front) ? "（系统权限弹窗挡在前面，请在手机上处理）" : "";
            fail("WECHAT_NOT_OPEN", "无法打开微信，当前前台是 " + front + hint);
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
        for (var i = 0; i < 6; i++) {
            check();
            if (!inWechat()) fail("WRONG_APP", "导航期间微信失去前台，已停止操作");
            var home = homeControls();
            // 在首页但不在“微信”标签（例如在通讯录）：点底部“微信”标签
            if (home && nativeTitle() !== "微信") {
                tap(home.tab);
                home = waitFor(homeControls, 1500);
            }
            if (home) return home;
            // 还没到首页：按一次返回
            back();
            sleep(350);
        }
        fail("HOME_NOT_FOUND", "无法返回微信消息列表，请手动打开微信首页");
    }

    // recentRows 首页会话列表中名称与 name 相符的行（可能多个，由调用方判断是否唯一）。
    function recentRows(name) {
        var variants = titleVariants(name);
        return unique(
            all(id(profile.contact_id)).filter(function (n) {
                return variants.indexOf(normalizeTitle(n.text())) >= 0 && inListArea(n.bounds());
            })
        );
    }

    // 用微信全局搜索打开聊天：搜索结果必须稳定且唯一。
    function searchChat(name, group, searchButton) {
        var query = (aliases[name] || {}).query || name;
        tap(searchButton);
        var box = waitFor(function () {
            return one(className("android.widget.EditText"));
        }, 3000);
        if (!box || !box.setText(query)) fail("SEARCH_FAILED", "无法输入联系人搜索名称");
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
                stableSince = Date.now();
                return false;
            }
            return Date.now() - stableSince >= 180;
        }, 3000);
        // 结果必须唯一，否则停止，避免进错聊天
        if (!settled || candidates.length !== 1) failWithScreen("CONTACT_AMBIGUOUS", "未找到唯一精确联系人或群，请使用唯一备注名");
        tap(candidates[0]);
        // 联系人结果可能先打开资料页，需要再点“发消息”。
        if (
            !waitFor(function () {
                return messageList() || one(text("发消息"));
            }, 2000)
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
        if (messageList() && (titleMatches(name) === true || stillInChat(name))) {
            step("打开聊天", titleMatches(name) === true ? "已在目标聊天（标题一致）" : "仍在上次进入的聊天里（屏幕内容接得上）");
            return;
        }
        // 否则回首页，在会话列表里找名称完全一致的那一行；找到多个同名就停止
        var home = goHome();
        var rows = recentRows(name);
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
            sleep(500);
        }
    }

    // ---------- 读取消息 ----------

    // 文字消息的方向：看同一高度附近的头像在左侧还是右侧。
    function direction(bounds, avatars) {
        var best = 80,
            result = "unknown";
        avatars.forEach(function (a) {
            var distance = Math.abs(a.top - bounds.top);
            if (distance < best) {
                best = distance;
                result = a.centerX() < device.width / 2 ? "incoming" : "outgoing";
            }
        });
        return result;
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

    // 从整屏截图中裁剪缩略图（JPEG Base64）。
    function attachThumbnail(item, shot, b) {
        var crop = null;
        try {
            crop = images.clip(shot, b.left, b.top, b.width(), b.height());
            // 缩略图尺寸受限于手机屏幕上的显示大小，压缩质量尽量高；要清晰原图请开启“取原图”。
            var data = String(images.toBase64(crop, "jpg", 85));
            if (data.length > 500000) item.image_error = "缩略图超过大小限制";
            else item.thumbnail = data;
        } catch (_) {
            item.image_error = "缩略图获取失败";
        } finally {
            if (crop) crop.recycle();
        }
    }

    // 读取当前屏幕上的消息，从上到下排序。
    // budget 为 null 时不截图；否则最多截取 budget.images 张缩略图（会递减）。
    function visibleMessages(budget) {
        var list = messageList();
        if (!list) fail("MESSAGE_LIST_MISSING", "消息列表不可用");
        var area = list.bounds(),
            result = [];
        // 先取所有头像位置，用来判断每条文字消息是收到的还是发出的
        var avatars = all(id(profile.avatar_id)).map(function (n) {
            return n.bounds();
        });
        // 文字消息：有文字且与消息列表区域有交集的气泡
        unique(all(id(profile.message_id))).forEach(function (n) {
            var b = n.bounds();
            if (!n.text() || b.bottom <= area.top || b.top >= area.bottom) return;
            result.push({ text: String(n.text()), direction: direction(b, avatars), top: b.top, left: b.left });
        });
        var shot = null;
        try {
            // 图片消息：方向看图片在屏幕左半边还是右半边；需要时截取缩略图（整屏只截一次）
            imageNodes(area).forEach(function (n) {
                var b = n.bounds();
                var item = {
                    text: "[图片]",
                    kind: "image",
                    direction: b.centerX() < device.width / 2 ? "incoming" : "outgoing",
                    top: b.top,
                    left: b.left,
                    bounds: [b.left, Math.max(b.top, area.top), b.right, Math.min(b.bottom, area.bottom)] // 可见部分，用于点开大图
                };
                // 被屏幕边缘截断的图片只记录位置，不截缩略图（翻页时会在完整显示的那一屏补上）。
                var clipped = b.top <= area.top || b.bottom >= area.bottom;
                if (!budget || clipped) {
                    // 不截图
                } else if (budget.images <= 0) item.image_error = "单次最多获取 " + MAX_THUMBNAILS + " 张图片";
                else {
                    budget.images--;
                    if (!shot) shot = capture();
                    attachThumbnail(item, shot, b);
                }
                result.push(item);
            });
        } finally {
            if (shot) shot.recycle();
        }
        // 文字和图片合在一起，按屏幕位置从上到下排序
        return result.sort(function (a, b) {
            return a.top - b.top || a.left - b.left;
        });
    }

    // 去掉只在手机上使用的坐标字段。
    function withoutPosition(messages) {
        return messages.map(function (m) {
            var copy = {};
            for (var key in m) if (key !== "top" && key !== "left" && key !== "bounds") copy[key] = m[key];
            return copy;
        });
    }

    // 被屏幕边缘截断的消息看不到头像，方向会是 unknown，此时只比较文字和类型。
    function sameMessage(a, b) {
        var sameDirection = a.direction === b.direction || a.direction === "unknown" || b.direction === "unknown";
        return a.text === b.text && a.kind === b.kind && sameDirection;
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

    // 在消息列表内滑动；toOlder 为 true 时向上翻看更早的消息。
    function scroll(toOlder) {
        var list = messageList();
        if (!list) return false;
        var b = list.bounds(),
            x = b.centerX();
        // 每次滑动半屏，较慢的滑动减少惯性，保证相邻两屏有重叠的消息可以比对。
        var upper = Math.round(b.top + b.height() * 0.25),
            lower = Math.round(b.top + b.height() * 0.75);
        var ok = toOlder ? swipe(x, upper, x, lower, 400) : swipe(x, lower, x, upper, 400);
        sleep(toOlder ? 350 : 200);
        return ok;
    }

    // 两屏内容和位置都相同，说明列表没有移动（已到顶部或底部）。
    function samePlace(a, b) {
        var key = function (list) {
            return JSON.stringify(
                list.map(function (m) {
                    return [m.kind, m.text, m.top];
                })
            );
        };
        return key(a) === key(b);
    }

    // 滑到最新消息处，保证读取从聊天底部开始。
    function scrollToLatest() {
        var before = visibleMessages(null);
        // 向下滑，直到列表不再移动（最多 25 次）
        for (var i = 0; i < 25 && scroll(false); i++) {
            var after = visibleMessages(null);
            if (samePlace(after, before)) return;
            before = after;
        }
    }

    // 在 messages 的文字消息（跳过图片）中找最后一次连续出现的 texts，返回其后第一条消息的位置；找不到返回 -1。
    function afterTexts(messages, texts) {
        if (!texts.length) return -1;
        // 只在文字消息中找（图片的文字都是“[图片]”，无法区分）
        var positions = [];
        messages.forEach(function (m, i) {
            if (m.kind !== "image") positions.push(i);
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
    // 很长的消息一屏放不下，翻一页可能没有新消息，此时继续翻；只有列表不再移动才算到了最早。
    // options：limit 条数；until 已记录的最后几条文字；originals 最多取几张原图（只取 until 之后的新图片）；tag 原图文件名前缀。
    function readMessages(name, options) {
        var limit = options.limit,
            until = options.until || [];
        // 核对聊天后滑到底部，从最新的消息开始读
        verifyChat(name);
        scrollToLatest();
        var budget = { images: MAX_THUMBNAILS };
        var screen = visibleMessages(budget),
            messages = screen,
            pages = 0,
            stopReason = "limit_reached";
        try {
            // 向上翻页，直到读够、读到已有记录、到达最早或出现异常
            while (messages.length < limit) {
                if (afterTexts(messages, until) >= 0) {
                    stopReason = "reached_known";
                    break;
                }
                if (pages >= 20) {
                    stopReason = "page_cap";
                    break;
                }
                if (!scroll(true)) {
                    stopReason = "scroll_failed";
                    break;
                }
                pages++;
                var older = visibleMessages(budget);
                // 列表没有移动：已经到最早的消息
                if (samePlace(older, screen)) {
                    stopReason = "history_start";
                    break;
                }
                screen = older;
                // 新的一屏必须和已读部分有重叠，才能确定拼接位置；否则停止，避免拼错顺序
                var shared = overlap(older, messages);
                if (!shared) {
                    stopReason = "unverified_overlap";
                    break;
                }
                // 重叠部分在上一屏可能被截断（看不到头像、图片没截全），用这一屏补上方向和缩略图。
                for (var k = 0; k < shared; k++) {
                    var seen = older[older.length - shared + k];
                    if (messages[k].direction === "unknown") messages[k].direction = seen.direction;
                    if (!messages[k].thumbnail && seen.thumbnail) {
                        messages[k].thumbnail = seen.thumbnail;
                        delete messages[k].image_error;
                    }
                }
                // 把新的一屏中更早的部分拼到前面
                messages = older.slice(0, older.length - shared).concat(messages);
            }
        // 翻过页就滑回底部，下次操作仍从最新消息开始
        } finally {
            if (pages) scrollToLatest();
        }
        // 提前停止的读取记为降级：结果可能不完整
        var STOP_WARNINGS = {
            unverified_overlap: "向上翻页时相邻两屏没能比对上，读取提前停止，更早的消息可能没读到",
            page_cap: "翻到 20 页上限仍没读到已有记录，中间的消息可能没读到",
            scroll_failed: "消息列表滑动失败，读取提前停止"
        };
        step("读取消息", messages.length + " 条，翻页 " + pages + " 次，停止原因 " + stopReason);
        if (STOP_WARNINGS[stopReason]) warn("READ_" + stopReason.toUpperCase(), STOP_WARNINGS[stopReason]);
        var thumbFailed = messages.filter(function (m) {
            return m.image_error === "缩略图获取失败" || m.image_error === "缩略图超过大小限制";
        }).length;
        if (thumbFailed) warn("THUMBNAIL_FAILED", thumbFailed + " 张图片没能截取缩略图");
        // 需要取原图时，只处理 until 之后的新图片
        if (options.originals > 0) fetchOriginals(messages, Math.max(0, afterTexts(messages, until)), options.originals, options.tag);
        // 读完再核对一次，确保读取期间没有被切到别的聊天
        verifyChat(name);
        return {
            messages: withoutPosition(messages.slice(-limit)),
            captured_at: new Date().toISOString(),
            history_pages: pages,
            stop_reason: stopReason
        };
    }

    // ---------- 原图 ----------

    // 微信“保存图片”可能写入的目录。只取开始保存之后新出现的文件。
    var SAVE_DIRS = ["/sdcard/Pictures/WeiXin/", "/sdcard/DCIM/WeiXin/", "/sdcard/tencent/MicroMsg/WeiXin/", "/sdcard/Pictures/", "/sdcard/DCIM/Camera/"];

    // newestSavedImage 在保存目录中找 since 之后最新的图片文件，确认已写完后返回路径；没有返回 null。
    function newestSavedImage(since) {
        var best = null,
            bestTime = since - 2000;
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
        sleep(300);
        return size > 0 && best.length() === size ? String(best.getPath()) : null;
    }

    // 微信能否把图片保存到手机（“读写设备上的照片及文件”权限）。没有权限时点“保存图片”会弹出授权框。
    function wechatCanSave() {
        var pm = context.getPackageManager();
        return pm.checkPermission("android.permission.WRITE_EXTERNAL_STORAGE", PKG) === android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    // 逐次按返回直到回到聊天页；每次等页面切换完成，避免多按退出聊天。
    function leaveViewer() {
        for (var i = 0; i < 3 && !messageList(); i++) {
            back();
            waitFor(messageList, 1500);
        }
    }

    // 点开图片 → 等待加载 → 有“查看原图”就加载原图 → 长按“保存图片”取原图文件 → 返回聊天。
    // 微信没有存储权限或保存失败时，截取大图页面代替（清晰度高于聊天缩略图）。
    // 结果写在 message 上：original_file（original_source 为 screenshot 表示截图）或 original_error。
    function saveOriginal(message, b, fileName) {
        var started = Date.now();
        new java.io.File(originalsDir).mkdirs();
        try {
            // 1. 点击图片可见部分的中心，等聊天列表消失（大图页面已打开）
            check();
            click(Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2));
            if (!waitFor(function () {
                return inWechat() && !messageList();
            }, 3000))
                fail("VIEWER_NOT_OPEN", "大图没有打开");
            sleep(800);
            // 2. 有“查看原图”按钮就点开，等按钮和加载进度消失，最多 20 秒
            var full = one(textStartsWith("查看原图"));
            if (full) {
                tap(full);
                waitFor(function () {
                    return !one(textStartsWith("查看原图")) && !one(textMatches(/^\d{1,3}%$/));
                }, 20000);
                sleep(500);
            }
            // 3. 微信有存储权限时，长按图片，在菜单中点“保存图片”，等新文件出现
            var saved = null,
                save = null;
            if (wechatCanSave()) {
                press(Math.round(device.width / 2), Math.round(device.height / 2), 800);
                save = waitFor(function () {
                    return one(text("保存图片"));
                }, 2500);
            }
            if (save) {
                tap(save);
                saved = waitFor(function () {
                    return newestSavedImage(started);
                }, 8000);
            }
            // 4. 取到文件：复制到原图目录等电脑来取，并删除微信存进相册的副本
            if (saved) {
                var ext = saved.slice(saved.lastIndexOf(".")).toLowerCase();
                files.copy(saved, originalsDir + fileName + ext);
                files.remove(saved); // 删除微信存进相册的副本
                media.scanFile(saved);
                message.original_file = fileName + ext;
                step("取原图", "已保存原图文件");
            // 没取到文件：关闭可能还开着的菜单，截取大图页面代替，并记一条降级
            } else {
                if (one(text("取消"))) {
                    back(); // 关闭长按菜单
                    sleep(500);
                }
                var shot = capture();
                try {
                    images.save(shot, originalsDir + fileName + ".jpg", "jpg", 92);
                } finally {
                    shot.recycle();
                }
                message.original_file = fileName + ".jpg";
                message.original_source = "screenshot";
                message.original_note = wechatCanSave() ? "没能保存原图文件，用大图截图代替" : "微信没有“读写照片及文件”权限，用大图截图代替原图";
                warn("ORIGINAL_SCREENSHOT", message.original_note);
            }
        } catch (e) {
            message.original_error = String(e.message || e);
            warn("ORIGINAL_FAILED", "取原图失败：" + message.original_error);
        // 无论成功与否都返回聊天页
        } finally {
            leaveViewer();
        }
    }

    // 为 messages[from:] 中的图片取原图，从最早的开始最多 max 张（电脑把 from 设在最早一张还没有原图的图片处）。
    // 当前在聊天底部：用屏幕内容与 messages 的重叠确定每条消息在屏幕上的位置，必要时向上翻页。
    function fetchOriginals(messages, from, max, tag) {
        // 选出要取原图的图片在 messages 中的位置
        var targets = [];
        for (var i = from; i < messages.length && targets.length < max; i++) {
            if (messages[i].kind === "image") targets.push(i);
        }
        if (!targets.length) return;
        // 当前屏幕在聊天底部：屏幕上的第 k 条对应 messages[offset + k]
        var screen = visibleMessages(null),
            mapped = overlap(messages, screen), // screen[0..mapped) 对应 messages 的最后 mapped 条
            offset = messages.length - mapped,
            pages = 0;
        try {
            // 先处理当前屏幕上能看到的目标图片，再向上翻页处理更早的
            while (targets.length && mapped) {
                var remaining = [];
                for (var t = 0; t < targets.length; t++) {
                    var k = targets[t] - offset;
                    if (k < 0 || k >= mapped || screen[k].kind !== "image") {
                        remaining.push(targets[t]);
                        continue;
                    }
                    saveOriginal(messages[targets[t]], screen[k].bounds, tag + "-" + targets[t]);
                    // 返回后列表应停在原位置，否则无法继续对应，停止。
                    var after = visibleMessages(null);
                    if (!samePlace(after, screen)) {
                        remaining = [];
                        break;
                    }
                }
                // 还有没处理的：向上翻一页，用新旧两屏的重叠更新对应关系
                targets = remaining;
                if (!targets.length || pages >= 20 || !scroll(true)) break;
                pages++;
                var older = visibleMessages(null),
                    shared = overlap(older, screen);
                if (!shared || samePlace(older, screen)) break;
                offset -= older.length - shared;
                screen = older;
                mapped = older.length;
            }
        } finally {
            if (pages) scrollToLatest();
        }
        // 翻页后仍没找到的图片，记下原因
        targets.forEach(function (i) {
            if (!messages[i].original_file && !messages[i].original_error) {
                messages[i].original_error = "没能在屏幕上定位这张图片";
                warn("ORIGINAL_NOT_LOCATED", "有图片没能在屏幕上定位，未取原图");
            }
        });
    }

    // 当前屏幕的消息快照；capture 为 true 时附带图片缩略图。
    function snapshot(capture) {
        return {
            messages: withoutPosition(visibleMessages(capture ? { images: MAX_THUMBNAILS } : null)),
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
        return waitFor(input, 2500);
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
        }, 2000);
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
        }, 5000);
        if (!confirmed) failWithScreen("SEND_UNCONFIRMED", "已尝试点击发送，但未确认新增消息；请核对手机，不要直接重发");
        step("发送文字", "界面已出现新消息");
        verifyChat(name);
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
            if (/packageinstaller|permissioncontroller|lbe\.security/.test(foregroundPackage())) return "permission";
            return one(descMatches(/搜索/)) || one(text("搜索"));
        }, 5000);
        if (search === "permission")
            fail("WECHAT_STORAGE_PERMISSION", "微信需要“读取设备上的照片及文件”权限才能发送图片，请在手机上允许后重试");
        if (!search) fail("SHARE_PICKER_UNSUPPORTED", "未识别微信分享联系人选择页");
        // 点搜索，输入聊天的搜索名称
        tap(search);
        var box = waitFor(function () {
            return one(className("android.widget.EditText"));
        }, 3000);
        if (!box || !box.setText((aliases[name] || {}).query || name)) fail("SHARE_SEARCH_UNSUPPORTED", "未找到分享搜索框");

        // 搜索结果是会话行（与首页会话列表同一种控件），名称必须与目标的某种写法一致且唯一。
        // 不能按搜索词找文字：搜索框本身、“包含: xxx”的群聊行都会误中。
        var variants = titleVariants(name),
            rows = [];
        waitFor(function () {
            rows = unique(
                all(id(profile.contact_id)).filter(function (n) {
                    return variants.indexOf(normalizeTitle(n.text())) >= 0;
                })
            );
            return rows.length === 1;
        }, 3000);
        if (rows.length !== 1) fail("AMBIGUOUS_SHARE_TARGET", "分享页中没有找到唯一的「" + name + "」");
        tap(rows[0]);

        // 确认弹窗：有“发送”按钮，并且能看到收件人名称。
        var confirm = waitFor(function () {
            return one(textMatches(/^发送(\(1\))?$/));
        }, 3000);
        var recipientShown = all(className("android.widget.TextView")).some(function (n) {
            return variants.indexOf(normalizeTitle(n.text())) >= 0;
        });
        if (!confirm || !recipientShown) fail("SHARE_CONFIRM_UNSUPPORTED", "无法核对分享确认页的收件人");
        return confirm;
    }

    // 通过系统分享把图片发给微信：分享页搜索唯一收件人，发送后回到聊天确认出现新的发出图片。
    function sendImage(name, group, base64, fileTag) {
        // 1. 解码图片并确认是有效图片，写成临时文件供分享
        var bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        var decoded = images.fromBytes(bytes);
        if (!decoded) fail("BAD_IMAGE", "图片解码失败");
        decoded.recycle();
        var path = workDir + "outgoing-" + fileTag + ".jpg";
        files.writeBytes(path, bytes);

        // 2. 在聊天里记下发送前发出的图片数
        verifyChat(name);
        var before = outgoingImageCount(visibleMessages(null));
        // 允许以 file:// 地址分享文件。
        android.os.StrictMode.setVmPolicy(new android.os.StrictMode.VmPolicy.Builder().build());
        // 3. 用系统分享把图片发给微信的分享页面
        var intent = new android.content.Intent(android.content.Intent.ACTION_SEND);
        intent.setType("image/jpeg");
        intent.putExtra(android.content.Intent.EXTRA_STREAM, android.net.Uri.fromFile(new java.io.File(path)));
        intent.setClassName(PKG, "com.tencent.mm.ui.tools.ShareImgUI");
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);

        // 4. 在分享页选中唯一的收件人；失败时退出分享页
        var confirm;
        try {
            confirm = pickShareTarget(name);
        } catch (e) {
            // 还没点“发送”，退出分享页，避免手机停在选择聊天页面。
            // 权限弹窗除外：按返回等于替用户拒绝授权。
            // 依次收起键盘、退出搜索、关闭分享页，最多按 3 次返回。
            for (var i = 0; i < 3 && e.code !== "WECHAT_STORAGE_PERMISSION"; i++) {
                if (!one(text("选择聊天")) && !one(className("android.widget.EditText"))) break;
                back();
                sleep(600);
            }
            throw e;
        }
        // 5. 点发送；从这里开始出错只能报告“结果未知”
        step("分享图片", "已核对收件人，点击发送");
        clicked = true;
        tap(confirm);
        sleep(1500);
        // 外部分享成功后微信会问“返回 xxx / 留在微信”，留在微信才能继续确认结果。
        var stay = one(text("留在微信"));
        if (stay) tap(stay);

        // 6. 回到聊天确认：发出的图片多了一张，且最后一条就是发出的图片；确认后删除临时文件
        openChat(name, group);
        var confirmed = waitFor(function () {
            var now = visibleMessages(null),
                last = now[now.length - 1];
            return outgoingImageCount(now) > before && last && last.kind === "image" && last.direction === "outgoing";
        }, 5000);
        if (!confirmed) failWithScreen("SEND_UNCONFIRMED", "已点击图片发送，尚未确认新增图片，请检查手机，不要重发");
        step("发送图片", "聊天中已出现新发出的图片");
        files.remove(path);
    }

    // ---------- 未读监测 ----------

    // collectRow 递归收集会话行内的文字（最多 8 层），拼成签名；
    // 描述含“未读”或有 1–3 位数字的小角标时，标记为未读。
    function collectRow(node, depth, info) {
        if (!node || depth > 8) return;
        var t = String(node.text() || ""),
            d = String(node.desc() || "");
        if (/未读|unread/i.test(d) || (/^\d{1,3}\+?$/.test(t) && node.bounds().width() < 100)) info.unread = true;
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
            if (!label || b.left < 0 || b.right > device.width) return;
            var row = n; // 向上找到整行：高度不超过屏幕四分之一的最外层
            for (var i = 0; i < 6 && row.parent() && row.parent().bounds().height() <= device.height / 4; i++)
                row = row.parent();
            var info = { unread: false, signature: "" };
            collectRow(row, 0, info);
            if (info.unread) result[chatName(label)] = info.signature;
        });
        return result;
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
        stillInChat: stillInChat,
        currentChat: currentChat,
        openChat: openChat,
        returnToList: returnToList,
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
