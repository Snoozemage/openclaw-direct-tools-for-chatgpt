import assert from "node:assert/strict";
import http from "node:http";
import { readFile, unlink } from "node:fs/promises";
import { handleBrowserTool } from "../src/tools/browser/handler.mjs";

const server=http.createServer((req,res)=>{
  if(req.url.startsWith("/api/check")){
    res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({ok:true,fixture:"browser-live"})); return;
  }
  res.writeHead(200,{"content-type":"text/html; charset=utf-8"});
  res.end(`<!doctype html><html><head><title>OpenClaw Browser Verification</title><style>body{font:18px system-ui;padding:70px;background:#f8f7fc}input,button,select{font:inherit;margin:10px;padding:12px}#count{font-weight:bold}</style></head><body><h1>Browser verification</h1><label>Name <input id="name" aria-label="Name"></label><button id="count" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><select aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select><button onclick="document.querySelector('#result').textContent='ready';fetch('/api/check?at='+Date.now()).then(r=>r.json()).then(x=>window.api=x)">Fetch fixture</button><p id="result"></p></body></html>`);
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin="http://127.0.0.1:"+server.address().port;
let tabId;
let traceActive=false;
const artifacts=[];
async function call(args){
  const result=await handleBrowserTool("openclaw_browser",{...(tabId?{tabId}:{}),...args});
  const texts=result.content?.filter(x=>x.type==="text").map(x=>x.text)??[];
  if(result.isError) throw new Error(JSON.stringify({args,result}));
  let value;
  for(const text of texts){
    const start=text.indexOf("\n---\n"), end=text.lastIndexOf("\n<<<END_EXTERNAL_UNTRUSTED_CONTENT");
    const clean=start>=0&&end>start?text.slice(start+5,end):text;
    try{value=JSON.parse(clean);break;}catch{}
  }
  if(value?.error || value?.type==="tool_error") throw new Error(JSON.stringify(value));
  return {value,text:texts.join("\n"),diagnostics:result.diagnostics};
}
const report=(name,details={})=>console.log(JSON.stringify({check:name,...details}));
try{
  const opened=await call({action:"open",targetUrl:origin,timeoutMs:15000});
  report("open-response",{text:opened.text.slice(0,1200)});
  tabId=opened.value?.tabId??opened.value?.targetId;
  assert.ok(tabId,"open returns a tab handle"); report("opened-fixture",{tabId});
  if(process.env.BROWSER_CLEANUP_TRACE==="1") {
    const stopped=await call({action:"trace",operation:"stop"});
    if(stopped.value?.path)await unlink(stopped.value.path);
    report("cleaned-previous-verification-trace");
  }
  const snapshot=await call({action:"snapshot",interactive:true,compact:true});
  report("snapshot",{text:snapshot.text.slice(0,1400)});
  const nameRef=snapshot.text.match(/textbox[^\n]*?ref[=:" ]+([a-zA-Z0-9]+)/)?.[1];
  const countRef=snapshot.text.match(/button[^\n]*?0[^\n]*?ref[=:" ]+([a-zA-Z0-9]+)/)?.[1];
  assert.ok(nameRef,"Name textbox ref"); assert.ok(countRef,"Counter button ref");
  await call({action:"highlight",ref:countRef}); report("native-highlight");
  const clicked=await call({action:"act",kind:"click",ref:countRef});
  report("click-feedback",clicked.diagnostics);
  assert.equal(clicked.diagnostics?.visualFeedback?.available,true);
  const evaluated=await call({action:"act",kind:"evaluate",fn:'() => ({count:document.querySelector("#count").textContent,feedback:!!document.querySelector("[data-openclaw-browser-feedback]"),state:window[Symbol.for("openclaw.browser.feedback.v1")]?.enabled})'});
  assert.equal(evaluated.value?.result?.count,"1"); assert.equal(evaluated.value?.result?.feedback,true);
  report("cursor-installed-click-landed");
  await call({action:"act",kind:"batch",actions:[{kind:"click",ref:nameRef},{kind:"type",ref:nameRef,text:"Browser works"}]});
  let state=await call({action:"act",kind:"evaluate",fn:'() => document.querySelector("#name").value'});
  assert.equal(state.value?.result,"Browser works"); report("native-batch-input");
  await call({action:"effects",enabled:false});
  state=await call({action:"act",kind:"evaluate",fn:'() => !!document.querySelector("[data-openclaw-browser-feedback]")'});
  assert.equal(state.value?.result,false);
  await call({action:"act",kind:"click",ref:countRef});
  state=await call({action:"act",kind:"evaluate",fn:'() => !!document.querySelector("[data-openclaw-browser-feedback]")'});
  assert.equal(state.value?.result,false); report("effects-disabled-stays-off");
  await call({action:"effects",enabled:true}); report("effects-restored");
  await call({action:"storage",storageKind:"local",operation:"set",key:" verification ",value:"ok"});
  state=await call({action:"storage",storageKind:"local",key:" verification "});
  assert.equal(state.value?.values?.[" verification "],"ok");
  await call({action:"storage",storageKind:"local",operation:"clear"}); report("native-local-storage");
  await call({action:"storage",storageKind:"session",operation:"set",key:"fixture",value:"session-ok"});
  state=await call({action:"storage",storageKind:"session",key:"fixture"});
  assert.equal(state.value?.values?.fixture,"session-ok");
  await call({action:"storage",storageKind:"session",operation:"clear"}); report("native-session-storage");
  try {
    await call({action:"cookies",operation:"set",cookie:{name:"openclaw-fixture",value:"ok",url:origin}});
    state=await call({action:"cookies"});
    assert.ok(state.value?.cookies?.some(c=>c.name==="openclaw-fixture"&&c.value==="ok"));
    report("native-cookie-roundtrip");
  } catch(error) {
    if(!/Storage.setCookies.*wasn't found/.test(error.message)) throw error;
    report("native-cookie-write-unsupported-on-extension");
    try { state=await call({action:"cookies"}); report("native-cookie-read",{supported:true}); }
    catch(readError){ if(!/Storage.getCookies.*wasn't found/.test(readError.message))throw readError; report("native-cookie-read",{supported:false}); }
  } finally {
    await call({action:"act",kind:"evaluate",fn:'() => {document.cookie="openclaw-fixture=;Max-Age=0;path=/";return true}'});
  }
  state=await call({action:"dialogs"}); report("native-dialog-inspection",{ok:state.value?.ok});
  await call({action:"trace",operation:"start",screenshots:false,snapshots:false,sources:false});
  traceActive=true;
  await call({action:"act",kind:"evaluate",fn:'() => {let count=0;const timer=setInterval(()=>{fetch("/api/check?at="+Date.now()).then(r=>r.json()).then(x=>window.api=x);if(++count>=16)clearInterval(timer)},500);return true}'});
  state=await call({action:"responsebody",url:"**/api/check*",maxChars:1000,timeoutMs:5000});
  assert.match(JSON.stringify(state.value),/browser-live/); report("native-response-body");
  state=await call({action:"trace",operation:"stop"});
  traceActive=false;
  assert.ok(state.value?.path); artifacts.push(state.value.path);
  const trace=await readFile(state.value.path); assert.equal(trace.subarray(0,2).toString(),"PK"); report("native-trace",{bytes:trace.length});
  await call({action:"set",setting:"offline",offline:false}); report("native-environment-setting");
  await call({action:"effects",enabled:false});
  report("all-live-checks-passed");
}finally{
  if(traceActive){try{const stopped=await call({action:"trace",operation:"stop"});if(stopped.value?.path)artifacts.push(stopped.value.path);}catch{}}
  if(tabId){try{await call({action:"effects",enabled:false});}catch{} try{await call({action:"close"});}catch{}}
  for(const artifact of artifacts)await unlink(artifact).catch(()=>{});
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
