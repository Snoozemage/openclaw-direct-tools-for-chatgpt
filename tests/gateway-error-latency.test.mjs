import test from "node:test";
import assert from "node:assert/strict";
import { invokeGatewayTool, shouldCollectGatewayErrorLogs } from "../src/openclaw-client.mjs";

test("gateway errors return without waiting for diagnostics by default", async () => {
  const previous = process.env.OPENCLAW_BRIDGE_ERROR_LOGS;
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.OPENCLAW_BRIDGE_ERROR_LOGS;
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return new Response(JSON.stringify({
        ok: false,
        error: { type: "tool_error", message: "tool execution failed" },
      }), { status: 500, headers: { "content-type": "application/json" } });
    };
    const startedAt = Date.now();
    const result = await invokeGatewayTool("browser", {
      action: "act", kind: "click", targetId: "t-test",
    });
    assert.equal(fetches, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error.httpStatus, 500);
    assert.equal(result.error.message, "tool execution failed");
    assert.equal(result.error.gatewayLogContext, undefined);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.OPENCLAW_BRIDGE_ERROR_LOGS;
    else process.env.OPENCLAW_BRIDGE_ERROR_LOGS = previous;
  }
});

test("Gateway log collection requires explicit opt-in", () => {
  assert.equal(shouldCollectGatewayErrorLogs({}), false);
  assert.equal(shouldCollectGatewayErrorLogs({ OPENCLAW_BRIDGE_ERROR_LOGS: "false" }), false);
  assert.equal(shouldCollectGatewayErrorLogs({ OPENCLAW_BRIDGE_ERROR_LOGS: "1" }), true);
});
