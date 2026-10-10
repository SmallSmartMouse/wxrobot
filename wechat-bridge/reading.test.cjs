const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const test = require("node:test");
const source = fs.readFileSync(__dirname + "/wechat.js", "utf8");
const readSource = source.slice(source.indexOf("    function readMessages("), source.indexOf("    // ---------- 原图 ----------"));
const originalsSource = source.slice(source.indexOf("    function fetchOriginals("), source.indexOf("    // 当前屏幕的消息快照"));
function fixture() {
    let up = 0;
    const screen = [{text:"latest",kind:"image"}];
    const ctx = {
        verifyChat(){}, scrollToLatest(){return true;}, entered:{}, newBudget:()=>({unrecognized:[]}),
        visibleMessages:()=>screen, afterTexts:()=>-1, MAX_PAGES:20, NEW_ONLY_MAX_PAGES:5, MAX_ORIGINAL_PAGES:8,
        canScrollUp:()=>true, pageUp(){up++;return false;}, step(){},warn(){},
        READ_STOP_WARNINGS:{}, withoutPosition:x=>x, overlap:()=>1, samePlace:()=>true,
        saveOriginal(){},
    };
    vm.createContext(ctx); vm.runInContext(readSource + originalsSource,ctx);
    return {ctx, up:()=>up};
}
test("new-only reads current screen with zero history pages",()=>{
    const {ctx,up}=fixture();
    ctx.canScrollUp=()=>{throw Error("must not inspect older pages");};
    const r=ctx.readMessages("chat",{limit:100,readHistory:false,originals:2});
    assert.equal(up(),0);assert.equal(r.history_pages,0);assert.equal(r.stop_reason,"new_messages_only");
    assert.equal(r.messages.length,1);
});
test("original recovery never pages up in new-only mode",()=>{
    const {ctx,up}=fixture();
    ctx.canScrollUp=()=>{throw Error("must not search historical images");};
    ctx.fetchOriginals([{kind:"image"},{kind:"text"}],0,1,"test",false);
    assert.equal(up(),0);
});
test("default history mode still attempts paging",()=>{
    const {ctx,up}=fixture();
    const r=ctx.readMessages("chat",{limit:30});
    assert.equal(up(),1);assert.equal(r.stop_reason,"scroll_failed");
});

test("new-only ignores history limit and keeps the whole observed screen",()=>{
    const {ctx,up}=fixture();
    ctx.visibleMessages=()=>[{text:"one"},{text:"two"},{text:"three"}];
    const r=ctx.readMessages("chat",{limit:1,readHistory:false});
    assert.equal(r.messages.length,3);assert.equal(up(),0);
});
test("new-only pages back until the last known texts so the batch can be aligned",()=>{
    const {ctx,up}=fixture();
    // 底部一屏只有新消息；向上一页才看到上次读到的 known
    const screens=[[{text:"new1"},{text:"new2"}],[{text:"known"},{text:"new1"}]];
    let page=0;
    ctx.visibleMessages=()=>screens[Math.min(page,screens.length-1)];
    ctx.pageUp=()=>{page++;return true;};
    ctx.afterTexts=(messages,until)=>messages.findIndex(m=>m.text===until[0]);
    const r=ctx.readMessages("chat",{limit:1,readHistory:false,until:["known"]});
    assert.equal(r.history_pages,1);assert.equal(r.stop_reason,"reached_known");
    assert.deepEqual(r.messages.map(m=>m.text),["known","new1","new2"]);
});
test("new-only stops paging at its own small cap",()=>{
    const {ctx}=fixture();
    let page=0;
    ctx.visibleMessages=()=>[{text:"p"+page},{text:"p"+(page-1)}];
    ctx.pageUp=()=>{page++;return true;};
    const r=ctx.readMessages("chat",{limit:1,readHistory:false,until:["never"]});
    assert.equal(r.history_pages,5);assert.equal(r.stop_reason,"new_messages_only");
});
test("cannot reach bottom must fail instead of claiming a successful read",()=>{
    const {ctx}=fixture();ctx.scrollToLatest=()=>false;ctx.fail=(code)=>{throw Error(code);};
    assert.throws(()=>ctx.readMessages("chat",{limit:30,readHistory:false}),/LATEST_NOT_REACHED/);
});

test("classification failure keeps successfully read messages",()=>{
    const {ctx}=fixture();
    ctx.identifyChatKind=()=>{throw Error("details unavailable");};
    const r=ctx.readMessages("chat",{limit:20,readHistory:false,identifyKind:true});
    assert.equal(r.messages.length,1);assert.equal(r.chat_type,"unknown");
});

const kindSource=source.slice(source.indexOf("    function identifyChatKind("),source.indexOf("    // ---------- 打开聊天 ----------"));
for (const [activity,expected] of [["com.tencent.mm.ui.SingleChatInfoUI","person"],["com.tencent.mm.chatroom.ui.ChatroomInfoUI","group"],["com.tencent.mm.ui.OtherUI","unknown"]]) {
    test("classify verified details page: "+activity,()=>{
        let inChat=true,returned=0;
        const ctx={verifyChat(){assert.equal(inChat,true);},one:()=>({}),desc:x=>x,
            tap(){inChat=false;},messageList:()=>inChat,waitFor:f=>f(),inWechat:()=>true,
            currentActivity:()=>activity,back(){inChat=true;returned++;}};
        vm.createContext(ctx);vm.runInContext(kindSource,ctx);
        assert.equal(ctx.identifyChatKind("anything群(123)"),expected);
        assert.equal(returned,1);assert.equal(inChat,true);
    });
}
test("missing details button does not guess or navigate",()=>{
    const ctx={verifyChat(){},one:()=>null,desc:x=>x,tap(){throw Error("must not tap");}};
    vm.createContext(ctx);vm.runInContext(kindSource,ctx);
    assert.equal(ctx.identifyChatKind("群(123)"),"unknown");
});
