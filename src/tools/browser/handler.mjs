import { invokeGatewayTool, getRecentGatewayToolErrorLog } from "../../openclaw-client.mjs";
import { normalizeToolOutput } from "../../mcp/format.mjs";
import { browserToolDefinition } from "./schema.mjs";
import { ensurePersonalChromeRunning } from "./chrome-launch.mjs";
import { ADVANCED_BROWSER_ACTIONS } from "./advanced-routes.mjs";
import { invokeAdvancedBrowser } from "./advanced.mjs";
import { browserFeedbackFunction, feedbackOptions, shouldShowBrowserFeedback } from "./effects.mjs";
import {
  isBrowserTimeout,
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
  if (shouldShowBrowserFeedback(args)) {
    const { ref, options } = feedbackOptions(args);
    try {
      const probe = await invokeGatewayTool("browser", {
        action: "act", kind: "evaluate", profile: "chrome",
        ...pickFeedbackRoute(nativeArgs), ...(ref ? { ref } : {}),
        fn: browserFeedbackFunction(options), timeoutMs: 5000,
      });
      const errors = probe.ok ? readNativeErrors(probe.output) : [];
      const details = readFeedbackDetails(probe.output);
      const enabled = details.result?.enabled !== false;
      feedback = { available: probe.ok && !errors.length && enabled, ...(probe.ok && !errors.length && enabled ? {} : { reason: !enabled ? "Browser effects disabled for this document" : probe.error?.message ?? errors[0]?.error ?? errors[0]?.message ?? "Browser feedback unavailable" }) };
      if (probe.ok && !errors.length && details.targetId && !nativeArgs.targetId) nativeArgs = { ...nativeArgs, targetId: details.targetId };
    } catch (error) { feedback = { available: false, reason: error.message }; }
  }
  const startedAt = Date.now();
  const result = await invokeGatewayTool("browser", nativeArgs);
  if (feedback?.available) {
    // Finish only on the same observed tab. Do not guess another active tab.
    if (nativeArgs.targetId) {
      try {
        await invokeGatewayTool("browser", {
          action: "act", kind: "evaluate", profile: "chrome",
          ...pickFeedbackRoute(nativeArgs), fn: browserFeedbackFunction({ finish: true }), timeoutMs: 3000,
        });
      } catch { /* feedback cleanup must never replace the action result */ }
    }
    result.diagnostics = { ...result.diagnostics, visualFeedback: feedback };
  } else if (feedback) result.diagnostics = { ...result.diagnostics, visualFeedback: feedback };
  const nativeErrors = result?.ok ? readNativeErrors(result.output) : [];
  const failed = !result?.ok || nativeErrors.length > 0;
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
    gatewayLogContext: await getRecentGatewayToolErrorLog(startedAt),
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