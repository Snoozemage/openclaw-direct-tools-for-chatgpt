import { handleStartHereTool } from "../tools/start-here/handler.mjs";
import { handleBridgeRestartTool } from "../tools/bridge-restart/handler.mjs";
import { handleBrowserTool } from "../tools/browser/handler.mjs";
import { handleComputerTool } from "../tools/computer/handler.mjs";
import { handleImageRenderTool } from "../tools/image-render/handler.mjs";
import { handleFileTool } from "../tools/files/handler.mjs";
import { handleFileSearchTool } from "../tools/file-search/handler.mjs";
import { handleCodebaseIntelligenceTool } from "../tools/codebase-intelligence/handler.mjs";
import { handleRuntimeTool } from "../tools/runtime/handler.mjs";
import { handleToolDiscovery } from "../tools/tool-discovery/handler.mjs";

const handlers = [handleStartHereTool, handleBridgeRestartTool, handleBrowserTool, handleComputerTool, handleImageRenderTool, handleFileTool, handleFileSearchTool, handleCodebaseIntelligenceTool, handleRuntimeTool, handleToolDiscovery];

export async function callBridgeTool(name, args = {}) {
  for (const handler of handlers) {
    const result = await handler(name, args);
    if (result !== undefined) return result;
  }
  return { isError: true, content: [{ type: "text", text: "Unknown MCP tool: " + name }] };
}
