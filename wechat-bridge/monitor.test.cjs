const fs=require("node:fs"),vm=require("node:vm"),test=require("node:test"),assert=require("node:assert/strict");
const source=fs.readFileSync(__dirname+"/bridge.js","utf8");
const monitorSource=source.slice(source.indexOf('var monitorAccount ='),source.indexOf('// ---------- HTTP ----------'));
function fixture(){
 let clock=10000;const events=[];let owner="a";
 const ctx={Date:{now:()=>clock},lastChat:null,currentAccountId:()=>owner,pushEvent:e=>events.push(e),
 ui:{begin(){},unreadChats:()=>null,currentChat:()=>"chat",snapshot:()=>({messages:[{text:"new"}],at_latest:true})}};
 vm.createContext(ctx);vm.runInContext(monitorSource,ctx);
 return {ctx,events,tick(){clock+=4000;},owner(v){owner=v;}};
}
test("failed snapshot retries unchanged messages on next monitor cycle",()=>{
 const f=fixture();let fail=true;
 f.ctx.ui.snapshot=images=>{if(images&&fail){fail=false;throw Error("capture failed");}return {messages:[{text:"new"}],at_latest:true};};
 assert.throws(()=>f.ctx.monitor(),/capture failed/);f.tick();f.ctx.monitor();
 assert.equal(f.events.length,1);assert.equal(f.events[0].snapshot.messages[0].text,"new");
});
test("empty visible chat is emitted so first arrival is not swallowed",()=>{
 const f=fixture();f.ctx.ui.snapshot=()=>({messages:[],at_latest:true});f.ctx.monitor();
 assert.equal(f.events.length,1);assert.equal(f.events[0].snapshot.messages.length,0);
});
test("unread count survives opening the conversation and account switching",()=>{
 const f=fixture();f.ctx.ui.unreadChats=()=>({chat:{signature:"two unread",count:2}});f.ctx.monitor();
 assert.equal(f.events[0].kind,"unread_chat");assert.equal(f.events[0].unread_count,2);
 f.tick();f.owner("b");f.ctx.monitor();
 assert.equal(f.events.filter(e=>e.kind==="unread_chat").length,2);
});
test("return to list failure does not destroy an already read result",()=>{
 const body=source.slice(source.indexOf("function runTask(task)"),source.indexOf("// POST /v1/account/refresh"));
 let finished;
 const ctx={TASK_TIMEOUT_MS:10000,log(){},currentAccountId:()=>"a",addDiagnostic(){},finishTask:(task,status,result)=>finished={status,result},
 ui:{begin(){},openChat(){},readMessages:()=>({messages:[{text:"new"}]}),returnToList(){throw Error("back failed");},clicked:()=>false,diagnostics:()=>({warnings:[]})}};
 vm.createContext(ctx);vm.runInContext(body,ctx);ctx.runTask({id:"t",operation:"read",payload:{chat:"chat",return_list:true,read_history:false}});
 assert.equal(finished.status,"succeeded");assert.equal(finished.result.messages[0].text,"new");assert.equal(finished.result.diagnostics.warnings[0].code,"RETURN_LIST_FAILED");
});
