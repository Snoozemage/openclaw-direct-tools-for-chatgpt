import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { agentId, invokeTimeoutMs, openclawCli, stateDir } from "../../config/runtime.mjs";
import { gatewayCall, invokeGatewayTool } from "../../openclaw-client.mjs";
import { isMissingCookieCommand, runCookieCompatibility } from "./cookie-compat.mjs";
import { browserToolDefinition } from "./schema.mjs";
import { buildAdvancedBrowserRequest } from "./advanced-routes.mjs";
import { boundBrowserResult } from "./output.mjs";

let functions;
let cached;
async function loadExport(prefix, name) {
  const dir = path.join(path.dirname(openclawCli), "dist");
  for (const entry of await readdir(dir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".mjs")) continue;
    const filename = path.join(dir, entry);
    const source = await readFile(filename, "utf8");
    if (!source.includes("function " + name + "(") && !source.includes("class " + name)) continue;
    const alias = source.match(new RegExp(name + " as ([A-Za-z_$][A-Za-z0-9_$]*)"))?.[1];
    const module = await import(pathToFileURL(filename).href);
    if (typeof (module[name] ?? module[alias]) === "function") return module[name] ?? module[alias];
  }
  throw new Error("Installed OpenClaw does not export " + name);
}

// Feed the extended Browser surface through the same native construction,
// effective agent policy, Gateway deny floor and before-call hooks as core tools.
// Do not call browser.request directly from the public handler.
export async function createPolicyBoundBrowserTool(config) {
  functions ??= Promise.all([
    loadExport("agent-tools-", "createOpenClawCodingToolsInternalAsync"),
    loadExport("tool-policy-match-", "filterToolsByPolicy"),
    loadExport("agent-tools.before-tool-call-", "wrapToolWithBeforeToolCallHook"),
    loadExport("external-content-", "wrapExternalContent"),
  ]).catch(error => { functions = undefined; throw error; });
  const [constructTools, filterTools, wrapHook, wrapExternalContent] = await functions;
  const sessionKey = "agent:" + agentId + ":openclaw-browser-wrapper";
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || path.join(stateDir, "workspace");
  // Cache only observed method-not-found capabilities for this policy/config instance.
  const missingCookieCommands = new Set();
  const surface = {
    name: "browser", label: "Browser", description: browserToolDefinition.description,
    parameters: browserToolDefinition.inputSchema,
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      const request = buildAdvancedBrowserRequest(args);
      let details;
      const cookieOperation = args.operation ?? "get";
      const cookieCommand = args.action === "cookies" && ["get", "set", "setMany"].includes(cookieOperation)
        ? (cookieOperation === "get" ? "get" : "set") : null;
      const localCookie = cookieCommand && request.target === "host" && !args.node;
      if (localCookie && missingCookieCommands.has(cookieCommand)) {
        details = await runCookieCompatibility(args, { loadExport, invokeTool: invokeGatewayTool, signal });
      } else try {
        details = await gatewayCall("browser.request", request, Math.min(invokeTimeoutMs, (request.timeoutMs ?? 25000) + 5000), { safeError: true, signal });
      } catch (error) {
        if (!isMissingCookieCommand(args, error)) throw error;
        if (localCookie) missingCookieCommands.add(cookieCommand);
        details = await runCookieCompatibility(args, { loadExport, invokeTool: invokeGatewayTool, signal });
      }
      // Preserve native Browser's boundary around page-controlled strings.
      const { json, truncated } = boundBrowserResult(details);
      const text = wrapExternalContent(json, { source: "browser", includeWarning: true });
      return { content: [{ type: "text", text }], details: { ok: true, text, truncated, externalContent: { untrusted: true, source: "browser", wrapped: true } } };
    },
  };
  const options = { config, agentId, workspaceDir, sessionKey };
  if (config.browser?.enabled === false) return null;
  const nativeTools = await constructTools(options);
  if (!nativeTools.some(tool => tool.name === "browser")) return null;
  const tools = await constructTools(options, undefined, undefined, { tools: [surface] });
  const allowed = filterTools(tools.filter(tool => tool.name === "browser"), { deny: config.gateway?.tools?.deny ?? [] });
  if (!allowed.length) return null;
  return wrapHook(allowed[0], { config, agentId, workspaceDir, sessionKey });
}

export async function invokeAdvancedBrowser(args) {
  try {
    const raw = await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8");
    const fingerprint = createHash("sha256").update(raw).digest("hex");
    if (cached?.fingerprint !== fingerprint) cached = { fingerprint, tool: await createPolicyBoundBrowserTool(JSON.parse(raw)) };
    if (!cached.tool) return { ok: false, error: { type: "tool_not_available", message: "Browser is denied by effective OpenClaw tool policy." } };
    const prepared = typeof cached.tool.prepareArguments === "function" ? await cached.tool.prepareArguments(args) : args;
    const output = await cached.tool.execute(randomUUID(), prepared, AbortSignal.timeout(invokeTimeoutMs));
    return { ok: true, output, diagnostics: { stage: "native_browser_control", action: args.action } };
  } catch (error) {
    return { ok: false, error: { type: /Protocol error.*wasn.t found/.test(error.message) ? "unsupported_browser_transport" : "native_browser_control_error", action: args.action, message: error instanceof Error ? error.message : String(error) } };
  }
}
