import test from "node:test";
import assert from "node:assert/strict";
import { computerToolDefinition, COMPUTER_ACTIONS, MAX_COMPUTER_BATCH_ACTIONS } from "../src/tools/computer/schema.mjs";
import { createComputerToolHandler } from "../src/tools/computer/handler.mjs";

const fakeInvoker = (calls, result = { content: [] }) => async (...args) => {
  calls.push(args);
  return result;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("computer schema documents the snapshot-linked execution lifecycle", () => {
  const schema = computerToolDefinition.inputSchema;
  assert.equal(computerToolDefinition.name, "openclaw_computer");
  assert.deepEqual(schema.properties.action.enum, [...COMPUTER_ACTIONS]);
  assert.deepEqual(schema.required, ["action"]);
  assert.equal(schema.additionalProperties, true);
  assert.match(computerToolDefinition.description, /desktop UI, not browser DOM/i);
  assert.match(computerToolDefinition.description, /close_execution/i);
  assert.match(computerToolDefinition.description, /displayFrameId/i);
  assert.match(schema.properties.displayFrameId.description, /fresh snapshot after the screen changes/i);
  assert.ok(schema.properties.keys);
  assert.ok(schema.properties.windowRef);
  assert.match(schema.properties.executionId.pattern, /[0-9a-fA-F]/i);
  assert.ok(COMPUTER_ACTIONS.includes("close_execution"));
});

test("snapshot creates and forwards one executionId with only snapshot parameters", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const result = await handle("openclaw_computer", {
    action: "snapshot",
    screenIndex: 1,
    maxWidth: 1200,
    format: "png",
    x: 30,
    timeoutMs: 5000,
  }, {
    node: "snapshot-test-node",
    invokeNodeCommand: fakeInvoker(calls),
  });

  assert.deepEqual(result, { content: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "snapshot-test-node");
  assert.equal(calls[0][1], "screen.snapshot");
  assert.deepEqual(calls[0][2].screenIndex, 1);
  assert.deepEqual(calls[0][2].maxWidth, 1200);
  assert.deepEqual(calls[0][2].format, "png");
  assert.deepEqual(Object.keys(calls[0][2]).sort(), ["executionId", "format", "maxWidth", "screenIndex"].sort());
  assert.match(calls[0][2].executionId, UUID_V4);
  assert.equal(calls[0][3], 5000);
  assert.deepEqual(calls[0][4], { executionId: calls[0][2].executionId });
});

test("snapshot preserves vision image content and adds a short screenshot_ref for optional rendering", async () => {
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" };
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const result = await handle("openclaw_computer", { action: "snapshot" }, {
    node: "screenshot-ref-node",
    invokeNodeCommand: async () => ({ content: [{ type: "text", text: "snapshot complete" }, image] }),
  });

  assert.equal(result.content[1], image);
  assert.match(result.content[0].text, /Screenshot reference for optional UI rendering: scr_[a-f0-9]{24}/);
  assert.equal(result.content[0].text.split("\n").length, 2);
  assert.match(result.structuredContent.screenshot_ref, /^scr_[a-f0-9]{24}$/);
});

test("computer actions reuse the snapshot executionId and filter action-specific parameters", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const invoke = fakeInvoker(calls);
  await handle("openclaw_computer", { action: "snapshot" }, { node: "shared-node", invokeNodeCommand: invoke });
  const executionId = calls[0][2].executionId;

  await handle("openclaw_computer", {
    action: "left_click",
    x: 320,
    y: 180,
    windowRef: "window-1",
    displayFrameId: "frame-from-latest-snapshot",
    timeoutMs: 8000,
    text: "must not leak into click payload",
  }, { node: "shared-node", invokeNodeCommand: invoke });

  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], "computer.act");
  assert.deepEqual(calls[1][2], {
    action: "left_click",
    windowRef: "window-1",
    displayFrameId: "frame-from-latest-snapshot",
    x: 320,
    y: 180,
    executionId,
  });
  assert.equal(calls[1][3], 8000);
  assert.deepEqual(calls[1][4], { executionId, refWidth: undefined });
});

