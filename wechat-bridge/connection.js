// 局域网发现与手机主动连接电脑。
//   发现：监听 UDP 发现请求。v1（旧版电脑）单播回复本机地址和 HMAC 签名；v2 记下电脑，由下面的连接线程主动连过去。
//   连接：首次采用承诺/揭示随机数生成会话验证码，双方确认后保存独立授权凭证；之后用凭证认证并接收任务请求。
// WSS 固定证书指纹；验证码和长期凭证不写日志、不放在 UDP 报文中。
//
// options：config（device_id、phone_api_token、discovery_port）、base（数据目录）、port（手机 HTTP 端口）、
//          handle（处理电脑经连接发来的请求）、log、diagnostic（记录诊断事件）。
module.exports = function (options) {
    var config = options.config, base = options.base;
    var discoverySocket = null;
    var path = base + "trusted-computers.json";
    var trusted = {}, peers = {}, closed = false, pending = null;
    var mutex = new java.util.concurrent.locks.ReentrantLock();
    var random = new java.security.SecureRandom();
    var requests = new java.util.concurrent.Semaphore(16);
    try { if (files.exists(path)) trusted = JSON.parse(files.read(path)); } catch (e) { throw Error("电脑授权文件读取失败：" + e); }
    // 已授权的电脑按上次连接的地址直接重连，不必等它的发现广播（电脑可能关闭了自动搜索）。
    for (var savedId in trusted) {
        if (trusted[savedId].address && trusted[savedId].port)
            peers[savedId] = { id: savedId, host: trusted[savedId].address, port: trusted[savedId].port, discoveryNonce: "", phase: "closed", next: 0, seen: 0 };
    }

    function locked(fn) { mutex.lock(); try { return fn(); } finally { mutex.unlock(); } }
    function utf8(value) { return new java.lang.String(String(value)).getBytes("UTF-8"); }
    function hex(bytes) {
        var out = "";
        for (var i = 0; i < bytes.length; i++) out += ("0" + (bytes[i] & 255).toString(16)).slice(-2);
        return out;
    }
    function hash(value) { return hex(java.security.MessageDigest.getInstance("SHA-256").digest(utf8(value))); }
    function secret() {
        var bytes = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 32);
        random.nextBytes(bytes); return hex(bytes);
    }
    function hmacHex(key, text) {
        var mac = javax.crypto.Mac.getInstance("HmacSHA256");
        mac.init(new javax.crypto.spec.SecretKeySpec(utf8(key), "HmacSHA256"));
        return hex(mac.doFinal(utf8(text)));
    }
    function proof(token, peer) {
        return hmacHex(token, ["wxrobot-auth-v2", peer.id, peer.session, peer.nonce, config.device_id].join("\n"));
    }
    function saveTrusted() {
        var temp = path + ".tmp";
        files.write(temp, JSON.stringify(trusted));
        if (!new java.io.File(temp).renameTo(new java.io.File(path))) throw Error("保存电脑授权失败");
    }
    function send(peer, value) {
        if (!peer.ws || !peer.ws.send(JSON.stringify(value))) throw Error("电脑连接已中断");
    }
    function dismiss(peer) {
        if (peer.dialog) { try { peer.dialog.dismiss(); } catch (_) {} peer.dialog = null; }
    }
    // 重连间隔：已授权的电脑连续失败时从 5 秒起加倍，最长 5 分钟（重启服务、短暂断网很快重连，长期连不上的不刷屏）；
    // 连上后（ready）或广播显示它换了地址、重新上线时（discover）从头计算。
    // 未授权的电脑每次被拒绝或配对超时后加倍，从 1 分钟到 30 分钟，避免别的电脑的广播反复弹出配对框。
    function retryDelay(peer, rejected) {
        if (trusted[peer.id]) {
            peer.failures = (peer.failures || 0) + 1;
            return Math.min(5000 * Math.pow(2, peer.failures - 1), 5 * 60000);
        }
        if (!rejected) return 5000;
        peer.declines = (peer.declines || 0) + 1;
        return Math.min(60000 * Math.pow(2, peer.declines - 1), 30 * 60000);
    }
    // trustOnly 一台手机只信任一台电脑：peer 认证成功后删除其他电脑的授权并断开它们，返回删除的个数。
    // 旧电脑之后再广播也只会被当作未授权电脑，需要重新配对。
    function trustOnly(peer) {
        var removed = 0;
        for (var id in trusted) {
            if (id === peer.id) continue;
            delete trusted[id];
            removed++;
            if (peers[id]) {
                disconnect(peers[id], false);
                delete peers[id];
            }
        }
        if (removed) saveTrusted();
        return removed;
    }
    function disconnect(peer, rejected) {
        locked(function () {
            if (pending === peer) pending = null;
            peer.phase = "closed";
            peer.next = Date.now() + retryDelay(peer, rejected);
            dismiss(peer);
            if (peer.ws) peer.ws.cancel();
            peer.ws = null;
            if (peer.client) {
                peer.client.dispatcher().executorService().shutdown();
                peer.client.connectionPool().evictAll();
                peer.client = null;
            }
        });
    }
    function showPairing(peer) {
        var digest = hash(["wxrobot-pair-v2", peer.id, peer.session, config.device_id, peer.secret, peer.nonce].join("\n"));
        var value = new java.math.BigInteger(digest.slice(0, 8), 16).mod(java.math.BigInteger.valueOf(1000000));
        var code = ("000000" + String(value)).slice(-6);
        var content = "电脑：" + peer.host + "\n\n在电脑网页输入验证码：\n\n" + code.slice(0, 3) + " " + code.slice(3) + "\n\n有效期 3 分钟。允许后，这台电脑可读取和发送微信消息。";
        try {
            peer.dialog = dialogs.build({
                title: "连接微信消息台", content: content,
                positive: "允许这台电脑", negative: "拒绝",
                autoDismiss: false, canceledOnTouchOutside: false, cancelable: false
            }).on("positive", function () {
                if (peer.phase !== "pairing") return;
                try {
                    peer.approved = true;
                    send(peer, { type: "approve", approved: true });
                    peer.dialog.setContent(content + "\n\n手机已确认，等待网页完成验证…");
                } catch (_) { disconnect(peer, true); }
            }).on("negative", function () { disconnect(peer, true); }).show();
        } catch (e) {
            options.log("无法显示配对验证码，请打开 AutoJs6 后重新搜索：" + e);
            disconnect(peer, true);
        }
    }
    function receive(peer, message) {
        if (message.type === "challenge" && peer.phase === "hello") {
            if (message.server_id !== peer.id || !/^[a-f0-9]{32}$/.test(message.session_id) || !/^[a-f0-9]{64}$/.test(message.nonce)) throw Error("电脑挑战无效");
            peer.session = message.session_id; peer.nonce = message.nonce;
            var saved = trusted[peer.id];
            if (saved) {
                peer.phase = "auth";
                send(peer, { type: "auth", proof: proof(saved.token, peer) });
            } else {
                peer.phase = "revealed";
                send(peer, { type: "reveal", secret: peer.secret });
            }
        } else if (message.type === "pairing" && peer.phase === "revealed") {
            peer.phase = "pairing";
            // OkHttp 回调线程没有 AutoJs Timer。必须在脚本线程显示弹窗，
            // 否则 AutoJs6 的 onDismiss 会访问空 Timer，导致整个应用闪退。
            threads.start(function () {
                locked(function () {
                    if (!closed && peer.phase === "pairing") showPairing(peer);
                });
            });
        } else if (message.type === "paired" && peer.phase === "pairing") {
            if (!peer.approved) throw Error("手机尚未确认授权");
            if (!/^[a-f0-9]{64}$/.test(message.token)) throw Error("授权凭证无效");
            locked(function () {
                trusted[peer.id] = { token: message.token, address: peer.host, port: peer.port, approved_at: new Date().toISOString() };
                saveTrusted();
            });
            peer.phase = "auth";
            send(peer, { type: "auth", proof: proof(message.token, peer) });
        } else if (message.type === "ready" && peer.phase === "auth") {
            peer.phase = "ready";
            peer.declines = 0; peer.failures = 0;
            var removed = 0;
            locked(function () {
                if (pending === peer) pending = null;
                // 认证成功后才记下电脑的新地址，下次直接按它重连
                var saved = trusted[peer.id];
                if (saved && (saved.address !== peer.host || saved.port !== peer.port)) {
                    saved.address = peer.host; saved.port = peer.port;
                    try { saveTrusted(); } catch (e) { options.log("保存电脑地址失败：" + e); }
                }
                try { removed = trustOnly(peer); } catch (e) { options.log("移除旧电脑授权失败：" + e); }
            });
            dismiss(peer); options.log("已连接电脑 " + peer.host + "（加密连接）");
            if (removed) options.log("一台手机只信任一台电脑，已移除 " + removed + " 台旧电脑的授权");
            if (options.onReady) options.onReady();
        } else if (message.type === "revoked") {
            locked(function () { delete trusted[peer.id]; saveTrusted(); });
            options.log("电脑授权已失效，下次连接需要重新确认"); disconnect(peer, true);
        } else if (message.type === "expired" || message.type === "error") {
            options.log(message.message || "电脑配对已过期，请重新搜索"); disconnect(peer, true);
        } else if (message.type === "request" && peer.phase === "ready") {
            if (!/^[a-f0-9]{32}$/.test(message.id)) throw Error("请求编号无效");
            if (!requests.tryAcquire()) {
                send(peer, { type: "response", id: message.id, status: 503, body: { error: { message: "手机请求繁忙" } } });
                return;
            }
            threads.start(function () {
                try {
                    var result;
                    try { result = options.handle(message); }
                    catch (e) { result = [e.status || 500, { error: { message: e.status ? e.message : "手机接口内部错误" } }]; }
                    send(peer, { type: "response", id: message.id, status: result[0], body: result[1] });
                } catch (_) {} finally { requests.release(); }
            });
        }
    }
    function connect(peer) {
        peer.phase = "connecting"; peer.secret = secret(); peer.started = Date.now(); peer.approved = false;
        var trust = new JavaAdapter(javax.net.ssl.X509TrustManager, {
            getAcceptedIssuers: function () { return java.lang.reflect.Array.newInstance(java.lang.Class.forName("java.security.cert.X509Certificate"), 0); },
            checkClientTrusted: function () { throw new java.security.cert.CertificateException("client certificate unsupported"); },
            checkServerTrusted: function (chain) {
                if (!chain || !chain.length) throw new java.security.cert.CertificateException("missing certificate");
                chain[0].checkValidity();
                var actual = hex(java.security.MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()));
                if (actual !== peer.id) throw new java.security.cert.CertificateException("computer identity changed");
            }
        });
        var tls = javax.net.ssl.SSLContext.getInstance("TLS");
        tls.init(null, [trust], random);
        peer.client = new okhttp3.OkHttpClient.Builder()
            .sslSocketFactory(tls.getSocketFactory(), trust)
            // 主机名是可变化的局域网 IP，身份由上面的完整证书指纹校验。
            .hostnameVerifier(new JavaAdapter(javax.net.ssl.HostnameVerifier, { verify: function () { return true; } }))
            .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
            .pingInterval(15, java.util.concurrent.TimeUnit.SECONDS).build();
        var request = new okhttp3.Request.Builder().url("wss://" + peer.host + ":" + peer.port + "/link").build();
        peer.ws = peer.client.newWebSocket(request, new JavaAdapter(okhttp3.WebSocketListener, {
            onOpen: function (ws) {
                peer.ws = ws; peer.phase = "hello";
                try { send(peer, { type: "hello", device_id: String(config.device_id), name: String(device.brand + " " + device.model), api_port: Number(config.phone_api_port || 8766), discovery_nonce: peer.discoveryNonce, commit: hash(peer.secret) }); }
                catch (_) { disconnect(peer, true); }
            },
            onMessage: function (ws, text) {
                if (peer.ws !== ws) return;
                try { receive(peer, JSON.parse(String(text))); }
                catch (e) { options.log("电脑连接处理失败：" + e); disconnect(peer, true); }
            },
            onFailure: function (ws, error) {
                if (peer.ws !== ws) return;
                // 已授权电脑连续失败只记第一次，之后放慢重试，恢复时由“已连接电脑”提示
                if (!trusted[peer.id] || !peer.failures) options.log("电脑连接暂时中断：" + error + (trusted[peer.id] ? "；之后逐步放慢重试，最长 5 分钟一次" : ""));
                disconnect(peer, !trusted[peer.id]);
            },
            onClosing: function (ws) { ws.close(1000, "closed"); },
            onClosed: function (ws) { if (peer.ws === ws) disconnect(peer, !trusted[peer.id]); }
        }));
    }
    // 到电脑的地址取自 UDP 来源，不接受广播内任意指定的外部地址。
    function discover(packet, source) {
        if (closed || packet.type !== "wxrobot-discover-v2" || !/^[a-f0-9]{64}$/.test(packet.server_id) || !/^[a-f0-9]{32}$/.test(packet.nonce) || !(packet.link_port > 0 && packet.link_port <= 65535 && packet.link_port % 1 === 0)) return;
        locked(function () {
            var peer = peers[packet.server_id];
            if (!peer) {
                if (Object.keys(peers).length >= 8 || (!trusted[packet.server_id] && pending)) return;
                peer = peers[packet.server_id] = { id: packet.server_id, phase: "closed", next: 0 };
            }
            // 已授权电脑换了地址或停了一阵后重新广播（例如开机）：不必等放慢后的间隔，马上重连。
            // 一直在广播却连不上的电脑（例如防火墙挡住接入端口）不会因广播而加快重试。
            var returned = String(source) !== peer.host || packet.link_port !== peer.port || Date.now() - (peer.seen || 0) > 120000;
            if (trusted[packet.server_id] && returned && peer.failures) {
                peer.failures = 0;
                if (peer.phase === "closed") peer.next = 0;
            }
            peer.host = String(source); peer.port = packet.link_port; peer.discoveryNonce = packet.nonce; peer.seen = Date.now();
        });
    }
    threads.start(function () {
        while (!closed) {
            locked(function () {
                for (var id in peers) {
                    var peer = peers[id];
                    if (peer.phase !== "closed" && peer.phase !== "ready" && Date.now() - peer.started > 190000) disconnect(peer, true);
                    if (peer.phase === "closed" && !trusted[id] && Date.now() - peer.seen > 120000) { delete peers[id]; continue; }
                    if (peer.phase !== "closed" || Date.now() < peer.next) continue;
                    if (!trusted[id]) { if (pending && pending !== peer) continue; pending = peer; }
                    try { connect(peer); } catch (e) { options.log("建立电脑连接失败：" + e); disconnect(peer, true); }
                }
            });
            sleep(1000);
        }
    });
    // ---------- UDP 发现 ----------

    // replyLegacy 回复旧版电脑（v1）的发现请求：本机地址、接口端口和用 Token 计算的签名，Token 本身不发送。
    function replyLegacy(packet, nonce) {
        var replySocket = new java.net.DatagramSocket();
        try {
            // 通过到电脑的路由选取本机地址，兼容手机同时启用 Wi-Fi、移动数据或 VPN。
            replySocket.connect(packet.getAddress(), packet.getPort());
            var ip = String(replySocket.getLocalAddress().getHostAddress());
            var signature = hmacHex(config.phone_api_token, ["wxrobot-phone-v1", nonce, config.device_id, ip, options.port].join("\n"));
            var data = utf8(JSON.stringify({ type: "wxrobot-phone-v1", nonce: nonce, device_id: String(config.device_id), ip: ip, api_port: options.port, signature: signature }));
            replySocket.send(new java.net.DatagramPacket(data, data.length, packet.getAddress(), packet.getPort()));
        } finally {
            replySocket.close();
        }
    }

    // listen 接收发现请求，直到 socket 关闭。只接受 IPv4 来源；v1 回复每 200 毫秒最多一次。
    function listen(socket) {
        var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 2048);
        var lastReply = 0, lastFailure = 0;
        while (!socket.isClosed()) {
            try {
                // 每次重新创建 Packet，避免上一包的长度截断下一包。
                var packet = new java.net.DatagramPacket(buffer, buffer.length);
                socket.receive(packet);
                if (!(packet.getAddress() instanceof java.net.Inet4Address)) continue;
                var request;
                try {
                    request = JSON.parse(String(new java.lang.String(packet.getData(), packet.getOffset(), packet.getLength(), "UTF-8")));
                } catch (_) { continue; }
                if (request && request.type === "wxrobot-discover-v2") {
                    discover(request, String(packet.getAddress().getHostAddress()));
                } else if (request && request.type === "wxrobot-discover-v1" && /^[0-9a-f]{32}$/.test(request.nonce) && Date.now() - lastReply >= 200) {
                    lastReply = Date.now();
                    replyLegacy(packet, request.nonce);
                }
            } catch (e) {
                if (socket.isClosed()) return;
                if (Date.now() - lastFailure > 60000) {
                    lastFailure = Date.now();
                    options.diagnostic("warning", "DISCOVERY_RESPONSE_FAILED", "局域网发现回复失败：" + e, { source: "discovery" });
                }
            }
        }
    }

    // startDiscovery 打开 UDP 发现端口（config.discovery_port，默认 39000，0 为关闭）。失败时只记日志，仍可手动连接。
    function startDiscovery() {
        var port = config.discovery_port == null ? 39000 : Number(config.discovery_port);
        if (port === 0) return;
        try {
            if (port < 1 || port > 65535 || port % 1 !== 0) throw Error("discovery_port 必须为 0 到 65535");
            if (String(config.device_id).length > 128 || /[\r\n]/.test(String(config.device_id))) throw Error("device_id 格式无效");
            discoverySocket = new java.net.DatagramSocket(port, java.net.InetAddress.getByName("0.0.0.0"));
            discoverySocket.setBroadcast(true);
            var socket = discoverySocket;
            threads.start(function () { listen(socket); });
            options.log("局域网自动发现已启动，UDP 端口 " + port);
        } catch (e) {
            if (discoverySocket) discoverySocket.close();
            options.log("局域网自动发现启动失败：" + e + "；仍可手动连接手机");
        }
    }

    return {
        startDiscovery: startDiscovery,
        discover: discover,
        // 只有配对框显示期间才暂停手机的监测和任务；连接、握手阶段只有几秒，不影响正常工作。
        isPairing: function () { return locked(function () { return pending !== null && pending.phase === "pairing"; }); },
        close: function () {
            closed = true;
            if (discoverySocket) discoverySocket.close();
            locked(function () { for (var id in peers) disconnect(peers[id], false); });
        }
    };
};
