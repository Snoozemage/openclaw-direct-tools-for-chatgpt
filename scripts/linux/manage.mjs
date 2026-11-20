import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { BRIDGE_UNIT, TUNNEL_UNIT, SECRET_ATTRIBUTES, linuxPaths,
  renderLinuxUnit, validatePort, readLinuxConfig, bridgeEnvironment } from "./core.mjs";

const action = process.argv[2];
const paths = linuxPaths({ xdgConfigHome: process.env.XDG_CONFIG_HOME || "" });
const repoRoot = resolve(import.meta.dirname, "../..");
const units = [BRIDGE_UNIT, TUNNEL_UNIT];
const label = "OpenClaw ChatGPT tunnel API key";
const trayScript = resolve(repoRoot, "scripts/linux/tray.py");
const trayAutostartFile = join(dirname(paths.appDir), "autostart", "openclaw-direct-tools-tray.desktop");
const trayDesktopMarker = "# Managed by OpenClaw Direct Tools for ChatGPT.";

if (process.platform !== "linux") throw new Error("Linux lifecycle scripts require Linux.");

function command(program, args, { env = process.env, input, quiet = false, allowFailure = false } = {}) {
  const result = spawnSync(program, args, {
    cwd: repoRoot, env, input, encoding: "utf8",
    stdio: quiet ? ["pipe", "pipe", "pipe"] : (input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit"),
    timeout: 90000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error && !allowFailure) throw result.error;
  if ((result.status !== 0 || result.error) && !allowFailure)
    throw new Error(program + " exited with code " + result.status + (quiet ? ": " + (result.stderr || "").trim() : ""));
  return result;
}

function executable(name) {
  const result = command("which", [name], { quiet: true, allowFailure: true });
  return result.status === 0 ? result.stdout.trim().split("\n")[0] : "";
}

function trayPython() {
  const python = executable("python3");
  if (!python) throw new Error("Python 3 is required for the KDE tray.");
  const result = command(python, ["-c", "from PySide6.QtWidgets import QApplication, QSystemTrayIcon"],
    { quiet: true, allowFailure: true });
  if (result.status !== 0) throw new Error("PySide6/Qt6 is required for the Linux tray (python3-pyside6).");
  return python;
}

function graphicalEnvironment() {
  const env = { ...process.env };
  const result = command("systemctl", ["--user", "show-environment"], { quiet: true, allowFailure: true });
  if (result.status === 0) {
    for (const line of result.stdout.split("\n")) {
      const index = line.indexOf("=");
      if (index < 1) continue;
      const key = line.slice(0, index);
      if (["WAYLAND_DISPLAY", "DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
        "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XAUTHORITY"].includes(key) && !env[key])
        env[key] = line.slice(index + 1);
    }
  }
  return env;
}

function startTray({ optional = false } = {}) {
  const env = graphicalEnvironment();
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) {
    if (!optional) throw new Error("A graphical desktop session is required for the tray.");
    console.log("Tray not launched: no graphical desktop session.");
    return;
  }
  try {
    const python = trayPython();
    const current = command(python, [trayScript, "--status"], { quiet: true, allowFailure: true, env });
    if (current.status === 0) {
      console.log("OpenClaw tray is already running (" + current.stdout.trim() + ").");
      return;
    }
    // A transient systemd user service outlives terminals and native exec sessions.
    // Keep login autostart in the desktop entry rather than permanently enabling this unit.
    const args = ["--user", "--collect", "--service-type=exec", "--unit=openclaw-direct-tools-tray"];
    for (const key of ["WAYLAND_DISPLAY", "DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
      "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XAUTHORITY"]) {
      if (env[key]) args.push("--setenv=" + key + "=" + env[key]);
    }
    command("systemd-run", [...args, python, trayScript]);
    console.log("OpenClaw KDE tray launched through systemd --user.");
  } catch (error) {
    if (!optional) throw error;
    console.log("Tray not launched: " + error.message);
  }
}

function stopTray() {
  const python = executable("python3");
  if (python) command(python, [trayScript, "--quit"], { quiet: true, allowFailure: true });
}

function desktopQuote(value) {
  if (/[\r\n]/u.test(value)) throw new Error("Invalid desktop Exec path");
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

async function installTrayAutostart() {
  const python = trayPython();
  const content = [
    trayDesktopMarker,
    "[Desktop Entry]",
    "Type=Application",
    "Name=OpenClaw Direct Tools",
    "Comment=Gateway, MCP Bridge and Secure MCP Tunnel status",
    "Exec=" + desktopQuote(python) + " " + desktopQuote(trayScript),
    "TryExec=" + python,
    "Terminal=false",
    "StartupNotify=false",
    "OnlyShowIn=KDE;",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
  if (existsSync(trayAutostartFile)) {
    const previous = await readFile(trayAutostartFile, "utf8");
    if (!previous.startsWith(trayDesktopMarker))
      throw new Error("Refusing to replace unrelated autostart file: " + trayAutostartFile);
  }
  await mkdir(dirname(trayAutostartFile), { recursive: true });
  await writeFile(trayAutostartFile, content, { mode: 0o644 });
}

async function uninstallTrayAutostart() {
  if (!existsSync(trayAutostartFile)) return;
  const previous = await readFile(trayAutostartFile, "utf8");
  if (!previous.startsWith(trayDesktopMarker))
    throw new Error("Refusing to remove unrelated autostart file: " + trayAutostartFile);
  await rm(trayAutostartFile);
}

function requirePath(file, description) {
  if (!file || !isAbsolute(file) || !existsSync(file)) {
    throw new Error(description + " not found: " + (file || "(unset)"));
  }
  return realpathSync(file);
}

async function ask(labelText, defaultValue = "") {
  if (!process.stdin.isTTY) {
    if (defaultValue) return defaultValue;
    throw new Error("Set required values using environment variables when running without a terminal: " + labelText);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(labelText + (defaultValue ? " [" + defaultValue + "]" : "") + ": ")).trim() || defaultValue;
  } finally {
    rl.close();
  }
}

async function askHidden() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new Error("Set CONTROL_PLANE_API_KEY in the environment for noninteractive setup.");
  process.stdout.write("OpenAI Platform tunnel API key (hidden): ");
  let key = "";
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    await new Promise((ok, fail) => {
      function onData(data) {
        for (const char of data.toString()) {
          if (char === "\r" || char === "\n") { process.stdin.off("data", onData); ok(); return; }
          if (char === "\u0003") { process.stdin.off("data", onData); fail(new Error("Cancelled")); return; }
          if (char === "\u007f" || char === "\b") key = key.slice(0, -1);
          else if (char >= " ") key += char;
        }
      }
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
  }
  return key;
}

function loadSecret() {
  const result = command("secret-tool", ["lookup", ...SECRET_ATTRIBUTES], { quiet: true, allowFailure: true });
  return result.status === 0 ? (result.stdout || "").replace(/\r?\n$/u, "") : "";
}

function storeSecret(key) {
  if (!key || key.length < 20 || /\s/u.test(key)) throw new Error("Tunnel API key is invalid.");
  command("secret-tool", ["store", "--label=" + label, ...SECRET_ATTRIBUTES], { input: key });
  if (loadSecret() !== key) throw new Error("Secret Service verification failed; local setup was not saved.");
}

function defaultCliPath() {
  const cli = executable("openclaw");
  if (cli) {
    const real = realpathSync(cli);
    if (/\.m?js$/iu.test(real)) return real;
  }
  // Recent OpenClaw installers keep a private Node.js toolchain rather than an npm-global CLI.
  const toolchainDir = join(homedir(), ".openclaw", "tools");
  if (existsSync(toolchainDir)) {
    const toolchains = readdirSync(toolchainDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^node-v\d+/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const toolchain of toolchains) {
      const candidate = join(toolchainDir, toolchain, "lib", "node_modules", "openclaw", "openclaw.mjs");
      if (existsSync(candidate)) return candidate;
    }
  }
  const npm = executable("npm");
  if (npm) {
    const result = command(npm, ["root", "-g"], { quiet: true, allowFailure: true });
    if (result.status === 0) {
      const candidate = join(result.stdout.trim(), "openclaw", "openclaw.mjs");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

async function installUnit(role, nodePath) {
  const fileName = role === "bridge" ? BRIDGE_UNIT : TUNNEL_UNIT;
  const destination = join(paths.unitDir, fileName);
  if (existsSync(destination)) {
    const existing = await readFile(destination, "utf8");
    if (!existing.startsWith("# Managed by OpenClaw Direct Tools for ChatGPT.")) {
      throw new Error("Refusing to replace an unrelated systemd unit: " + destination);
    }
  }
  await writeFile(destination, renderLinuxUnit({ role, repoRoot, nodePath, configPath: paths.configPath }), { mode: 0o600 });
  await chmod(destination, 0o600);
}

async function setup() {
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  if (major < 22 || (major === 22 && minor < 17)) throw new Error("Node.js 22.17+ is required.");
  if (!executable("systemctl")) throw new Error("systemctl is required (systemd user session).");
  if (!executable("secret-tool")) throw new Error("Install Secret Service CLI first: sudo dnf install libsecret");
  const existing = existsSync(paths.configPath) ? await readLinuxConfig(paths.configPath) : null;

  const openclawConfigPath = requirePath(
    process.env.OPENCLAW_CONFIG_PATH || existing?.openclawConfigPath || join(homedir(), ".openclaw", "openclaw.json"),
    "OpenClaw config",
  );
  const gatewaySettings = JSON.parse(await readFile(openclawConfigPath, "utf8"));
  const stateDir = dirname(openclawConfigPath);
  const openclawCliPath = requirePath(
    process.env.OPENCLAW_CLI_PATH || existing?.openclawCliPath || defaultCliPath(),
    "OpenClaw CLI openclaw.mjs (set OPENCLAW_CLI_PATH)",
  );
  if (!/\.m?js$/iu.test(openclawCliPath))
    throw new Error("OPENCLAW_CLI_PATH must point to the Node.js CLI module (openclaw.mjs).");
  const tunnelClientPath = requirePath(
    process.env.OPENCLAW_TUNNEL_CLIENT_PATH || existing?.tunnelClientPath || executable("tunnel-client"),
    "Official tunnel-client binary (set OPENCLAW_TUNNEL_CLIENT_PATH; see https://github.com/openai/tunnel-client/releases/latest)",
  );
  const gatewayPort = validatePort(
    process.env.OPENCLAW_GATEWAY_PORT || existing?.gatewayPort || gatewaySettings.gateway?.port || 18789, "gateway");
  const bridgePort = validatePort(process.env.OPENCLAW_BRIDGE_PORT || existing?.bridgePort || 19002, "bridge");
  const tunnelHealthPort = validatePort(process.env.OPENCLAW_TUNNEL_HEALTH_PORT || existing?.tunnelHealthPort || 8081, "tunnel health");
  if (new Set([gatewayPort, bridgePort, tunnelHealthPort]).size !== 3)
    throw new Error("Gateway, bridge and tunnel health ports must be distinct.");
  const tunnelId = process.env.OPENCLAW_TUNNEL_ID || await ask("Secure MCP Tunnel ID", existing?.tunnelId || "");
  if (!/^tunnel_[A-Za-z0-9_-]{8,}$/u.test(tunnelId)) throw new Error("Invalid tunnel ID.");
  const nodePath = requirePath(process.execPath, "Node.js executable");
  if (typeof gatewaySettings.gateway?.auth?.token !== "string" || !gatewaySettings.gateway.auth.token) {
    throw new Error("Linux setup currently requires gateway.auth.token as a string in openclaw.json; environment/SecretRef tokens are not persisted to the bridge service.");
  }
  command("systemctl", ["--user", "show-environment"], { quiet: true });

  let key = process.env.CONTROL_PLANE_API_KEY || loadSecret();
  if (!key) key = await askHidden();
  storeSecret(key);

  await mkdir(paths.appDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
  await chmod(paths.appDir, 0o700);
  await chmod(paths.profileDir, 0o700);
  await mkdir(paths.unitDir, { recursive: true, mode: 0o700 });
  const tunnelProfilePath = join(paths.profileDir, "openclaw-chatgpt-bridge.yaml");
  command(tunnelClientPath, [
    "init", "--profile", "openclaw-chatgpt-bridge", "--profile-dir", paths.profileDir,
    "--tunnel-id", tunnelId, "--mcp-server-url", "http://127.0.0.1:" + bridgePort + "/mcp",
    "--control-plane-api-key-ref", "env:CONTROL_PLANE_API_KEY",
    "--health-listen-addr", "127.0.0.1:" + tunnelHealthPort, "--force",
  ], { env: { ...process.env, CONTROL_PLANE_API_KEY: key } });
  key = "";
  if (!existsSync(tunnelProfilePath)) throw new Error("Tunnel-client did not create its expected YAML profile.");

  const config = {
    schemaVersion: 1, openclawHome: stateDir, openclawStateDir: stateDir,
    openclawConfigPath, openclawCliPath, nodePath,
    gatewayPort, bridgePort, agentId: existing?.agentId || "main",
    tunnelId, tunnelClientPath, tunnelProfilePath, tunnelHealthPort,
  };
  await writeFile(paths.configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(paths.configPath, 0o600);
  await installUnit("bridge", nodePath);
  await installUnit("tunnel", nodePath);
  command("systemctl", ["--user", "daemon-reload"]);
  // The standalone OpenClaw Node toolchain may not be on the service PATH.
  const bundledNpm = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundledNpm)) command(process.execPath, [bundledNpm, "ci"]);
  else command(requirePath(executable("npm"), "npm executable"), ["ci"]);
  console.log("Linux setup complete. No API key is stored in the repository or config.json.");
  console.log("Run npm start. Optional login startup: npm run autostart:install.");
}

async function start() {
  const config = await readLinuxConfig(paths.configPath);
  const env = bridgeEnvironment(config);
  const gatewayStatus = command(config.nodePath, [config.openclawCliPath, "gateway", "status", "--json"],
    { env, quiet: true, allowFailure: true });
  let ready = false;
  try { ready = gatewayStatus.status === 0 && JSON.parse(gatewayStatus.stdout).rpc?.ok === true; } catch {}
  if (!ready) {
    console.log("Starting the existing OpenClaw Gateway service...");
    command(config.nodePath, [config.openclawCliPath, "gateway", "start"], { env });
  }
  command("systemctl", ["--user", "start", BRIDGE_UNIT, TUNNEL_UNIT]);
  startTray({ optional: true });
  console.log("Services requested. Inspect npm run status or journalctl --user -u " + BRIDGE_UNIT);
  console.log("Monitor: http://127.0.0.1:" + config.bridgePort + "/monitor");
}

async function status() {
  const config = await readLinuxConfig(paths.configPath);
  const gateway = command("systemctl", ["--user", "is-active", "openclaw-gateway.service"], { quiet: true, allowFailure: true });
  const gatewayActive = gateway.stdout.trim() === "active";
  console.log("openclaw-gateway.service: " + (gatewayActive ? "active" : "inactive"));
  if (!gatewayActive) process.exitCode = 1;
  for (const unit of units) {
    const active = command("systemctl", ["--user", "is-active", unit], { quiet: true, allowFailure: true });
    const enabled = command("systemctl", ["--user", "is-enabled", unit], { quiet: true, allowFailure: true });
    console.log(unit + ": " + active.stdout.trim() + " (autostart: " + enabled.stdout.trim() + ")");
    if (active.stdout.trim() !== "active") process.exitCode = 1;
  }
  try {
    const response = await fetch("http://127.0.0.1:" + config.bridgePort + "/healthz",
      { signal: AbortSignal.timeout(2000) });
    const data = await response.json();
    const ready = response.ok && data.ok === true && data.server === "openclaw-chatgpt-bridge";
    console.log("Bridge health: " + (ready ? "ready" : "not ready"));
    if (!ready) process.exitCode = 1;
  } catch { console.log("Bridge health: unavailable"); process.exitCode = 1; }
  try {
    const response = await fetch("http://127.0.0.1:" + config.tunnelHealthPort + "/readyz",
      { signal: AbortSignal.timeout(2000) });
    const body = await response.text();
    let status = "";
    try { status = JSON.parse(body)?.status || ""; } catch {}
    const ready = response.ok && (body.trim() === "ready" || status === "ready");
    console.log("Tunnel readiness: " + (ready ? "ready" : "not ready"));
    if (!ready) process.exitCode = 1;
  } catch { console.log("Tunnel readiness: unavailable"); process.exitCode = 1; }
  console.log("Gateway details: openclaw gateway status --deep");
}

function testCredentialStore() {
  if (!executable("secret-tool")) throw new Error("secret-tool is missing; install libsecret.");
  const attrs = ["service", "OpenClawChatGPTBridgeTest", "nonce", randomUUID()];
  const value = "temporary-test-" + randomUUID();
  let cleared = false;
  try {
    command("secret-tool", ["store", "--label=OpenClaw ChatGPT Bridge temporary test", ...attrs],
      { input: value, quiet: true });
    const result = command("secret-tool", ["lookup", ...attrs], { quiet: true });
    if (result.stdout.replace(/\r?\n$/u, "") !== value)
      throw new Error("Secret Service round-trip failed.");
  } finally {
    const cleanup = command("secret-tool", ["clear", ...attrs], { quiet: true, allowFailure: true });
    cleared = cleanup.status === 0;
  }
  if (!cleared) throw new Error("Could not remove the temporary Secret Service test entry.");
  console.log("Secret Service store/lookup/clear: OK.");
}

async function main() {
  switch (action) {
    case "setup": await setup(); break;
    case "start": await start(); break;
    case "stop":
      command("systemctl", ["--user", "stop", TUNNEL_UNIT, BRIDGE_UNIT]);
      stopTray();
      break;
    case "tray:start": startTray(); break;
    case "tray:stop": stopTray(); break;
    case "tray:status": {
      const python = trayPython();
      command(python, [trayScript, "--status"]);
      break;
    }
    case "status": await status(); break;
    case "bridge:restart":
      await readLinuxConfig(paths.configPath);
      command("systemctl", ["--user", "restart", BRIDGE_UNIT]);
      console.log("Bridge restarted; Gateway and tunnel were left running.");
      break;
    case "logs":
      command("journalctl", ["--user", "--no-pager", "--lines=100",
        "-u", "openclaw-gateway.service", "-u", BRIDGE_UNIT, "-u", TUNNEL_UNIT]);
      break;
    case "test:credential-store": testCredentialStore(); break;
    case "autostart:install":
      await readLinuxConfig(paths.configPath);
      await installTrayAutostart();
      command("systemctl", ["--user", "enable", ...units]);
      console.log("Bridge, tunnel and KDE tray enabled at login. Gateway autostart is managed separately by OpenClaw.");
      break;
    case "autostart:uninstall":
      command("systemctl", ["--user", "disable", ...units]);
      await uninstallTrayAutostart();
      break;
    default: throw new Error("Unsupported Linux command: " + action);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
