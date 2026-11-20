import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { readLinuxConfig, SECRET_ATTRIBUTES } from "./core.mjs";

const config = await readLinuxConfig();
// A systemd After= dependency orders process launches, not HTTP readiness.
// tunnel-client's initial MCP discovery is one-shot; starting it too early
// disables the control-plane poller until the process is restarted.
const bridgeHealth = `http://127.0.0.1:${config.bridgePort}/healthz`;
let bridgeReady = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const response = await fetch(bridgeHealth, { signal: AbortSignal.timeout(1000) });
    const health = response.ok ? await response.json() : null;
    if (health?.server === "openclaw-chatgpt-bridge") {
      bridgeReady = true;
      break;
    }
  } catch { /* Bridge has not started listening yet. */ }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!bridgeReady) {
  throw new Error(`Bridge is not ready at ${bridgeHealth}; tunnel service will retry.`);
}
let key = process.env.CONTROL_PLANE_API_KEY;
if (!key) {
  const result = spawnSync("secret-tool", ["lookup", ...SECRET_ATTRIBUTES], {
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    throw new Error("Cannot read the tunnel API key from Secret Service. Unlock your desktop keyring or rerun npm run setup.");
  }
  key = result.stdout.replace(/\r?\n$/u, "");
}
const env = { ...process.env, CONTROL_PLANE_API_KEY: key };
const child = spawn(config.tunnelClientPath, ["run", "--config", config.tunnelProfilePath], {
  env, stdio: "inherit",
});
key = "";
child.on("error", (error) => {
  console.error("Could not start tunnel-client:", error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
