import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { networkInterfaces } from "node:os";
import { readLinuxConfig, SECRET_ATTRIBUTES, networkFingerprint } from "./core.mjs";

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

// An already-established TCP connection can remain stuck after changing Wi-Fi,
// gateway or local IP. systemd cannot recover it while the process is alive.
// On a confirmed network transition, exit unsuccessfully so Restart=on-failure
// starts a fresh tunnel-client with new sockets. Do not restart on a lone sample.
function currentNetwork() {
  const route = spawnSync("ip", ["-4", "route", "show", "default"], {
    encoding: "utf8", timeout: 2000,
  });
  if (route.status !== 0) return null; // Do not restart on ip command errors.
  return networkFingerprint(route.stdout, networkInterfaces());
}
let baselineNetwork = currentNetwork();
let networkWasDown = baselineNetwork === "";
let pendingNetwork = null;
let networkRestart = false;
let stopping = false;
const networkCheck = setInterval(() => {
  if (stopping || networkRestart) return;
  const observed = currentNetwork();
  if (observed === null) return;
  if (observed === "") { networkWasDown = true; pendingNetwork = null; return; }
  if (baselineNetwork === null || baselineNetwork === "") {
    baselineNetwork = observed;
    networkWasDown = false;
    return;
  }
  if (!networkWasDown && observed === baselineNetwork) {
    pendingNetwork = null;
    return;
  }
  if (pendingNetwork !== observed) { pendingNetwork = observed; return; }
  console.error("Tunnel network changed or reconnected; restarting tunnel-client.");
  networkRestart = true;
  child.kill("SIGTERM");
  // In case the child ignores SIGTERM, guarantee it cannot retain a stale socket.
  const forceStop = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
  forceStop.unref();
}, 5000);
networkCheck.unref();

child.on("error", (error) => {
  console.error("Could not start tunnel-client:", error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  clearInterval(networkCheck);
  process.exitCode = networkRestart ? 1 : (code ?? (signal ? 1 : 0));
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(networkCheck);
    if (!child.killed) child.kill(signal);
  });
}
