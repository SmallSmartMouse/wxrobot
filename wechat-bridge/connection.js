// 局域网发现与手机主动连接电脑。
//   发现：监听 UDP 发现请求，记下电脑的证书指纹、地址和接入端口，由下面的连接线程主动连过去。
//   连接：首次采用承诺/揭示随机数生成会话验证码，双方确认后保存独立授权凭证；之后用凭证认证并接收电脑的请求。
// WSS 固定证书指纹；验证码和长期凭证不写日志、不放在 UDP 报文中。
//
// options：config（device_id、discovery_port）、base（数据目录）、handle（处理电脑经连接发来的请求，返回 [状态码, 响应体]）、
//          log、diagnostic（记录诊断事件）、onReady（连上电脑后调用）。
module.exports = function (options) {
    var config = options.config, base = options.base;
    var discoverySocket = null;
    var path = base + "trusted-computers.json";
    var trusted = {}, peers = {}, closed = false, pending = null;
    var holder = { id: "", releasedAt: 0 }; // 占用这台手机的电脑；releasedAt 为 0 表示仍连着，否则是断开的时间
    var mutex = new java.util.concurrent.locks.ReentrantLock();
    var random = new java.security.SecureRandom();
    var requests = new java.util.concurrent.Semaphore(16);
    // LINK_HOLD_MS 连接断开后仍为原电脑保留手机的时长：够它重启服务、短暂断网后连回来（重连从 5 秒起），
    // 又不至于让换电脑的人等太久。
    var LINK_HOLD_MS = 30000;
    var HANDSHAKE_TIMEOUT_MS = 190000; // 握手和配对（验证码 3 分钟）的上限
    var UNTRUSTED_FORGET_MS = 120000; // 未授权的电脑这么久没有广播就忘掉

    loadTrusted();

    // loadTrusted 读取已授权的电脑。已授权的电脑按上次连接的地址直接重连，不必等它的发现广播（电脑可能关闭了自动搜索）；
    // 重启脚本前已经连着它：当作刚断开，同样给它 30 秒先连回来，期间不给别的电脑弹配对框。
    function loadTrusted() {
        try { if (files.exists(path)) trusted = JSON.parse(files.read(path)); } catch (e) { throw Error("电脑授权文件读取失败：" + e); }
        for (var savedId in trusted) {
            if (trusted[savedId].address && trusted[savedId].port)
                peers[savedId] = { id: savedId, host: trusted[savedId].address, port: trusted[savedId].port, discoveryNonce: "", phase: "closed", next: 0, seen: 0 };
            holder = { id: savedId, releasedAt: Date.now() };
        }
    }

    // ---------- 工具 ----------

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
    // proof 用凭证对电脑的挑战签名，电脑据此确认是已授权的这台手机。
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

    // ---------- 连接管理 ----------

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
    // heldByOther 手机是否正被另一台电脑占用：已和别的电脑建立连接，或那条连接断开还不到 30 秒。
    // 占用期间不理会其他电脑的发现广播、不去连接它们，也就不会弹出配对框打断正在工作的电脑。
    function heldByOther(id) {
        if (!holder.id || holder.id === id) return false;
        return !holder.releasedAt || Date.now() - holder.releasedAt < LINK_HOLD_MS;
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
            if (holder.id === peer.id && peer.phase === "ready") holder.releasedAt = Date.now();
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

    // ---------- 配对验证码 ----------

    // pairingCode 和电脑各自算出的 6 位验证码：绑定电脑证书、会话、设备、手机秘密和电脑挑战。
    function pairingCode(peer) {
        var digest = hash(["wxrobot-pair-v2", peer.id, peer.session, config.device_id, peer.secret, peer.nonce].join("\n"));
        var value = new java.math.BigInteger(digest.slice(0, 8), 16).mod(java.math.BigInteger.valueOf(1000000));
        return ("000000" + String(value)).slice(-6);
    }
    // showPairing 弹出验证码，等用户在手机上允许或拒绝。
    function showPairing(peer) {
        var code = pairingCode(peer);
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

    // ---------- 电脑发来的消息 ----------
    // 握手：hello（手机）→ challenge → auth（已授权）或 reveal → pairing → paired（新配对）→ ready。
    // 之后电脑发 request，手机回 response。

    // receive 按消息类型交给对应的处理函数；不符合当前阶段的消息忽略。
    function receive(peer, message) {
        var handler = {
            challenge: onChallenge, pairing: onPairing, paired: onPaired, ready: onReady,
            revoked: onRevoked, expired: onEnded, error: onEnded, request: onRequest
        }[message.type];
        if (handler) handler(peer, message);
    }
    // onChallenge 电脑下发挑战：已授权的用凭证签名认证，未授权的揭示秘密开始配对。
    function onChallenge(peer, message) {
        if (peer.phase !== "hello") return;
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
    }
    // onPairing 电脑开始配对：显示验证码。OkHttp 回调线程没有 AutoJs Timer，必须在脚本线程显示弹窗，
    // 否则 AutoJs6 的 onDismiss 会访问空 Timer，导致整个应用闪退。
    function onPairing(peer) {
        if (peer.phase !== "revealed") return;
        peer.phase = "pairing";
        threads.start(function () {
            locked(function () {
                if (!closed && peer.phase === "pairing") showPairing(peer);
            });
        });
    }
    // onPaired 两边都确认后电脑发来凭证：保存授权，再用它认证。
    function onPaired(peer, message) {
        if (peer.phase !== "pairing") return;
        if (!peer.approved) throw Error("手机尚未确认授权");
        if (!/^[a-f0-9]{64}$/.test(message.token)) throw Error("授权凭证无效");
        locked(function () {
            trusted[peer.id] = { token: message.token, address: peer.host, port: peer.port, approved_at: new Date().toISOString() };
            saveTrusted();
        });
        peer.phase = "auth";
        send(peer, { type: "auth", proof: proof(message.token, peer) });
    }
    // onReady 认证通过：手机归这台电脑，记下它的新地址，其他电脑的授权和连接一并移除。
    function onReady(peer) {
        if (peer.phase !== "auth") return;
        peer.phase = "ready";
        peer.declines = 0; peer.failures = 0;
        var removed = locked(function () { return claimPhone(peer); });
        dismiss(peer); options.log("已连接电脑 " + peer.host + "（加密连接）");
        if (removed) options.log("一台手机只信任一台电脑，已移除 " + removed + " 台旧电脑的授权");
        if (options.onReady) options.onReady();
    }
    // claimPhone 在锁内调用：记下电脑的新地址（认证成功后才记，下次直接按它重连），只信任这台电脑，
    // 断开其他还在握手、配对的电脑（关掉配对框），之后也不再理会它们。返回移除授权的电脑数。
    function claimPhone(peer) {
        if (pending === peer) pending = null;
        var saved = trusted[peer.id], removed = 0;
        if (saved && (saved.address !== peer.host || saved.port !== peer.port)) {
            saved.address = peer.host; saved.port = peer.port;
            try { saveTrusted(); } catch (e) { options.log("保存电脑地址失败：" + e); }
        }
        try { removed = trustOnly(peer); } catch (e) { options.log("移除旧电脑授权失败：" + e); }
        holder = { id: peer.id, releasedAt: 0 };
        for (var id in peers) if (id !== peer.id && peers[id].phase !== "closed") disconnect(peers[id], false);
        return removed;
    }
    // onRevoked 电脑主动解除了授权：删除凭证；手机马上可以接受其他电脑，不必再等 30 秒。
    function onRevoked(peer) {
        locked(function () { delete trusted[peer.id]; saveTrusted(); });
        options.log("电脑授权已失效，下次连接需要重新确认"); disconnect(peer, true);
        locked(function () { if (holder.id === peer.id) holder = { id: "", releasedAt: 0 }; });
    }
    // onEnded 配对过期或出错。
    function onEnded(peer, message) {
        options.log(message.message || "电脑配对已过期，请重新搜索"); disconnect(peer, true);
    }
    // onRequest 电脑的请求：在新线程里处理（事件长轮询会阻塞），同时最多 16 个，结果按编号回给电脑。
    function onRequest(peer, message) {
        if (peer.phase !== "ready") return;
        if (!/^[a-f0-9]{32}$/.test(message.id)) throw Error("请求编号无效");
        if (!requests.tryAcquire()) {
            send(peer, { type: "response", id: message.id, status: 503, body: { error: { message: "手机请求繁忙" } } });
            return;
        }
        threads.start(function () {
            try {
                var result = handleSafely(message);
                send(peer, { type: "response", id: message.id, status: result[0], body: result[1] });
            } catch (_) {} finally { requests.release(); }
        });
    }
    // handleSafely 处理请求；主动抛出的错误带状态码，原样返回，其他异常只返回笼统说明，不暴露内部信息。
    function handleSafely(message) {
        try { return options.handle(message); }
        catch (e) { return [e.status || 500, { error: { code: e.code || "INTERNAL_ERROR", message: e.status ? e.message : "手机接口内部错误" } }]; }
    }

    // ---------- 建立连接 ----------

    // pinnedTrust 只接受证书指纹就是 peer.id 的电脑（主机名是可变化的局域网 IP，身份由完整证书指纹校验）。
    function pinnedTrust(peer) {
        return new JavaAdapter(javax.net.ssl.X509TrustManager, {
            getAcceptedIssuers: function () { return java.lang.reflect.Array.newInstance(java.lang.Class.forName("java.security.cert.X509Certificate"), 0); },
            checkClientTrusted: function () { throw new java.security.cert.CertificateException("client certificate unsupported"); },
            checkServerTrusted: function (chain) {
                if (!chain || !chain.length) throw new java.security.cert.CertificateException("missing certificate");
                chain[0].checkValidity();
                var actual = hex(java.security.MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()));
                if (actual !== peer.id) throw new java.security.cert.CertificateException("computer identity changed");
            }
        });
    }
    // connect 向电脑的接入端口建立 WSS 连接，连上后发 hello（带配对用的秘密承诺）。
    function connect(peer) {
        peer.phase = "connecting"; peer.secret = secret(); peer.started = Date.now(); peer.approved = false;
        var trust = pinnedTrust(peer);
        var tls = javax.net.ssl.SSLContext.getInstance("TLS");
        tls.init(null, [trust], random);
        peer.client = new okhttp3.OkHttpClient.Builder()
            .sslSocketFactory(tls.getSocketFactory(), trust)
            .hostnameVerifier(new JavaAdapter(javax.net.ssl.HostnameVerifier, { verify: function () { return true; } }))
            .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
            .pingInterval(15, java.util.concurrent.TimeUnit.SECONDS).build();
        var request = new okhttp3.Request.Builder().url("wss://" + peer.host + ":" + peer.port + "/link").build();
        peer.ws = peer.client.newWebSocket(request, new JavaAdapter(okhttp3.WebSocketListener, {
            onOpen: function (ws) {
                peer.ws = ws; peer.phase = "hello";
                try { send(peer, { type: "hello", device_id: String(config.device_id), name: String(device.brand + " " + device.model), discovery_nonce: peer.discoveryNonce, commit: hash(peer.secret) }); }
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
    // discover 收到电脑的发现请求：记下电脑的地址和接入端口。到电脑的地址取自 UDP 来源，不接受广播内任意指定的外部地址。
    function discover(packet, source) {
        if (closed || packet.type !== "wxrobot-discover-v2" || !/^[a-f0-9]{64}$/.test(packet.server_id) || !/^[a-f0-9]{32}$/.test(packet.nonce) || !(packet.link_port > 0 && packet.link_port <= 65535 && packet.link_port % 1 === 0)) return;
        locked(function () {
            if (heldByOther(packet.server_id)) return;
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
    // 连接线程：每秒检查各电脑，超时的握手断开，到了重试时间的发起连接。
    // 同一时刻只和一台未授权的电脑握手（pending），避免同时弹出多个配对框。
    threads.start(function () {
        while (!closed) {
            locked(function () {
                for (var id in peers) maintainPeer(peers[id]);
            });
            sleep(1000);
        }
    });
    // maintainPeer 在锁内调用：处理一台电脑的连接状态。
    function maintainPeer(peer) {
        var id = peer.id;
        if (peer.phase !== "closed" && peer.phase !== "ready" && Date.now() - peer.started > HANDSHAKE_TIMEOUT_MS) disconnect(peer, true);
        if (peer.phase === "closed" && !trusted[id] && Date.now() - peer.seen > UNTRUSTED_FORGET_MS) { delete peers[id]; return; }
        if (peer.phase !== "closed" || Date.now() < peer.next || heldByOther(id)) return;
        if (!trusted[id]) { if (pending && pending !== peer) return; pending = peer; }
        try { connect(peer); } catch (e) { options.log("建立电脑连接失败：" + e); disconnect(peer, true); }
    }

    // ---------- UDP 发现 ----------

    // listen 接收发现请求，直到 socket 关闭。只接受 IPv4 来源。
    function listen(socket) {
        var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 2048);
        var lastFailure = 0;
        while (!socket.isClosed()) {
            try {
                // 每次重新创建 Packet，避免上一包的长度截断下一包。
                var packet = new java.net.DatagramPacket(buffer, buffer.length);
                socket.receive(packet);
                if (!(packet.getAddress() instanceof java.net.Inet4Address)) continue;
                var request = parsePacket(packet);
                if (request) discover(request, String(packet.getAddress().getHostAddress()));
            } catch (e) {
                if (socket.isClosed()) return;
                if (Date.now() - lastFailure > 60000) {
                    lastFailure = Date.now();
                    options.diagnostic("warning", "DISCOVERY_FAILED", "局域网发现请求处理失败：" + e, { source: "discovery" });
                }
            }
        }
    }
    // parsePacket 解析发现请求，格式无效返回 null。
    function parsePacket(packet) {
        try {
            return JSON.parse(String(new java.lang.String(packet.getData(), packet.getOffset(), packet.getLength(), "UTF-8")));
        } catch (_) {
            return null;
        }
    }

    // startDiscovery 打开 UDP 发现端口（config.discovery_port，默认 39000，0 为关闭）。失败时只记日志：
    // 已授权的电脑仍会按保存的地址重连。
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
            options.log("局域网自动发现启动失败：" + e + "；已授权的电脑仍会按保存的地址重连");
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
