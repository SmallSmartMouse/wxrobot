// 重启微信桥：停止本目录下正在运行的脚本，等文件锁释放后启动 bridge.js，并尝试同意截图授权弹窗。
var BASE = "/sdcard/wechat-bridge/";
// bridge.lock 是当前版本；另外两个是旧版双脚本的锁，升级时也要等它们释放（端口相同）。
var LOCKS = ["bridge.lock", "phone-server.lock", "agent.lock"];

// log 输出到控制台并追加到 restart.log，方便事后查看重启过程。
function log(message) {
    console.log(message);
    files.append(BASE + "restart.log", new Date().toISOString() + " " + message + "\n");
}

// 脚本路径可能记录为 /sdcard/... 或 /storage/emulated/0/...，按目录名匹配。
function stopRunningScripts() {
    var running = engines.all();
    for (var i = 0; i < running.length; i++) {
        var source = String(running[i].getSource());
        // 停止本目录下除自己以外的所有脚本（包括旧版本的脚本）
        if (source.indexOf("/wechat-bridge/") >= 0 && !/\/restart\.js$/.test(source)) {
            log("停止 " + source);
            running[i].forceStop();
        }
    }
}

// 能临时加锁说明旧实例已退出。
function lockFree(path) {
    if (!files.exists(path)) return true;
    var file = new java.io.RandomAccessFile(path, "rw");
    try {
        // 能拿到锁说明没有实例持有它，立即释放
        var lock = file.getChannel().tryLock();
        if (!lock) return false;
        lock.release();
        return true;
    } catch (_) {
        return false; // 同进程内旧引擎仍持有锁
    } finally {
        file.close();
    }
}

// waitForLocks 等所有锁都可用（旧实例完全退出），最多约 15 秒；超时则放弃启动。
function waitForLocks() {
    for (var attempt = 0; attempt < 60; attempt++) {
        if (LOCKS.every(function (name) { return lockFree(BASE + name); })) return;
        sleep(250);
    }
    log("旧脚本仍未释放锁，放弃启动");
    throw Error("旧脚本仍未停止，请稍后重试");
}

// 启动后系统可能弹出“AutoJs6 将开始截取屏幕”，点“立即开始”。没有弹窗可能是已经授权。
function acceptCapturePrompt() {
    for (var attempt = 0; attempt < 60; attempt++) {
        sleep(250);
        // 只在系统界面弹出截图授权框时点击
        if (currentPackage() !== "com.android.systemui") continue;
        if (!textMatches(/AutoJs6.*截取.*屏幕.*/).exists()) continue;
        var start = text("立即开始").findOnce();
        if (start) {
            start.click();
            return;
        }
    }
}

// 重启流程：停旧脚本 → 等锁释放 → 启动 bridge.js → 处理截图授权弹窗
stopRunningScripts();
waitForLocks();
engines.execScriptFile(BASE + "bridge.js");
log("已启动 bridge.js");
acceptCapturePrompt();
