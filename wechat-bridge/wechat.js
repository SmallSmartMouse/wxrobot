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
    var profile = {};
    [DEFAULT_PROFILE, config.profile || {}].forEach(function (source) {
        for (var key in source) if (source[key]) profile[key] = source[key];
    });
    // 聊天名称 → { query: 搜索和原生标题使用的名称, title: OCR 看到的标题, list_name: 会话列表里的名称 }
    var aliases = config.chat_aliases || {};
    var deadline = 0;
    var clicked = false; // 本次任务是否已点击发送；点击后出错只能报告“结果未知”
    var captureFailed = false; // 截图授权失效（例如被其他脚本的截图申请顶掉），需要重启微信桥
    var originalsDir = workDir + "originals/";

    function fail(code, message) {
        var e = new Error(message);
        e.code = code;
        throw e;
    }

    function clock() {
        return android.os.SystemClock.elapsedRealtime();
    }

    function capture() {
        try {
            return images.copy(captureScreen());
        } catch (e) {
            captureFailed = true;
            fail("CAPTURE_FAILED", "截图失败，截图授权可能已失效，请重启微信桥");
        }
    }

    // 开始一次新操作：重设超时并清除“已点击发送”标记。
    function begin(timeoutMs) {
        deadline = clock() + timeoutMs;
        clicked = false;
    }

    function screenLocked() {
        return !device.isScreenOn() || context.getSystemService("keyguard").isKeyguardLocked();
    }

    // 每个界面步骤前检查：未超时、无障碍开启、屏幕解锁。
    function check() {
        if (clock() > deadline) fail("UI_TIMEOUT", "界面操作超时");
        if (!auto.service) fail("ACCESSIBILITY_DISABLED", "无障碍服务已关闭");
        if (screenLocked()) fail("SCREEN_LOCKED", "请保持手机亮屏并解锁");
    }

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

    function all(selector) {
        var found = selector.packageName(PKG).visibleToUser(true).find(),
            list = [];
        for (var i = 0; i < found.size(); i++) list.push(found.get(i));
        return list;
    }

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

    function inWechat() {
        return foregroundPackage() === PKG;
    }

    // 聊天页面的消息列表；不在聊天页面时返回 null。
    function messageList() {
        return inWechat() ? one(id(profile.list_id)) : null;
    }

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

    function editDistance(a, b) {
        var row = [];
        for (var j = 0; j <= b.length; j++) row.push(j);
        for (var i = 1; i <= a.length; i++) {
            var diagonal = row[0];
            row[0] = i;
            for (var k = 1; k <= b.length; k++) {
                var above = row[k];
                row[k] = Math.min(row[k] + 1, row[k - 1] + 1, diagonal + (a[i - 1] === b[k - 1] ? 0 : 1));
                diagonal = above;
            }
        }
        return row[b.length];
    }

    // OCR 识别结果与名称是否足够接近：数字和字母必须完全一致（避免“1群”与“2群”混淆），
    // 其余每 5 个字允许错 1 个（OCR 常把“淘”认成“海”）。
    function ocrSimilar(observed, expected) {
        var digits = function (t) {
            return (t.match(/[0-9a-z]/g) || []).join("");
        };
        if (digits(observed) !== digits(expected)) return false;
        return editDistance(observed, expected) <= Math.floor(Math.max(observed.length, expected.length) / 5);
    }

    // 同一个聊天可能出现的所有写法：通知/会话名、搜索名、OCR 标题、会话列表名。
    function titleVariants(name) {
        var alias = aliases[name] || {};
        return [name, alias.query, alias.title, alias.list_name]
            .filter(function (t) {
                return t;
            })
            .map(normalizeTitle);
    }

    function chatName(label) {
        var key = normalizeTitle(label);
        for (var name in aliases) if (titleVariants(name).indexOf(key) >= 0) return name;
        return label;
    }

    // ---------- 核对当前聊天 ----------

    var lastSeenTitle = ""; // 最近一次核对时看到的标题，核对失败时写进错误信息

    function nativeTitle() {
        var nodes = all(id(profile.title_id));
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].bounds().top < device.height * 0.2 && nodes[i].text()) return String(nodes[i].text());
        }
        return null;
    }

    // 标题栏 OCR 识别出的文字。
    function ocrTitleLabels() {
        var shot = capture();
        var strip = images.clip(shot, 0, Math.round(device.height * 0.03), device.width, Math.round(device.height * 0.08));
        try {
            var words = ocr.detect(strip),
                labels = [];
            for (var i = 0; i < words.length; i++) labels.push(String(words[i].label));
            return labels;
        } finally {
            strip.recycle();
            shot.recycle();
        }
    }

    // 先比对原生标题控件（必须完全一致）；读不到或不一致时用 OCR 识别标题栏（允许少量识别错误）。
    // 群聊页面不暴露标题控件，只能靠 OCR。
    function chatIs(name) {
        if (!messageList()) return false;
        var variants = titleVariants(name),
            title = nativeTitle();
        if (title !== null && variants.indexOf(normalizeTitle(title)) >= 0) return true;
        var labels = ocrTitleLabels();
        lastSeenTitle = "标题控件「" + title + "」，OCR「" + labels.join(" ") + "」";
        var matched = labels.filter(function (label) {
            return variants.some(function (expected) {
                return ocrSimilar(normalizeTitle(label), expected);
            });
        });
        return matched.length === 1;
    }

    function verifyChat(name, timeoutMs, message) {
        lastSeenTitle = "";
        var ok = waitFor(function () {
            return chatIs(name);
        }, timeoutMs || 1800);
        if (!ok) fail("CHAT_MISMATCH", (message || "聊天标题不匹配，已停止操作") + "：期望「" + name + "」，看到" + (lastSeenTitle || "不在聊天页面"));
    }

    // 当前打开的聊天名称，用于监测手动打开的聊天；读不到标题时返回 null。
    function currentChat() {
        if (!messageList()) return null;
        var title = nativeTitle();
        return title && title !== "微信" ? chatName(title.replace(/\s*[（(]\d{1,6}[）)]\s*$/, "")) : null;
    }

    // ---------- 打开聊天 ----------

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
            if (home && nativeTitle() !== "微信") {
                tap(home.tab);
                home = waitFor(homeControls, 1500);
            }
            if (home) return home;
            back();
            sleep(350);
        }
        fail("HOME_NOT_FOUND", "无法返回微信消息列表，请手动打开微信首页");
    }

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
        if (!settled || candidates.length !== 1) fail("CONTACT_AMBIGUOUS", "未找到唯一精确联系人或群，请使用唯一备注名");
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
        verifyChat(name, 4000, "无法核对聊天对象");
    }

    // 依次尝试：当前聊天 → 首页最近会话 → 全局搜索。
    function openChat(name, group) {
        check();
        if (!inWechat()) launchWechat();
        if (chatIs(name)) return;
        var home = goHome();
        var rows = recentRows(name);
        if (rows.length > 1) fail("CONTACT_AMBIGUOUS", "消息列表存在多个同名目标，请使用唯一备注名");
        if (rows.length === 1) {
            tap(rows[0]);
            verifyChat(name, 3000, "最近聊天对象未通过核对");
            return;
        }
        searchChat(name, group, home.search);
    }

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
        var avatars = all(id(profile.avatar_id)).map(function (n) {
            return n.bounds();
        });
        unique(all(id(profile.message_id))).forEach(function (n) {
            var b = n.bounds();
            if (!n.text() || b.bottom <= area.top || b.top >= area.bottom) return;
            result.push({ text: String(n.text()), direction: direction(b, avatars), top: b.top, left: b.left });
        });
        var shot = null;
        try {
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
        for (var i = 0; i < 25 && scroll(false); i++) {
            var after = visibleMessages(null);
            if (samePlace(after, before)) return;
            before = after;
        }
    }

    // 在 messages 的文字消息（跳过图片）中找最后一次连续出现的 texts，返回其后第一条消息的位置；找不到返回 -1。
    function afterTexts(messages, texts) {
        if (!texts.length) return -1;
        var positions = [];
        messages.forEach(function (m, i) {
            if (m.kind !== "image") positions.push(i);
        });
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
        verifyChat(name);
        scrollToLatest();
        var budget = { images: MAX_THUMBNAILS };
        var screen = visibleMessages(budget),
            messages = screen,
            pages = 0,
            stopReason = "limit_reached";
        try {
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
                if (samePlace(older, screen)) {
                    stopReason = "history_start";
                    break;
                }
                screen = older;
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
                messages = older.slice(0, older.length - shared).concat(messages);
            }
        } finally {
            if (pages) scrollToLatest();
        }
        if (options.originals > 0) fetchOriginals(messages, Math.max(0, afterTexts(messages, until)), options.originals, options.tag);
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

    function newestSavedImage(since) {
        var best = null,
            bestTime = since - 2000;
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
            check();
            click(Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2));
            if (!waitFor(function () {
                return inWechat() && !messageList();
            }, 3000))
                fail("VIEWER_NOT_OPEN", "大图没有打开");
            sleep(800);
            var full = one(textStartsWith("查看原图"));
            if (full) {
                tap(full);
                waitFor(function () {
                    return !one(textStartsWith("查看原图")) && !one(textMatches(/^\d{1,3}%$/));
                }, 20000);
                sleep(500);
            }
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
            if (saved) {
                var ext = saved.slice(saved.lastIndexOf(".")).toLowerCase();
                files.copy(saved, originalsDir + fileName + ext);
                files.remove(saved); // 删除微信存进相册的副本
                media.scanFile(saved);
                message.original_file = fileName + ext;
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
                if (!wechatCanSave()) message.original_note = "微信没有“读写照片及文件”权限，用大图截图代替原图";
            }
        } catch (e) {
            message.original_error = String(e.message || e);
        } finally {
            leaveViewer();
        }
    }

    // 为 messages[from:] 中的图片取原图，从最早的开始最多 max 张（电脑把 from 设在最早一张还没有原图的图片处）。
    // 当前在聊天底部：用屏幕内容与 messages 的重叠确定每条消息在屏幕上的位置，必要时向上翻页。
    function fetchOriginals(messages, from, max, tag) {
        var targets = [];
        for (var i = from; i < messages.length && targets.length < max; i++) {
            if (messages[i].kind === "image") targets.push(i);
        }
        if (!targets.length) return;
        var screen = visibleMessages(null),
            mapped = overlap(messages, screen), // screen[0..mapped) 对应 messages 的最后 mapped 条
            offset = messages.length - mapped,
            pages = 0;
        try {
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
        targets.forEach(function (i) {
            if (!messages[i].original_file && !messages[i].original_error) messages[i].original_error = "没能在屏幕上定位这张图片";
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
        var before = countText(content);
        var box = textInput();
        if (!box) fail("INPUT_NOT_FOUND", "未找到唯一聊天输入框，请切换到文字输入模式");
        if (box.text() && String(box.text()).trim()) fail("DRAFT_EXISTS", "聊天中有未发送草稿，未覆盖");
        if (!box.setText(content)) fail("INPUT_FAILED", "无法输入消息");
        var sendButton = waitFor(function () {
            return one(text("发送"));
        }, 2000);
        verifyChat(name);
        box = input();
        if (!sendButton || !box || String(box.text()) !== content) fail("INPUT_MISMATCH", "输入内容或发送按钮不匹配");
        clicked = true;
        tap(sendButton);
        var confirmed = waitFor(function () {
            var current = input();
            return current && !String(current.text() || "") && countText(content) > before;
        }, 5000);
        if (!confirmed) fail("SEND_UNCONFIRMED", "已尝试点击发送，但未确认新增消息；请核对手机，不要直接重发");
        verifyChat(name);
    }

    function outgoingImageCount(messages) {
        return messages.filter(function (m) {
            return m.kind === "image" && m.direction === "outgoing";
        }).length;
    }

    // 在微信“选择聊天”页搜索并选中唯一的目标，返回确认弹窗里的“发送”按钮。
    function pickShareTarget(name) {
        var search = waitFor(function () {
            if (/packageinstaller|permissioncontroller|lbe\.security/.test(foregroundPackage())) return "permission";
            return one(descMatches(/搜索/)) || one(text("搜索"));
        }, 5000);
        if (search === "permission")
            fail("WECHAT_STORAGE_PERMISSION", "微信需要“读取设备上的照片及文件”权限才能发送图片，请在手机上允许后重试");
        if (!search) fail("SHARE_PICKER_UNSUPPORTED", "未识别微信分享联系人选择页");
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
        var bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        var decoded = images.fromBytes(bytes);
        if (!decoded) fail("BAD_IMAGE", "图片解码失败");
        decoded.recycle();
        var path = workDir + "outgoing-" + fileTag + ".jpg";
        files.writeBytes(path, bytes);

        verifyChat(name);
        var before = outgoingImageCount(visibleMessages(null));
        // 允许以 file:// 地址分享文件。
        android.os.StrictMode.setVmPolicy(new android.os.StrictMode.VmPolicy.Builder().build());
        var intent = new android.content.Intent(android.content.Intent.ACTION_SEND);
        intent.setType("image/jpeg");
        intent.putExtra(android.content.Intent.EXTRA_STREAM, android.net.Uri.fromFile(new java.io.File(path)));
        intent.setClassName(PKG, "com.tencent.mm.ui.tools.ShareImgUI");
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);

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
        clicked = true;
        tap(confirm);
        sleep(1500);
        // 外部分享成功后微信会问“返回 xxx / 留在微信”，留在微信才能继续确认结果。
        var stay = one(text("留在微信"));
        if (stay) tap(stay);

        openChat(name, group);
        var confirmed = waitFor(function () {
            var now = visibleMessages(null),
                last = now[now.length - 1];
            return outgoingImageCount(now) > before && last && last.kind === "image" && last.direction === "outgoing";
        }, 5000);
        if (!confirmed) fail("SEND_UNCONFIRMED", "已点击图片发送，尚未确认新增图片，请检查手机，不要重发");
        files.remove(path);
    }

    // ---------- 未读监测 ----------

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

    return {
        begin: begin,
        clicked: function () {
            return clicked;
        },
        status: status,
        chatIs: chatIs,
        currentChat: currentChat,
        openChat: openChat,
        returnToList: returnToList,
        readMessages: readMessages,
        originalsDir: originalsDir,
        snapshot: snapshot,
        sendText: sendText,
        sendImage: sendImage,
        unreadChats: unreadChats
    };
};
