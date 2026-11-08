import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const sourceText = await readFile(new URL("../src/monitor/assets/monitor.js", import.meta.url), "utf8");
const definitions = sourceText.split('$("filter").onchange=render;')[0];

function makeMonitor(fetchImpl) {
  const elements = new Map();
  for (const id of ["dot", "connection", "restart"]) {
    elements.set(id, { classList: { add() {}, remove() {} }, textContent: "", disabled: false });
  }
  const streams = [];
  let reloads = 0;
  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; streams.push(this); }
    close() { this.closed = true; }
  }
  const sandbox = {
    document: { getElementById: id => elements.get(id) },
    window: { location: { reload: () => { reloads++; } } },
    EventSource: FakeEventSource,
    fetch: fetchImpl,
    setTimeout: callback => Promise.resolve().then(callback),
    Date,
  };
  runInNewContext(definitions + "\nconnectEvents();", sandbox);
  return {
    sandbox, streams, elements, get reloads() { return reloads; },
    restart: () => runInNewContext("restartBridge()", sandbox),
  };
}

test("monitor reloads after a disconnected event stream reconnects", () => {
  const monitor = makeMonitor();
  const stream = monitor.streams[0];
  assert.equal(stream.url, "/events");
  stream.onopen();
  assert.equal(monitor.reloads, 0);
  stream.onerror();
  assert.equal(monitor.elements.get("connection").textContent, "Reconnecting…");
  stream.onopen();
  assert.equal(monitor.reloads, 1);
});

test("monitor restart button reloads the page only after the new PID is confirmed", async () => {
  const calls = [];
  const monitor = makeMonitor(async url => {
    calls.push(url);
    if (url === "/api/restart") return {
      ok: true, json: async () => ({ previousPid: 100 }),
    };
    if (url === "/healthz") return {
      ok: true, json: async () => ({
        ok: true, server: "openclaw-chatgpt-bridge", pid: 101,
      }),
    };
    throw new Error("Unexpected URL: " + url);
  });
  await monitor.restart();
  assert.deepEqual(calls, ["/api/restart", "/healthz"]);
  assert.equal(monitor.reloads, 1);
  assert.equal(monitor.streams[0].closed, true);
});
