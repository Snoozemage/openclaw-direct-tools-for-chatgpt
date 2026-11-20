import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { agentId, invokeTimeoutMs, openclawCli, stateDir } from "../../config/runtime.mjs";
import { runtimeToolDefinitions } from "./schema.mjs";

const nativeNames = new Map([
  ["openclaw_exec", "exec"],
  ["openclaw_process", "process"],
]);
const publicNames = new Set(runtimeToolDefinitions.map((definition) => definition.name));
let nativeToolsPromise;

async function createNativeToolMap() {
  const packageRoot = path.dirname(openclawCli);
  const distPath = path.join(packageRoot, "dist");
  const entries = await readdir(distPath, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^agent-tools-.*\.(?:mjs|js)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  let factory = null;
  const sdkPath = path.join(distPath, "plugin-sdk", "agent-harness.js");
  try {
    const sdk = await import(pathToFileURL(sdkPath).href);
    factory = sdk.createOpenClawCodingToolsAsync ?? sdk.createOpenClawCodingTools ?? null;
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ENOENT") throw error;
  }
  for (const name of factory ? [] : candidates) {
    const modulePath = path.join(distPath, name);
    const source = await readFile(modulePath, "utf8");
    if (!source.includes("createOpenClawCodingToolsAsync")) continue;
    const imported = await import(pathToFileURL(modulePath).href);
    const candidate = imported.createOpenClawCodingToolsAsync ?? imported.n;
    if (typeof candidate === "function") {
      factory = candidate;
      break;
    }
  }

  if (!factory) {
    throw new Error("Could not locate OpenClaw's internal tool factory in dist/agent-tools-*.mjs; exec/process wrappers are unavailable.");
  }
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) throw new Error("OPENCLAW_CONFIG_PATH is not configured.");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const tools = await factory({
    config,
    agentId,
    workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR || path.join(stateDir, "workspace"),
    sessionKey: "agent:" + agentId + ":openclaw-runtime-tool-wrapper",
  });
  const byName = new Map(Array.isArray(tools) ? tools.map((tool) => [tool.name, tool]) : []);
  for (const name of nativeNames.values()) {
    if (typeof byName.get(name)?.execute !== "function") {
      throw new Error("OpenClaw runtime did not construct an executable native tool: " + name);
    }
  }
  return byName;
}

export async function listNativeRuntimeTools() {
  if (!nativeToolsPromise) {
    nativeToolsPromise = createNativeToolMap().catch((error) => {
      nativeToolsPromise = undefined;
      throw error;
    });
  }
  const tools = await nativeToolsPromise;
  return [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  }));
}

async function getNativeTool(name) {
  if (!nativeToolsPromise) {
    nativeToolsPromise = createNativeToolMap().catch((error) => {
      nativeToolsPromise = undefined;
      throw error;
    });
  }
  const tools = await nativeToolsPromise;
  const tool = tools.get(name);
  if (!tool) throw new Error("OpenClaw native tool is not available: " + name);
  return tool;
}

function toContent(result) {
  if (Array.isArray(result?.content)) return result.content;
  const details = result?.details ?? result ?? { message: "OpenClaw native runtime tool returned an empty result." };
  return [{ type: "text", text: JSON.stringify(details, null, 2) }];
}

export function createRuntimeToolHandler({ resolveTool = getNativeTool } = {}) {
  return async function handleRuntimeTool(name, args = {}) {
    if (!publicNames.has(name)) return undefined;
    const nativeName = nativeNames.get(name);
    const startedAt = Date.now();
    try {
      const tool = await resolveTool(nativeName);
      const prepared = typeof tool.prepareArguments === "function"
        ? await tool.prepareArguments(args)
        : args;
      const result = await tool.execute(randomUUID(), prepared ?? {}, AbortSignal.timeout(invokeTimeoutMs));
      const details = result?.details;
      const structuredContent = details && typeof details === "object" && !Array.isArray(details)
        ? Object.fromEntries(Object.entries(details).filter(([key]) => key !== "content"))
        : undefined;
      return {
        ...(result?.isError === true ? { isError: true } : {}),
        content: toContent(result),
        ...(structuredContent && Object.keys(structuredContent).length ? { structuredContent } : {}),
        diagnostics: {
          stage: "native_runtime_tool_execution",
          nativeTool: nativeName,
          elapsedMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      return {
        isError: true,
        diagnostics: {
          stage: "native_runtime_tool_execution",
          nativeTool: nativeName,
          elapsedMs: Date.now() - startedAt,
          errorName: error?.name ?? null,
        },
        content: [{ type: "text", text: JSON.stringify({
          type: "native_runtime_tool_execution_error",
          nativeTool: nativeName,
          message: error instanceof Error ? error.message : String(error),
        }, null, 2) }],
      };
    }
  };
}

export const handleRuntimeTool = createRuntimeToolHandler();