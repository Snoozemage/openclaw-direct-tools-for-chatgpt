import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import { root, runtimeNode, openclawCli, gatewayPort, gatewayToken, agentId, invokeTimeoutMs } from "./config/runtime.mjs";
import { jsonText } from "./mcp/format.mjs";
const execFile = promisify(execFileCallback);

export async function gatewayCall(method, params = {}, timeoutMs = 20000, { safeError = false, signal } = {}) {
  const args = [
    openclawCli, "gateway", "call", method,
    "--json", "--params", JSON.stringify(params), "--timeout", String(timeoutMs),
  ];
  let stdout;
  try {
    ({ stdout } = await execFile(runtimeNode, args, {
      cwd: root, env: process.env, windowsHide: true, signal,
      timeout: timeoutMs + 5000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8",
    }));
  } catch (error) {
    if (safeError) {
      // Child-process errors repeat the command line, including serialized
      // Browser cookies, credentials or headers. Never echo it for this surface.
      let message = "request failed";
      for (const output of [error.stdout, error.stderr]) {
        try { const value = JSON.parse(output); message = value.error?.message ?? message; } catch {}
      }
      throw new Error("OpenClaw Gateway call " + method + " failed: " + message);
    }
    const details = [error.stderr, error.stdout, error.message].filter(Boolean).join("\n").slice(-4000);
    throw new Error("OpenClaw Gateway call " + method + " failed: " + details);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("OpenClaw returned non-JSON for " + method + ": " + String(stdout).slice(-2000));
  }
}

function parseGatewayLogLine(line) {
  if (line && typeof line === "object" && typeof line.message === "string") {
    return {
      time: line.time ?? null,
      level: String(line.level ?? "").toLowerCase(),
      subsystem: line.subsystem ?? null,
      message: line.message,
      traceId: line.traceId ?? null,
      spanId: line.spanId ?? null,
    };
  }
  if (typeof line !== "string") return null;
  let parsed;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const meta = parsed._meta && typeof parsed._meta === "object" ? parsed._meta : {};
  const parseContext = (value) => {
    if (typeof value !== "string") return {};
    try {
      const context = JSON.parse(value);
      return context && typeof context === "object" ? context : {};
    } catch {
      return {};
    }
  };
  const context = parseContext(meta.name);
  const fallbackContext = parseContext(parsed["0"]);
  const numericParts = Object.keys(parsed)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => typeof parsed[key] === "string" ? parsed[key] : JSON.stringify(parsed[key]));
  return {
    time: typeof parsed.time === "string" ? parsed.time : (meta.date ?? null),
    level: String(meta.logLevelName ?? parsed.level ?? "").toLowerCase(),
    subsystem: context.subsystem ?? fallbackContext.subsystem ?? parsed.subsystem ?? null,
    message: typeof parsed.message === "string" ? parsed.message : numericParts.slice(1).join(" "),
    traceId: typeof parsed.traceId === "string" ? parsed.traceId : null,
    spanId: typeof parsed.spanId === "string" ? parsed.spanId : null,
  };
}

// Keep only high-signal Gateway context: tool-invocation records, browser records,
// and warning/error levels. Preserve trace identifiers, but omit the duplicated raw JSON.
export async function getRecentGatewayToolErrorLog(startedAt, timeoutMs = 10000) {
  const start = Number.isFinite(Number(startedAt)) ? Number(startedAt) : Date.now() - 30000;
  try {
    const tail = await gatewayCall("logs.tail", { limit: 500, maxBytes: 500000 }, timeoutMs);
    const sourceLines = Array.isArray(tail?.lines) ? tail.lines : Array.isArray(tail?.result?.lines) ? tail.result.lines : [];
    const end = Date.now();
    const inWindow = sourceLines
      .map(parseGatewayLogLine)
      .filter((line) => {
        if (!line) return false;
        const time = Date.parse(line.time ?? "");
        return Number.isFinite(time) && time >= start - 5000 && time <= end + 1000;
      })
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const relevantLines = inWindow.filter((line) => {
      const level = String(line.level ?? "").toLowerCase();
      const subsystem = String(line.subsystem ?? "").toLowerCase();
      return ["warn", "warning", "error", "fatal", "critical"].includes(level)
        || subsystem.includes("tools-invoke")
        || subsystem.includes("browser");
    });
    const displayedLines = relevantLines.slice(-12);
    return {
      found: displayedLines.length > 0,
      source: "OpenClaw Gateway logs.tail",
      windowStart: new Date(start - 5000).toISOString(),
      windowEnd: new Date(end + 1000).toISOString(),
      candidateLineCount: inWindow.length,
      lineCount: relevantLines.length,
      omittedLineCount: Math.max(0, relevantLines.length - displayedLines.length),
      lines: displayedLines,
      correlationNote: "Filtered to browser/tool-invocation records and warning/error levels. Records are time-correlated only and may not belong to this exact request if other calls ran concurrently.",
      ...(!displayedLines.length ? { reason: "No browser/tool-invocation or warning/error records were found in the call time window; the original tool/transport error is preserved." } : {}),
    };
  } catch (error) {
    return {
      found: false,
      source: "OpenClaw Gateway logs.tail",
      reason: "Could not read recent OpenClaw Gateway logs: " + (error instanceof Error ? error.message : String(error)),
    };
  }
}

