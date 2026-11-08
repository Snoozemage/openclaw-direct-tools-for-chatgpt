const PROFILE_INDEPENDENT_ACTIONS = new Set(["doctor", "profiles", "importprofile"]);

export const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
export const OPEN_RECOVERY_PROBE_TIMEOUT_MS = 5_000;

export function prepareBrowserArgs(args = {}) {
  const { profile: _profile, browser: _browser, systemProfile: _systemProfile, tabId, visualFeedback: _feedback, ...forwardedArgs } = args;
  if (tabId !== undefined && forwardedArgs.targetId === undefined) forwardedArgs.targetId = tabId;
  if (Array.isArray(forwardedArgs.actions)) forwardedArgs.actions = forwardedArgs.actions.map(step => {
    const { tabId: stepTabId, ...rest } = step;
    return stepTabId !== undefined && rest.targetId === undefined ? { ...rest, targetId: stepTabId } : rest;
  });
  const nativeArgs = PROFILE_INDEPENDENT_ACTIONS.has(args.action)
    ? forwardedArgs
    : { ...forwardedArgs, profile: "chrome" };

  if (args.action === "open" && args.timeoutMs === undefined) {
    return { ...nativeArgs, timeoutMs: DEFAULT_OPEN_TIMEOUT_MS };
  }

  return nativeArgs;
}

export function isBrowserTimeout(errorDetails) {
  const text = typeof errorDetails === "string" ? errorDetails : JSON.stringify(errorDetails ?? {});
  return /timed out|timeout\b(?: after| of| while| waiting| reached)?|deadline exceeded/i.test(text);
}

function comparableUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function outputContainsTargetUrl(output, targetUrl) {
  const expected = comparableUrl(targetUrl);
  if (!expected) return false;

  const serialized = JSON.stringify(output ?? {});
  const candidates = serialized.match(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>\\]+/gi) ?? [];
  return candidates.some((candidate) => {
    const cleaned = candidate.replace(/[),.;\]}]+$/, "");
    return comparableUrl(cleaned) === expected;
  });
}
