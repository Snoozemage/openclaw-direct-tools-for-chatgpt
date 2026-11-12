import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectRegistry } from "../src/tools/codebase-intelligence/registry.mjs";
import { createCodebaseIntelligenceHandler } from "../src/tools/codebase-intelligence/handler.mjs";
import { codebaseIntelligenceToolDefinition } from "../src/tools/codebase-intelligence/schema.mjs";
import { toolDefinitions } from "../src/mcp/tool-definitions.mjs";
import { callBridgeTool } from "../src/mcp/tool-dispatcher.mjs";
import { mcpHandler } from "../src/mcp/sdk-server.mjs";

async function withRegistryFixture(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-intelligence-"));
  try {
    const alpha = path.join(dir, "alpha");
    const beta = path.join(dir, "beta");
    const blocked = path.join(dir, "blocked");
    for (const repo of [alpha, beta, blocked]) {
      await mkdir(path.join(repo, ".git"), { recursive: true });
    }
    const storage = path.join(dir, "storage");
    await mkdir(storage);
    const registry = createProjectRegistry({ stateRoot: storage });
    await callback({ dir, alpha, beta, blocked, storage, registry });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sample(projectId, root, overrides = {}) {
  return {
    projectId,
    name: "Training management",
    repositories: [{ id: "legacy-php", root, languages: ["php", "sql"] }],
    ...overrides,
  };
}

async function expectCode(task, code) {
  await assert.rejects(task, (error) => error?.code === code);
}

test("exposes exactly one mixed read/write MCP tool with Phase 1 actions", () => {
  const matches = toolDefinitions.filter((tool) => tool.name === "openclaw_codebase_intelligence");
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0], codebaseIntelligenceToolDefinition);
  assert.deepEqual(matches[0].annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(matches[0].inputSchema.required, ["action"]);
  assert.equal(matches[0].inputSchema.additionalProperties, false);
  assert.deepEqual(matches[0].inputSchema.properties.action.enum, ["project", "index", "status", "search", "php", "csharp", "typescript", "trace", "impact", "architecture", "docs", "compare", "match"]);
  assert.equal(matches[0].inputSchema.properties.repositories.maxItems, 12);
});

test("registry register/list/show/status persist and never read or index source", async () => withRegistryFixture(async ({ alpha, storage, registry }) => {
  const input = sample("vaa-training", alpha);
  const first = await registry.register(input);
  assert.equal(first.created, true);
  assert.equal(first.project.projectId, "vaa-training");
  assert.equal(first.project.repositories[0].root, await realpath(alpha));
  const second = await registry.register(input);
  assert.equal(second.created, false);
  const names = await registry.list();
  assert.deepEqual(names.map((item) => item.projectId), ["vaa-training"]);
  assert.equal(names[0].repositoryCount, 1);
  assert.equal((await registry.show("vaa-training")).repositories[0].id, "legacy-php");
  const status = await registry.status("vaa-training");
  assert.deepEqual(status.index, {
    state: "not_indexed",
    revision: null,
    fileCount: 0,
    message: "Phase 1 only registers projects. Indexing starts in Phase 2.",
  });
  const saved = JSON.parse(await readFile(path.join(storage, "projects.json"), "utf8"));
  assert.equal(saved.projects.length, 1);
}));

test("registers canonical Git roots and rejects missing or non-directory paths", async () => {
  await withRegistryFixture(async ({ alpha, beta, blocked, registry }) => {
    assert.equal((await registry.register(sample("vaa-blocked", blocked))).created, true);
    const nested = path.join(alpha, "nested");
    await mkdir(path.join(nested, ".git"), { recursive: true });
    assert.equal((await registry.register(sample("vaa-nested", nested))).created, true);
    await expectCode(() => registry.register(sample("vaa-missing", path.join(beta, "missing"))), "PATH_UNAVAILABLE");
    await expectCode(() => registry.register(sample("vaa-file", path.join(alpha, "file.txt"))), "PATH_UNAVAILABLE");
    assert.equal((await registry.list()).length, 2);
  });
});

test("symlink or junction registration resolves to a canonical Git root", async () => withRegistryFixture(async ({ dir, blocked, registry }) => {
  const alias = path.join(dir, "alias-of-blocked");
  try {
    await symlink(blocked, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return;
    throw error;
  }
  const result = await registry.register(sample("vaa-escape", alias));
  assert.equal(result.project.repositories[0].root, await realpath(blocked));
}));

test("missing Git metadata, invalid project registry and oversized registration fail closed", async () => withRegistryFixture(async ({ alpha, dir, storage, registry }) => {
  const notGit = path.join(dir, "not-git");
  await mkdir(notGit);
  await expectCode(() => registry.register(sample("vaa-no-git", notGit)), "PATH_UNAVAILABLE");
  const registryPath = path.join(storage, "projects.json");
  await writeFile(registryPath, "{ bad-json");
  await expectCode(() => registry.register(sample("vaa-invalid", alpha)), "INVALID_CONFIG");
  await writeFile(registryPath, JSON.stringify({ version: 1, projects: [] }));
  const tooMany = Array.from({ length: 13 }, (_, i) => ({
    id: "repo-" + i, root: alpha, languages: ["php"],
  }));
  await expectCode(() => registry.register(sample("vaa-too-many", alpha, { repositories: tooMany })), "INVALID_ARGUMENTS");
}));

test("removed Git metadata is reported as an unavailable repository", async () => withRegistryFixture(async ({ alpha, registry }) => {
  await registry.register(sample("vaa-training", alpha));
  await rm(path.join(alpha, ".git"), { recursive: true, force: true });
  const status = await registry.status("vaa-training");
  assert.deepEqual(status.repositoriesUnavailable, ["legacy-php"]);
  await expectCode(() => registry.ensureProjectAllowed("vaa-training"), "PATH_UNAVAILABLE");
}));

test("registry rejects malicious input, duplicate repos, invalid languages and conflicts", async () => withRegistryFixture(async ({ alpha, beta, registry }) => {
  await expectCode(() => registry.register(sample("../escape", alpha)), "INVALID_ARGUMENTS");
  await expectCode(() => registry.register(sample("vaa-training", alpha, { repositories: [{
    id: "one", root: alpha, languages: ["python"],
  }] })), "INVALID_ARGUMENTS");
  await expectCode(() => registry.register(sample("vaa-training", alpha, { repositories: [{
    id: "one", root: alpha, languages: ["sql"],
  }] })), "INVALID_ARGUMENTS");
  await expectCode(() => registry.register(sample("vaa-training", alpha, { repositories: [{
    id: "one", root: alpha, languages: ["php", "php"],
  }] })), "INVALID_ARGUMENTS");
  await expectCode(() => registry.register(sample("vaa-training", alpha, { repositories: [{
    id: "one", root: alpha, languages: ["php"], extra: "ignore-me",
  }] })), "INVALID_ARGUMENTS");
  await expectCode(() => registry.register(sample("vaa-training", alpha, { repositories: [
    { id: "same", root: alpha, languages: ["php"] },
    { id: "same", root: beta, languages: ["csharp"] },
  ] })), "INVALID_ARGUMENTS");
  await expectCode(() => registry.register(sample("vaa-training", alpha, { repositories: [
    { id: "one", root: alpha, languages: ["php"] },
    { id: "two", root: alpha, languages: ["csharp"] },
  ] })), "INVALID_ARGUMENTS");

  await registry.register(sample("vaa-training", alpha));
  await expectCode(() => registry.register(sample("vaa-training", beta)), "PROJECT_EXISTS");
  await expectCode(() => registry.show("other-project"), "PROJECT_NOT_FOUND");
}));

test("concurrent register calls are serialized, atomic and idempotent", async () => withRegistryFixture(async ({ alpha, beta, registry }) => {
  const batch = await Promise.all([
    registry.register(sample("vaa-alpha", alpha)),
    registry.register(sample("vaa-beta", beta, { name: "Second project" })),
    registry.register(sample("vaa-alpha", alpha)),
  ]);
  assert.equal(batch.filter((item) => item.created).length, 2);
  const list = await registry.list();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((item) => item.projectId).sort(), ["vaa-alpha", "vaa-beta"]);
}));

test("handler validates operation-specific arguments and leaves unrelated tools alone", async () => withRegistryFixture(async ({ alpha, registry }) => {
  const handler = createCodebaseIntelligenceHandler({ registry });
  assert.equal(await handler("unrelated", {}), undefined);
  assert.equal((await handler("openclaw_codebase_intelligence", { action: "index" })).structuredContent.code, "INVALID_ARGUMENTS");
  assert.equal((await handler("openclaw_codebase_intelligence", { action: "trace" })).structuredContent.code, "INVALID_ARGUMENTS");
  assert.equal((await handler("openclaw_codebase_intelligence", { action: "project" })).structuredContent.code, "INVALID_OPERATION");
  assert.equal((await handler("openclaw_codebase_intelligence", { action: "status" })).structuredContent.code, "INVALID_ARGUMENTS");
  assert.equal((await handler("openclaw_codebase_intelligence", { action: "project", operation: "list", root: alpha })).structuredContent.code, "INVALID_ARGUMENTS");

  const registered = await handler("openclaw_codebase_intelligence", { action: "project", operation: "register", ...sample("vaa-training", alpha) });
  assert.equal(registered.isError, undefined);
  assert.equal(registered.structuredContent.created, true);
  assert.equal(registered.structuredContent.project.repositories[0].id, "legacy-php");
  const listed = await handler("openclaw_codebase_intelligence", { action: "project", operation: "list" });
  assert.equal(listed.structuredContent.projects.length, 1);
  const shown = await handler("openclaw_codebase_intelligence", { action: "project", operation: "show", projectId: "vaa-training" });
  assert.equal(shown.structuredContent.project.projectId, "vaa-training");
  const status = await handler("openclaw_codebase_intelligence", { action: "status", projectId: "vaa-training" });
  assert.equal(status.structuredContent.status.index.state, "not_indexed");
}));

test("tool dispatch recognizes public tool but does not invent a missing project", async () => {
  const response = await callBridgeTool("openclaw_codebase_intelligence", { action: "status", projectId: "does-not-exist" });
  assert.equal(response.isError, true);
  assert.ok(["PROJECT_NOT_FOUND", "REGISTRY_IO_ERROR"].includes(response.structuredContent.code));
});

// Test the real MCP JSON-RPC surface in-process, without restarting the user's active bridge.
async function rpc(method, params = {}, session = "codebase-phase1-mcp-fixture") {
  const result = await mcpHandler.fetch(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-openai-session": session,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method + "-fixture", method, params }),
  }));
  const body = await result.text();
  const payload = result.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(body.split(/\r?\n/u).filter((line) => line.startsWith("data:")).at(-1).slice(5))
    : JSON.parse(body);
  return { status: result.status, payload };
}

