import { invokeGatewayTool, getRecentGatewayToolErrorLog, shouldCollectGatewayErrorLogs } from "../../openclaw-client.mjs";
import { normalizeToolOutput } from "../../mcp/format.mjs";
import { browserToolDefinition } from "./schema.mjs";
import { ensurePersonalChromeRunning } from "./chrome-launch.mjs";
import { ADVANCED_BROWSER_ACTIONS } from "./advanced-routes.mjs";
import { invokeAdvancedBrowser } from "./advanced.mjs";
import { browserAutoFragmentFeedbackFunction, browserFeedbackFunction, browserFragmentClickFunction, browserLinkContextFunction, feedbackOptions, shouldShowBrowserFeedback } from "./effects.mjs";
import {
  isBrowserTimeout,
  isPlainFragmentLink,
  isConfirmedLinkNavigation,
  isPostNavigationVisibilityError,
  outputContainsTargetUrl,
  OPEN_RECOVERY_PROBE_TIMEOUT_MS,
  prepareBrowserArgs,
} from "./recovery.mjs";

function readFeedbackDetails(output) {
  const details = output?.details;
  if (details?.targetId) return details;
  for (const item of output?.content ?? []) {
    if (item.type !== "text") continue;
    const start = item.text.indexOf("\n---\n"), end = item.text.lastIndexOf("\n<<<END_EXTERNAL_UNTRUSTED_CONTENT");
    const json = start >= 0 && end > start ? item.text.slice(start + 5, end) : item.text;
    try { return JSON.parse(json); } catch { /* native text may not be JSON */ }
  }
  return {};
}

