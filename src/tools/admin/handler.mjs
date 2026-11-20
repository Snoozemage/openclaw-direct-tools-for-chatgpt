import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { makeAdminPlan, isJobId } from "./operations.mjs";

const execFile = promisify(execFileCallback);
const runner = resolve(import.meta.dirname, "../../../scripts/linux/admin-runner.mjs");

function response(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}
function failure(error) {
  return { isError: true, content: [{ type: "text", text: error?.message || String(error) }] };
}
function getRoot() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() === 0)
    throw new Error("KDE administration is only available from an unprivileged Linux user session.");
  const sessionDir = process.env.XDG_RUNTIME_DIR;
  if (!sessionDir || sessionDir !== "/run/user/" + process.getuid())
    throw new Error("No trusted XDG_RUNTIME_DIR; sign into the Fedora desktop session.");
  return join(sessionDir, "openclaw-chatgpt-bridge", "admin-jobs");
}
function adminRequest(args) {
  if (args.action !== "run") throw new TypeError("This action must be run.");
  const { action: _action, jobId: _jobId, ...requested } = args;
  if (_jobId !== undefined) throw new TypeError("jobId is only valid for status requests.");
  return makeAdminPlan(requested);
}
export function createAdminHandler({ runUnit = execFile, idGenerator = () => randomUUID().replaceAll("-", "") } = {}) {
  return async function handleAdminTool(name, args = {}) {
    if (name !== "openclaw_admin") return undefined;
    try {
      const root = getRoot();
      if (args.action === "status") {
        if (!isJobId(args.jobId) || Object.keys(args).some((key) => !["action", "jobId"].includes(key)))
          throw new TypeError("Expected action=status with a valid jobId only.");
        const state = JSON.parse(await readFile(join(root, args.jobId + ".json"), "utf8"));
        if (state.jobId !== args.jobId) throw new Error("Job status mismatch.");
        return response(state);
      }
      if (args.action !== "run") throw new TypeError("Expected action=run or action=status.");
      const plan = adminRequest(args);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const jobId = idGenerator();
      if (!isJobId(jobId)) throw new TypeError("Invalid generated job ID.");
      const statePath = join(root, jobId + ".json");
      const initial = { jobId, state: "queued", purpose: plan.purpose, command: plan.display, updatedAt: new Date().toISOString() };
      await writeFile(statePath, JSON.stringify(initial) + "\n", { mode: 0o600, flag: "wx" });
      const payload = Buffer.from(JSON.stringify({
        command: plan.display,
        purpose: plan.purpose,
        ...(plan.workdir ? { workdir: plan.workdir } : {}),
        timeoutSeconds: plan.timeoutMs / 1000,
      })).toString("base64url");
      const unitName = "openclaw-admin-" + jobId;
      try {
        await runUnit("/usr/bin/systemd-run", [
          "--user", "--quiet", "--collect", "--unit=" + unitName,
          "--property=NoNewPrivileges=no",
          process.execPath, runner, jobId, payload,
        ], { timeout: 10000, maxBuffer: 4096, windowsHide: true });
      } catch (error) {
        // No job ID is returned on launch failure, so do not leave orphaned queue data.
        await unlink(statePath).catch(() => {});
        throw error;
      }
      return response({
        jobId, state: "queued", purpose: plan.purpose, command: plan.display,
        message: "KDE displays the purpose before the root command. Polkit requests authentication if needed. Use action=status with jobId to get the result.",
      });
    } catch (error) {
      return failure(error);
    }
  };
}

export const handleAdminTool = createAdminHandler();
