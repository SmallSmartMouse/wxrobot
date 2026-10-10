const fs = require("node:fs"), vm = require("node:vm"), test = require("node:test"), assert = require("node:assert/strict");
const source = fs.readFileSync(__dirname + "/wechat.js", "utf8");
const launch = source.slice(source.indexOf("    function launchWechat()"), source.indexOf("    // 微信底部"));
function fixture() {
  let front = false, primary = 0, fallback = 0;
  const ctx = { PKG: "com.tencent.mm", inWechat: () => front, waitFor: f => f(), step(){},
    app: {startActivity(){primary++;}},
    context: {getPackageManager: () => ({getLaunchIntentForPackage: () => ({addFlags(){}})}), startActivity(){fallback++;front=true;}},
    foregroundPackage: () => "com.miui.home", PERMISSION_UI: /permission/,
    fail(code,message){throw Object.assign(new Error(message),{code});}};
  vm.createContext(ctx); vm.runInContext(launch, ctx);
  return {ctx, front(){front=true;}, counts:()=>[primary,fallback]};
}
test("desktop launch falls back to package launch intent",()=>{const f=fixture();f.ctx.launchWechat();assert.deepEqual(f.counts(),[1,1]);});
test("already foreground does not relaunch",()=>{const f=fixture();f.front();f.ctx.launchWechat();assert.deepEqual(f.counts(),[0,0]);});
test("blocked startup reports foreground and recovery instruction",()=>{const f=fixture();f.ctx.context.startActivity=()=>{};assert.throws(()=>f.ctx.launchWechat(),e=>e.code==="WECHAT_NOT_OPEN"&&/后台弹出界面/.test(e.message)&&/com.miui.home/.test(e.message));});
test("primary launch exception still uses fallback",()=>{const f=fixture();f.ctx.app.startActivity=()=>{throw Error("blocked");};f.ctx.launchWechat();assert.equal(f.counts()[1],1);});
test("connection refresh schedules account work without executing UI in callback",()=>{
 const bridge=fs.readFileSync(__dirname+"/bridge.js","utf8");
 const body=bridge.slice(bridge.indexOf("function requestAccountRefresh()"),bridge.indexOf("// readAccount"));
 const ctx={withLock:fn=>fn(),accountWanted:false,lastAccountTry:9000};vm.createContext(ctx);vm.runInContext(body,ctx);ctx.requestAccountRefresh();
 assert.equal(ctx.accountWanted,true);assert.equal(ctx.lastAccountTry,0);
 const connection=fs.readFileSync(__dirname+"/connection.js","utf8");
 assert.match(connection,/if \(options.onReady\) options.onReady\(\);/);
 assert.match(bridge,/onReady: requestAccountRefresh/);
});
test("online account error is visible even when ready is true",()=>{
 const src=fs.readFileSync(__dirname+"/../wechat-web/static/device-status.js","utf8").replace(/export /g,"");
 const ctx={};vm.createContext(ctx);vm.runInContext(src,ctx);
 const phone={connection:"在线",available:false,device:{online:true,info:{ready:true,account:{wechat_id:"",error:{code:"WECHAT_NOT_OPEN",message:"当前前台是 com.miui.home"}}}}};
 assert.equal(ctx.deviceStatus(phone),"已连接 · 不可用");assert.match(ctx.deviceProblems(phone).join(""),/微信未打开/);
 phone.available=true;phone.device.info.account={wechat_id:"a"};assert.equal(ctx.deviceProblems(phone).length,0);
});
