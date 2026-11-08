export const startHereToolDefinition = {
  name: "start_here",
  title: "Initialize ChatGPT Session",
  description: "Initialize this ChatGPT conversation and load the bridge's full tool-routing instructions. Must be called successfully before any other bridge tool in this conversation.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Optional short label for the current work, shown in the local monitor.", maxLength: 160 },
    },
    additionalProperties: false,
  },
};
