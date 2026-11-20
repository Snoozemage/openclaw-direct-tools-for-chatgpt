// Run by a one-shot systemd *user* unit, outside the NoNewPrivileges=true Bridge.
// This process stays unprivileged; pkexec authorizes the requested root shell.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { makeAdminPlan, isJobId } from "../../src/tools/admin/operations.mjs";

const OUTPUT_LIMIT = 10000;

function jobRoot() {
  if (!process.env.XDG_RUNTIME_DIR || process.getuid?.() === 0)
    throw new Error("An unprivileged graphical user session is required.");
  return join(process.env.XDG_RUNTIME_DIR, "openclaw-chatgpt-bridge", "admin-jobs");
}

async function record(jobId, state) {
  const root = jobRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, jobId + ".json");
  const tmp = target + ".tmp." + process.pid;
  await writeFile(tmp, JSON.stringify({ jobId, updatedAt: new Date().toISOString(), ...state }) + "\n", { mode: 0o600 });
  await rename(tmp, target);
}

function invoke(program, args, { capture = false, timeoutMs = 0, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
    let timedOut = false;
    const timeout = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs) : null;
    let output = "";
    let error = "";
    const collect = (which, chunk) => {
      const text = chunk.toString("utf8");
      if (which === "out") output = (output + text).slice(-OUTPUT_LIMIT);
      else error = (error + text).slice(-OUTPUT_LIMIT);
    };
    child.stdout?.on("data", (chunk) => collect("out", chunk));
    child.stderr?.on("data", (chunk) => collect("err", chunk));
    child.once("error", (e) => { if (timeout) clearTimeout(timeout); resolve({ code: 127, output: "", error: e.message }); });
    child.once("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      resolve({
      code: timedOut ? 124 : (code ?? 1), signal: signal ?? null,
      output: capture ? output : "",
      error: capture ? error : "",
      });
    });
  });
}

async function main() {
  const [jobId, encoded] = process.argv.slice(2);
  if (!isJobId(jobId) || !encoded || encoded.length > 32768 || !/^[A-Za-z0-9_-]+$/u.test(encoded))
    throw new Error("Malformed administrative job.");
  const plan = makeAdminPlan(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  const status = await readFile("/proc/self/status", "utf8");
  if (!/^NoNewPrivs:\s*0\s*$/mu.test(status))
    throw new Error("The helper inherited NoNewPrivileges; refusing to request elevation.");
  if (!process.env.DBUS_SESSION_BUS_ADDRESS || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY))
    throw new Error("No GUI session available for a KDE authorization dialog.");
  if (!existsSync(plan.program) || !existsSync("/usr/bin/pkexec") || !existsSync("/usr/bin/notify-send"))
    throw new Error("Required administrator command, pkexec or desktop notification utility is missing.");

  // A non-modal KDE notification identifies the purpose, even if Polkit has cached
  // authentication. Do not proceed silently if the notification service rejects it.
  const notice = await invoke("/usr/bin/notify-send", [
    "--app-name=OpenClaw", "--icon=dialog-password", "--expire-time=15000",
    "OpenClaw cần quyền quản trị", plan.purpose,
  ], { capture: true });
  if (notice.code !== 0)
    throw new Error("Could not show the purpose on the desktop: " + (notice.error || notice.code));

  // Only Polkit handles authorization. KDE presents its native authentication dialog
  // when required; a cached authorization may allow the operation without a new dialog.
  await record(jobId, { state: "authenticating", purpose: plan.purpose, command: plan.display });
  const result = await invoke("/usr/bin/pkexec", [plan.program, ...plan.args], {
    capture: true, timeoutMs: plan.timeoutMs, cwd: plan.workdir,
  });
  // pkexec returns 126 if authorization was dismissed, and 127 for an authorization error.
  const state = result.code === 0 ? "completed" : (result.code === 126 ? "cancelled" : "failed");
  await record(jobId, {
    state, purpose: plan.purpose, command: plan.display, exitCode: result.code,
    stdout: result.output, stderr: result.error,
    ...(result.signal ? { signal: result.signal } : {}),
  });
}

const jobId = process.argv[2];
main().catch(async (error) => {
  if (isJobId(jobId)) {
    try { await record(jobId, { state: "failed", message: error.message }); }
    catch { /* The unprivileged runner cannot store its error. */ }
  }
  process.stderr.write("OpenClaw admin helper failed: " + error.message + "\n");
  process.exitCode = 1;
});
