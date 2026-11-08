import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openclawCli } from "../src/config/runtime.mjs";
import { invokeGatewayTool } from "../src/openclaw-client.mjs";

const dist=path.join(path.dirname(openclawCli),"dist");
const moduleName=(await readdir(dist)).find(name=>name.startsWith("pw-tools-core.interactions.navigation-")&&name.endsWith(".mjs"));
const native=await import(pathToFileURL(path.join(dist,moduleName)).href);
const getPage=native.U, closeConnection=native.x;
assert.equal(typeof getPage,"function");
const nonce=randomUUID().replaceAll("-","");
const initial="oc_route_"+nonce, written=initial+"_written";
const originServer=http.createServer((req,res)=>{
  const headers={"content-type":"text/html"};
  if(req.url==="/")headers["set-cookie"]=initial+"=synthetic; HttpOnly; SameSite=Lax; Path=/; Max-Age=120";
  res.writeHead(200,headers);res.end("<!doctype html><title>OpenClaw cookie route probe</title><h1>Disposable cookie test</h1>");
});
await new Promise(resolve=>originServer.listen(0,"127.0.0.1",resolve));
const url="http://127.0.0.1:"+originServer.address().port+"/";
const cdpUrl="http://127.0.0.1:19011";
let targetId,session,owner,unregister;
const report=(check,fields={})=>console.log(JSON.stringify({check,...fields}));
function payload(result){
  if(!result.ok)throw new Error(result.error?.message??"Browser tool failed");
  const text=result.output.content.find(item=>item.type==="text").text;
  const start=text.indexOf("\n---\n"),end=text.lastIndexOf("\n<<<END_EXTERNAL");
  return JSON.parse(start>=0&&end>start?text.slice(start+5,end):text);
}
try {
  const opened=payload(await invokeGatewayTool("browser",{action:"open",profile:"chrome",targetUrl:url,label:"cookie-route-probe"},undefined,10000));
  targetId=opened.targetId;assert.ok(targetId);report("fixture-opened");
  const {t:Owner}=await import(pathToFileURL(path.join(dist,"owner-client-eQcEYyIr.mjs")).href);
  const {n:readToken}=await import(pathToFileURL(path.join(dist,"relay-auth-CnEa0zHZ.mjs")).href);
  const {n:register}=await import(pathToFileURL(path.join(dist,"relay-access-BkaMRznz.mjs")).href);
  owner=await Owner.connect({port:19011,profile:"chrome",token:readToken(),signal:AbortSignal.timeout(15000)});
  unregister=register(cdpUrl,{client:owner,port:19011});
  const reference=await owner.capture(targetId);
  const page=await getPage({cdpUrl,targetId,relayReference:reference});
  try {await page.context().cookies();report("root-storage",{supported:true});}
  catch(error){report("root-storage",{supported:false,error:error.message});}
  session=await page.context().newCDPSession(page);
  const storage=await session.send("Storage.getCookies");
  const match=storage.cookies.find(cookie=>cookie.name===initial);
  assert.ok(match?.httpOnly);
  report("tab-session-storage-read",{supported:true,httpOnlyCookieFound:true});
  await session.send("Storage.setCookies",{cookies:[{name:written,value:"synthetic-written",url,httpOnly:true,sameSite:"Lax",expires:Math.floor(Date.now()/1000)+120}]});
  const network=await session.send("Network.getCookies",{urls:[url]});
  assert.ok(network.cookies.some(cookie=>cookie.name===written&&cookie.httpOnly));
  report("tab-session-storage-write",{supported:true,httpOnlyCookieVerified:true});
} finally {
  if(session){
    for(const name of [initial,written])await session.send("Network.deleteCookies",{name,url}).catch(()=>{});
    await session.detach().catch(()=>{});
  }
  await closeConnection({cdpUrl}).catch(()=>{});
  await owner?.close().catch(()=>{});unregister?.();
  if(targetId)await invokeGatewayTool("browser",{action:"close",profile:"chrome",targetId},undefined,6000);
  originServer.closeAllConnections();await new Promise(resolve=>originServer.close(resolve));
  report("fixture-cleaned");
}
