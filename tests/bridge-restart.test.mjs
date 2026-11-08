import test from "node:test";
import assert from "node:assert/strict";
import { createBridgeRestartController } from "../src/bridge-restart.mjs";
import { createBridgeRestartToolHandler } from "../src/tools/bridge-restart/handler.mjs";
import { bridgeRestartToolDefinition } from "../src/tools/bridge-restart/schema.mjs";
import { callBridgeTool } from "../src/mcp/tool-dispatcher.mjs";

test("restart refuses an unsupervised bridge without scheduling shutdown", () => {
  let scheduled = 0;
  const controller = createBridgeRestartController({
    isSupervised: () => false,
    schedule: () => { scheduled++; },
  });
  controller.bindShutdown(() => {});
  assert.deepEqual(controller.request(), {
    statusCode: 503,
    body: { error: "Bridge restart requires an active bridge supervisor." },
  });
  assert.equal(scheduled, 0);
});

test("restart schedules one shutdown only and preserves Gateway/Tunnel", () => {
  let shutdown = null;
  let count = 0;
  const controller = createBridgeRestartController({
    isSupervised: () => true,
    schedule: (callback) => { shutdown = callback; count++; },
    getPid: () => 12345,
  });
  let stopped = 0;
  controller.bindShutdown(() => { stopped++; });
  const response = controller.request();
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.status, "scheduled");
  assert.equal(response.body.previousPid, 12345);
  assert.match(response.body.message, /Gateway and Tunnel are not managed/u);
  assert.equal(count, 1);
  assert.equal(stopped, 0);
  assert.equal(controller.request().statusCode, 409);
  assert.equal(count, 1);
  shutdown();
  assert.equal(stopped, 1);
});

test("restart reports absent shutdown hook and failed scheduling", () => {
  const missing = createBridgeRestartController({ isSupervised: () => true });
  assert.equal(missing.request().statusCode, 503);
  const failing = createBridgeRestartController({
    isSupervised: () => true,
    schedule: () => { throw new Error("scheduler offline"); },
  });
  failing.bindShutdown(() => {});
  assert.equal(failing.request().statusCode, 500);
  assert.equal(failing.request().statusCode, 500);
});

test("new MCP restart tool exposes a stable, parameter-free interface", async () => {
  assert.equal(bridgeRestartToolDefinition.name, "openclaw_bridge_restart");
  assert.deepEqual(bridgeRestartToolDefinition.inputSchema.required ?? [], []);
  assert.equal(bridgeRestartToolDefinition.inputSchema.additionalProperties, false);
  const controller = createBridgeRestartController({ isSupervised: () => false });
  const handler = createBridgeRestartToolHandler({ controller });
  assert.equal(await handler("another_tool"), undefined);
  const response = await handler("openclaw_bridge_restart");
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.httpStatus, 503);
  assert.equal(response.structuredContent.error, "Bridge restart requires an active bridge supervisor.");
});

test("MCP dispatcher routes restart to its dedicated handler", async () => {
  const response = await callBridgeTool("openclaw_bridge_restart", {});
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.httpStatus, 503);
});