test("real MCP tools/list and tools/call expose project and status after start_here", async () => {
  const listed = await rpc("tools/list", {}, "codebase-phase1-discovery");
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.result.tools.filter((item) => item.name === "openclaw_codebase_intelligence").length, 1);
  const exposed=listed.payload.result.tools.find(x=>x.name==="openclaw_codebase_intelligence");
  assert.ok(exposed.inputSchema.properties.action.enum.includes("docs"));
  assert.ok(exposed.inputSchema.properties.action.enum.includes("architecture"));
  assert.ok(exposed.inputSchema.properties.action.enum.includes("impact"));
  assert.ok(exposed.inputSchema.properties.operation.enum.includes("preview"));
  assert.ok(exposed.inputSchema.properties.operation.enum.includes("apply"));
  assert.equal(exposed.inputSchema.properties.approved.type,"boolean");
  assert.equal(exposed.inputSchema.properties.checkWorktree.type,"boolean");
  const session = "codebase-phase1-tool-call";
  const blocked = await rpc("tools/call", {
    name: "openclaw_codebase_intelligence", arguments: { action: "project", operation: "list" },
  }, session);
  assert.equal(blocked.payload.result.isError, true);
  await rpc("tools/call", { name: "start_here", arguments: {} }, session);
  const called = await rpc("tools/call", {
    name: "openclaw_codebase_intelligence", arguments: { action: "project", operation: "list" },
  }, session);
  assert.equal(called.status, 200);
  assert.equal(called.payload.result.isError, undefined);
  assert.equal(called.payload.result.structuredContent.operation, "list");
  assert.ok(Array.isArray(called.payload.result.structuredContent.projects));
  const unknown = await rpc("tools/call", {
    name: "openclaw_codebase_intelligence", arguments: { action: "status", projectId: "unknown-mcp-p1" },
  }, session);
  assert.equal(unknown.payload.result.isError, true);
  assert.ok(["PROJECT_NOT_FOUND", "REGISTRY_IO_ERROR"].includes(unknown.payload.result.structuredContent.code));
  const deniedApply=await rpc("tools/call",{
    name:"openclaw_codebase_intelligence",arguments:{
      action:"docs",operation:"apply",projectId:"vaa-training",
      previewId:"a".repeat(40),
    },
  },session);
  assert.equal(deniedApply.payload.result.isError,true);
  assert.equal(deniedApply.payload.result.structuredContent.code,"DOC_APPROVAL_REQUIRED");
});
