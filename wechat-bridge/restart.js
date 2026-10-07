// 重启微信桥：停止本目录下正在运行的脚本，等文件锁释放后启动 bridge.js，并尝试同意截图授权弹窗。
var BASE = "/sdcard/wechat-bridge/";
// bridge.lock 是当前版本；另外两个是旧版双脚本的锁，升级时也要等它们释放（端口相同）。
var LOCKS = ["bridge.lock", "phone-server.lock", "agent.lock"];

function log(message) {
    console.log(message);
    files.append(BASE + "restart.log", new Date().toISOString() + " " + message + "\n");
}

// 脚本路径可能记录为 /sdcard/... 或 /storage/emulated/0/...，按目录名匹配。
function stopRunningScripts() {
    var running = engines.all();
    for (var i = 0; i < running.length; i++) {
        var source = String(running[i].getSource());
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
        if (currentPackage() !== "com.android.systemui") continue;
        if (!textMatches(/AutoJs6.*截取.*屏幕.*/).exists()) continue;
        var start = text("立即开始").findOnce();
        if (start) {
            start.click();
            return;
        }
    }
}

stopRunningScripts();
waitForLocks();
engines.execScriptFile(BASE + "bridge.js");
log("已启动 bridge.js");
acceptCapturePrompt();
