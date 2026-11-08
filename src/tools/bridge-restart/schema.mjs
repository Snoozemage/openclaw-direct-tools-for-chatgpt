export const bridgeRestartToolDefinition = {
  name: "openclaw_bridge_restart",
  title: "Restart Bridge",
  description: "Restart only the local ChatGPT MCP bridge through its active supervisor. Available only for supervised bridge installations; Gateway and Tunnel remain running. The MCP connection will briefly disconnect. After reconnection, call start_here if the session requires reinitialization.",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};
