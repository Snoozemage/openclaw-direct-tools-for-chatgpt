const string = (description, extra = {}) => ({ type: "string", description, ...extra });

export const toolDiscoveryDefinitions = [
  {
    name: "openclaw_tool_search",
    title: "Search OpenClaw Tools",
    description: "Search tools available in the current OpenClaw agent runtime, including eligible core and plugin tools not directly wrapped by this bridge. Returns compact descriptions and input signatures. Use English keywords for best results because native tool metadata is primarily English. Results are limited to tools with an exact schema and effective availability; directly wrapped tools are omitted to avoid bypassing bridge-specific behavior.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { ...string("Required search text, such as 'schedule reminder', 'Android UI', or 'read memory'.", { minLength: 1, maxLength: 200 }) },
        limit: { type: "integer", description: "Maximum results; defaults to 8 and is capped at 20.", minimum: 1, maximum: 20 },
        source: { type: "string", enum: ["core", "plugin", "mcp", "channel"], description: "Optional source filter." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "openclaw_tool_describe",
    title: "Describe OpenClaw Tool",
    description: "Return the exact input schema and available output schema for a tool id returned by openclaw_tool_search. Uses schemas built by the installed OpenClaw runtime; it does not invent missing schemas. Call this before dispatching a tool when the compact search signature is insufficient.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: string("Exact tool id returned by openclaw_tool_search.", { minLength: 1, maxLength: 200 }),
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "openclaw_dispatch_action",
    title: "Dispatch OpenClaw Tool",
    description: "Invoke one tool discovered through openclaw_tool_search. Supply its exact id and target-specific args. The bridge refreshes effective tool availability before dispatch; OpenClaw Gateway permissions, approvals, hooks, validation, and HTTP-invocation restrictions remain authoritative. Directly wrapped tools are intentionally excluded because their bridge wrappers enforce additional behavior.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: string("Exact tool id returned by openclaw_tool_search.", { minLength: 1, maxLength: 200 }),
        args: { type: "object", description: "Arguments matching the exact input schema returned by openclaw_tool_describe.", additionalProperties: true },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];
