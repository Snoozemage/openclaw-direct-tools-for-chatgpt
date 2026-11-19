import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { readLinuxConfig, SECRET_ATTRIBUTES } from "./core.mjs";

const config = await readLinuxConfig();
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
