const fs = require("node:fs"), vm = require("node:vm"), test = require("node:test"), assert = require("node:assert/strict");
const source = fs.readFileSync(__dirname + "/bridge.js", "utf8");
const body = source.slice(source.indexOf("function requestCapture()"), source.indexOf("\nrequestCapture();"));
function fixture({ locked = false, blocked = false, result = true, throws = false } = {}) {
    const calls = [], diagnostics = [];
    let foreground = "com.tencent.mm";
    const ctx = {
        captureReady: false, lastCaptureRequest: 0, Date,
        device: { isScreenOn: () => true },
        context: { getPackageName: () => "org.autojs.autojs6", getSystemService: () => ({ isKeyguardLocked: () => locked }) },
        currentPackage: () => foreground,
        app: { launchPackage(pkg) { calls.push("launch"); if (!blocked) foreground = pkg; } },
        sleep() {}, threads: { start() { calls.push("clicker"); return { interrupt() { calls.push("interrupt"); } }; } },
        requestScreenCapture() { calls.push("request"); assert.equal(foreground, "org.autojs.autojs6"); if (throws) throw Error("timeout"); return result; },
        addDiagnostic(...args) { diagnostics.push(args); },
        ui: { captureRestored() { calls.push("restored"); } }, log() {}
    };
    vm.createContext(ctx); vm.runInContext(body, ctx);
    ctx.requestCapture();
    return { ctx, calls, diagnostics };
}
test("capture brings AutoJs6 forward before requesting permission", () => {
    const f = fixture(); assert.deepEqual(f.calls, ["launch", "clicker", "request", "interrupt", "restored"]); assert.equal(f.ctx.captureReady, true);
});
test("locked phone defers permission request", () => {
    const f = fixture({ locked: true }); assert.deepEqual(f.calls, []); assert.ok(f.ctx.lastCaptureRequest > 0);
});
test("blocked foreground launch reports recovery without requesting capture", () => {
    const f = fixture({ blocked: true }); assert.deepEqual(f.calls, ["launch"]); assert.match(f.diagnostics[0][2], /手动打开 AutoJs6/);
});
test("denial and timeout both release clicker and leave capture unavailable", () => {
    for (const opts of [{ result: false }, { throws: true }]) {
        const f = fixture(opts); assert.equal(f.ctx.captureReady, false); assert.equal(f.calls.at(-1), "interrupt"); assert.equal(f.diagnostics[0][1], "CAPTURE_REQUEST_FAILED");
    }
});
