import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OPEN_TIMEOUT_MS,
  isBrowserTimeout,
  isConfirmedLinkNavigation,
  isPlainFragmentLink,
  isPostNavigationVisibilityError,
  outputContainsTargetUrl,
  prepareBrowserArgs,
} from "../src/tools/browser/recovery.mjs";

test("plain fragment navigation is selected only for safe same-document links", () => {
  const before="https://en.wikipedia.org/wiki/Transformer_(deep_learning)#History";
  const target="https://en.wikipedia.org/wiki/Transformer_(deep_learning)#Applications";
  assert.equal(isPlainFragmentLink(before,target,"#Applications"),true);
  for(const [from,to,raw,tgt,download,handler] of [
    [before,target,"/wiki/Transformer_(deep_learning)#Applications"],
    [before,target,"#!Applications"],
    [before,target,"#Applications","_blank"],
    [before,target,"#Applications",null,true],
    [before,target,"#Applications",null,false,true],
    [target,target,"#Applications"],
    [before,"https://en.wikipedia.org/wiki/Other#Applications","#Applications"],
    [before,"https://en.wikipedia.org/wiki/Transformer_(deep_learning)?view=1#Applications","#Applications"],
    [before,"https://evil.example/","#Applications"],
    [before,"javascript:alert(1)","#Applications"],
  ]) assert.equal(isPlainFragmentLink(from,to,raw,tgt,download,handler),false);
});

test("post-navigation visibility errors require the exact clicked reference", () => {
  const error = {
    message: "tool execution failed",
    gatewayLogContext: {lines:[{message:'BrowserServiceError: Element "e94" is not interactable (not visible).'}]},
  };
  assert.equal(isPostNavigationVisibilityError(error, "e94"), true);
  assert.equal(isPostNavigationVisibilityError(error, "e95"), false);
  assert.equal(isPostNavigationVisibilityError({message:'Element "e94" is not interactable'}, "e94"), false);
});

test("link navigation is verified against the intended destination, not merely a changed page", () => {
  const before = "https://www.youtube.com/results?search_query=Laufey";
  const link = "https://www.youtube.com/watch?v=lSD_L-xic9o&list=RDlSD_L-xic9o&pp=tracking";
  assert.equal(isConfirmedLinkNavigation(before, link, "https://www.youtube.com/watch?v=lSD_L-xic9o&list=RDlSD_L-xic9o"), true);
  assert.equal(isConfirmedLinkNavigation(before, link, before), false);
  assert.equal(isConfirmedLinkNavigation(before, link, "https://www.youtube.com/watch?v=another"), false);
  assert.equal(isConfirmedLinkNavigation(before, link, "https://www.youtube.com/watch?v=another&list=RDlSD_L-xic9o"), false);
  assert.equal(isConfirmedLinkNavigation(before, link, "https://www.youtube.com/shorts/lSD_L-xic9o"), false);
  assert.equal(isConfirmedLinkNavigation(before, link, "https://example.com/watch?v=lSD_L-xic9o"), false);
  assert.equal(isConfirmedLinkNavigation(before, "javascript:alert(1)", "https://www.youtube.com/watch"), false);
  assert.equal(isConfirmedLinkNavigation(before, "https://www.youtube.com/watch", "https://www.youtube.com/watch"), true);
});

test("open gets a short default timeout while explicit timeout values are preserved", () => {
  assert.deepEqual(
    prepareBrowserArgs({ action: "open", targetUrl: "https://example.com" }),
    { action: "open", targetUrl: "https://example.com", profile: "chrome", timeoutMs: DEFAULT_OPEN_TIMEOUT_MS },
  );
  assert.equal(prepareBrowserArgs({ action: "open", timeoutMs: 30_000 }).timeoutMs, 30_000);
  assert.deepEqual(prepareBrowserArgs({ action: "open", profile: "openclaw", browser: "openclaw", systemProfile: "Other", targetUrl: "https://example.com" }), {
    action: "open", targetUrl: "https://example.com", profile: "chrome", timeoutMs: DEFAULT_OPEN_TIMEOUT_MS,
  });
  assert.deepEqual(prepareBrowserArgs({ action: "tabs", profile: "openclaw", browser: "openclaw", systemProfile: "Other" }), { action: "tabs", profile: "chrome" });
  assert.deepEqual(prepareBrowserArgs({ action: "doctor", profile: "openclaw", browser: "openclaw", systemProfile: "Other" }), { action: "doctor" });
  assert.deepEqual(prepareBrowserArgs({ action: "profiles", profile: "openclaw" }), { action: "profiles" });
});

test("timeout detection uses error wording, not the presence of a timeoutMs parameter", () => {
  assert.equal(isBrowserTimeout({ message: "tool execution failed", log: "browser timed out" }), true);
  assert.equal(isBrowserTimeout({ timeoutMs: 10_000, message: "invalid target" }), false);
});

test("open timeout recovery ignores URL fragments but does not match a different path", () => {
  const output = { content: [{ type: "text", text: 'tabs: [{"url":"https://example.com/page/#section"}]' }] };
  assert.equal(outputContainsTargetUrl(output, "https://example.com/page/"), true);
  assert.equal(outputContainsTargetUrl(output, "https://example.com/page"), false);
  assert.equal(outputContainsTargetUrl(output, "https://example.com/p"), false);
});

test("open timeout recovery supports Chrome internal URLs", () => {
  assert.equal(
    outputContainsTargetUrl({ content: [{ type: "text", text: "chrome://extensions" }] }, "chrome://extensions"),
    true,
  );
});
