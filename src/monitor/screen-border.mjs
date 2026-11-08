import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export function createScreenBorderController({
  platform = process.platform, spawn = spawnProcess, now = Date.now,
  leaseMs = 5 * 60 * 1000, interval = setInterval, cancelInterval = clearInterval,
  timeout = setTimeout, cancelTimeout = clearTimeout,
} = {}) {
  const leases = new Map();
  let child, heartbeat, ready = false, details, lastError;
  const script = fileURLToPath(new URL("../../scripts/windows/screen-border.ps1", import.meta.url));

  function stopChild() {
    const previous = child;
    child = undefined;
    ready = false;
    details = undefined;
    if (!previous) return;
    try { previous.stdin.end("stop\n"); } catch {}
    const killer = timeout(() => { try { previous.kill(); } catch {} }, 5000);
    killer.unref?.();
    previous.once("exit", () => cancelTimeout(killer));
  }
  function pulse() {
    for (const [key, expiry] of leases) if (expiry <= now()) leases.delete(key);
    if (!leases.size) {
      if (heartbeat) cancelInterval(heartbeat);
      heartbeat = undefined;
      stopChild();
      return;
    }
    if (platform !== "win32") return;
    if (!child) {
      try {
        const launched = spawn("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
          "-File", script, "-ParentProcessId", String(process.pid),
        ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        child = launched;
        lastError = undefined;
        let buffer = "";
        launched.stdout.on("data", bytes => {
          buffer = (buffer + bytes.toString()).slice(-16000);
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            try {
              const event = JSON.parse(line);
              if (child === launched && event.event === "ready") {
                ready = true;
                details = event;
              }
            } catch {}
          }
        });
        launched.stderr.on("data", bytes => { lastError = bytes.toString().trim().slice(-1200); });
        const failed = error => {
          if (child !== launched) return;
          lastError = error?.message || "Screen border helper exited.";
          child = undefined; ready = false; details = undefined;
          // A rendering error must not start a tight process-restart loop.
          if (heartbeat) cancelInterval(heartbeat);
          heartbeat = undefined;
        };
        launched.on("error", failed);
        launched.stdin.on("error", failed);
        launched.once("exit", () => failed());
      } catch (error) { lastError = error.message; return; }
    }
    try { child?.stdin.write("active\n"); } catch (error) { lastError = error.message; }
  }
  function open(key) {
    if (platform !== "win32") return;
    leases.set(key, now() + leaseMs);
    if (!heartbeat) { heartbeat = interval(pulse, 1000); heartbeat.unref?.(); }
    pulse();
  }
  function close(key) { leases.delete(key); pulse(); }
  function clear(prefix = "") {
    for (const key of leases.keys()) if (key.startsWith(prefix)) leases.delete(key);
    pulse();
  }
  function getStatus() {
    return {
      supported: platform === "win32", active: leases.size > 0,
      sessionCount: leases.size, helperRunning: Boolean(child), ready,
      ...(details ? { renderer: details } : {}),
      ...(lastError ? { error: lastError } : {}),
    };
  }
  return { open, close, clear, getStatus, dispose: () => clear(), pulse };
}

const CUA_OPERATIONS = new Set([
  "start_session", "move_cursor", "click", "right_click", "double_click", "drag",
  "scroll", "type_text", "press_key", "hotkey", "get_desktop_state", "get_window_state",
  "bring_to_front", "launch_app", "set_value", "invoke_menu", "zoom",
]);
function succeeded(result) {
  return result?.isError !== true && result?.details?.isError !== true;
}
export function createCuaBorderLifecycle(indicator) {
  let sequence = 0;
  return {
    clear: () => indicator.clear("cua:"),
    async run(id, args, operation) {
      const action = id.replace(/^cua-driver__/, "");
      const key = "cua:session:" + (args.session ?? "implicit");
      const pending = "cua:pending:" + (++sequence);
      const track = CUA_OPERATIONS.has(action);
      if (track) indicator.open(pending);
      try {
        const result = await operation();
        if (succeeded(result)) {
          if (action === "end_session") indicator.close(key);
          else if (track) indicator.open(key);
        } else indicator.clear("cua:");
        return result;
      } catch (error) {
        indicator.clear("cua:");
        throw error;
      } finally {
        if (track) indicator.close(pending);
      }
    },
  };
}
export const screenBorder = createScreenBorderController();
export const cuaBorderLifecycle = createCuaBorderLifecycle(screenBorder);
