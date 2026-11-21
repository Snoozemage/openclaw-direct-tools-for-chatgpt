import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileToolDefinitions } from "../src/tools/files/schema.mjs";
import { createFileToolHandler } from "../src/tools/files/handler.mjs";
import { toolDefinitions } from "../src/mcp/tool-definitions.mjs";

const nativeNames = new Map([
  ["openclaw_ls", "ls"],
  ["openclaw_read", "read"],
  ["openclaw_edit", "edit"],
  ["openclaw_write", "write"],
  ["openclaw_apply_patch", "apply_patch"],
]);

test("file tools expose five independent schemas with native parameter contracts", () => {
  assert.deepEqual(fileToolDefinitions.map((tool) => tool.name), [...nativeNames.keys()]);
  for (const tool of fileToolDefinitions) {
    assert.ok(tool.inputSchema.properties);
    assert.match(tool.description, /OpenClaw|native/i);
    assert.ok(toolDefinitions.some((registered) => registered.name === tool.name));
  }

  const read = fileToolDefinitions.find((tool) => tool.name === "openclaw_read");
  assert.deepEqual(read.inputSchema.oneOf.map((branch) => branch.required), [["path"], ["requests"]]);
  assert.equal(read.inputSchema.properties.offset.minimum, 1);
  assert.equal(read.inputSchema.properties.cursor.minimum, 0);
  assert.equal(read.inputSchema.properties.optional.const, true);

  for (const name of ["openclaw_ls", "openclaw_read"]) {
    const requests = fileToolDefinitions.find((tool) => tool.name === name).inputSchema.properties.requests;
    assert.equal(requests.minItems, 1);
    assert.equal(requests.maxItems, 5);
    assert.deepEqual(requests.items.required, ["path"]);
  }

  const edit = fileToolDefinitions.find((tool) => tool.name === "openclaw_edit");
  assert.deepEqual(edit.inputSchema.required, ["path", "edits"]);
  assert.deepEqual(edit.inputSchema.properties.edits.items.required, ["oldText", "newText"]);

  assert.deepEqual(fileToolDefinitions.find((tool) => tool.name === "openclaw_write").inputSchema.required, ["path", "content"]);
  assert.deepEqual(fileToolDefinitions.find((tool) => tool.name === "openclaw_apply_patch").inputSchema.required, ["input"]);
});

test("each public file tool prepares arguments when required, then calls its native executor", async () => {
  const calls = [];
  const preparations = [];
  const handler = createFileToolHandler({
    resolveTool: async (nativeName) => ({
      prepareArguments: (args) => {
        preparations.push(nativeName);
        return { ...args, preparedBy: nativeName };
      },
      execute: async (callId, args, signal) => {
        calls.push({ nativeName, callId, args, signal });
        return { content: [{ type: "text", text: "ok" }], details: { nativeName, content: "duplicate output", nextAfter: "cursor" } };
      },
    }),
  });

  const sampleArgs = {
    openclaw_ls: { path: "C:\\repo", limit: 23, after: "file-a" },
    openclaw_read: { path: "C:\\repo\\README.md", offset: 4, limit: 20 },
    openclaw_edit: { path: "src\\app.mjs", edits: [{ oldText: "old", newText: "new" }] },
    openclaw_write: { path: "notes.txt", content: "complete content" },
    openclaw_apply_patch: { input: "*** Begin Patch\n*** End Patch" },
  };

  for (const [publicName, args] of Object.entries(sampleArgs)) {
    const result = await handler(publicName, args);
    assert.equal(result.content[0].text, "ok");
    assert.deepEqual(result.structuredContent, { nativeName: nativeNames.get(publicName), nextAfter: "cursor" });
    assert.equal(result.diagnostics.nativeTool, nativeNames.get(publicName));
  }

  assert.deepEqual(preparations, [...nativeNames.values()]);
  assert.deepEqual(calls.map(({ nativeName, args }) => ({ nativeName, args })), Object.entries(sampleArgs).map(([publicName, args]) => ({
    nativeName: nativeNames.get(publicName),
    args: { ...args, preparedBy: nativeNames.get(publicName) },
  })));
  for (const call of calls) {
    assert.match(call.callId, /^[0-9a-f-]{36}$/i);
    assert.ok(call.signal instanceof AbortSignal);
  }
});

test("edit and write preserve native unified patch metadata", async () => {
  const patch = "--- before.txt\n+++ after.txt\n@@ -1 +1 @@\n-old\n+new\n";
  const handler = createFileToolHandler({
    resolveTool: async () => ({
      execute: async () => ({
        content: [{ type: "text", text: "File updated successfully." }],
        details: { changed: true, diff: "-1 old\\n+1 new", patch, content: "duplicate" },
      }),
    }),
  });

  for (const [name, args] of [
    ["openclaw_edit", { path: "test.txt", edits: [{ oldText: "old", newText: "new" }] }],
    ["openclaw_write", { path: "test.txt", content: "new" }],
  ]) {
    const result = await handler(name, args);
    assert.equal(result.structuredContent.patch, patch);
    assert.equal(result.structuredContent.diff, "-1 old\\n+1 new");
    assert.equal("content" in result.structuredContent, false);
  }
});

