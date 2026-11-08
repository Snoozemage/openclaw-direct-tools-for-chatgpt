import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mcpHandler } from "../src/mcp/sdk-server.mjs";
import {
  isSessionInitialized,
  listSessions,
  clearSessionsFromMonitor,
  removeSessionFromMonitor,
  requestSessionId,
  touchSession,
} from "../src/mcp/session-registry.mjs";
import { toolDefinitions } from "../src/mcp/tool-definitions.mjs";
import { buildMcpInstructions, hostDisplayName } from "../src/mcp/instructions.mjs";

let requestId = 0;

async function rpc(method, params = {}, session) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session) headers["x-openai-session"] = session;
  const response = await mcpHandler.fetch(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method,
      params,
    }),
  }));
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    assert.ok(data.length > 0, "SDK returned no SSE data for " + method + ": " + body.slice(0, 500));
    return { status: response.status, payload: JSON.parse(data.at(-1)) };
  }
  return { status: response.status, payload: JSON.parse(body) };
}

async function callTool(name, args = {}, session = "test-session") {
  return rpc("tools/call", { name, arguments: args }, session);
}

test("prefers OpenAI conversation identity and supports documented header fallbacks", () => {
  assert.equal(requestSessionId({ headers: { "x-openai-session": "chat-a", "mcp-session-id": "mcp-a" } }), "chat-a");
  assert.equal(requestSessionId({ headers: { "mcp-session-id": "mcp-a" } }), "mcp-a");
  assert.equal(requestSessionId({ headers: { "x-openai-conversation-id": "chat-b" } }), "chat-b");
  assert.equal(requestSessionId({ headers: { "x-openai-session-id": "chat-c" } }), "chat-c");
  assert.equal(requestSessionId(new Headers({ "x-openai-session": "chat-header-object" })), "chat-header-object");
  assert.equal(requestSessionId({ headers: { "x-openai-session": "x".repeat(600) } }), undefined);
});

test("MCP instructions follow the OpenChatX builder pattern and adapt to the host platform", () => {
  assert.equal(hostDisplayName("win32"), "Windows");
  assert.equal(hostDisplayName("darwin"), "macOS");
  assert.equal(hostDisplayName("linux"), "linux");
  assert.match(buildMcpInstructions("win32"), /fully permissioned Windows machine/u);
  assert.match(buildMcpInstructions("linux"), /fully permissioned linux machine/u);
  assert.match(buildMcpInstructions(), /# Tool routing/u);
  assert.match(buildMcpInstructions(), /openclaw_dispatch_action/u);
  assert.match(buildMcpInstructions(), /openclaw_browser action=act, kind=batch/u);
  assert.match(buildMcpInstructions(), /two or more necessary consecutive interactions/u);
  assert.match(buildMcpInstructions(), /Avoid redundant hover, scrollIntoView, wait, and delayMs/u);
  assert.match(buildMcpInstructions(), /Every type action must include its own ref or selector/u);
  assert.match(buildMcpInstructions(), /not inherited by later actions/u);
  assert.match(buildMcpInstructions(), /openclaw_computer action=batch with up to five actions/u);
  assert.doesNotMatch(buildMcpInstructions(), /project_manage|subagent_run|summarize/u);
});

test("SDK initialize exposes the bridge-specific instruction text", async () => {
  const response = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "session-test", version: "1.0.0" },
  }, null);
  assert.equal(response.status, 200);
  assert.equal(response.payload.result.serverInfo.name, "openclaw-chatgpt-bridge");
  assert.match(response.payload.result.instructions, /# Tool routing/u);
  assert.match(response.payload.result.instructions, /openclaw_dispatch_action/u);
  assert.doesNotMatch(response.payload.result.instructions, /project_manage|subagent_run|summarize/u);
  assert.match(response.payload.result.instructions, /INITIALIZATION_REQUIRED/u);
});

