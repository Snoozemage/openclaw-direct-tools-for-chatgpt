import process from "node:process";

export function createBridgeRestartController({
  isSupervised = () => process.env.OPENCLAW_BRIDGE_SUPERVISED === "1",
  schedule = (callback) => setTimeout(callback, 1000),
  getPid = () => process.pid,
} = {}) {
  let shutdown = null;
  let pending = false;

  return {
    bindShutdown(callback) {
      if (typeof callback !== "function") throw new TypeError("Bridge shutdown handler must be a function.");
      shutdown = callback;
    },
    request() {
      if (!isSupervised() || !shutdown) {
        return { statusCode: 503, body: { error: "Bridge restart requires an active bridge supervisor." } };
      }
      if (pending) {
        return { statusCode: 409, body: { error: "Bridge restart is already pending." } };
      }
      pending = true;
      try {
        schedule(shutdown);
      } catch (error) {
        pending = false;
        return { statusCode: 500, body: { error: "Could not schedule bridge restart." } };
      }
      return {
        statusCode: 202,
        body: {
          ok: true,
          status: "scheduled",
          previousPid: getPid(),
          message: "The bridge supervisor will restart the bridge. Gateway and Tunnel are not managed by it.",
        },
      };
    },
  };
}

export const bridgeRestart = createBridgeRestartController();
