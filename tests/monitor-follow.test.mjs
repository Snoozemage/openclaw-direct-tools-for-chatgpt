import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../src/monitor/assets/monitor.js", import.meta.url), "utf8");
const monitorCode = source.split("window.setInterval(renderSessions,5000);")[0];

function setupMonitor() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "",
        textContent: "",
        innerHTML: "",
        scrollTop: 0,
        dataset: {},
        classList: { add() {}, remove() {} },
        setAttribute(name, value) { this[name] = value; },
        addEventListener() {},
        replaceChildren() {},
        appendChild() {},
      });
    }
    return elements.get(id);
  };
  element("filter").value = "all";
  const main = element("main");
  let callButtons = [];
  const document = {
    getElementById: element,
    querySelector: selector => selector === "main" ? main : null,
    querySelectorAll(selector) {
      if (selector !== ".call-open") return [];
      const matches = [...element("calls").innerHTML.matchAll(/class="call-open" data-id="(\d+)"/g)];
      callButtons = matches.map(([, id]) => {
        const button = { dataset: { id } };
        return button;
      });
      return callButtons;
    },
    createElement: () => ({ textContent: "" }),
    addEventListener() {},
  };
  const context = createContext({
    document,
    window: {},
    Date,
  });
  runInContext(monitorCode, context);
  return {
    elements,
    run: code => runInContext(code, context),
    selected: () => runInContext("selectedEvent", context),
    following: () => runInContext("followLatest", context),
    call: (id, status = "running", sessionId = "session-a") => {
      runInContext(`apply(${JSON.stringify({ id, tool: "test_tool", status, sessionId, startedAt: "2026-11-11T03:00:00Z" })})`, context);
    },
    clickCall(id) {
      const button = callButtons.find(b => Number(b.dataset.id) === id);
      assert.ok(button, "expected visible tool call " + id);
      button.onclick();
    },
  };
}

test("monitor automatically opens each new call without switching on older completions", () => {
  const monitor = setupMonitor();
  monitor.call(1);
  assert.equal(monitor.selected(), 1);
  monitor.elements.get("main").scrollTop = 150;
  monitor.call(2);
  assert.equal(monitor.selected(), 2);
  assert.equal(monitor.elements.get("main").scrollTop, 0);
  assert.equal(monitor.elements.get("detail").innerHTML.includes("Call #2"), true);
  monitor.call(1, "success");
  assert.equal(monitor.selected(), 2);
  assert.equal(monitor.following(), true);
});

test("inspecting an older call pauses follow until resumed from the button", () => {
  const monitor = setupMonitor();
  monitor.call(1);
  monitor.call(2);
  monitor.clickCall(1);
  assert.equal(monitor.following(), false);
  assert.equal(monitor.elements.get("followLatest").textContent, "Follow latest");
  monitor.call(3);
  assert.equal(monitor.selected(), 1);
  assert.equal(monitor.elements.get("detail").innerHTML.includes("Call #1"), true);
  monitor.elements.get("followLatest").onclick();
  assert.equal(monitor.following(), true);
  assert.equal(monitor.selected(), 3);
  assert.equal(monitor.elements.get("followLatest").textContent, "Following latest");
});

test("follow respects selected session and status filters", () => {
  const monitor = setupMonitor();
  monitor.call(1, "running", "session-a");
  monitor.run('selectedSession="session-a"; render()');
  monitor.call(2, "running", "session-b");
  assert.equal(monitor.selected(), 1);
  monitor.call(3, "running", "session-a");
  assert.equal(monitor.selected(), 3);
  monitor.elements.get("filter").value = "running";
  monitor.run("render()");
  monitor.call(4, "success", "session-a");
  assert.equal(monitor.selected(), 3);
  monitor.call(5, "running", "session-a");
  assert.equal(monitor.selected(), 5);
});
