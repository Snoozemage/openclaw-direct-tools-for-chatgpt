import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../src/monitor/assets/monitor.js", import.meta.url), "utf8");
const monitorCode = source.split("window.setInterval(renderSessions,5000);")[0];

function setupMonitor(storage) {
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
        scrollIntoView(options) { this.scrollCalls = (this.scrollCalls || []).concat([options]); },
      });
    }
    return elements.get(id);
  };
  element("filter").value = "all";
  const main = element("main");
  element("section-output");
  element("inspector-sticky");
  let callButtons = [];
  let sessionButtons = [];
  let depthButtons = [];
  const document = {
    getElementById: element,
    querySelector: selector => selector === "main" ? main : selector === ".inspector-sticky" ? element("inspector-sticky") : null,
    querySelectorAll(selector) {
      if (selector === "[data-session]") {
        sessionButtons = [...element("sessions").innerHTML.matchAll(/data-session="([^"]+)"/g)]
          .map(([, session]) => ({ dataset: { session } }));
        return sessionButtons;
      }
      if (selector === "[data-depth-block]") {
        depthButtons = [...element("detail").innerHTML.matchAll(/data-depth-block="([^"]+)" data-depth-action="([^"]+)"/g)]
          .map(([, depthBlock, depthAction]) => ({ dataset: { depthBlock, depthAction } }));
        return depthButtons;
      }
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
    window: storage ? {
      sessionStorage: {
        getItem: key => storage.get(key)??null,
        setItem: (key,value) => storage.set(key,value),
      },
    } : {},
    Date,
  });
  runInContext(monitorCode, context);
  return {
    elements,
    run: code => runInContext(code, context),
    selected: () => runInContext("selectedEvent", context),
    following: () => runInContext("followLatest", context),
    followingAgent: () => runInContext("followSessionId", context),
    call: (id, status = "running", sessionId = "session-a") => {
      runInContext(`apply(${JSON.stringify({ id, tool: "test_tool", status, sessionId, startedAt: "2026-11-11T03:00:00Z" })})`, context);
    },
    clickCall(id) {
      const button = callButtons.find(b => Number(b.dataset.id) === id);
      assert.ok(button, "expected visible tool call " + id);
      button.onclick();
    },
    clickSession(id) {
      const button = sessionButtons.find(b => b.dataset.session === id);
      assert.ok(button, "expected session " + id);
      button.onclick();
    },
    clickDepth(key, action = "collapse") {
      const button = depthButtons.find(b => b.dataset.depthBlock === key && b.dataset.depthAction === action);
      assert.ok(button, "expected " + action + " control for " + key);
      button.onclick();
    },
  };
}