function pickFeedbackRoute(args) {
  return Object.fromEntries(["targetId", "target", "node", "dashboard"].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
}

let activeFeedbackTab = null;
let activeFeedbackSyncedAt = 0;
let activeFeedbackDocumentUrl = null;
const READ_FEEDBACK_REUSE_MS = 20_000;
const DEFAULT_LINK_CLICK_TIMEOUT_MS = 10_000;
const LINK_CLICK_TRANSPORT_TIMEOUT_MS = 15_000;
const LINK_CLICK_OBSERVE_DELAY_MS = 250;
const LINK_CLICK_OBSERVE_INTERVAL_MS = 350;
const LINK_CLICK_OBSERVE_WINDOW_MS = 14_000;

function documentUrl(url) {
  if (typeof url !== "string") return null;
  try { const result = new URL(url); result.hash = ""; return result.href; }
  catch { return null; }
}
function canReuseReadFeedback(targetId, url) {
  return Boolean(targetId && activeFeedbackTab === targetId
    && Date.now() - activeFeedbackSyncedAt < READ_FEEDBACK_REUSE_MS
    && (!url || !activeFeedbackDocumentUrl
      || documentUrl(url) === activeFeedbackDocumentUrl));
}
async function claimFeedbackTab(targetId, url = null) {
  if (!targetId) return;
  const previous = activeFeedbackTab;
  activeFeedbackTab = targetId;
  activeFeedbackSyncedAt = Date.now();
  activeFeedbackDocumentUrl = documentUrl(url);
  if (!previous || previous === targetId) return;
  try {
    await invokeGatewayTool("browser", {
      action:"act",kind:"evaluate",profile:"chrome",targetId:previous,
      fn:browserFeedbackFunction({deactivate:true}),timeoutMs:3000,
    });
  } catch {  }
}

async function watchLinkNavigation(context, targetId, isStopped) {
  const deadline = Date.now() + LINK_CLICK_OBSERVE_WINDOW_MS;
  await new Promise(resolve => setTimeout(resolve, LINK_CLICK_OBSERVE_DELAY_MS));
  while (!isStopped() && Date.now() < deadline) {
    try {
      const tabsResult = await invokeGatewayTool("browser", {
        action: "tabs", profile: "chrome", timeoutMs: 2_000,
      }, undefined, 3_000);
      if (isStopped()) return { kind: "watch_complete" };
      if (tabsResult.ok) {
        const tabs = readFeedbackDetails(tabsResult.output).tabs ?? [];
        const current = tabs.find(tab => tab.tabId === targetId || tab.targetId === targetId);
        if (current && isConfirmedLinkNavigation(context.pageUrl, context.linkUrl, current.url)) {
          return { kind: "navigation", url: current.url, tabId: current.tabId ?? targetId };
        }
      }
    } catch {}
    if (!isStopped()) await new Promise(resolve => setTimeout(resolve, LINK_CLICK_OBSERVE_INTERVAL_MS));
  }
  return { kind: "watch_complete" };
}

function isPlainFragmentContext(context) {
  return Boolean(context && isPlainFragmentLink(
    context.pageUrl, context.linkUrl, context.linkRawHref,
    context.linkTarget, context.linkDownload, context.linkHandler,
  ));
}

function nativeBatchStepFailed(response) {
  if (response?.isError) return true;
  for (const item of response?.content ?? []) {
    if (item.type !== "text") continue;
    const start = item.text.indexOf("\\n---\\n");
    const end = item.text.lastIndexOf("\\n<<<END_EXTERNAL_UNTRUSTED_CONTENT");
    const json = start >= 0 && end > start ? item.text.slice(start + 5, end) : item.text;
    try {
      const value = JSON.parse(json);
      if (value?.results?.some?.(step => step.ok === false)) return true;
    } catch {  }
  }
  return false;
}

function readNativeErrors(output) {
  return (output?.content ?? []).flatMap((item) => {
    if (item?.type !== "text" || typeof item.text !== "string") return [];

    try {
      const value = JSON.parse(item.text);
      if (value?.type !== "tool_error" && !value?.error) return [];
      return [{
        type: value.type ?? null,
        message: value.message ?? null,
        error: value.error ?? null,
      }];
    } catch {
      return [];
    }
  });
}

async function reconcileTimedOutOpen(args, nativeArgs, originalResult) {
  const targetUrl = args.targetUrl ?? args.url;
  if (typeof targetUrl !== "string" || !targetUrl.trim()) return null;

  let tabsResult;
  try {
    tabsResult = await invokeGatewayTool("browser", {
      action: "tabs",
      profile: nativeArgs.profile || "chrome",
      timeoutMs: OPEN_RECOVERY_PROBE_TIMEOUT_MS,
    });
  } catch {
    return null;
  }

  if (!tabsResult?.ok || !outputContainsTargetUrl(tabsResult.output, targetUrl)) return null;

  const elapsedMs = originalResult?.error?.elapsedMs
    ?? originalResult?.diagnostics?.elapsedMs
    ?? null;
  const details = {
    action: "open",
    outcome: "target_url_observed_in_tabs",
    targetUrl,
    message: "OpenClaw reported a timeout, but the requested URL is present in the current tab list. The bridge did not retry open.",
  };

  return {
    diagnostics: {
      stage: "open_timeout_reconciled",
      action: "open",
      elapsedMs,
      verification: "tabs",
      targetUrlObserved: true,
    },
    content: [{
      type: "text",
      text: JSON.stringify(details, null, 2),
    }],
  };
}

export async function handleBrowserTool(name, args = {}) {
  if (name !== browserToolDefinition.name) return undefined;

  let nativeArgs = prepareBrowserArgs(args);
  if (args.action === "act" && args.kind === "batch"
    && Array.isArray(args.actions) && args.actions.length > 1) {
    const steps = args.actions;
    const final = steps.at(-1);
    if (final?.kind === "click" && !final.doubleClick
      && (!final.button || final.button === "left")
      && !final.modifiers?.length && (final.ref || final.selector)
      && steps.slice(0,-1).every(step => ["hover","scrollIntoView","wait"].includes(step.kind))) {
      let context;
      try {
        const preflight = await invokeGatewayTool("browser", {
          action:"act",kind:"evaluate",profile:"chrome",
          ...pickFeedbackRoute(nativeArgs),
          ...(final.ref ? {ref:final.ref} : {}),
          fn:browserLinkContextFunction(final.selector),timeoutMs:3500,
        });
        context = preflight.ok && !readNativeErrors(preflight.output).length
          ? readFeedbackDetails(preflight.output).result : null;
      } catch {  }
      if (isPlainFragmentContext(context)) {
        const prefix = await handleBrowserTool(name,{
          ...args,actions:steps.slice(0,-1),
        });
        if (nativeBatchStepFailed(prefix)) return prefix;
        const clicked = await handleBrowserTool(name,{
          ...args,kind:"click",actions:undefined,...final,
        });
        if (clicked?.isError) return clicked;
        const prefixOutput = readFeedbackDetails(prefix);
        const clickOutput = readFeedbackDetails(clicked);
        const results = [...(prefixOutput.results ?? []),{
          ok:clickOutput.ok === true,
          outcome:clickOutput.outcome,
          ...(clickOutput.url ? {url:clickOutput.url} : {}),
        }];
        return {
          ...clicked,
          content:[{type:"text",text:JSON.stringify({
            ok:results.every(step=>step.ok),results,
            ...(clickOutput.url ? {url:clickOutput.url} : {}),
          },null,2)}],
          diagnostics:{...clicked.diagnostics,batchPrefixActions:steps.length-1},
        };
      }
    }
  }
  if (ADVANCED_BROWSER_ACTIONS.includes(args.action)) {
    const result = await invokeAdvancedBrowser(nativeArgs);
    return { ...normalizeToolOutput(result), diagnostics: result.diagnostics ?? result.error };
  }
  if (args.action === "effects") {
    const result = await invokeGatewayTool("browser", {
      ...nativeArgs, action: "act", kind: "evaluate",
      fn: browserFeedbackFunction({ enabled: args.enabled !== false, force: true }),
    });
    const errors = result.ok ? readNativeErrors(result.output) : [];
    if (result.ok && !errors.length) {
      const details = readFeedbackDetails(result.output);
      const tab = args.tabId ?? nativeArgs.targetId ?? details.tabId ?? details.targetId;
      if (args.enabled === false) {
        if (tab === activeFeedbackTab) {
          activeFeedbackTab = null; activeFeedbackSyncedAt = 0; activeFeedbackDocumentUrl = null;
        }
      } else if (details.result?.enabled) await claimFeedbackTab(tab, details.url);
    }
    return { ...normalizeToolOutput(result), ...(errors.length ? { isError: true } : {}), diagnostics: { stage: "browser_visual_feedback", ...result.diagnostics } };
  }
  let chromeLaunch = { launched: false };
  if (args.action === "open" && nativeArgs.profile === "chrome") {
    try {
      chromeLaunch = await ensurePersonalChromeRunning();
    } catch (error) {
      return {
        isError: true,
        diagnostics: { stage: "chrome_launch", action: "open" },
        content: [{
          type: "text",
          text: JSON.stringify({
            type: "chrome_launch_failed",
            message: error instanceof Error ? error.message : String(error),
          }, null, 2),
        }],
      };
    }
  }

  let feedback;
  let clickContext;
  let autoFragmentProbe;
  const eligibleClick = args.action === "act" && args.kind === "click"
    && !args.doubleClick && (!args.button || args.button === "left")
    && !args.modifiers?.length;
  if (shouldShowBrowserFeedback(args)) {
    const { ref, options } = feedbackOptions(args);
    try {
      const probe = await invokeGatewayTool("browser", {
        action: "act", kind: "evaluate", profile: "chrome",
        ...pickFeedbackRoute(nativeArgs), ...(ref ? { ref } : {}),
        fn: eligibleClick
          ? browserAutoFragmentFeedbackFunction(options,options.selector)
          : browserFeedbackFunction(options), timeoutMs: 5000,
      });
      const errors = probe.ok ? readNativeErrors(probe.output) : [];
      const details = readFeedbackDetails(probe.output);
      if (args.kind === "click" && probe.ok && !errors.length) {
        clickContext = details.result;
        if (eligibleClick && details.result?.scheduled === true) autoFragmentProbe=probe;
      }
      const enabled = details.result?.enabled !== false;
      feedback = { available: probe.ok && !errors.length && enabled, ...(probe.ok && !errors.length && enabled ? {} : { reason: !enabled ? "Browser effects disabled for this document" : probe.error?.message ?? errors[0]?.error ?? errors[0]?.message ?? "Browser feedback unavailable" }) };
      if (probe.ok && !errors.length && details.targetId && !nativeArgs.targetId) nativeArgs = { ...nativeArgs, targetId: details.targetId };
      if (feedback.available) await claimFeedbackTab(args.tabId ?? nativeArgs.targetId ?? details.tabId ?? details.targetId, details.url);
    } catch (error) { feedback = { available: false, reason: error.message }; }
  }
  if (args.action === "act" && args.kind === "click" && !clickContext
    && !shouldShowBrowserFeedback(args)) {
    try {
      const probe = await invokeGatewayTool("browser", {
        action: "act", kind: "evaluate", profile: "chrome",
        ...pickFeedbackRoute(nativeArgs), ...(nativeArgs.ref ? {ref:nativeArgs.ref} : {}),
        fn: browserLinkContextFunction(nativeArgs.selector), timeoutMs: 5000,
      });
      if (probe.ok && !readNativeErrors(probe.output).length) {
        const details = readFeedbackDetails(probe.output);
        clickContext = details.result;
        if (details.targetId && !nativeArgs.targetId) nativeArgs = {...nativeArgs,targetId:details.targetId};
      }
    } catch {  }
  }

  const fragmentClick = eligibleClick && nativeArgs.targetId
    && (autoFragmentProbe || isPlainFragmentContext(clickContext));
  const watchableLinkClick = eligibleClick && !fragmentClick && nativeArgs.targetId
    && clickContext?.pageUrl && clickContext?.linkUrl
    && clickContext.pageUrl !== clickContext.linkUrl
    && (!clickContext.linkTarget || clickContext.linkTarget === "_self")
    && !clickContext.linkDownload;
  const boundedLinkClick = watchableLinkClick && args.timeoutMs === undefined;
  if (boundedLinkClick) nativeArgs = { ...nativeArgs, timeoutMs: DEFAULT_LINK_CLICK_TIMEOUT_MS };
  const startedAt = Date.now();
  const nativeRequest = Promise.resolve(autoFragmentProbe ?? invokeGatewayTool("browser", fragmentClick
    ? {action:"act",kind:"evaluate",profile:"chrome",targetId:nativeArgs.targetId,
      ...(nativeArgs.ref ? {ref:nativeArgs.ref} : {}),
      fn:browserFragmentClickFunction(nativeArgs.selector,
        clickContext.linkUrl,clickContext.linkRawHref,clickContext.pageUrl),
      timeoutMs:args.timeoutMs ?? 4500}
    : nativeArgs, undefined, boundedLinkClick ? LINK_CLICK_TRANSPORT_TIMEOUT_MS : undefined))
    .then(result => ({ kind: "native", result }));
  let observationStopped = false;
  const first = watchableLinkClick
    ? await Promise.race([nativeRequest, watchLinkNavigation(clickContext, nativeArgs.targetId,
      () => observationStopped)])
    : await nativeRequest;
  observationStopped = true;
  if (first.kind === "navigation") {
    if (activeFeedbackTab === nativeArgs.targetId) {
      activeFeedbackTab = null; activeFeedbackSyncedAt = 0; activeFeedbackDocumentUrl = null;
    }
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: true, action: "click", outcome: "navigation_confirmed",
        url: first.url, tabId: first.tabId,
        message: "Destination observed while the native click was still pending. No click was retried.",
      }, null, 2) }],
      diagnostics: { stage: "click_navigation_observed",
        verification: "same_tab_destination", visualFeedback: feedback ?? null,
        elapsedMs: Date.now() - startedAt },
    };
  }
  const result = first.kind === "native" ? first.result : (await nativeRequest).result;
  if (feedback?.available && !autoFragmentProbe) {
    // Finish only on the same observed tab. Do not guess another active tab.
    if (nativeArgs.targetId) {
      try {
        await invokeGatewayTool("browser", {
          action: "act", kind: "evaluate", profile: "chrome",
          ...pickFeedbackRoute(nativeArgs), fn: browserFeedbackFunction({ finish: true, activate: true }), timeoutMs: 3000,
        });
      } catch { /* feedback cleanup must never replace the action result */ }
    }
    result.diagnostics = { ...result.diagnostics, visualFeedback: feedback };
  } else if (feedback) result.diagnostics = { ...result.diagnostics, visualFeedback: feedback };
  const nativeErrors = result?.ok ? readNativeErrors(result.output) : [];
  const failed = !result?.ok || nativeErrors.length > 0;
  if (fragmentClick) {
    const details = !failed ? readFeedbackDetails(result.output) : null;
    let confirmed = details?.result?.scheduled === true
      && details?.url === clickContext.linkUrl;
    if (!confirmed && (failed || details?.result?.scheduled === true)) {
      try {
        const tabsResult = await invokeGatewayTool("browser", {
          action:"tabs",profile:"chrome",timeoutMs:OPEN_RECOVERY_PROBE_TIMEOUT_MS,
        });
        const tabs = tabsResult.ok ? readFeedbackDetails(tabsResult.output).tabs ?? [] : [];
        confirmed = tabs.some(tab => (tab.targetId === nativeArgs.targetId
          || tab.tabId === nativeArgs.targetId) && tab.url === clickContext.linkUrl);
      } catch {  }
    }
    if (confirmed) return {
      content:[{type:"text",text:JSON.stringify({
        ok:true,action:"click",outcome:"fragment_navigation_confirmed",
        url:clickContext.linkUrl,tabId:args.tabId ?? nativeArgs.targetId,
      },null,2)}],
      diagnostics:{stage:"fragment_navigation",verification:"same_tab_fragment",
        visualFeedback:feedback ?? null,elapsedMs:Date.now()-startedAt},
    };
    return {
      isError:true,
      content:[{type:"text",text:JSON.stringify({
        type:"fragment_navigation_unconfirmed",
        message:"The in-page click was not confirmed; it was not retried.",
        targetUrl:clickContext.linkUrl,
      },null,2)}],
      diagnostics:{stage:"fragment_navigation_unconfirmed",
        visualFeedback:feedback ?? null,elapsedMs:Date.now()-startedAt},
    };
  }
  if (!failed && ["open","focus","navigate","snapshot","text","screenshot"].includes(args.action)
    && args.visualFeedback !== false) {
    const details = readFeedbackDetails(result.output);
    const tab = details.tabId ?? nativeArgs.targetId ?? details.targetId;
    const readOnlyAction = ["snapshot","text","screenshot"].includes(args.action);
    if (tab && !(readOnlyAction && canReuseReadFeedback(tab,details.url))) {
      try {
        const probe = await invokeGatewayTool("browser", {
          action:"act",kind:"evaluate",profile:"chrome",targetId:tab,
          fn:browserFeedbackFunction({kind:"ready"}),timeoutMs:5000,
        });
        if (probe.ok && !readNativeErrors(probe.output).length
          && readFeedbackDetails(probe.output).result?.enabled) {
          await claimFeedbackTab(tab,readFeedbackDetails(probe.output).url ?? details.url);
        }
      } catch {  }
    }
  }
  if (!failed && (args.action === "stop" || (args.action === "close"
    && (args.tabId ?? nativeArgs.targetId) === activeFeedbackTab))) {
    activeFeedbackTab = null; activeFeedbackSyncedAt = 0; activeFeedbackDocumentUrl = null;
  }
  if (failed && args.action === "act" && args.kind === "click"
    && clickContext?.pageUrl && clickContext?.linkUrl && nativeArgs.targetId
    && (!result?.ok || isPostNavigationVisibilityError(result.error ?? nativeErrors[0], nativeArgs.ref ?? nativeArgs.selector)
      || isBrowserTimeout(nativeErrors[0]))) {
    try {
      const tabsResult = await invokeGatewayTool("browser", {
        action:"tabs",profile:"chrome",timeoutMs:OPEN_RECOVERY_PROBE_TIMEOUT_MS,
      });
      if (tabsResult.ok) {
        const tabs = readFeedbackDetails(tabsResult.output).tabs ?? [];
        const current = tabs.find(tab => tab.tabId === nativeArgs.targetId || tab.targetId === nativeArgs.targetId);
        if (current && isConfirmedLinkNavigation(clickContext.pageUrl, clickContext.linkUrl, current.url)) {
          return {
            content:[{type:"text",text:JSON.stringify({
              ok:true,action:"click",outcome:"navigation_confirmed",
              url:current.url,tabId:current.tabId,
              message:"Destination verified after native click reported the original element hidden. No click was retried.",
            },null,2)}],
            diagnostics:{stage:"click_navigation_reconciled",verification:"same_tab_destination",visualFeedback:feedback ?? null},
          };
        }
      }
    } catch {  }
  }
  if (args.action === "open" && failed && isBrowserTimeout(result)) {
    const recovered = await reconcileTimedOutOpen(args, nativeArgs, result);
    if (recovered) return recovered;
  }

  const response = normalizeToolOutput(result);

  if (!result?.ok) {
    return {
      ...response,
      diagnostics: {
        stage: result?.error?.type ?? "gateway_tool_error",
        action: args.action ?? null,
        kind: args.kind ?? null,
        elapsedMs: result?.error?.elapsedMs ?? null,
        ...(chromeLaunch.launched ? { chromeAutoLaunched: true, chromeProfileDirectory: chromeLaunch.profileDirectory } : {}),
      },
    };
  }

  if (nativeErrors.length === 0) {
    return {
      ...response,
      diagnostics: chromeLaunch.launched
        ? { ...(result.diagnostics ?? {}), chromeAutoLaunched: true, chromeProfileDirectory: chromeLaunch.profileDirectory }
        : result.diagnostics ?? null,
    };
  }

  const diagnostics = {
    stage: "native_browser_tool_execution",
    action: args.action ?? null,
    kind: args.kind ?? null,
    elapsedMs: result.diagnostics?.elapsedMs ?? null,
    nativeErrors,
    ...(shouldCollectGatewayErrorLogs() ? { gatewayLogContext: await getRecentGatewayToolErrorLog(startedAt) } : {}),
  };

  return {
    isError: true,
    diagnostics,
    content: [{
      type: "text",
      text: JSON.stringify({ type: "native_browser_tool_execution_error", ...diagnostics }, null, 2),
    }],
  };
}