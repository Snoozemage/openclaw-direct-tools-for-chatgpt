import { startHereToolDefinition } from "../tools/start-here/schema.mjs";
import { bridgeRestartToolDefinition } from "../tools/bridge-restart/schema.mjs";
import { browserToolDefinition } from "../tools/browser/schema.mjs";
import { computerToolDefinition } from "../tools/computer/schema.mjs";
import { imageRenderToolDefinition } from "../tools/image-render/schema.mjs";
import { fileToolDefinitions } from "../tools/files/schema.mjs";
import { fileSearchToolDefinitions } from "../tools/file-search/schema.mjs";
import { codebaseIntelligenceToolDefinition } from "../tools/codebase-intelligence/schema.mjs";
import { runtimeToolDefinitions } from "../tools/runtime/schema.mjs";
import { toolDiscoveryDefinitions } from "../tools/tool-discovery/schema.mjs";

// Assemble the public MCP tool list from the tool schemas.
export const toolDefinitions = [startHereToolDefinition, bridgeRestartToolDefinition, browserToolDefinition, computerToolDefinition, imageRenderToolDefinition, ...fileToolDefinitions, ...fileSearchToolDefinitions, codebaseIntelligenceToolDefinition, ...runtimeToolDefinitions, ...toolDiscoveryDefinitions];
