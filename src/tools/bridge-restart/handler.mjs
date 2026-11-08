import { bridgeRestart } from "../../bridge-restart.mjs";
import { bridgeRestartToolDefinition } from "./schema.mjs";

export function createBridgeRestartToolHandler({ controller = bridgeRestart } = {}) {
  return async function handleBridgeRestartTool(name) {
    if (name !== bridgeRestartToolDefinition.name) return undefined;
    const result = controller.request();
    return {
      ...(result.statusCode !== 202 ? { isError: true } : {}),
      content: [{ type: "text", text: JSON.stringify(result.body, null, 2) }],
      structuredContent: { ...result.body, httpStatus: result.statusCode },
    };
  };
}

export const handleBridgeRestartTool = createBridgeRestartToolHandler();
