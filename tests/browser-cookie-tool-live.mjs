import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

const nonce=randomUUID().replaceAll("-","");
const initial="oc_tool_"+nonce,written=initial+"_written";
const server=http.createServer((req,res)=>{
  const headers={"content-type":"text/html"};
  if(req.url==="/")headers["set-cookie"]=initial+"=synthetic; HttpOnly; SameSite=Lax; Path=/; Max-Age=120";
  res.writeHead(200,headers);res.end("<!doctype html><title>Cookie tool verification</title><h1>Disposable cookie verification</h1>");
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const url="http://127.0.0.1:"+server.address().port+"/";
let sequence=0,tabId;
const session="cookie-tool-verification-"+nonce;
const report=(check,details={})=>console.log(JSON.stringify({check,...details}));
async function rpc(method,params){
  const response=await fetch("http://127.0.0.1:19002/mcp",{
    method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream","x-openai-session":session},
    body:JSON.stringify({jsonrpc:"2.0",id:++sequence,method,params}),signal:AbortSignal.timeout(110000),
  });
  const text=await response.text();
  const data=response.headers.get("content-type")?.includes("text/event-stream")
    ?text.split(/\r?\n/).filter(line=>line.startsWith("data:")).at(-1)?.slice(5).trim():text;
  const message=JSON.parse(data);
  if(message.error)throw new Error("MCP error: "+message.error.message);
  return message.result;
}
function value(result){
  if(result.isError)throw new Error(result.content?.filter(item=>item.type==="text").map(item=>item.text).join("\n"));
  const text=result.content.find(item=>item.type==="text").text;
  const start=text.indexOf("\n---\n"),end=text.lastIndexOf("\n<<<END_EXTERNAL");
  try{return JSON.parse(start>=0&&end>start?text.slice(start+5,end):text);}catch{throw new Error("Browser result was not complete JSON; content omitted from diagnostic output.");}
}
const call=async args=>value(await rpc("tools/call",{name:"openclaw_browser",arguments:{...(tabId?{tabId}:{}),...args}}));
try{
  await rpc("tools/call",{name:"start_here",arguments:{}});
  const opened=await call({action:"open",targetUrl:url,label:"cookie-tool-verification"});
  tabId=opened.tabId??opened.targetId;assert.ok(tabId);report("mcp-fixture-opened");
  let result=await call({action:"cookies",url,filter:initial});
  assert.equal(result.transport,"extension-tab-session");
  assert.ok(result.cookies.some(cookie=>cookie.name===initial&&cookie.httpOnly));report("mcp-cookie-get",{httpOnly:true});
  await call({action:"cookies",operation:"set",cookie:{name:written,value:"synthetic-written",url,httpOnly:true,sameSite:"Lax",expires:Math.floor(Date.now()/1000)+120}});
  result=await call({action:"cookies",url,filter:initial});
  assert.ok(result.cookies.some(cookie=>cookie.name===written&&cookie.httpOnly));report("mcp-cookie-set-verified",{httpOnly:true});
  const previous=await call({action:"cookies",url,filter:"oc_route_"});
  const leftovers=previous.cookies.filter(cookie=>cookie.domain==="127.0.0.1"&&/^oc_route_[a-f0-9]{32}(?:_written)?$/.test(cookie.name)&&["synthetic","synthetic-written"].includes(cookie.value));
  for(const cookie of leftovers)await call({action:"cookies",operation:"set",cookie:{name:cookie.name,value:"",url,expires:1}});
  if(leftovers.length)report("previous-probe-cleanup",{count:leftovers.length});
}finally{
  if(tabId){
    for(const name of [initial,written])await call({action:"cookies",operation:"set",cookie:{name,value:"",url,expires:1}}).catch(()=>{});
    try{const result=await call({action:"cookies",url,filter:initial});assert.ok(!result.cookies.some(cookie=>cookie.name===initial||cookie.name===written));report("test-cookies-removed");}finally{await call({action:"close"});}
  }
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  report("mcp-fixture-closed");
}
