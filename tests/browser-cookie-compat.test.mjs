import test from "node:test";
import assert from "node:assert/strict";
import { boundBrowserResult } from "../src/tools/browser/output.mjs";
import { isMissingCookieCommand, resolveCookieTarget, runCookieCompatibility } from "../src/tools/browser/cookie-compat.mjs";

test("cookie fallback accepts only missing Storage commands, never access or auth failures",()=>{
  const cookie={action:"cookies"};
  assert.equal(isMissingCookieCommand(cookie,new Error("browserContext.cookies: Protocol error (Storage.getCookies): 'Storage.getCookies' wasn't found")),true);
  for(const message of ["denied by policy","Unauthorized","access was revoked","Protocol error (Storage.getCookies): permission denied","Protocol error (Runtime.evaluate): 'Runtime.evaluate' wasn't found"])
    assert.equal(isMissingCookieCommand(cookie,new Error(message)),false,message);
  assert.equal(isMissingCookieCommand({action:"act"},new Error("Protocol error (Storage.getCookies): 'Storage.getCookies' wasn't found")),false);
});

test("cookie target resolution refuses implicit, inaccessible or ambiguous tabs",()=>{
  const tabs=[{targetId:"ABC111",tabId:"t1",label:"work"},{targetId:"ABC222",tabId:"t2"}];
  assert.equal(resolveCookieTarget(tabs,"t1"),"ABC111");
  assert.equal(resolveCookieTarget(tabs,"work"),"ABC111");
  assert.equal(resolveCookieTarget(tabs,"ABC2"),"ABC222");
  for(const ref of [undefined,"","ABC","t3"])assert.throws(()=>resolveCookieTarget(tabs,ref));
});

test("remote routing, canceled calls and non-loopback endpoints stop before relay authentication",async()=>{
  const noLoad=()=>{throw new Error("must not read native credentials");};
  const noInvoke=()=>{throw new Error("must not invoke host browser");};
  await assert.rejects(runCookieCompatibility({target:"node"},{loadExport:noLoad,invokeTool:noInvoke}),/local Chrome/);
  const controller=new AbortController();controller.abort(new Error("canceled"));
  await assert.rejects(runCookieCompatibility({},{loadExport:noLoad,invokeTool:noInvoke,signal:controller.signal}),/canceled/);
  const invokeTool=async()=>({ok:true,output:{details:{driver:"extension",running:true,cdpUrl:"http://example.com:19011"}}});
  await assert.rejects(runCookieCompatibility({targetId:"t1"},{loadExport:noLoad,invokeTool}),/loopback/);
});

test("cookie operations serialize native leases and release resources after success or failure",async()=>{
  let active=0,maxActive=0,closed=0,detached=0,released=0,unregistered=0,fail=false;
  const methods=[];
  class Owner{
    static async connect(){active++;maxActive=Math.max(maxActive,active);return new Owner();}
    async capture(){return {release:async()=>{released++;}};}
    async close(){closed++;active--;}
  }
  const session={async send(method){methods.push(method);await new Promise(resolve=>setTimeout(resolve,5));if(fail)throw new Error("protocol refused");return {cookies:[{name:"synthetic",httpOnly:true}]};},async detach(){detached++;}};
  const functions={
    RelayOwnerClient:Owner,readExtensionRelayToken:()=>"private-test-key",
    registerBorrowedRelayCdpAccess:()=>()=>{unregistered++;},
    getPageForTargetId:async()=>({url:()=>"http://127.0.0.1/",context:()=>({newCDPSession:async()=>session})}),
    closePlaywrightBrowserConnection:async()=>{},
  };
  const loadExport=async(_prefix,name)=>functions[name];
  const invokeTool=async(_name,args)=>({ok:true,output:{details:args.action==="status"
    ?{driver:"extension",running:true,cdpUrl:"http://127.0.0.1:19011"}
    :{tabs:[{targetId:"raw-tab",tabId:"t1"}]}}});
  const dependencies={loadExport,invokeTool};
  const [a,b]=await Promise.all([
    runCookieCompatibility({action:"cookies",targetId:"t1"},dependencies),
    runCookieCompatibility({action:"cookies",targetId:"t1",operation:"set",cookie:{name:"synthetic",value:"fake",url:"http://127.0.0.1/"}},dependencies),
  ]);
  assert.equal(a.cookies[0].httpOnly,true);assert.equal(b.transport,"extension-tab-session");
  assert.equal(maxActive,1);assert.deepEqual(methods,["Network.getCookies","Storage.setCookies"]);
  const sent=methods.length;
  for(const args of [
    {url:"https://other.example/"},
    {operation:"set",cookie:{name:"synthetic",value:"fake",url:"https://other.example/"}},
    {operation:"set",cookie:{name:"synthetic",value:"fake",domain:".other.example",path:"/"}},
    {operation:"clear"},
  ])await assert.rejects(runCookieCompatibility({action:"cookies",targetId:"t1",...args},dependencies));
  assert.equal(methods.length,sent);
  fail=true;
  await assert.rejects(runCookieCompatibility({action:"cookies",targetId:"t1"},dependencies),/protocol refused/);
  assert.equal(active,0);
  assert.deepEqual([closed,detached,released,unregistered],[7,7,7,7]);
});

test("oversized Browser results remain valid JSON and never include partial cookie values",()=>{
  const secret="synthetic-private-cookie-value".repeat(1000);
  const bounded=boundBrowserResult({ok:true,targetId:"t1",cookies:[{name:"test",value:secret}]});
  const result=JSON.parse(bounded.json);
  assert.equal(bounded.truncated,true);
  assert.equal(result.cookieCount,1);
  assert.equal(bounded.json.includes("synthetic-private-cookie-value"),false);
  const small=boundBrowserResult({ok:true,cookies:[]});
  assert.equal(small.truncated,false);
  assert.deepEqual(JSON.parse(small.json),{ok:true,cookies:[]});
});
