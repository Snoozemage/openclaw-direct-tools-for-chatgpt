import assert from "node:assert/strict";
import http from "node:http";
import { handleBrowserTool } from "../src/tools/browser/handler.mjs";

const server = http.createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "require-trusted-types-for 'script'",
  });
  res.end('<!doctype html><title>Trusted Types browser feedback</title><button id="count" onclick="this.textContent=String(+this.textContent+1)">0</button><a id="jump" href="#section">Jump to section</a><section id="section">Example section</section>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

let tabId, secondTabId;
async function call(args) {
  const result = await handleBrowserTool("openclaw_browser", { ...(tabId ? {tabId} : {}), ...args });
  if (result.isError) throw new Error(JSON.stringify({ args, result }));
  for (const part of result.content ?? []) {
    if (part.type !== "text") continue;
    const start = part.text.indexOf("\n---\n");
    const end = part.text.lastIndexOf("\n<<<END_EXTERNAL_UNTRUSTED_CONTENT");
    const raw = start >= 0 && end > start ? part.text.slice(start + 5, end) : part.text;
    try {
      const value = JSON.parse(raw);
      if (value.error || value.type === "tool_error") throw new Error(JSON.stringify(value));
      return { value, diagnostics: result.diagnostics };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return { value: null, diagnostics: result.diagnostics };
}
try {
  const opened = await call({ action: "open", targetUrl: "http://127.0.0.1:" + server.address().port, timeoutMs: 15000 });
  tabId = opened.value?.tabId ?? opened.value?.targetId;
  assert.ok(tabId, "fixture browser tab opened");

  const onOpen = await call({ action: "act", kind: "evaluate",
    fn: '() => ({enabled:window[Symbol.for("openclaw.browser.feedback.v1")]?.enabled,position:window[Symbol.for("openclaw.browser.feedback.v1")]?.position,until:window[Symbol.for("openclaw.browser.feedback.v1")]?.until})' });
  assert.equal(onOpen.value?.result?.enabled, true, "opening a tab must show the idle AI cursor");
  assert.ok(onOpen.value?.result?.position, "idle AI cursor has an initial position");
  assert.equal(onOpen.value?.result?.until, 0, "passive cursor must not capture the user\'s own input");
  const clamped = await call({action:"act",kind:"evaluate",
    fn:"() => {const state=window[Symbol.for(\'openclaw.browser.feedback.v1\')];state.show(-200,-100,\'ready\',null);return state.position}"});
  assert.deepEqual(clamped.value?.result, {x:14,y:18}, "idle cursor stays inside the viewport");

  const enforced = await call({ action: "act", kind: "evaluate",
    fn: "() => {try {document.createElement('div').innerHTML='<b>blocked</b>';return false} catch (error) {return error instanceof TypeError}}" });
  assert.equal(enforced.value?.result, true, "Trusted Types must block innerHTML");

  const clicked = await call({ action: "act", kind: "click", selector: "#count" });
  assert.equal(clicked.diagnostics?.visualFeedback?.available, true,
    "AI cursor overlay must install successfully under Trusted Types");

  const inspected = await call({ action: "act", kind: "evaluate",
    fn: '() => {const state=window[Symbol.for("openclaw.browser.feedback.v1")];return {count:document.querySelector("#count").textContent,overlay:!!document.querySelector("[data-openclaw-browser-feedback]"),enabled:state?.enabled,visible:state?.visible,hostDisplay:state?.host?.style.display,until:state?.until}}' });
  assert.deepEqual(inspected.value?.result, {
    count: "1", overlay: true, enabled: true, visible: true,
    hostDisplay: "block", until: 0,
  }, "after click, the AI cursor remains visible while action capture ends");
  await new Promise(resolve => setTimeout(resolve, 2000));
  const persistent = await call({ action: "act", kind: "evaluate",
    fn: '() => ({enabled:window[Symbol.for("openclaw.browser.feedback.v1")]?.enabled,position:window[Symbol.for("openclaw.browser.feedback.v1")]?.position,overlay:!!document.querySelector("[data-openclaw-browser-feedback]")})' });
  assert.equal(persistent.value?.result?.enabled, true, "idle cursor survives the old fade timeout");
  assert.equal(persistent.value?.result?.overlay, true, "idle cursor remains mounted");
  assert.ok(persistent.value?.result?.position, "cursor keeps its last position");

  await call({action:"act",kind:"evaluate",
    fn:"() => {window.__fragmentClicks=0;document.querySelector('#jump').addEventListener('click',()=>window.__fragmentClicks++);return true}"});
  const jump=await call({action:"act",kind:"click",selector:"#jump"});
  assert.equal(jump.value?.outcome,"fragment_navigation_confirmed",
    "in-document link click must complete without a locator timeout");
  const observed=await call({action:"act",kind:"evaluate",
    fn:"() => ({hash:location.hash,clicks:window.__fragmentClicks,visible:window[Symbol.for('openclaw.browser.feedback.v1')]?.visible,until:window[Symbol.for('openclaw.browser.feedback.v1')]?.until})"});
  assert.deepEqual(observed.value?.result,{hash:"#section",clicks:1,visible:true,until:0},
    "fragment click navigates once and leaves the idle cursor visible");

  const second = await call({ action: "open", targetUrl:"http://127.0.0.1:" + server.address().port + "/second",timeoutMs:15000 });
  secondTabId = second.value?.tabId ?? second.value?.targetId;
  assert.ok(secondTabId && secondTabId !== tabId, "second tab opened");

  const firstAfterSwitch = await call({ action:"act",kind:"evaluate",
    fn:'() => ({overlay:!!document.querySelector("[data-openclaw-browser-feedback]")})' });
  assert.equal(firstAfterSwitch.value?.result?.overlay, false, "switching controlled tabs removes the previous cursor");

  const secondActive = await call({ action:"act",kind:"evaluate",tabId:secondTabId,
    fn:'() => ({overlay:!!document.querySelector("[data-openclaw-browser-feedback]"),enabled:window[Symbol.for("openclaw.browser.feedback.v1")]?.enabled})' });
  assert.deepEqual(secondActive.value?.result, {overlay:true,enabled:true}, "new tab owns the cursor");

  await call({ action:"effects",tabId:secondTabId,enabled:false });
  const hidden = await call({action:"act",kind:"evaluate",tabId:secondTabId,
    fn:'() => !!document.querySelector("[data-openclaw-browser-feedback]")' });
  assert.equal(hidden.value?.result,false, "explicit stop removes the cursor");

  console.log("PASS: Trusted Types; persistent idle cursor; single active tab; explicit stop.");
} finally {
  if (secondTabId) await call({action:"close",tabId:secondTabId}).catch(() => {});
  if (tabId) await call({action: "close"}).catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
