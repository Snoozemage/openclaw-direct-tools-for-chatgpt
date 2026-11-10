import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createScreenBorderController, createCuaBorderLifecycle } from "../src/monitor/screen-border.mjs";
import { createComputerToolHandler } from "../src/tools/computer/handler.mjs";

function fixture() {
  let clock = 0, beat;
  const children = [], messages = [];
  const controller = createScreenBorderController({
    platform: "win32", now: () => clock, leaseMs: 100,
    interval: fn => { beat = fn; return { unref() {} }; }, cancelInterval: () => { beat = undefined; },
    timeout: () => ({ unref() {} }), cancelTimeout() {},
    spawn: (command, args) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin.on("data", data => messages.push(data.toString()));
      child.stdin.on("finish", () => child.emit("exit", 0));
      child.kill = () => child.emit("exit", 0);
      children.push({ child, command, args });
      return child;
    },
  });
  return { controller, children, messages, tick(ms) { clock += ms; beat?.(); } };
}

test("border stays across action gaps and concurrent sessions until the last close", () => {
  const f = fixture();
  f.controller.open("a");
  f.controller.open("b");
  assert.equal(f.children.length, 1);
  assert.ok(f.messages.includes("active\n"));
  f.children[0].child.stdout.write('{"event":"ready","windowCount":4}\n');
  assert.equal(f.controller.getStatus().ready, true);
  f.controller.close("a");
  assert.equal(f.controller.getStatus().active, true);
  f.controller.close("b");
  assert.equal(f.controller.getStatus().active, false);
  assert.equal(f.controller.getStatus().helperRunning, false);
  assert.ok(f.messages.includes("stop\n"));
});

test("idle expiry and explicit shutdown close the renderer", () => {
  const f = fixture();
  f.controller.open("a");
  f.tick(50);
  f.controller.open("a");
  f.tick(60);
  assert.equal(f.controller.getStatus().active, true);
  f.tick(41);
  assert.equal(f.controller.getStatus().active, false);
  f.controller.open("b");
  f.controller.dispose();
  assert.equal(f.controller.getStatus().sessionCount, 0);
});

test("a renderer failure is reported without an automatic restart loop", () => {
  const f = fixture();
  f.controller.open("a");
  f.children[0].child.emit("error", new Error("renderer unavailable"));
  f.tick(1);
  assert.equal(f.children.length, 1);
  assert.match(f.controller.getStatus().error, /unavailable/);
  assert.equal(f.controller.getStatus().helperRunning, false);
  f.controller.dispose();
});

test("CUA sessions retain the border between calls and clear on end or transport loss", async () => {
  const f = fixture(), lifecycle = createCuaBorderLifecycle(f.controller);
  await lifecycle.run("cua-driver__start_session", { session: "one" }, async () => ({ content: [] }));
  assert.equal(f.controller.getStatus().sessionCount, 1);
  await lifecycle.run("cua-driver__get_agent_cursor_state", { session: "one" }, async () => ({ content: [] }));
  assert.equal(f.controller.getStatus().sessionCount, 1);
  await lifecycle.run("cua-driver__start_session", { session: "two" }, async () => ({ content: [] }));
  assert.deepEqual(lifecycle.activeSessions(), ["one", "two"]);
  await lifecycle.run("cua-driver__end_session", { session: "one" }, async () => ({ content: [] }));
  assert.deepEqual(lifecycle.activeSessions(), ["two"]);
  assert.equal(f.controller.getStatus().sessionCount, 1);
  await assert.rejects(lifecycle.run("cua-driver__click", { session: "two" }, async () => { throw new Error("disconnected"); }), /disconnected/);
  assert.equal(f.controller.getStatus().active, false);
  assert.deepEqual(lifecycle.activeSessions(), ["two"], "failed input must not lose the session needed for manual close");
  await lifecycle.run("cua-driver__end_session", { session: "two" }, async () => ({ content: [] }));
  assert.deepEqual(lifecycle.activeSessions(), []);
  lifecycle.clear();
  assert.deepEqual(lifecycle.activeSessions(), []);
});

test("refused CUA work never leaves a persistent border", async () => {
  const f = fixture(), lifecycle = createCuaBorderLifecycle(f.controller);
  await lifecycle.run("cua-driver__start_session", { session: "blocked" }, async () => ({ isError: true }));
  assert.equal(f.controller.getStatus().active, false);
});

test("legacy snapshot/close and failed input update the same indicator", async () => {
  const f = fixture(), handler = createComputerToolHandler({ indicator: f.controller, idleTimeoutMs: 0 });
  const deps = { node: "test", invokeNodeCommand: async () => ({ content: [] }) };
  await handler("openclaw_computer", { action: "snapshot" }, deps);
  assert.equal(f.controller.getStatus().sessionCount, 1);
  await handler("openclaw_computer", { action: "close_execution" }, deps);
  assert.equal(f.controller.getStatus().active, false);
  await handler("openclaw_computer", { action: "snapshot" }, deps);
  await handler("openclaw_computer", { action: "get_cursor_position" }, { ...deps, invokeNodeCommand: async () => ({ isError: true }) });
  assert.equal(f.controller.getStatus().active, false);
});
