import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { agentId, invokeTimeoutMs, openclawCli, stateDir } from "../../config/runtime.mjs";
import { cuaBorderLifecycle } from "../../monitor/screen-border.mjs";

const sessionKey = "agent:" + agentId + ":openclaw-configured-mcp-wrapper";
let imports;
let state;
let queue = Promise.resolve();

// As with the core runtime wrapper, resolve the installed runtime's real exports
// rather than copying native MCP schemas, policy matching, or approval handling.
async function loadNativeExport(prefix, functionName) {
  const directory = path.join(path.dirname(openclawCli), "dist");
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".mjs")) continue;
    const filename = path.join(directory, entry);
    const source = await readFile(filename, "utf8");
    if (!source.includes("function " + functionName + "(")) continue;
    const alias = source.match(new RegExp(functionName + " as ([A-Za-z_$][A-Za-z0-9_$]*)"))?.[1];
    const module = await import(pathToFileURL(filename).href);
    const exported = module[functionName] ?? module[alias];
    if (typeof exported === "function") return exported;
  }
  throw new Error("Installed OpenClaw does not export " + functionName + "; configured MCP is unavailable.");
}

async function nativeFunctions() {
  if (!imports) imports = Promise.all([
    loadNativeExport("agent-bundle-mcp-materialize-", "createBundleMcpToolRuntime"),
    loadNativeExport("agent-tools-", "createOpenClawCodingToolsInternalAsync"),
    loadNativeExport("tool-policy-match-", "filterToolsByPolicy"),
    loadNativeExport("agent-tools.before-tool-call-", "wrapToolWithBeforeToolCallHook"),
  ]).catch(error => { imports = undefined; throw error; });
  return imports;
}

function serialize(operation) {
  const result = queue.catch(() => {}).then(operation);
  queue = result.catch(() => {});
  return result;
}

async function currentState() {
  const raw = await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8");
  const fingerprint = createHash("sha256").update(raw).digest("hex");
  if (state?.fingerprint === fingerprint) return state;
  cuaBorderLifecycle.clear();
  await state?.runtime.dispose();
  state = undefined;
  const cfg = JSON.parse(raw);
  // Only the explicitly configured cursor provider is admitted here. Other MCP
  // servers keep their existing native lifecycle and invocation paths.
  const server = cfg.mcp?.servers?.["cua-driver"];
  if (!server || server.enabled === false) return { tools: new Map() };
  const [createRuntime, constructTools, filterTools, wrapHook] = await nativeFunctions();
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || path.join(stateDir, "workspace");
  const runtimeConfig = { ...cfg, mcp: { ...cfg.mcp, servers: { "cua-driver": server } } };
  const runtime = await createRuntime({ cfg: runtimeConfig, workspaceDir });
  try {
    if (runtime.diagnostics?.length) throw new Error(runtime.diagnostics.map(x => x.serverName + ": " + x.message).join("; "));
    const rawNames = new Set(runtime.tools.filter(tool => tool.name.startsWith("cua-driver__")).map(tool => tool.name));
    const tools = await constructTools({
      config: cfg, agentId, workspaceDir, sessionKey,
    }, undefined, undefined, { tools: runtime.tools });
    // Keep native Gateway-specific denials in addition to the agent/profile/
    // sandbox policies already applied by OpenClaw's tool constructor.
    const allowed = filterTools(tools.filter(tool => rawNames.has(tool.name)), {
      deny: cfg.gateway?.tools?.deny ?? [],
    });
    runtime.restrictAppTools?.(allowed);
    const ctx = { config: cfg, agentId, sessionKey, workspaceDir };
    state = {
      fingerprint, runtime,
      tools: new Map(allowed.map(tool => [tool.name, wrapHook(tool, ctx)])),
    };
    return state;
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export async function listConfiguredMcpTools() {
  return serialize(async () => [...(await currentState()).tools.values()].map(tool => ({
    name: tool.name, description: tool.description ?? "", parameters: tool.parameters,
    source: "mcp", nativePolicyValidated: true,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  })));
}

export async function invokeConfiguredMcpTool(id, args = {}) {
  return serialize(async () => {
    const tool = (await currentState()).tools.get(id);
    if (!tool) return { ok: false, error: { type: "not_available", message: "Configured MCP tool is not available: " + id } };
    const prepared = typeof tool.prepareArguments === "function" ? await tool.prepareArguments(args) : args;
    const output = await cuaBorderLifecycle.run(id, prepared, () =>
      tool.execute(randomUUID(), prepared, AbortSignal.timeout(invokeTimeoutMs))
    );
    return { ok: true, output };
  });
}

export function activeConfiguredCuaSessionCount() {
  return cuaBorderLifecycle.activeSessions().length;
}

export async function closeConfiguredCuaSessions() {
  const sessions = cuaBorderLifecycle.activeSessions();
  let closed = 0;
  for (const session of sessions) {
    try {
      const result = await invokeConfiguredMcpTool("cua-driver__end_session",
        session === "implicit" ? {} : { session });
      if (result.ok && result.output?.isError !== true
        && result.output?.details?.isError !== true) closed++;
    } catch { /* retain failed session so a later manual close can retry */ }
  }
  return { attempted: sessions.length, closed, failed: sessions.length - closed };
}

export async function disposeConfiguredMcpRuntime() {
  return serialize(async () => {
    const previous = state;
    state = undefined;
    cuaBorderLifecycle.clear();
    await previous?.runtime.dispose();
  });
}
