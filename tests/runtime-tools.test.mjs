import test from "node:test";
import assert from "node:assert/strict";
import { runtimeToolDefinitions } from "../src/tools/runtime/schema.mjs";
import { createRuntimeToolHandler } from "../src/tools/runtime/handler.mjs";

test("exec and process expose independent native runtime tool schemas", () => {
  assert.deepEqual(runtimeToolDefinitions.map((tool) => tool.name), ["openclaw_exec", "openclaw_process"]);
  const exec = runtimeToolDefinitions[0];
  const process = runtimeToolDefinitions[1];
  assert.ok(exec.inputSchema.required.includes("command"));
  assert.ok(exec.inputSchema.properties.workdir);
  assert.ok(exec.inputSchema.properties.pty);
  assert.match(exec.description, /Use for builds, tests, Git, package managers, and other development commands\. Always set background: true when launching a GUI application/u);
  assert.match(exec.inputSchema.properties.background.description, /Start an independent background process that survives the request\. Set true when launching a GUI app/u);
  assert.deepEqual(process.inputSchema.properties.action.enum, ["list", "poll", "log", "write", "send-keys", "submit", "paste", "kill", "clear", "remove"]);
  assert.ok(process.inputSchema.required.includes("action"));
  assert.equal(exec.annotations.destructiveHint, true);
  assert.equal(process.annotations.destructiveHint, true);
});

test("runtime handler prepares native arguments, executes the selected tool, and returns output", async () => {
  const calls = [];
  const handler = createRuntimeToolHandler({
    resolveTool: async (name) => ({
      prepareArguments: async (args) => ({ ...args, prepared: true }),
      execute: async (_id, args, signal) => {
        calls.push({ name, args, aborted: signal.aborted });
        return { content: [{ type: "text", text: "ok" }], details: { status: "completed", exitCode: 0 } };
      },
    }),
  });
  const result = await handler("openclaw_exec", { command: "node --version" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "exec");
  assert.equal(calls[0].args.prepared, true);
  assert.equal(calls[0].args.command, "node --version");
  assert.equal(result.content[0].text, "ok");
  assert.equal(result.structuredContent.exitCode, 0);
  assert.equal(result.diagnostics.nativeTool, "exec");
});

test("runtime handler preserves native errors and ignores unrelated tool names", async () => {
  const handler = createRuntimeToolHandler({
    resolveTool: async () => ({ execute: async () => ({ isError: true, content: [{ type: "text", text: "denied" }] }) }),
  });
  assert.equal(await handler("openclaw_browser", {}), undefined);
  const result = await handler("openclaw_process", { action: "list" });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "denied");
});