test("apply_patch returns a unified diff of the file contents before and after the patch", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-patch-preview-"));
  const filePath = path.join(workspaceDir, "patched.txt");
  await writeFile(filePath, "before\nremoved\nsame\n", "utf8");

  try {
    const handler = createFileToolHandler({
      workspaceDir,
      resolveTool: async () => ({
        execute: async () => {
          await writeFile(filePath, "after\nadded\nsame\n", "utf8");
          return {
            content: [{ type: "text", text: "Success. Updated the following files: M patched.txt" }],
            details: { summary: { added: [], modified: ["patched.txt"], deleted: [] } },
          };
        },
      }),
    });
    const result = await handler("openclaw_apply_patch", {
      input: "*** Begin Patch\n*** Update File: patched.txt\n@@\n-before\n-removed\n+after\n+added\n*** End Patch",
    });

    assert.match(result.structuredContent.patch, /^--- /m);
    assert.match(result.structuredContent.patch, /^\+\+\+ /m);
    assert.match(result.structuredContent.patch, /^@@ [-+]/m);
    assert.match(result.structuredContent.patch, /^\-before$/m);
    assert.match(result.structuredContent.patch, /^\+after$/m);
    assert.match(result.structuredContent.patch, /^\-removed$/m);
    assert.match(result.structuredContent.patch, /^\+added$/m);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("read resolves file and parent-directory symlinks before invoking the native reader", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-read-link-"));
  try {
    await mkdir(path.join(workspaceDir, "real"));
    const file = path.join(workspaceDir, "real", "file.txt");
    await writeFile(file, "one\ntwo\n", "utf8");
    await symlink("real", path.join(workspaceDir, "linked-dir"));
    await symlink("linked-dir/file.txt", path.join(workspaceDir, "linked-file.txt"));
    const canonicalPath = await realpath(file);
    const prepared = [];
    const handler = createFileToolHandler({
      workspaceDir,
      resolveTool: async () => ({
        prepareArguments: (args) => {
          prepared.push(args);
          return args;
        },
        execute: async (_callId, args) => ({ content: [{ type: "text", text: args.path }] }),
      }),
    });

    const result = await handler("openclaw_read", {
      requests: [
        { path: "linked-file.txt", offset: 2, limit: 3 },
        { path: "linked-dir/file.txt", offset: 1, limit: 2 },
        { path: "real/file.txt", offset: 1, limit: 5 },
      ],
    });
    assert.equal(result.isError, undefined);
    // Batch requests run concurrently; native invocation order is unspecified.
    assert.deepEqual(prepared.sort((left, right) => left.limit - right.limit), [
      { path: canonicalPath, offset: 1, limit: 2 },
      { path: canonicalPath, offset: 2, limit: 3 },
      { path: "real/file.txt", offset: 1, limit: 5 },
    ]);
    assert.deepEqual(result.structuredContent.results.map(({ path }) => path), [
      "linked-file.txt", "linked-dir/file.txt", "real/file.txt",
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("read preserves missing paths and rejects symlink loops without invoking native read", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-read-broken-link-"));
  try {
    await symlink("missing.txt", path.join(workspaceDir, "broken.txt"));
    await symlink("loop.txt", path.join(workspaceDir, "loop.txt"));
    const paths = [];
    const handler = createFileToolHandler({
      workspaceDir,
      resolveTool: async () => ({
        execute: async (_callId, args) => {
          paths.push(args.path);
          return { isError: true, content: [{ type: "text", text: "not found" }] };
        },
      }),
    });
    const broken = await handler("openclaw_read", { path: "broken.txt", optional: true });
    assert.equal(broken.isError, true);
    assert.deepEqual(paths, ["broken.txt"]);
    const loop = await handler("openclaw_read", { path: "loop.txt" });
    assert.equal(loop.isError, true);
    assert.match(loop.content[0].text, /ELOOP|too many levels/i);
    assert.deepEqual(paths, ["broken.txt"]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("read forwards native image content without dropping image blocks", async () => {
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const handler = createFileToolHandler({
    resolveTool: async () => ({ execute: async () => ({ content: [{ type: "text", text: "image read" }, image] }) }),
  });
  const result = await handler("openclaw_read", { path: "image.png" });
  assert.deepEqual(result.content, [{ type: "text", text: "image read" }, image]);
});

test("read batch forwards independent per-file line ranges and labels each result", async () => {
  const calls = [];
  const handler = createFileToolHandler({
    resolveTool: async (nativeName) => ({
      prepareArguments: (args) => ({ ...args }),
      execute: async (_callId, args) => {
        calls.push({ nativeName, args });
        return {
          content: [{ type: "text", text: "read " + args.path + " at " + args.offset + " limit " + args.limit }],
          details: { path: args.path, offset: args.offset, limit: args.limit, content: "duplicate" },
        };
      },
    }),
  });

  const result = await handler("openclaw_read", {
    requests: [
      { path: "src/a.mjs", offset: 10, limit: 5 },
      { path: "src/b.mjs", offset: 40, limit: 8 },
    ],
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.diagnostics.stage, "native_file_tool_batch");
  assert.equal(result.diagnostics.requestCount, 2);
  assert.equal(result.diagnostics.failedCount, 0);
  assert.deepEqual(result.structuredContent.results.map(({ path, isError, details }) => ({ path, isError, details })), [
    { path: "src/a.mjs", isError: false, details: { path: "src/a.mjs", offset: 10, limit: 5 } },
    { path: "src/b.mjs", isError: false, details: { path: "src/b.mjs", offset: 40, limit: 8 } },
  ]);
  assert.deepEqual(result.content.filter((item) => item.type === "text").map((item) => item.text), [
    "=== src/a.mjs ===",
    "read src/a.mjs at 10 limit 5",
    "=== src/b.mjs ===",
    "read src/b.mjs at 40 limit 8",
  ]);
  assert.deepEqual(calls.map(({ nativeName, args }) => ({ nativeName, path: args.path, offset: args.offset, limit: args.limit })).sort((a, b) => a.path.localeCompare(b.path)), [
    { nativeName: "read", path: "src/a.mjs", offset: 10, limit: 5 },
    { nativeName: "read", path: "src/b.mjs", offset: 40, limit: 8 },
  ]);
});

test("ls batch returns per-directory results and preserves partial failures", async () => {
  const calls = [];
  const handler = createFileToolHandler({
    resolveTool: async (nativeName) => ({
      execute: async (_callId, args) => {
        calls.push({ nativeName, args });
        if (args.path === "missing/") {
          return { isError: true, content: [{ type: "text", text: "directory not found" }] };
        }
        return { content: [{ type: "text", text: "listed " + args.path }], details: { nextAfter: args.after ?? null } };
      },
    }),
  });

  const result = await handler("openclaw_ls", {
    requests: [
      { path: "src/", limit: 20 },
      { path: "missing/", after: "last-entry" },
    ],
  });

  assert.equal(result.isError, true);
  assert.equal(result.diagnostics.requestCount, 2);
  assert.equal(result.diagnostics.failedCount, 1);
  assert.deepEqual(result.structuredContent.results.map(({ path, isError }) => ({ path, isError })), [
    { path: "src/", isError: false },
    { path: "missing/", isError: true },
  ]);
  assert.deepEqual(calls.map(({ nativeName, args }) => ({ nativeName, args })), [
    { nativeName: "ls", args: { path: "src/", limit: 20 } },
    { nativeName: "ls", args: { path: "missing/", after: "last-entry" } },
  ]);
  assert.ok(result.content.some((item) => item.text === "=== missing/ (ERROR) ==="));
  assert.ok(result.content.some((item) => item.text === "directory not found"));
});

test("batch rejects more than five items and mixed single/batch arguments before execution", async () => {
  const handler = createFileToolHandler({
    resolveTool: async () => assert.fail("invalid batch must not execute"),
  });

  const tooMany = await handler("openclaw_read", {
    requests: Array.from({ length: 6 }, (_, index) => ({ path: "file-" + index + ".txt" })),
  });
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.content[0].text, /between 1 and 5/);

  const conflicting = await handler("openclaw_ls", {
    path: "src/",
    requests: [{ path: "tests/" }],
  });
  assert.equal(conflicting.isError, true);
  assert.match(conflicting.content[0].text, /do not combine requests/);
});

test("native executor errors are returned as MCP errors with diagnostics", async () => {
  const handler = createFileToolHandler({
    resolveTool: async () => {
      throw new Error("OpenClaw runtime unavailable");
    },
  });
  const result = await handler("openclaw_ls", { path: "." });
  assert.equal(result.isError, true);
  assert.equal(result.diagnostics.stage, "native_file_tool_execution");
  assert.equal(result.diagnostics.nativeTool, "ls");
  assert.match(result.content[0].text, /OpenClaw runtime unavailable/);
});

test("native tool failures stay MCP errors and preserve native content", async () => {
  const handler = createFileToolHandler({
    resolveTool: async () => ({
      execute: async () => ({
        isError: true,
        content: [{ type: "text", text: "Path does not exist" }],
      }),
    }),
  });
  const result = await handler("openclaw_read", { path: "missing.txt" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Path does not exist/);
});

test("file handler leaves unrelated tool names untouched", async () => {
  const handler = createFileToolHandler({ resolveTool: async () => assert.fail("must not resolve a tool") });
  assert.equal(await handler("openclaw_browser", { action: "snapshot" }), undefined);
});
