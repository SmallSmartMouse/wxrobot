const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const test = require("node:test");
const source = fs.readFileSync(__dirname + "/connection.js", "utf8");
const between = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const body = between("    function retryDelay(", "    function disconnect(") + between("    function discover(", "    threads.start(function () {\n        while");
const A = "a".repeat(64), B = "b".repeat(64);

function fixture(trusted) {
    let clock = 1000000;
    const ctx = {
        trusted, peers: {}, pending: null, closed: false, saved: 0, disconnected: [],
        Date: { now: () => clock },
        locked: fn => fn(),
        saveTrusted() { ctx.saved++; },
        disconnect(peer) { ctx.disconnected.push(peer.id); },
    };
    vm.createContext(ctx);
    vm.runInContext(body, ctx);
    return { ctx, advance: ms => { clock += ms; } };
}
const broadcast = (id, port = 18788) => ({ type: "wxrobot-discover-v2", server_id: id, nonce: "c".repeat(32), link_port: port });

test("trusted computer retries back off from 5 seconds to 5 minutes", () => {
    const { ctx } = fixture({ [A]: { token: "t" } });
    const peer = { id: A };
    const delays = Array.from({ length: 9 }, () => ctx.retryDelay(peer, false));
    assert.deepEqual(delays, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
});

test("successful computer becomes the only trusted one and old peers are dropped", () => {
    const { ctx } = fixture({ [A]: { token: "a" }, [B]: { token: "b" } });
    ctx.peers[A] = { id: A };
    ctx.peers[B] = { id: B };
    assert.equal(ctx.trustOnly(ctx.peers[A]), 1);
    assert.deepEqual(Object.keys(ctx.trusted), [A]);
    assert.deepEqual(Object.keys(ctx.peers), [A]);
    assert.deepEqual(ctx.disconnected, [B]);
    assert.equal(ctx.saved, 1);
    assert.equal(ctx.trustOnly(ctx.peers[A]), 0);
    assert.equal(ctx.saved, 1, "nothing to remove must not rewrite the file");
});

test("steady broadcasts from an unreachable computer do not speed up retries", () => {
    const { ctx, advance } = fixture({ [A]: { token: "a" } });
    ctx.discover(broadcast(A), "192.168.0.120");
    const peer = ctx.peers[A];
    peer.phase = "closed";
    peer.failures = 4;
    peer.next = 999999999;
    advance(30000);
    ctx.discover(broadcast(A), "192.168.0.120");
    assert.equal(peer.failures, 4);
    assert.equal(peer.next, 999999999);
});

test("computer that changed address or came back online is retried at once", () => {
    const { ctx, advance } = fixture({ [A]: { token: "a" } });
    ctx.discover(broadcast(A), "192.168.0.120");
    const peer = ctx.peers[A];
    Object.assign(peer, { phase: "closed", failures: 6, next: 999999999 });
    ctx.discover(broadcast(A), "192.168.0.64");
    assert.equal(peer.failures, 0);
    assert.equal(peer.next, 0);
    Object.assign(peer, { failures: 6, next: 999999999 });
    advance(180000);
    ctx.discover(broadcast(A), "192.168.0.64");
    assert.equal(peer.failures, 0);
    assert.equal(peer.next, 0);
});