test("standalone computer actions receive an executionId instead of failing native validation", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  await handle("openclaw_computer", { action: "list_apps" }, {
    node: "list-apps-node",
    invokeNodeCommand: fakeInvoker(calls),
  });

  assert.equal(calls[0][1], "computer.act");
  assert.equal(calls[0][2].action, "list_apps");
  assert.match(calls[0][2].executionId, UUID_V4);
  assert.equal(calls[0][4].executionId, calls[0][2].executionId);
});

test("close_execution uses OpenClaw's internal close command and releases the active id", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const invoke = fakeInvoker(calls);
  await handle("openclaw_computer", { action: "snapshot" }, { node: "close-test-node", invokeNodeCommand: invoke });
  const firstId = calls[0][2].executionId;

  await handle("openclaw_computer", { action: "close_execution" }, { node: "close-test-node", invokeNodeCommand: invoke });
  assert.equal(calls[1][1], "computer.act");
  assert.deepEqual(calls[1][2], {
    action: "__close_execution",
    executionId: firstId,
    reason: "bridge-client-close",
  });

  await handle("openclaw_computer", { action: "snapshot" }, { node: "close-test-node", invokeNodeCommand: invoke });
  assert.notEqual(calls[2][2].executionId, firstId);
});

test("an explicit different executionId closes the previous bridge-owned execution first", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const invoke = fakeInvoker(calls);
  await handle("openclaw_computer", { action: "snapshot" }, { node: "replace-test-node", invokeNodeCommand: invoke });
  const oldId = calls[0][2].executionId;
  const newId = "123e4567-e89b-42d3-a456-426614174000";

  await handle("openclaw_computer", { action: "snapshot", executionId: newId }, { node: "replace-test-node", invokeNodeCommand: invoke });
  assert.deepEqual(calls[1][2], {
    action: "__close_execution",
    executionId: oldId,
    reason: "bridge-execution-replaced",
  });
  assert.equal(calls[2][2].executionId, newId);
});

test("idle computer executions are closed automatically", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 15 });
  await handle("openclaw_computer", { action: "snapshot" }, {
    node: "idle-test-node",
    invokeNodeCommand: fakeInvoker(calls),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], "computer.act");
  assert.deepEqual(calls[1][2], {
    action: "__close_execution",
    executionId: calls[0][2].executionId,
    reason: "bridge-idle-timeout",
  });
});

test("invalid execution IDs and unknown actions fail before invoking the node", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const deps = { node: "validation-node", invokeNodeCommand: fakeInvoker(calls) };

  const badId = await handle("openclaw_computer", { action: "snapshot", executionId: "not-a-uuid" }, deps);
  assert.equal(badId.isError, true);
  assert.match(badId.content[0].text, /executionId must be the UUID/);

  const unknown = await handle("openclaw_computer", { action: "run_shell" }, deps);
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unsupported desktop action/);
  assert.equal(calls.length, 0);
});

test("computer batch schema documents sequential actions and limits", () => {
  const schema = computerToolDefinition.inputSchema;
  assert.ok(schema.properties.action.enum.includes("batch"));
  assert.equal(schema.properties.actions.minItems, 1);
  assert.equal(schema.properties.actions.maxItems, MAX_COMPUTER_BATCH_ACTIONS);
  assert.equal(MAX_COMPUTER_BATCH_ACTIONS, 5);
  assert.match(schema.properties.actions.description, /1–5 steps/);
  assert.match(schema.properties.actions.description, /observing the UI/);
  assert.ok(schema.properties.actions.items.properties.action.enum.includes("snapshot"));
  assert.ok(!schema.properties.actions.items.properties.action.enum.includes("batch"));
  assert.ok(!schema.properties.actions.items.properties.action.enum.includes("close_execution"));
  assert.match(schema.properties.stopOnError.description, /Defaults to true/);
});

