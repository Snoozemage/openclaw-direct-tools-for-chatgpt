import { agentId, invokeTimeoutMs } from "../../config/runtime.mjs";
import { gatewayCall, invokeGatewayTool } from "../../openclaw-client.mjs";
import { listNativeRuntimeTools } from "../runtime/handler.mjs";
import { listConfiguredMcpTools, invokeConfiguredMcpTool } from "../runtime/configured-mcp.mjs";
import { buildAvailableToolCatalog, describeTool, searchToolCatalog } from "./engine.mjs";
import { toolDiscoveryDefinitions } from "./schema.mjs";

const publicNames = new Set(toolDiscoveryDefinitions.map((definition) => definition.name));
const sessionKey = "agent:" + agentId + ":main";
const CATALOG_TTL_MS = 10000;
let cachedCatalog;
let cachedUntil = 0;
let catalogPromise;

async function loadAvailableToolCatalog({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedCatalog && Date.now() < cachedUntil) return cachedCatalog;
  if (!forceRefresh && catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const notices = [];
    const [effective, runtimeTools, configuredMcp] = await Promise.all([
      gatewayCall("tools.effective", { sessionKey, agentId }, 20000),
      listNativeRuntimeTools(),
      listConfiguredMcpTools().catch(error => {
        notices.push({ type: "configured_mcp_unavailable", message: error.message });
        return [];
      }),
    ]);
    const catalog = buildAvailableToolCatalog(effective, [...runtimeTools, ...configuredMcp]);
    catalog.notices = notices;
    cachedCatalog = catalog;
    cachedUntil = Date.now() + CATALOG_TTL_MS;
    return catalog;
  })();
  try {
    return await catalogPromise;
  } finally {
    catalogPromise = undefined;
  }
}

function jsonResult(value, diagnostics) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function errorResult(error, stage, toolName) {
  return {
    isError: true,
    diagnostics: { stage, ...(toolName ? { toolName } : {}), errorName: error?.name ?? null },
    content: [{ type: "text", text: JSON.stringify({
      type: "tool_discovery_error",
      ...(toolName ? { tool: toolName } : {}),
      message: error instanceof Error ? error.message : String(error),
    }, null, 2) }],
  };
}

function formatDispatchResult(id, result) {
  if (!result?.ok) {
    return {
      isError: true,
      diagnostics: { stage: "openclaw_tool_dispatch", toolName: id, ...(result?.error?.type ? { errorType: result.error.type } : {}) },
      content: [{ type: "text", text: JSON.stringify(result?.error ?? { message: "OpenClaw tool invocation failed without error details." }, null, 2) }],
    };
  }

  const output = result.output;
  const content = Array.isArray(output?.content)
    ? output.content
    : [{ type: "text", text: JSON.stringify(output?.details ?? output ?? { message: "OpenClaw tool returned an empty result." }, null, 2) }];
  const details = output?.details ?? output?.structuredContent;
  const structuredContent = details && typeof details === "object" && !Array.isArray(details)
    ? Object.fromEntries(Object.entries(details).filter(([key]) => key !== "content"))
    : undefined;
  return {
    ...(output?.isError === true ? { isError: true } : {}),
    content,
    ...(structuredContent && Object.keys(structuredContent).length ? { structuredContent } : {}),
    diagnostics: { stage: "openclaw_tool_dispatch", toolName: id, ...(result.diagnostics ?? {}) },
  };
}

export function createToolDiscoveryHandler({
  loadCatalog = loadAvailableToolCatalog,
  dispatch = (id, args) => id.startsWith("cua-driver__")
    ? invokeConfiguredMcpTool(id, args)
    : invokeGatewayTool(id, args, sessionKey, invokeTimeoutMs),
} = {}) {
  return async function handleToolDiscovery(name, args = {}) {
    if (!publicNames.has(name)) return undefined;
    const startedAt = Date.now();
    try {
      if (name === "openclaw_tool_search") {
        const catalog = await loadCatalog();
        const matches = searchToolCatalog(catalog, args.query, args.limit ?? 8, args.source);
        return jsonResult({ query: args.query, count: matches.length, matches,
          ...(catalog.notices?.length ? { notices: catalog.notices } : {}),
        }, {
          stage: "openclaw_tool_search",
          elapsedMs: Date.now() - startedAt,
          catalogToolCount: catalog.length,
        });
      }

      if (name === "openclaw_tool_describe") {
        const catalog = await loadCatalog();
        return jsonResult(describeTool(catalog, args.id), {
          stage: "openclaw_tool_describe",
          elapsedMs: Date.now() - startedAt,
        });
      }

      if (name === "openclaw_dispatch_action") {
        const catalog = await loadCatalog({ forceRefresh: true });
        // A fresh effective catalog is required immediately before a native call.
        // The Gateway applies its own policy/approval checks again during invocation.
        describeTool(catalog, args.id);
        if (args.args !== undefined && (args.args === null || typeof args.args !== "object" || Array.isArray(args.args))) {
          throw new TypeError("args must be a JSON object.");
        }
        const result = await dispatch(args.id, args.args ?? {});
        const formatted = formatDispatchResult(args.id, result);
        formatted.diagnostics = { ...(formatted.diagnostics ?? {}), elapsedMs: Date.now() - startedAt };
        return formatted;
      }

      return undefined;
    } catch (error) {
      return errorResult(error, name, name === "openclaw_dispatch_action" ? args.id : undefined);
    }
  };
}

export const handleToolDiscovery = createToolDiscoveryHandler();
