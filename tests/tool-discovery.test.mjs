import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAvailableToolCatalog,
  describeTool,
  formatInputSignature,
  searchToolCatalog,
} from "../src/tools/tool-discovery/engine.mjs";
import { createToolDiscoveryHandler } from "../src/tools/tool-discovery/handler.mjs";
import { toolDiscoveryDefinitions } from "../src/tools/tool-discovery/schema.mjs";

function makeCatalog() {
  return [{
    id: "mobile_ui",
    name: "mobile_ui",
    source: "core",
    label: "Mobile UI",
    group: "Nodes",
    status: "available",
    description: "Observe and control a paired Android app using accessibility.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["observe", "act"], description: "Required operation." },
        node: { type: "string", description: "Paired Android node." },
      },
      required: ["action"],
    },
  }];
}

test("tool discovery exposes three compact controls with accurate annotations", () => {
  assert.deepEqual(toolDiscoveryDefinitions.map((tool) => tool.name), [
    "openclaw_tool_search",
    "openclaw_tool_describe",
    "openclaw_dispatch_action",
  ]);
  assert.equal(toolDiscoveryDefinitions[0].annotations.readOnlyHint, true);
  assert.equal(toolDiscoveryDefinitions[1].annotations.readOnlyHint, true);
  assert.equal(toolDiscoveryDefinitions[2].annotations.destructiveHint, true);
  assert.equal(toolDiscoveryDefinitions[2].inputSchema.required.includes("id"), true);
});

test("effective inventory includes only available tools with exact runtime schemas", () => {
  const effective = {
    groups: [{
      id: "core",
      label: "Tools",
      source: "core",
      tools: [
        { id: "memory_search", source: "core", description: "Search memory" },
        { id: "browser", source: "core", description: "Control browser" },
        { id: "schema_missing", source: "core", description: "No schema" },
        { id: "not_available", source: "core", description: "Disabled tool" },
        { id: "ambiguous", source: "core", description: "First duplicate" },
      ],
    }, {
      id: "plugin",
      label: "Plugin tools",
      source: "plugin",
      tools: [{ id: "ambiguous", source: "plugin", description: "Duplicate plugin name" }],
    }],
    toolAccess: {
      tools: [
        { id: "memory_search", status: "available" },
        { id: "browser", status: "available" },
        { id: "schema_missing", status: "available" },
        { id: "not_available", status: "unavailable" },
        { id: "ambiguous", status: "available" },
      ],
    },
  };
  const runtimeTools = [
    { name: "memory_search", description: "Search the memory store", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "browser", description: "Native browser", parameters: { type: "object", properties: {} } },
    { name: "not_available", description: "Disabled", parameters: { type: "object", properties: {} } },
    { name: "ambiguous", description: "Duplicate", parameters: { type: "object", properties: {} } },
  ];
  const catalog = buildAvailableToolCatalog(effective, runtimeTools);
  assert.deepEqual(catalog.map((tool) => tool.id), ["memory_search"]);
});

test("only native policy-approved CUA schemas supplement a cold Gateway MCP preview", () => {
  const schema = { type: "object", properties: { session: { type: "string" } } };
  const tools = [
    { name: "cua-driver__get_agent_cursor_state", source: "mcp", nativePolicyValidated: true, parameters: schema },
    { name: "cua-driver__click", source: "mcp", parameters: schema },
    { name: "other__tool", source: "mcp", nativePolicyValidated: true, parameters: schema },
  ];
  const catalog = buildAvailableToolCatalog({}, tools);
  assert.deepEqual(catalog.map(tool => tool.id), ["cua-driver__get_agent_cursor_state"]);
  assert.deepEqual(describeTool(catalog, "cua-driver__get_agent_cursor_state").inputSchema, schema);
  const denied = {
    groups: [{ tools: [{ id: "cua-driver__get_agent_cursor_state", source: "mcp" }] }],
    toolAccess: { tools: [{ id: "cua-driver__get_agent_cursor_state", status: "unavailable" }] },
  };
  assert.deepEqual(buildAvailableToolCatalog(denied, tools), []);
});

