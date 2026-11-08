export const monitorEvents = [];
export const eventClients = new Set();
let nextEventId = 1;
let firstRetainedEventId = 1;
const firstRetainedEventIdBySession = new Map();
const activeToolEvents = new Map();

function redact(value, key = "") {
  if (/secret|token|password|api.?key|authorization|cookie|credential/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  if (typeof value === "string") return value.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]").replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 16000);
  return value;
}

function eventCommand(args) { return args?.command ?? args?.cmd ?? args?.script ?? args?.method ?? ""; }

function applySession(event, session) {
  event.sessionId = session?.id ?? null;
  event.sessionLabel = session?.id ?? "Unscoped / local";
  event.sessionTask = session?.task ?? null;
  event.sessionInitialized = session?.initialized ?? null;
  event.sessionStatus = session?.status ?? null;
}

function publishEvent(event) {
  if (event.id < firstRetainedEventId) return;
  if (event.sessionId && event.id < (firstRetainedEventIdBySession.get(event.sessionId) ?? 0)) return;
  const safe = redact(event);
  const index = monitorEvents.findIndex(item => item.id === safe.id);
  if (index < 0) monitorEvents.push(safe); else monitorEvents[index] = safe;
  if (monitorEvents.length > 200) monitorEvents.splice(0, monitorEvents.length - 200);
  publishMonitorSignal(safe);
}

export function publishMonitorSignal(signal) {
  const message = "data: " + JSON.stringify(redact(signal)) + "\n\n";
  for (const client of eventClients) { try { client.write(message); } catch { eventClients.delete(client); } }
}

export function getCurrentToolActivity() {
  const active = [...activeToolEvents.values()];
  const computerCount = active.filter((event) => event.computer).length;
  return {
    state: computerCount > 0 ? "computer" : active.length > 0 ? "tool" : "idle",
    activeCount: active.length,
    computerCount,
    toolCount: active.length - computerCount,
  };
}

function publishToolActivity() {
  publishMonitorSignal({ type: "activity", activity: getCurrentToolActivity() });
}

export function clearMonitorEvents() {
  const clearedCount = monitorEvents.length;
  monitorEvents.length = 0;
  firstRetainedEventId = nextEventId;
  firstRetainedEventIdBySession.clear();
  publishMonitorSignal({ type: "clear" });
  return clearedCount;
}

export function removeMonitorEventsForSession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return 0;
  firstRetainedEventIdBySession.set(sessionId, nextEventId);
  let removedCount = 0;
  for (let index = monitorEvents.length - 1; index >= 0; index--) {
    if (monitorEvents[index].sessionId !== sessionId) continue;
    monitorEvents.splice(index, 1);
    removedCount++;
  }
  return removedCount;
}

export function beginToolEvent(tool, args, requestId, session) {
  const event = { id: nextEventId++, requestId: String(requestId ?? ""), tool, arguments: redact(args), command: redact(eventCommand(args)), method: args?.method, status: "running", startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, output: null, error: null };
  applySession(event, session);
  const computer = tool === "openclaw_computer"
    || (tool === "openclaw_dispatch_action" && /^cua-driver__/.test(args?.id ?? ""));
  activeToolEvents.set(event.id, { id: event.id, tool, computer });
  publishEvent(event);
  publishToolActivity();
  return event;
}

function parseContentForMonitor(item) {
  if (item?.type === "image") return { type: "image", mimeType: item.mimeType || "unknown", note: "Image payload omitted from monitor log." };
  if (item?.type === "text" && typeof item.text === "string") {
    try { return redact(JSON.parse(item.text)); } catch { return redact(item.text); }
  }
  return redact(item);
}

function compactDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return diagnostics;
  const compact = { ...diagnostics };
  for (const key of ["originalError", "nativeErrors", "gatewayLogContext", "gatewayLog", "gatewayLogLookup"]) delete compact[key];
  return Object.keys(compact).length ? redact(compact) : null;
}

export function finishToolEvent(event, result, error, session) {
  const finishedAt = new Date().toISOString();
  event.finishedAt = finishedAt;
  event.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(event.startedAt));
  event.status = error || result?.isError ? "error" : "success";
  if (session) applySession(event, session);
  if (result?.diagnostics) {
    const diagnostics = compactDiagnostics(result.diagnostics);
    if (diagnostics) event.diagnostics = diagnostics;
  }
  if (error) {
    const detail = error instanceof Error
      ? { name: error.name, message: error.message, code: error.code ?? null, cause: error.cause ? String(error.cause) : null, stack: typeof error.stack === "string" ? error.stack.split("\n").slice(0, 8).join("\n") : null }
      : { message: String(error) };
    event.error = redact(detail);
  }
  if (result) {
    const content = result.content || result.result?.content;
    if (Array.isArray(content)) {
      const parsedContent = content.map(parseContentForMonitor);
      if (result.isError) {
        if (!event.error) {
          const primary = parsedContent.find(item => item && typeof item === "object") ?? parsedContent[0];
          event.error = primary ? redact(primary) : { message: "Tool returned isError=true without error details." };
        }
        event.output = null;
      } else if (["openclaw_edit", "openclaw_write", "openclaw_apply_patch"].includes(event.tool)
      && result.structuredContent
      && typeof result.structuredContent === "object"
      && (typeof result.structuredContent.patch === "string" || typeof result.structuredContent.diff === "string")) {
      event.output = redact({ ...result.structuredContent, result: parsedContent });
    } else event.output = parsedContent;
    } else if (result.isError) {
      if (!event.error) event.error = redact(result);
      event.output = null;
    } else event.output = redact(result);
  }
  publishEvent(event);
  activeToolEvents.delete(event.id);
  publishToolActivity();
}