test("batch sends actions sequentially in one handler call and reuses one execution", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const invoke = async (...args) => {
    calls.push(args);
    return { content: [{ type: "text", text: "ok-" + args[2].action }] };
  };

  await handle("openclaw_computer", {
    action: "snapshot",
    maxWidth: 960,
    format: "jpeg",
  }, { node: "batch-node", invokeNodeCommand: invoke });
  const result = await handle("openclaw_computer", {
    action: "batch",
    actions: [
      { action: "left_click", x: 200, y: 100, displayFrameId: "frame-1" },
      { action: "type", text: "die with a smile" },
      { action: "key", keys: "ENTER" },
      { action: "key", keys: "TAB" },
      { action: "key", keys: "ENTER" },
    ],
  }, { node: "batch-node", invokeNodeCommand: invoke });

  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((call) => call[1]), [
    "screen.snapshot",
    "computer.act", "computer.act", "computer.act", "computer.act", "computer.act",
  ]);
  const executionId = calls[0][2].executionId;
  assert.match(executionId, UUID_V4);
  assert.ok(calls.every((call) => call[2].executionId === executionId));
  assert.deepEqual(calls[1][2], {
    action: "left_click",
    displayFrameId: "frame-1",
    x: 200,
    y: 100,
    executionId,
  });
  assert.equal(calls[2][2].text, "die with a smile");
  assert.equal(calls[3][2].keys, "ENTER");
  assert.equal(calls[4][2].keys, "TAB");
  assert.equal(calls[5][2].keys, "ENTER");
  assert.match(result.content[0].text, /5\/5 actions executed; 5 succeeded, 0 failed/);
  assert.equal(result.structuredContent.results.length, 5);
  assert.equal(result.isError, undefined);
});

test("batch stops at the first error by default and returns partial results", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const invoke = async (...args) => {
    calls.push(args);
    if (args[2].action === "type") return { isError: true, content: [{ type: "text", text: "native failure" }] };
    return { content: [{ type: "text", text: "ok" }] };
  };

  const result = await handle("openclaw_computer", {
    action: "batch",
    actions: [
      { action: "left_click", x: 1, y: 2 },
      { action: "type", text: "fail" },
      { action: "key", keys: "ENTER" },
    ],
  }, { node: "batch-failure-node", invokeNodeCommand: invoke });

  assert.equal(calls.length, 2);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.results.length, 2);
  assert.equal(result.structuredContent.results[1].isError, true);
  assert.match(result.content[0].text, /2\/3 actions executed; 1 succeeded, 1 failed/);
});

test("batch validates the full action list before performing any side effects", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const deps = { node: "batch-validation-node", invokeNodeCommand: fakeInvoker(calls) };

  const closeResult = await handle("openclaw_computer", {
    action: "batch",
    actions: [
      { action: "left_click", x: 1, y: 2 },
      { action: "close_execution" },
    ],
  }, deps);
  assert.equal(closeResult.isError, true);
  assert.match(closeResult.content[0].text, /close_execution cannot run inside a batch/);
  assert.equal(calls.length, 0);

  const midBatchSnapshot = await handle("openclaw_computer", {
    action: "batch",
    actions: [
      { action: "snapshot" },
      { action: "left_click", x: 1, y: 2 },
    ],
  }, deps);
  assert.equal(midBatchSnapshot.isError, true);
  assert.match(midBatchSnapshot.content[0].text, /snapshot can only be the final batch action/);
  assert.equal(calls.length, 0);

  const oversized = await handle("openclaw_computer", {
    action: "batch",
    actions: Array.from({ length: 6 }, () => ({ action: "key", keys: "ENTER" })),
  }, deps);
  assert.equal(oversized.isError, true);
  assert.match(oversized.content[0].text, /between 1 and 5/);
  assert.equal(calls.length, 0);
});

test("batch can continue after failures when stopOnError is false", async () => {
  const calls = [];
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const invoke = async (...args) => {
    calls.push(args);
    return args[2].action === "type"
      ? { isError: true, content: [{ type: "text", text: "failed" }] }
      : { content: [{ type: "text", text: "ok" }] };
  };

  const result = await handle("openclaw_computer", {
    action: "batch",
    stopOnError: false,
    actions: [
      { action: "type", text: "first" },
      { action: "key", keys: "ENTER" },
    ],
  }, { node: "batch-continue-node", invokeNodeCommand: invoke });

  assert.equal(calls.length, 2);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.results.length, 2);
  assert.equal(result.structuredContent.results[1].isError, false);
});

test("other tool names are ignored by the computer handler", async () => {
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  assert.equal(await handle("openclaw_browser", { action: "snapshot" }), undefined);
});