test("monitor follows new calls and focuses their output without jumping for older completions", () => {
  const monitor = setupMonitor();
  monitor.call(1);
  assert.equal(monitor.selected(), 1);
  assert.equal(monitor.elements.get("section-output").scrollCalls.length, 1);
  monitor.call(2);
  assert.equal(monitor.selected(), 2);
  assert.equal(monitor.elements.get("section-output").scrollCalls.length, 2);
  assert.equal(monitor.elements.get("detail").innerHTML.includes("Call #2"), true);
  monitor.call(1, "success");
  assert.equal(monitor.selected(), 2);
  assert.equal(monitor.elements.get("section-output").scrollCalls.length, 2);
  monitor.call(2, "success");
  assert.equal(monitor.elements.get("section-output").scrollCalls.length, 3);
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

test("visible session choices scope the activity list with one click", () => {
  const monitor = setupMonitor();
  monitor.run('sessions=[{id:"session-a",task:"First conversation",lastSeenAt:Date.now(),initialized:true},{id:"session-b",task:"Second conversation",lastSeenAt:Date.now(),initialized:true}];render()');
  monitor.call(1, "success", "session-a");
  monitor.call(2, "running", "session-b");
  assert.equal(monitor.selected(), 1);
  assert.equal(monitor.elements.get("scopeCount").textContent, "2 chats");
  monitor.clickSession("session-a");
  assert.equal(monitor.selected(), 1);
  assert.equal(monitor.elements.get("activityCount").textContent, "1 call");
  assert.equal(monitor.elements.get("scopeCount").textContent, "2 chats");
  monitor.clickSession("all");
  assert.equal(monitor.selected(), 1);
  assert.equal(monitor.elements.get("activityCount").textContent, "2 calls");
  monitor.clickCall(2);
  assert.equal(monitor.followingAgent(), "session-b");
  assert.equal(monitor.selected(), 2);
});

test("arguments are expanded above output, without a redundant command section", () => {
  const monitor = setupMonitor();
  monitor.run('apply({id:1,tool:"test_tool",status:"running",sessionId:"session-a",arguments:{action:"click",ref:"e1"},startedAt:"2026-11-11T03:00:00Z"})');
  const detail = monitor.elements.get("detail").innerHTML;
  assert.ok(detail.indexOf('data-section-key="arguments"') < detail.indexOf('id="section-output"'));
  assert.ok(detail.includes('id="payload-output"'));
  assert.match(detail, /data-section-key="arguments"[^>]* open>/u);
  assert.doesNotMatch(detail, /Command \/ operation|data-section-key="operation"/u);
  assert.match(detail, /data-depth-block="arguments" data-depth-action="collapse">Collapse/u);
});

test("Follow latest stays on its agent until a different agent is selected", () => {
  const monitor = setupMonitor();
  monitor.call(1, "running", "session-a");
  monitor.call(2, "running", "session-b");
  assert.equal(monitor.selected(), 1);
  assert.equal(monitor.followingAgent(), "session-a");
  monitor.call(3, "running", "session-a");
  assert.equal(monitor.selected(), 3);
  monitor.call(4, "success", "session-b");
  assert.equal(monitor.selected(), 3);
  monitor.clickCall(4);
  assert.equal(monitor.following(), true);
  assert.equal(monitor.followingAgent(), "session-b");
  monitor.call(5, "success", "session-a");
  assert.equal(monitor.selected(), 4);
  monitor.call(6, "running", "session-b");
  assert.equal(monitor.selected(), 6);
  monitor.clickCall(2);
  assert.equal(monitor.following(), false);
  monitor.call(7, "success", "session-b");
  assert.equal(monitor.selected(), 2);
  monitor.elements.get("followLatest").onclick();
  assert.equal(monitor.following(), true);
  assert.equal(monitor.selected(), 7);
  assert.equal(monitor.followingAgent(), "session-b");
});

test("filtering another agent never changes the follow target", () => {
  const monitor = setupMonitor();
  monitor.call(1, "running", "session-a");
  monitor.call(2, "success", "session-b");
  monitor.elements.get("filter").value = "success";
  monitor.run("render()");
  assert.equal(monitor.selected(), null);
  assert.equal(monitor.followingAgent(), "session-a");
  monitor.call(3, "success", "session-a");
  assert.equal(monitor.selected(), 3);
  monitor.elements.get("filter").value = "all";
  monitor.run("render()");
  assert.equal(monitor.selected(), 3);
});

test("Collapse decreases JSON depth one level at a time; Expand opens everything", () => {
  const monitor = setupMonitor();
  monitor.run('window.JSONFormatter=class {constructor(data,depth){window.depth=depth}render(){return {}}}');
  monitor.run('apply({id:1,tool:"test_tool",status:"running",sessionId:"session-a",arguments:{nested:{more:{deep:{value:1}}}},output:{result:{nested:{message:"OK"}}},startedAt:"2026-11-11T03:00:00Z"})');
  assert.equal(monitor.run("treeDepth('arguments')"), Infinity);
  assert.equal(monitor.run("treeDepth('output')"), Infinity);
  assert.match(monitor.elements.get("detail").innerHTML, /data-depth-block="arguments" data-depth-action="collapse">Collapse/u);
  assert.match(monitor.elements.get("detail").innerHTML, /data-depth-block="output" data-depth-action="collapse">Collapse/u);
  monitor.clickDepth("arguments");
  assert.equal(monitor.run("treeDepth('arguments')"), 3);
  assert.equal(monitor.following(), false);
  assert.match(monitor.elements.get("detail").innerHTML, /data-depth-block="arguments" data-depth-action="collapse">Collapse/u);
  assert.match(monitor.elements.get("detail").innerHTML, /data-depth-block="arguments" data-depth-action="expand">Expand/u);
  assert.doesNotMatch(monitor.elements.get("detail").innerHTML, /section-collapsible fully-expanded/u);
  monitor.clickDepth("arguments");
  assert.equal(monitor.run("treeDepth('arguments')"), 2);
  monitor.clickDepth("arguments");
  assert.equal(monitor.run("treeDepth('arguments')"), 1);
  monitor.clickDepth("arguments");
  assert.equal(monitor.run("treeDepth('arguments')"), 0);
  assert.doesNotMatch(monitor.elements.get("detail").innerHTML, /data-depth-block="arguments" data-depth-action="collapse"/u);
  assert.match(monitor.elements.get("detail").innerHTML, /data-depth-block="arguments" data-depth-action="expand">Expand/u);
  monitor.clickDepth("arguments","expand");
  assert.equal(monitor.run("treeDepth('arguments')"), Infinity);
  assert.match(monitor.elements.get("detail").innerHTML, /data-depth-block="arguments" data-depth-action="collapse">Collapse/u);
  assert.match(monitor.elements.get("detail").innerHTML, /section-collapsible fully-expanded/u);
  monitor.call(2);
  assert.equal(monitor.selected(), 1);
  assert.equal(monitor.run("treeDepth('arguments')"), Infinity);
  monitor.clickCall(2);
  assert.equal(monitor.run("treeDepth('arguments')"), Infinity);
});

test("Output also starts fully expanded and collapses independently of Arguments", () => {
  const monitor=setupMonitor();
  monitor.run('apply({id:15,tool:"test_tool",status:"success",sessionId:"session-a",arguments:{nested:{alpha:1}},output:{result:{deep:{message:"done"}}},startedAt:"2026-11-11T03:00:00Z"})');
  assert.equal(monitor.run("treeDepth('arguments')"),Infinity);
  assert.equal(monitor.run("treeDepth('output')"),Infinity);
  assert.match(monitor.elements.get("detail").innerHTML,/data-depth-block="output" data-depth-action="collapse">Collapse/u);
  monitor.clickDepth("output");
  assert.equal(monitor.run("treeDepth('output')"),2);
  assert.equal(monitor.run("treeDepth('arguments')"),Infinity);
  assert.match(monitor.elements.get("detail").innerHTML,/data-depth-block="output" data-depth-action="collapse">Collapse/u);
  assert.match(monitor.elements.get("detail").innerHTML,/data-depth-block="output" data-depth-action="expand">Expand/u);
  monitor.clickDepth("output","expand");
  assert.equal(monitor.run("treeDepth('output')"),Infinity);
  assert.match(monitor.elements.get("detail").innerHTML,/data-depth-block="output" data-depth-action="collapse">Collapse/u);
});

test("previous saved depth settings do not override the new fully expanded default", () => {
  const storage=new Map();
  storage.set("openclaw.monitor.view.v1",JSON.stringify({followLatest:false,selectedEvent:10,followSessionId:"agent-a",blockDepths:{"10:arguments":1,"10:output":2}}));
  const monitor=setupMonitor(storage);
  monitor.run('apply({id:10,tool:"test_tool",status:"success",sessionId:"agent-a",arguments:{nested:{value:1}},output:{nested:{value:2}},startedAt:"2026-11-11T03:00:00Z"})');
  assert.equal(monitor.selected(),10);
  assert.equal(monitor.following(),false);
  assert.equal(monitor.run("treeDepth('arguments')"),Infinity);
  assert.equal(monitor.run("treeDepth('output')"),Infinity);
  assert.match(monitor.elements.get("detail").innerHTML,/data-depth-block="arguments" data-depth-action="collapse">Collapse/u);
  assert.match(monitor.elements.get("detail").innerHTML,/data-depth-block="output" data-depth-action="collapse">Collapse/u);
  assert.equal(JSON.parse(storage.get("openclaw.monitor.view.v1")).treeDepthVersion,3);
});

test("manually opening the JSON tree keeps the selected call stable during new events", () => {
  const monitor = setupMonitor();
  monitor.run('apply({id:1,tool:"test_tool",status:"success",sessionId:"session-a",arguments:{nested:{deep:1}},startedAt:"2026-11-11T03:00:00Z"})');
  monitor.clickDepth("arguments");
  monitor.call(2, "running", "session-a");
  assert.equal(monitor.selected(), 1);
  assert.equal(monitor.following(), false);
  assert.equal(monitor.run("treeDepth('arguments')"), 1);
  monitor.elements.get("followLatest").onclick();
  assert.equal(monitor.selected(), 2);
});

test("a monitor reconnect preserves manual JSON expansion and paused following", () => {
  const storage=new Map();
  const original=setupMonitor(storage);
  original.run('apply({id:1,tool:"test_tool",status:"success",sessionId:"agent-a",arguments:{nested:{deep:{value:1}}},startedAt:"2026-11-11T03:00:00Z"})');
  original.clickDepth("arguments");
  const saved=JSON.parse(storage.get("openclaw.monitor.view.v1"));
  assert.equal(saved.followLatest,false);
  assert.equal(saved.selectedEvent,1);
  assert.equal(saved.blockDepths["1:arguments"],2);

  const restored=setupMonitor(storage);
  restored.run('apply({id:1,tool:"test_tool",status:"success",sessionId:"agent-a",arguments:{nested:{deep:{value:1}}},startedAt:"2026-11-11T03:00:00Z"})');
  assert.equal(restored.selected(),1);
  assert.equal(restored.following(),false);
  assert.equal(restored.run("treeDepth('arguments')"),2);
  assert.match(restored.elements.get("detail").innerHTML,/data-depth-block="arguments" data-depth-action="expand">Expand/u);
  restored.call(2,"running","agent-a");
  assert.equal(restored.selected(),1);
});

test("one fluid desktop layout keeps Arguments and Output independently scrollable", async () => {
  const css = await readFile(new URL("../src/monitor/assets/monitor.css", import.meta.url), "utf8");
  const layout = css.split("/* One fluid desktop workspace.")[1];
  assert.ok(layout, "expected a shared desktop layout");
  assert.doesNotMatch(layout, /@media/u);
  assert.match(layout, /grid-template-columns:\s*clamp\(345px, 28vw, 520px\) minmax\(0, 1fr\)/u);
  assert.match(layout, /\.inspector-pane\s*\{\s*--inspector-gutter:[\s\S]*?display:\s*flex;\s*flex-direction:\s*column;\s*min-height:\s*0;\s*overflow:\s*hidden;/u);
  assert.match(layout, /\.inspector-pane > \.detail\s*\{\s*display:\s*flex;/u);
  assert.match(layout, /\.section-inner \.payload-body\s*\{\s*max-height:\s*clamp\(110px, 16dvh, 175px\);\s*overflow:\s*auto;/u);
  assert.match(layout, /\.section-collapsible\.fully-expanded \.payload-body\s*\{\s*max-height:\s*clamp\(130px, 22dvh, 210px\);/u);
  assert.match(layout, /\.section-output \.payload-body\s*\{\s*flex:\s*1 1 auto;\s*min-height:\s*0;\s*max-height:\s*none;\s*overflow:\s*auto;/u);
});

test("a different agent's events do not replace the current JSON tree", () => {
  const monitor = setupMonitor();
  monitor.call(1, "success", "session-a");
  const detail = monitor.elements.get("detail");
  let rerenders=0;
  Object.defineProperty(detail, "innerHTML", {
    configurable: true,
    get() { return this._html || ""; },
    set(value) { this._html=value; rerenders++; }
  });
  monitor.call(2, "running", "session-b");
  monitor.call(3, "success", "session-b");
  assert.equal(monitor.selected(), 1);
  assert.equal(rerenders, 0);
});

test("selected agent information moves into the inspector header", () => {
  const monitor = setupMonitor();
  monitor.run('sessions=[{id:"session-a",task:"Review module and update its tests",lastSeenAt:Date.now(),initialized:true}];render()');
  monitor.run('apply({id:11,tool:"openclaw_exec",status:"success",sessionId:"session-a",sessionLabel:"agent-2",sessionInitialized:true,arguments:{command:"git status"},startedAt:"2026-11-11T03:00:00Z",durationMs:120})');
  const context = monitor.elements.get("agentContext").innerHTML;
  const detail = monitor.elements.get("detail").innerHTML;
  assert.match(context, /agent-2/u);
  assert.match(context, /Review module and update its tests/u);
  assert.match(context, /Initialized/u);
  assert.match(context, /Last active/u);
  assert.match(detail, /Call #11/u);
  assert.doesNotMatch(detail, /Command \/ operation/u);
  assert.equal(monitor.run('JSON.stringify(argumentsForDisplay({command:"git status"}))'), '{"command":"git status"}');
});

test("activity counters follow the currently inspected agent", () => {
  const monitor = setupMonitor();
  monitor.call(1, "success", "session-a");
  monitor.call(2, "error", "session-b");
  monitor.call(3, "running", "session-a");
  assert.equal(monitor.elements.get("running").textContent, "1");
  assert.equal(monitor.elements.get("completed").textContent, "1");
  assert.equal(monitor.elements.get("errors").textContent, "0");
  monitor.clickCall(2);
  assert.equal(monitor.elements.get("running").textContent, "0");
  assert.equal(monitor.elements.get("completed").textContent, "0");
  assert.equal(monitor.elements.get("errors").textContent, "1");
});

test("follow keeps the title and arguments visible when output is already in view", () => {
  const monitor = setupMonitor();
  const inspector = monitor.elements.get("main");
  const output = monitor.elements.get("section-output");
  inspector.getBoundingClientRect = () => ({ top: 50, height: 700 });
  output.getBoundingClientRect = () => ({ top: 400 });
  monitor.call(1);
  assert.equal(inspector.scrollTop, 0);
  assert.equal(output.scrollCalls, undefined);
  output.getBoundingClientRect = () => ({ top: 900 });
  monitor.call(2);
  assert.ok(inspector.scrollTop > 0);
});

test("output focus accounts for the pinned agent and counter strip", () => {
  const monitor = setupMonitor();
  const inspector = monitor.elements.get("main");
  inspector.getBoundingClientRect = () => ({ top: 72, height: 828 });
  const pinned = monitor.elements.get("inspector-sticky");
  pinned.getBoundingClientRect = () => ({ top: 72, height: 210 });
  const output = monitor.elements.get("section-output");
  output.getBoundingClientRect = () => ({ top: 800 });
  monitor.call(1);
  assert.equal(inspector.scrollTop, 800 - (72 + 210 + 42));
});

test("agent context and counters share a single sticky surface", async () => {
  const html = await readFile(new URL("../src/monitor/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/monitor/assets/monitor.css", import.meta.url), "utf8");
  const panel = html.split('<div class="inspector-sticky">')[1].split('<section id="detail"')[0];
  assert.ok(panel.indexOf('id="agentContext"') < panel.indexOf('class="summary"'));
  assert.match(panel, /id="running"/);
  assert.match(panel, /id="completed"/);
  assert.match(panel, /id="errors"/);
  assert.match(css, /\.inspector-sticky\s*\{\s*position:\s*sticky;\s*top:\s*0;/);
});

test("monitor exposes sessions directly and removes the redundant privacy footer", async () => {
  const html = await readFile(new URL("../src/monitor/index.html", import.meta.url), "utf8");
  assert.match(html, /id="sessions"[^>]*role="group"/);
  assert.doesNotMatch(html, /<details id="sessionSwitcher"/);
  assert.doesNotMatch(html, /LOCAL ONLY|Session aliases and redacted values/);
  assert.match(html, /id="detail"/);
  assert.match(html, /id="followLatest"/);
  assert.doesNotMatch(html, /Activity monitor/);
  assert.doesNotMatch(html, /TOOL MONITOR/);
});

test("desktop density follows available height, not a monitor resolution", async () => {
  const css = await readFile(new URL("../src/monitor/assets/monitor.css", import.meta.url), "utf8");
  const layout = css.split("/* One fluid desktop workspace.")[1];
  assert.ok(layout);
  assert.match(layout, /height: clamp\(56px, 6\.6dvh, 72px\)/u);
  assert.match(layout, /\.inspector-sticky\s*\{[\s\S]*?padding:\s*clamp\(9px, 1\.3dvh, 17px\)/u);
  assert.doesNotMatch(layout, /@media/u);
});

test("Arguments displays long values on two lines with a scrollable second line", async () => {
  const css = await readFile(new URL("../src/monitor/assets/monitor.css", import.meta.url), "utf8");
  const js = await readFile(new URL("../src/monitor/assets/monitor.js", import.meta.url), "utf8");
  const argumentsStyles = css.split("/* Each long Argument value uses at most two lines.")[1];
  assert.ok(argumentsStyles);
  assert.match(argumentsStyles, /#payload-arguments\s*\{\s*overflow-x:\s*hidden;\s*overflow-wrap:\s*anywhere;/u);
  assert.match(argumentsStyles, /#payload-arguments \.argument-raw-line\s*\{\s*display:\s*block;/u);
  assert.match(argumentsStyles, /#payload-arguments \.json-formatter-string/u);
  assert.match(argumentsStyles, /#payload-arguments \.argument-two-lines > \.argument-remainder\s*\{\s*display:\s*block;[\s\S]*?overflow-x:\s*auto;[\s\S]*?white-space:\s*nowrap;/u);
  assert.match(js, /function splitArgumentLine\(element\)/u);
  assert.match(js, /if\(key==="arguments"\)formatArguments\(body\)/u);
  assert.match(js, /window\.addEventListener\("resize"/u);
  assert.match(js, /#payload-arguments \.json-formatter-toggler-link/u);
});
