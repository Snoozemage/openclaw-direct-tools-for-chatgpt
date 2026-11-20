import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const action = process.argv[2];
const repoRoot = resolve(import.meta.dirname, "..");
const windowsScripts = {
  setup: "scripts/windows/setup.ps1",
  start: "scripts/windows/service-start.ps1",
  stop: "scripts/windows/service-stop.ps1",
  "autostart:install": "scripts/windows/install-autostart.ps1",
  "autostart:uninstall": "scripts/windows/uninstall-autostart.ps1",
  status: "scripts/windows/status.ps1",
  "bridge:restart": "scripts/windows/restart-bridge.ps1",
  logs: "scripts/windows/logs.ps1",
  test: "tests/smoke.ps1",
  check: "tests/check-syntax.ps1",
  "test:credential-store": "tests/windows-credential-store.ps1",
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (action === "test" && process.platform === "linux") {
  const tests = readdirSync(resolve(repoRoot, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => resolve(repoRoot, "tests", name));
  run(process.execPath, ["--import", resolve(repoRoot, "tests/test-environment.mjs"), "--test", ...tests]);
} else if (action === "check" && process.platform === "linux") {
  const roots = ["src", "scripts"];
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
      const child = dir + "/" + entry.name;
      if (entry.isDirectory() && !["node_modules", "vendor"].includes(entry.name)) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(child);
    }
  }
  roots.forEach(visit);
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", resolve(repoRoot, file)], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log("Syntax checked " + files.length + " JavaScript modules.");
} else if (process.platform === "win32") {
  if (!windowsScripts[action]) throw new Error("Unknown command: " + action);
  run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(repoRoot, windowsScripts[action])]);
} else if (process.platform === "linux") {
  const supported = ["setup", "start", "stop", "status", "autostart:install", "autostart:uninstall",
    "bridge:restart", "logs", "test:credential-store"];
  if (!supported.includes(action)) throw new Error("Unknown command: " + action);
  run(process.execPath, [resolve(repoRoot, "scripts/linux/manage.mjs"), action]);
} else {
  throw new Error("Platform " + process.platform + " is not supported by the lifecycle scripts yet.");
}
