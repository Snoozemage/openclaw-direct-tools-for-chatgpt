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

export function isPlainFragmentLink(pageUrl, linkUrl, rawHref, linkTarget, linkDownload, inlineHandler) {
  if (typeof rawHref !== "string" || !rawHref.startsWith("#")
    || rawHref.length < 2 || rawHref.startsWith("#!")
    || linkTarget || linkDownload || inlineHandler) return false;
  try {
    const source = new URL(pageUrl), target = new URL(linkUrl);
    return (source.protocol === "http:" || source.protocol === "https:")
      && source.origin === target.origin
      && source.pathname === target.pathname
      && source.search === target.search
      && source.hash !== target.hash
      && Boolean(target.hash);
  } catch { return false; }
}

export function isPostNavigationVisibilityError(error, ref) {
  if (typeof ref !== "string" || !ref) return false;
  const messages = [
    error?.message,
    error?.gatewayError?.message,
    ...(error?.gatewayLogContext?.lines ?? []).map(line => line?.message),
  ];
  return messages.some(message => typeof message === "string"
    && message.includes('Element "' + ref + '" is not interactable (not visible)'));
}

export function isConfirmedLinkNavigation(beforeUrl, linkUrl, observedUrl) {
  try {
    const before = new URL(beforeUrl), link = new URL(linkUrl), observed = new URL(observedUrl);
    if (!["http:", "https:"].includes(link.protocol) || before.href === observed.href
      || link.origin !== observed.origin || link.pathname !== observed.pathname) return false;

    for (const key of ["v", "id", "videoId"]) {
      if (link.searchParams.has(key) && link.searchParams.get(key) !== observed.searchParams.get(key)) return false;
    }
    const params = [...link.searchParams.entries()];
    const shared = params.filter(([key]) => observed.searchParams.has(key));
    return params.length === 0 || (shared.length > 0
      && shared.every(([key, value]) => observed.searchParams.getAll(key).includes(value)));
  } catch {
    return false;
  }
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