export function shouldCollectGatewayErrorLogs(env = process.env) {
  return env.OPENCLAW_BRIDGE_ERROR_LOGS === "1";
}

async function attachGatewayLogDetails(error, startedAt, timeoutMs) {
  if (shouldCollectGatewayErrorLogs()) {
    error.gatewayLogContext = await getRecentGatewayToolErrorLog(startedAt, Math.min(10000, Math.max(3000, timeoutMs)));
  }
  return error;
}

export async function invokeGatewayTool(name, args = {}, sessionKey, timeoutMs = invokeTimeoutMs) {
  const startedAt = Date.now();
  const endpoint = "http://127.0.0.1:" + gatewayPort + "/tools/invoke";
  const payload = { tool: name, args, agentId, ...(sessionKey ? { sessionKey } : {}) };
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer " + gatewayToken, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = await attachGatewayLogDetails({
      type: error?.name === "TimeoutError" || error?.name === "AbortError" ? "gateway_transport_timeout" : "gateway_transport_error",
      message: error instanceof Error ? error.message : String(error), name: error?.name || null, code: error?.code || null,
      elapsedMs: Date.now() - startedAt, timeoutMs, endpoint, tool: name,
      action: args?.action || null, kind: args?.kind || null,
    }, startedAt, timeoutMs);
    return { ok: false, error: detail };
  }

  const elapsedMs = Date.now() - startedAt;
  const contentType = response.headers.get("content-type") || "";
  let rawBody = "";
  let body;
  try {
    rawBody = await response.text();
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    const detail = await attachGatewayLogDetails({
      type: "gateway_invalid_response", message: "OpenClaw returned a non-JSON response.", name: error?.name || null,
      httpStatus: response.status, contentType, elapsedMs, bodyPreview: rawBody.slice(0, 2000), endpoint,
      tool: name, action: args?.action || null, kind: args?.kind || null,
    }, startedAt, timeoutMs);
    return { ok: false, error: detail };
  }

  if (!response.ok || body?.ok === false) {
    const detail = await attachGatewayLogDetails({
      ...(body?.error && typeof body.error === "object" ? body.error : {}),
      type: body?.error?.type || "gateway_tool_error",
      message: body?.error?.message || "OpenClaw returned HTTP " + response.status,
      httpStatus: response.status, elapsedMs, timeoutMs, endpoint, tool: name,
      action: args?.action || null, kind: args?.kind || null,
      gatewayError: body?.error ?? null, responseKeys: Object.keys(body || {}),
    }, startedAt, timeoutMs);
    return { ok: false, error: detail };
  }

  return {
    ok: true,
    output: body.result ?? body.output ?? body,
    diagnostics: { httpStatus: response.status, elapsedMs, endpoint, tool: name },
  };
}

export async function invokeNodeCommand(node, command, params = {}, timeoutMs = 15000, metadata = {}) {
  const nodeArgs = [
    openclawCli, "nodes", "invoke",
    "--node", String(node),
    "--command", String(command),
    "--params", JSON.stringify(params),
    "--json",
    "--invoke-timeout", String(timeoutMs),
    "--timeout", String(Math.min(120000, timeoutMs + 5000)),
  ];
  let stdout;
  try {
    ({ stdout } = await execFile(runtimeNode, nodeArgs, {
      cwd: root, env: process.env, windowsHide: true,
      timeout: timeoutMs + 10000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8",
    }));
  } catch (error) {
    const details = [error.stderr, error.stdout, error.message].filter(Boolean).join("\\n").slice(-4000);
    return { isError: true, content: [{ type: "text", text: "OpenClaw node invocation failed: " + details }] };
  }

  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    return { isError: true, content: [{ type: "text", text: "OpenClaw node invocation returned non-JSON: " + String(stdout).slice(-2000) }] };
  }
  if (!result?.ok) {
    return { isError: true, content: [{ type: "text", text: jsonText(result) }] };
  }

  let imageData = typeof result.payload?.base64 === "string" ? result.payload.base64 : null;
  let imageFormat = String(result.payload?.format || "").toLowerCase();
  const cleaned = { ...result };
  delete cleaned.payloadJSON;
  if (result.payload && typeof result.payload === "object") {
    cleaned.payload = { ...result.payload };
    delete cleaned.payload.base64;
    if (metadata.executionId) cleaned.payload.executionId = metadata.executionId;
    const refWidth = metadata.refWidth ?? result.payload.width;
    if (refWidth) cleaned.payload.refWidth = refWidth;
    if (!imageData && result.payload.observation && typeof result.payload.observation.base64 === "string") {
      imageData = result.payload.observation.base64;
      imageFormat = String(result.payload.observation.format || "jpeg").toLowerCase();
      cleaned.payload.observation = { ...result.payload.observation };
      delete cleaned.payload.observation.base64;
    }
  }
  const content = [{ type: "text", text: jsonText(cleaned) }];
  if (imageData) {
    const mimeType = imageFormat === "jpeg" || imageFormat === "jpg" ? "image/jpeg" : imageFormat === "png" ? "image/png" : "application/octet-stream";
    content.push({ type: "image", data: imageData, mimeType });
  }
  return { content };
}
