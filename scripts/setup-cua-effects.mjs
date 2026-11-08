import { execFile as execFileCallback, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import path from "node:path";
import { gatewayCall } from "../src/openclaw-client.mjs";

const execFile = promisify(execFileCallback);
const command = process.env.OPENCLAW_CUA_DRIVER_PATH
  || path.join(process.env.LOCALAPPDATA, "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe");
await access(command);
const run = async (...args) => {
  const { stdout } = await execFile(command, args, {
    windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
};
console.log(await run("--version"));

// These are visual preferences only. Keep CUA's permission mode and OpenClaw's
// effective tool policy unchanged; register through the live, validated API.
const settings = {
  "cursor.halo": "on",
  "cursor.float": "on",
  "cursor.marks": "on",
  "cursor.badges": "verbose",
  "cursor.motion.style": "signature_arc",
  "cursor.motion.timing": "steady",
  "cursor.motion.effects.glow": "true",
  "cursor.motion.effects.ripple": "true",
  "cursor.motion.effects.squish": "true",
  "cursor.motion.effects.trail": "true",
};
// The CLI writes preferences through a daemon even when the eventual MCP
// connection owns its runtime. Start a temporary process only when needed.
let temporaryDaemon;
try {
  try { await run("status"); }
  catch (error) {
    if (!String(error.stderr).includes("daemon is not running")) throw error;
    let launchError;
    temporaryDaemon = spawn(command, ["serve"], { windowsHide: true, stdio: "ignore" });
    temporaryDaemon.on("error", error => { launchError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (launchError) throw launchError;
      if (temporaryDaemon.exitCode !== null) throw new Error("Temporary CUA daemon exited before readiness.");
      await delay(250);
      try { await run("status"); ready = true; break; }
      catch (error) {
        if (!String(error.stderr).includes("daemon is not running")) throw error;
      }
    }
    if (!ready) throw new Error("Temporary CUA daemon did not become ready.");
  }
  for (const [key, value] of Object.entries(settings)) {
    await run("config", "set", key, value);
    console.log("Configured " + key);
  }
} finally {
  // This process is setup-owned and has admitted no desktop work.
  temporaryDaemon?.kill();
}

const snapshot = await gatewayCall("config.get", {});
const existing = snapshot.config?.mcp?.servers?.["cua-driver"];
if (existing && (existing.command !== command || existing.url)) {
  throw new Error("An existing cua-driver server has a different endpoint; it was not overwritten.");
}
const server = {
  enabled: true, transport: "stdio", command, args: ["mcp"],
  connectionTimeoutMs: 30000, requestTimeoutMs: 120000,
  toolFilter: { include: [
    "start_session", "end_session", "get_session_state",
    "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_theme",
    "get_agent_cursor_state", "list_apps", "list_windows", "get_window_state",
    "get_desktop_state", "get_screen_size", "get_cursor_position", "move_cursor",
    "click", "type_text", "press_key", "hotkey", "scroll", "drag",
    "launch_app", "bring_to_front", "set_value", "invoke_menu", "zoom",
  ] },
};
const result = await gatewayCall("config.patch", {
  baseHash: snapshot.hash,
  raw: JSON.stringify({ mcp: { servers: { "cua-driver": server } } }),
  response: "summary",
  note: "Enable session-owned CUA cursor effects for ChatGPT desktop control.",
}, 60000);
console.log(JSON.stringify(result));