test("SDK negotiates the current MCP protocol through server/discover", async () => {
  const response = await mcpHandler.fetch(new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "session-test", version: "1.0.0" },
        },
      },
    }),
  }));
  assert.equal(response.status, 200);
  const payload = JSON.parse(await response.text());
  assert.ok(payload.result.supportedVersions.includes("2026-07-28"));
  assert.match(payload.result.instructions, /# Tool routing/u);
  assert.match(payload.result.instructions, /openclaw_dispatch_action/u);
  assert.equal(payload.result.capabilities.tools.listChanged, true);
});
test("SDK exposes all bridge tools and the screenshot viewer resource", async () => {
  const listed = await rpc("tools/list", {}, null);
  const names = listed.payload.result.tools.map((tool) => tool.name);
  assert.equal(names.length, toolDefinitions.length);
  assert.deepEqual(new Set(names), new Set(toolDefinitions.map((tool) => tool.name)));
  assert.ok(names.includes("openclaw_bridge_restart"));
  for (const publishedTool of listed.payload.result.tools) {
    const declaredTool = toolDefinitions.find((tool) => tool.name === publishedTool.name);
    assert.deepEqual(publishedTool.annotations, declaredTool.annotations, publishedTool.name);
  }

  const resources = await rpc("resources/list", {}, null);
  const viewer = resources.payload.result.resources.find((resource) => resource.uri === "ui://openclaw/image-render/v4.html");
  assert.ok(viewer);
  assert.equal(viewer.mimeType, "text/html;profile=mcp-app");
  assert.equal(viewer._meta.ui.prefersBorder, false);
  assert.deepEqual(viewer._meta["openai/ui"].availableDisplayModes, ["inline"]);

  const read = await rpc("resources/read", { uri: viewer.uri }, null);
  assert.equal(read.payload.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(read.payload.result.contents[0].text, /id="screenshot"/u);
});
test("start_here is the first exposed tool and has a compact optional task label", () => {
  assert.equal(toolDefinitions[0].name, "start_here");
  assert.deepEqual(toolDefinitions[0].inputSchema.required ?? [], []);
  assert.equal(toolDefinitions[0].inputSchema.properties.task.maxLength, 160);
});

test("start_here returns bridge-specific operating instructions", async () => {
  const response = await callTool("start_here", {}, "start-here-instructions-test");
  const instructions = response.payload.result.content[0].text;

  for (const heading of [
    "## Scope and operating principles",
    "## Progress updates",
    "## Tool routing",
    "## Shell discipline",
    "## Context and output discipline",
    "## Validation and completion",
    "## Decision boundaries",
    "## Communication",
    "## Session behavior",
  ]) {
    assert.ok(instructions.includes(heading), "Missing start_here section: " + heading);
  }

  assert.match(instructions, /openclaw_tool_search[\s\S]*openclaw_tool_describe[\s\S]*openclaw_dispatch_action/u);
  assert.match(instructions, /openclaw_process/u);
  assert.match(instructions, /batch forms when supported \(up to five items\)/u);
  assert.match(instructions, /action: "act"[\s\S]*kind: "batch"/u);
  assert.match(instructions, /up to five predictable actions/u);
  assert.match(instructions, /Each browser batch action has its own target/u);
  assert.match(instructions, /Always include ref or selector on the type action itself/u);
  assert.match(instructions, /If the runtime rejects batching, fall back to individual calls/u);
  assert.match(instructions, /explicit authorization before committing, pushing, force-pushing, merging/u);
  assert.match(instructions, /redaction is best-effort/u);
  assert.match(instructions, /To restart the bridge, call openclaw_bridge_restart/u);
  assert.doesNotMatch(instructions, /scripts\/windows\/restart-bridge\.ps1/u);
  assert.match(instructions, /After the bridge reconnects, call start_here again if the session requires reinitialization/u);
  assert.doesNotMatch(instructions, /Durable Jobs|job_manage|project_manage|subagent_run|\{\{MODE_INSTRUCTIONS\}\}|\bfile_read\b|\bbash\b/u);
});

test("a ChatGPT session must initialize before other tools and stays isolated from another session", async () => {
  const firstBlocked = await callTool("openclaw_tool_search", { query: "browser" }, "chat-session-a");
  assert.equal(firstBlocked.payload.result.isError, true);
  assert.match(firstBlocked.payload.result.content[0].text, /INITIALIZATION_REQUIRED/u);

  const started = await callTool("start_here", { task: "session startup test" }, "chat-session-a");
  assert.equal(started.payload.result.isError, undefined);
  assert.match(started.payload.result.content[0].text, /Tool routing/u);

  const first = listSessions().find((session) => session.task === "session startup test");
  assert.ok(first);
  assert.equal(first.initialized, true);
  assert.equal(isSessionInitialized("chat-session-a"), true);

  const secondBlocked = await callTool("openclaw_tool_search", { query: "browser" }, "chat-session-b");
  assert.equal(secondBlocked.payload.result.isError, true);
  assert.match(secondBlocked.payload.result.content[0].text, /INITIALIZATION_REQUIRED/u);

  const sessions = listSessions();
  const second = sessions.find((session) => session.lastTool === "openclaw_tool_search" && !session.initialized);
  assert.ok(second);
  assert.equal(second.initialized, false);
  assert.notEqual(first.id, second.id);
  assert.doesNotMatch(JSON.stringify(sessions), /chat-session-a|chat-session-b/u);
});

test("sessions without an identity remain compatible with local MCP clients", async () => {
  const result = await callTool("not_a_real_tool", {}, null);
  assert.ok(result.payload.error);
  assert.match(result.payload.error.message, /not found/u);
  assert.doesNotMatch(JSON.stringify(result.payload), /INITIALIZATION_REQUIRED/u);
});

test("removing a session from the monitor preserves initialization and restores it on the next tool call", async () => {
  const sessionKey = "remove-from-monitor-session";
  await callTool("start_here", { task: "removable session test" }, sessionKey);
  const before = listSessions().find((session) => session.task === "removable session test");
  assert.ok(before);
  assert.equal(before.initialized, true);

  assert.equal(removeSessionFromMonitor(before.id), true);
  assert.equal(listSessions().some((session) => session.id === before.id), false);
  assert.equal(touchSession(sessionKey), undefined);
  assert.equal(isSessionInitialized(sessionKey), true);

  const laterCall = await callTool("start_here", { task: "restored session test" }, sessionKey);
  assert.equal(laterCall.payload.result.isError, undefined);

  const restored = listSessions().find((session) => session.id === before.id);
  assert.ok(restored);
  assert.equal(restored.initialized, true);
  assert.equal(restored.id, before.id);
});

test("MCP restart requires session initialization and returns an actionable error without a supervisor", async () => {
  const sessionKey = "restart-needs-init-session";
  const blocked = await callTool("openclaw_bridge_restart", {}, sessionKey);
  assert.equal(blocked.payload.result.isError, true);
  assert.match(blocked.payload.result.content[0].text, /INITIALIZATION_REQUIRED/u);

  const initialized = await callTool("start_here", {}, sessionKey);
  assert.equal(initialized.payload.result.isError, undefined);
  const result = await callTool("openclaw_bridge_restart", {}, sessionKey);
  assert.equal(result.payload.result.isError, true);
  assert.equal(result.payload.result.structuredContent.httpStatus, 503);
  assert.match(result.payload.result.content[0].text, /requires an active bridge supervisor/u);
});

test("bridge restart delegates process replacement to the external supervisor", async () => {
  const server = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const supervisor = await readFile(new URL("../scripts/windows/bridge-supervisor.ps1", import.meta.url), "utf8");

  assert.match(server, /bridgeRestart\.bindShutdown\(shutdown\)/u);
  assert.match(server, /bridgeRestart\.request\(\)/u);
  const controller = await readFile(new URL("../src/bridge-restart.mjs", import.meta.url), "utf8");
  assert.match(controller, /OPENCLAW_BRIDGE_SUPERVISED === "1"/u);
  assert.match(controller, /setTimeout\(callback, 1000\)/u);
  assert.doesNotMatch(server, /spawn\("powershell\.exe"/u);
  assert.match(supervisor, /Local\\OpenClawChatGPTBridgeSupervisor/u);
  assert.match(supervisor, /Start-Process -FilePath \$nodePath/u);
  assert.match(supervisor, /health\.pid/u);
  assert.match(supervisor, /restarting the bridge only/u);
});

test("monitor displays the session count only once inside the All sessions card", async () => {
  const html = (await readFile(new URL("../src/monitor/index.html", import.meta.url), "utf8")) + await readFile(new URL("../src/monitor/assets/monitor.js", import.meta.url), "utf8");
  assert.match(html, /ChatGPT Sessions<\/span><\/div>/u);
  assert.doesNotMatch(html, /id="sessionCount"/u);
  assert.match(html, /sessions\.length/u);
  assert.match(html, /data-remove-session=/u);
  assert.match(html, /fetch\("\/api\/sessions\/"/u);
  assert.match(html, /async function restartBridge\(\)[\s\S]*?fetch\("\/api\/restart",\{method:"POST"\}\)/u);
  assert.doesNotMatch(html, /window\.confirm\(/u);
  assert.match(html, /fetch\("\/api\/restart",\{method:"POST"\}\)/u);
  assert.match(html, /String\(health\.pid\)/u);
  assert.match(html, /observedOffline/u);
  assert.match(html, /id="callSearch"/u);
  assert.match(html, /window\.JSONFormatter/u);
  assert.match(html, /window\.Diff2Html\.html/u);
  assert.match(html, /data-copy-session=/u);
  assert.match(html, /data-copy-call=/u);
  assert.match(html, /data-view-block=/u);
  assert.match(html, /data-depth-block=/u);
  assert.match(html, /data-diff-mode=/u);
  assert.match(html, /json-formatter\.css/u);
  assert.match(html, /events=events\.filter\(event=>event\.sessionId!==e\.sessionId\)/u);
  assert.match(html, /if\(e\.type==="clear"\)\{events=\[\];sessions=\[\]/u);
  assert.match(html, /clearedSessionCount/u);
  assert.doesNotMatch(html, /themeToggle|monitor-theme|data-theme="light"|copyHistory|Copy log|data-copy-block=/u);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|unpkg\.com/u);
});

test("Monitor auto-renders structured file patches and keeps other raw diff output opt-in", async () => {
  const monitor = await readFile(new URL("../src/monitor/assets/monitor.js", import.meta.url), "utf8");
  assert.match(monitor, /const FILE_MUTATION_TOOLS=new Set\(\["openclaw_edit","openclaw_write","openclaw_apply_patch"\]\)/u);
  assert.match(monitor, /return FILE_MUTATION_TOOLS\.has\(tool\)\?unifiedDiffText\(value\):structuredPatchDiffText\(value\)/u);
  assert.match(monitor, /rawDiffText=key==="output"&&autoDiffText===null\?unifiedDiffText\(value\):null/u);
  assert.match(monitor, /\}\r?\nfunction renderBlock\(key\)/u);
  assert.match(monitor, /data-open-diff=/u);
  assert.match(monitor, /data-raw-output=/u);
  assert.match(monitor, /manualDiffModes\[selectedEvent\]===true/u);
});
test("monitor formatter and diff assets are self-hosted from pinned npm dependencies", async () => {
  const server = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.dependencies["json-formatter-js"], "2.5.23");
  assert.equal(packageJson.dependencies.diff2html, "3.4.56");
  assert.match(server, /monitor\/assets\/json-formatter\.js/u);
  assert.match(server, /monitor\/assets\/json-formatter\.css/u);
  assert.match(server, /monitor\/assets\/diff2html\.js/u);
  assert.match(server, /monitor\/assets\/diff2html\.css/u);
  assert.match(server, /monitor\/assets\/monitor\.js/u);
  assert.match(server, /monitor\/assets\/monitor\.css/u);
  for (const assetPath of [
    "../node_modules/json-formatter-js/dist/json-formatter.umd.js",
    "../node_modules/json-formatter-js/dist/json-formatter.css",
    "../node_modules/diff2html/bundles/js/diff2html.min.js",
    "../node_modules/diff2html/bundles/css/diff2html.min.css",
    "../src/monitor/assets/monitor.js",
    "../src/monitor/assets/monitor.css",
  ]) {
    const asset = await readFile(new URL(assetPath, import.meta.url));
    assert.ok(asset.byteLength > 500, "Expected non-empty UI asset: " + assetPath);
  }
});

test("clearing monitor sessions hides current sessions without resetting their MCP initialization", async () => {
  const sessionKey = "clear-monitor-sessions-test";
  await callTool("start_here", { task: "clear monitor sessions test" }, sessionKey);
  const before = listSessions().find(session => session.task === "clear monitor sessions test");
  assert.ok(before);
  assert.equal(isSessionInitialized(sessionKey), true);

  const clearedCount = clearSessionsFromMonitor();
  assert.ok(clearedCount >= 1);
  assert.equal(listSessions().some(session => session.id === before.id), false);
  assert.equal(isSessionInitialized(sessionKey), true);
  assert.equal(touchSession(sessionKey), undefined);

  const nextCall = await callTool("start_here", { task: "session reappears after new call" }, sessionKey);
  assert.equal(nextCall.payload.result.isError, undefined);
  assert.ok(listSessions().some(session => session.id === before.id));
});
