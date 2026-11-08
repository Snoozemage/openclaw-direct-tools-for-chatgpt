import test from "node:test";
import assert from "node:assert/strict";
import { buildAdvancedBrowserRequest as request } from "../src/tools/browser/advanced-routes.mjs";
import { prepareBrowserArgs } from "../src/tools/browser/recovery.mjs";
import { browserFeedbackFunction, shouldShowBrowserFeedback } from "../src/tools/browser/effects.mjs";

test("advanced operations cannot escape their enumerated routes or Chrome binding",()=>{
  for (const args of [
    {action:"storage",storageKind:"../../profiles",operation:"clear"},
    {action:"trace",operation:"../../reset-profile"},
    {action:"set",setting:"../../profiles"},
    {action:"request",path:"/reset-profile"},
    {action:"highlight"},
    {action:"highlight",ref:"e1",dashboard:"other"},
    {action:"set",setting:"offline",target:"sandbox"},
  ]) assert.throws(()=>request(args));
  const actual=request({action:"highlight",ref:"e2",profile:"other",path:"/reset-profile",body:{ref:"e9"}});
  assert.equal(actual.path,"/highlight"); assert.equal(actual.query.profile,"chrome"); assert.equal(actual.body.ref,"e2");
});

test("GET routing preserves exact storage keys and cannot clear storage accidentally",()=>{
  const actual=request({action:"storage",storageKind:"local",key:" account ",targetId:"t1"});
  assert.equal(actual.method,"GET"); assert.equal(actual.path,"/storage/local");
  assert.deepEqual(actual.query,{profile:"chrome",targetId:"t1",key:" account "});
  assert.equal(actual.body,undefined);
  assert.throws(()=>request({action:"storage",storageKind:"local",operation:"set",key:"x"}));
  assert.equal(request({action:"storage",storageKind:"local",operation:"set",key:"x",value:""}).body.value,"");
});

test("false, zero and empty reset objects survive native settings mapping",()=>{
  assert.equal(request({action:"set",setting:"offline",offline:false}).body.offline,false);
  assert.deepEqual(request({action:"set",setting:"headers",headers:{}}).body.headers,{});
  assert.equal(request({action:"set",setting:"geolocation",latitude:0,longitude:0}).body.latitude,0);
  assert.deepEqual(request({action:"set",setting:"device",device:"iPhone 14"}).body,{name:"iPhone 14"});
  assert.equal(request({action:"set",setting:"viewport",width:1200,height:700}).body.kind,"resize");
  const response=request({action:"responsebody",url:"**/api",timeoutMs:5000});
  assert.equal(response.body.timeoutMs,5000); assert.ok(response.timeoutMs>response.body.timeoutMs);
  assert.throws(()=>request({action:"responsebody",url:"**/api",timeoutMs:-1}));
});

test("tab aliases reach the native target without overriding explicit target IDs",()=>{
  assert.equal(prepareBrowserArgs({action:"act",tabId:"t2"}).targetId,"t2");
  assert.equal(prepareBrowserArgs({action:"act",tabId:"t2",targetId:"t3"}).targetId,"t3");
  assert.deepEqual(prepareBrowserArgs({action:"act",actions:[{kind:"click",tabId:"t2",ref:"e1"}]}).actions,[{kind:"click",targetId:"t2",ref:"e1"}]);
  assert.equal(prepareBrowserArgs({action:"act",visualFeedback:false}).visualFeedback,undefined);
});

test("visual feedback remains optional and serialized options are inert data",()=>{
  assert.equal(shouldShowBrowserFeedback({action:"act",kind:"click"}),true);
  for(const args of [{action:"snapshot"},{action:"act",kind:"evaluate"},{action:"act",kind:"click",visualFeedback:false}]) assert.equal(shouldShowBrowserFeedback(args),false);
  const fn=browserFeedbackFunction({selector:'x"); globalThis.INJECTED = true; //'});
  assert.doesNotThrow(()=>new Function("return ("+fn+")"));
  assert.equal(globalThis.INJECTED,undefined);
});
