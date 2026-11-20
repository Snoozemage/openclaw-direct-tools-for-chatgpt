import { randomUUID } from "node:crypto";
import { readFile, readdir, lstat, stat } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { agentId, invokeTimeoutMs, openclawCli, stateDir } from "../../config/runtime.mjs";
import { fileToolDefinitions } from "./schema.mjs";

const fileToolNames = new Set(fileToolDefinitions.map((definition) => definition.name));
const nativeToolNames = new Map([
  ["openclaw_ls", "ls"],
  ["openclaw_read", "read"],
  ["openclaw_edit", "edit"],
  ["openclaw_write", "write"],
  ["openclaw_apply_patch", "apply_patch"],
]);

let nativeFileToolsPromise;

async function createNativeFileToolMap() {
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
    throw new Error(
      "Could not locate OpenClaw's internal tool factory in dist/agent-tools-*.mjs. "
      + "The installed OpenClaw build may have changed; file tools are unavailable rather than falling back to an unsupported Gateway call."
    );
  }

  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) throw new Error("OPENCLAW_CONFIG_PATH is not configured.");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const tools = await factory({
    config,
    agentId,
    workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR || path.join(stateDir, "workspace"),
    sessionKey: "agent:" + agentId + ":openclaw-file-tool-wrapper",
  });

  const byName = new Map(Array.isArray(tools) ? tools.map((tool) => [tool.name, tool]) : []);
  // Fedora's agent-harness SDK provides read/edit/write but not ls/apply_patch.
  // Do not disable available native tools because an unrelated tool is absent.
  for (const nativeName of ["read", "edit", "write"]) {
    if (typeof byName.get(nativeName)?.execute !== "function") {
      throw new Error("OpenClaw runtime did not construct an executable native file tool: " + nativeName);
    }
  }
  return byName;
}

async function getNativeFileTool(name) {
  if (!nativeFileToolsPromise) {
    nativeFileToolsPromise = createNativeFileToolMap().catch((error) => {
      nativeFileToolsPromise = undefined;
      throw error;
    });
  }
  const tools = await nativeFileToolsPromise;
  const tool = tools.get(name);
  if (!tool) throw new Error("OpenClaw native file tool is not available: " + name);
  return tool;
}

const MAX_PATCH_FILE_BYTES = 128 * 1024;
const MAX_PATCH_PREVIEW_CHARS = 250_000;

function patchFileDescriptors(input) {
  if (typeof input !== "string") return [];
  const descriptors = [];
  let current = null;
  for (const line of input.split(/\r?\n/u)) {
    const operation = line.match(/^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/u);
    if (operation) {
      current = { action: operation[1], source: operation[2], target: operation[2] };
      descriptors.push(current);
      continue;
    }
    const move = line.match(/^\*\*\* Move to:\s*(.+?)\s*$/u);
    if (move && current && current.action === "Update") current.target = move[1];
  }
  return descriptors;
}

function resolvePatchPath(filePath, workspaceDir) {
  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(workspaceDir, filePath);
}

async function snapshotPatchFile(filePath) {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size > MAX_PATCH_FILE_BYTES) {
      return { available: false, exists: metadata.isFile(), content: "" };
    }
    const content = await readFile(filePath, "utf8");
    if (content.includes("\0")) return { available: false, exists: true, content: "" };
    return { available: true, exists: true, content };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { available: true, exists: false, content: "" };
    }
    return { available: false, exists: false, content: "" };
  }
}

async function capturePatchSnapshots(input, workspaceDir) {
  const descriptors = patchFileDescriptors(input).map((descriptor) => ({
    action: descriptor.action,
    source: resolvePatchPath(descriptor.source, workspaceDir),
    target: resolvePatchPath(descriptor.target, workspaceDir),
  }));
  if (descriptors.length === 0) return null;

  const snapshots = new Map();
  for (const descriptor of descriptors) {
    for (const filePath of new Set([descriptor.source, descriptor.target])) {
      if (!snapshots.has(filePath)) snapshots.set(filePath, await snapshotPatchFile(filePath));
    }
  }
  return { descriptors, snapshots };
}

async function buildPatchPreview(capture) {
  if (!capture) return null;
  const patches = [];
  let totalChars = 0;
  for (const descriptor of capture.descriptors) {
    const before = capture.snapshots.get(descriptor.source);
    const after = await snapshotPatchFile(descriptor.target);
    if (!before?.available || !after.available) continue;
    if (before.exists === after.exists && before.content === after.content) continue;

    const patch = createTwoFilesPatch(
      before.exists ? descriptor.source : "/dev/null",
      after.exists ? descriptor.target : "/dev/null",
      before.content,
      after.content,
      "",
      "",
      { context: 3 },
    );
    if (!/^@@ [-+]/mu.test(patch)) continue;
    totalChars += patch.length;
    if (totalChars > MAX_PATCH_PREVIEW_CHARS) return null;
    patches.push(patch);
  }
  return patches.length > 0 ? patches.join("\n") : null;
}

function resultContent(result) {
  if (Array.isArray(result?.content)) return result.content;
  const payload = result?.details ?? result ?? { message: "OpenClaw native tool returned an empty result." };
  return [{ type: "text", text: JSON.stringify(payload, null, 2) }];
}

function structuredDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const { content: _content, ...metadata } = details;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function errorResponse(nativeTool, error, startedAt) {
  const diagnostics = {
    stage: "native_file_tool_execution",
    nativeTool,
    elapsedMs: Date.now() - startedAt,
    errorName: error?.name ?? null,
    message: error instanceof Error ? error.message : String(error),
  };
  return {
    isError: true,
    diagnostics,
    content: [{
      type: "text",
      text: JSON.stringify({ type: "native_file_tool_execution_error", ...diagnostics }, null, 2),
    }],
  };
}

export function createFileToolHandler({
  resolveTool = getNativeFileTool,
  workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || path.join(stateDir, "workspace"),
} = {}) {
  async function executeOne(nativeToolName, args = {}) {
    const startedAt = Date.now();
    try {
      if (nativeToolName === "ls" && resolveTool === getNativeFileTool) {
        const dir = path.resolve(args.path || workspaceDir);
        const max = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 500) : 500;
        const names = (await readdir(dir)).sort();
        const selected = names.filter((name) => !args.after || name > args.after).slice(0, max);
        const entries = await Promise.all(selected.map(async (name) => {
          const info = await lstat(path.join(dir, name));
          return { name, type: info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "other", size: info.size };
        }));
        const remaining = names.some((name) => name > (selected.at(-1) ?? args.after ?? "")) && selected.length === max;
        return {
          content: [{ type: "text", text: entries.map((entry) => `${entry.type === "directory" ? "d" : "-"} ${entry.name}`).join("\n") || "(empty)" }],
          structuredContent: { path: dir, entries, ...(remaining ? { after: selected.at(-1) } : {}) },
        };
      }
      const tool = await resolveTool(nativeToolName);
      const preparedArgs = typeof tool.prepareArguments === "function"
        ? await tool.prepareArguments(args)
        : args;
      let patchSnapshots = null;
      if (nativeToolName === "apply_patch") {
        try {
          patchSnapshots = await capturePatchSnapshots(preparedArgs?.input, workspaceDir);
        } catch {}
      }
      const result = await tool.execute(randomUUID(), preparedArgs ?? {}, AbortSignal.timeout(invokeTimeoutMs));
      if (result?.isError === true) {
        return {
          isError: true,
          diagnostics: {
            stage: "native_file_tool_execution",
            nativeTool: nativeToolName,
            elapsedMs: Date.now() - startedAt,
          },
          content: resultContent(result),
        };
      }

      const nativeStructuredContent = structuredDetails(result?.details);
      let generatedPatch = null;
      if (nativeToolName === "apply_patch" && patchSnapshots) {
        try {
          generatedPatch = await buildPatchPreview(patchSnapshots);
        } catch {}
      }
      const structuredContent = {
        ...(nativeStructuredContent ?? {}),
        ...(generatedPatch ? { patch: generatedPatch } : {}),
      };
      return {
        content: resultContent(result),
        ...(Object.keys(structuredContent).length > 0 ? { structuredContent } : {}),
        diagnostics: {
          stage: "native_file_tool_execution",
          nativeTool: nativeToolName,
          elapsedMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      return errorResponse(nativeToolName, error, startedAt);
    }
  }

  function batchInputError(nativeToolName, message) {
    return {
      isError: true,
      diagnostics: { stage: "argument_validation", nativeTool: nativeToolName },
      content: [{ type: "text", text: message }],
    };
  }

  return async function handleFileTool(name, args = {}) {
    if (!fileToolNames.has(name)) return undefined;

    const nativeToolName = nativeToolNames.get(name);
    const supportsBatch = name === "openclaw_ls" || name === "openclaw_read";
    if (supportsBatch && Object.prototype.hasOwnProperty.call(args, "requests")) {
      if (Object.keys(args).some((key) => key !== "requests")) {
        return batchInputError(nativeToolName, "For batch calls, put all per-item options inside requests and do not combine requests with single-operation arguments.");
      }
      if (!Array.isArray(args.requests) || args.requests.length < 1 || args.requests.length > 5) {
        return batchInputError(nativeToolName, "requests must contain between 1 and 5 items.");
      }
      for (let index = 0; index < args.requests.length; index += 1) {
        const request = args.requests[index];
        if (!request || typeof request !== "object" || Array.isArray(request)
          || typeof request.path !== "string" || request.path.trim().length === 0) {
          return batchInputError(nativeToolName, "Each requests item must be an object with a non-empty path; invalid item at index " + index + ".");
        }
      }

      const results = await Promise.all(args.requests.map(async (request) => ({
        path: request.path,
        ...(await executeOne(nativeToolName, request)),
      })));
      const content = [];
      for (const item of results) {
        content.push({
          type: "text",
          text: "=== " + item.path + (item.isError ? " (ERROR)" : "") + " ===",
        });
        content.push(...item.content);
      }
      const failedCount = results.filter((item) => item.isError === true).length;
      return {
        ...(failedCount > 0 ? { isError: true } : {}),
        content,
        structuredContent: {
          results: results.map((item) => ({
            path: item.path,
            isError: item.isError === true,
            ...(item.structuredContent ? { details: item.structuredContent } : {}),
            ...(item.diagnostics ? { diagnostics: item.diagnostics } : {}),
          })),
        },
        diagnostics: {
          stage: "native_file_tool_batch",
          nativeTool: nativeToolName,
          requestCount: results.length,
          failedCount,
        },
      };
    }

    return executeOne(nativeToolName, args);
  };
}

export const handleFileTool = createFileToolHandler();