test("compact signatures show requiredness, enum values, and bounded output", () => {
  assert.equal(
    formatInputSignature({
      type: "object",
      properties: { action: { type: "string", enum: ["observe", "act"] }, node: { type: "string" } },
      required: ["action"],
    }),
    '{ action: "observe" | "act"; node?: string }',
  );
  assert.ok(formatInputSignature({ type: "object", properties: Object.fromEntries(Array.from({ length: 100 }, (_, i) => ["parameter" + i, { type: "string" }])) }, 120).length <= 120);
});

test("tool search ranks exact names and searches parameter names and descriptions", () => {
  const catalog = [
    { id: "automations", label: "Automations", source: "core", group: "Automation", description: "Manage scheduled work", inputSchema: { type: "object", properties: { action: { type: "string", description: "Create a recurring reminder schedule." } } } },
    { id: "mobile_ui", label: "Mobile UI", source: "core", group: "Nodes", description: "Control Android accessibility interface", inputSchema: { type: "object", properties: { node: { type: "string", description: "Android device" } } } },
    { id: "memory_search", label: "Memory Search", source: "plugin", group: "Memory", description: "Search stored context", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { id: "mcp_widget", label: "External Widget", source: "mcp", group: "External", description: "External tool", inputSchema: { type: "object", properties: { hiddenSecretParam: { type: "string", description: "Android accessibility private parameter" } } } },
  ];
  assert.equal(searchToolCatalog(catalog, "mobile_ui")[0].id, "mobile_ui");
  assert.equal(searchToolCatalog(catalog, "android accessibility")[0].id, "mobile_ui");
  assert.equal(searchToolCatalog(catalog, "schedule reminder", 8, "core")[0].id, "automations");
  assert.deepEqual(searchToolCatalog(catalog, "schedule reminder", 8, "mcp"), []);
  const externalMatch = searchToolCatalog(catalog, "external", 8, "mcp");
  assert.equal(externalMatch[0].id, "mcp_widget");
  assert.equal(externalMatch[0].input, "unknown");
  assert.throws(() => searchToolCatalog(catalog, "  "), /non-empty/);
});

test("describe returns exact schema and rejects ids not in the current catalog", () => {
  const catalog = makeCatalog();
  assert.deepEqual(describeTool(catalog, "mobile_ui").inputSchema, catalog[0].inputSchema);
  assert.throws(() => describeTool(catalog, "unavailable_tool"), /not uniquely available/);
});

test("handler searches, describes, and dispatches using the discovered exact id", async () => {
  const calls = [];
  const catalog = makeCatalog();
  const handler = createToolDiscoveryHandler({
    loadCatalog: async (options) => {
      calls.push({ kind: "load", forceRefresh: options?.forceRefresh === true });
      return catalog;
    },
    dispatch: async (id, args) => {
      calls.push({ kind: "dispatch", id, args });
      return { ok: true, output: { content: [{ type: "text", text: "done" }], details: { status: "completed" } }, diagnostics: { elapsedMs: 5 } };
    },
  });

  const search = await handler("openclaw_tool_search", { query: "Android accessibility" });
  assert.equal(search.structuredContent.matches[0].id, "mobile_ui");

  const described = await handler("openclaw_tool_describe", { id: "mobile_ui" });
  assert.deepEqual(described.structuredContent.inputSchema, catalog[0].inputSchema);

  const dispatched = await handler("openclaw_dispatch_action", { id: "mobile_ui", args: { action: "observe" } });
  assert.equal(dispatched.content[0].text, "done");
  assert.deepEqual(dispatched.structuredContent, { status: "completed" });
  assert.deepEqual(calls.filter((call) => call.kind === "dispatch"), [{ kind: "dispatch", id: "mobile_ui", args: { action: "observe" } }]);
  assert.equal(calls.filter((call) => call.kind === "load").at(-1).forceRefresh, true);
});

test("dispatch refuses unknown ids and non-object arguments before invocation", async () => {
  let dispatchCount = 0;
  const handler = createToolDiscoveryHandler({
    loadCatalog: async () => makeCatalog(),
    dispatch: async () => { dispatchCount += 1; return { ok: true, output: {} }; },
  });
  const unknown = await handler("openclaw_dispatch_action", { id: "not_in_catalog", args: {} });
  assert.equal(unknown.isError, true);
  const arrayArgs = await handler("openclaw_dispatch_action", { id: "mobile_ui", args: ["bad"] });
  assert.equal(arrayArgs.isError, true);
  assert.equal(dispatchCount, 0);
  assert.equal(await handler("openclaw_browser", {}), undefined);
});
