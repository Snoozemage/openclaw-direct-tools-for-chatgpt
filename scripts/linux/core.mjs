import { homedir } from "node:os";
import { posix } from "node:path";
import { readFile } from "node:fs/promises";

// A routing change can strand an established tunnel TCP connection without
// exiting tunnel-client. Fingerprint the default route and its IPv4 source(s).
export function networkFingerprint(defaultRoutes, interfaces) {
  const routes = defaultRoutes.trim().split("\n").map((line) => line.trim()).filter(Boolean).sort();
  if (!routes.length) return "";
  const devices = [...new Set(routes.flatMap((line) => [...line.matchAll(/\bdev\s+(\S+)/gu)].map((match) => match[1])))];
  const addresses = devices.flatMap((device) => (interfaces[device] || [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => `${device}:${item.address}`)).sort();
  return JSON.stringify({ routes, addresses });
}

export const BRIDGE_UNIT = "openclaw-chatgpt-bridge.service";
export const TUNNEL_UNIT = "openclaw-chatgpt-tunnel.service";
export const SECRET_ATTRIBUTES = ["service", "OpenClawChatGPTBridge", "key", "CONTROL_PLANE_API_KEY"];

export function linuxPaths({ home = homedir(), xdgConfigHome = process.env.XDG_CONFIG_HOME || "" } = {}) {
  const base = xdgConfigHome || posix.join(home, ".config");
  const appDir = posix.join(base, "openclaw-chatgpt-bridge");
  return {
    appDir,
    configPath: posix.join(appDir, "config.json"),
    profileDir: posix.join(appDir, "tunnel-profiles"),
    unitDir: posix.join(base, "systemd", "user"),
  };
}

export function systemdArg(value) {
  const str = String(value);
  if (!str || str.includes("\n") || str.includes("\r") || str.includes("\0"))
    throw new Error("Unsafe systemd argument");
  return '"' + str.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

export function renderLinuxUnit({ role, repoRoot, nodePath, configPath }) {
  if (!["bridge", "tunnel"].includes(role)) throw new Error("Invalid service role");
  const launcher = posix.join(repoRoot, "scripts", "linux", "run-" + role + ".mjs");
  const name = role === "bridge" ? "OpenClaw ChatGPT MCP Bridge" : "OpenClaw ChatGPT Tunnel";
  const startAfter = role === "bridge"
    ? "After=network-online.target openclaw-gateway.service\nWants=network-online.target"
    : "After=network-online.target " + BRIDGE_UNIT + "\nWants=network-online.target " + BRIDGE_UNIT;
  return [
    "# Managed by OpenClaw Direct Tools for ChatGPT. Do not edit generated unit by hand.",
    "[Unit]",
    "Description=" + name,
    startAfter,
    "",
    "[Service]",
    "Type=simple",
    ...(configPath ? ["Environment=" + systemdArg("OPENCLAW_BRIDGE_CONFIG=" + configPath)] : []),
    "ExecStart=" + systemdArg(nodePath) + " " + systemdArg(launcher),
    "Restart=" + (role === "bridge" ? "always" : "on-failure"),
    "RestartSec=3",
    "UMask=0077",
    "NoNewPrivileges=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function bridgeEnvironment(config, env = process.env) {
  return {
    ...env,
    OPENCLAW_HOME: config.openclawHome,
    OPENCLAW_STATE_DIR: config.openclawStateDir,
    OPENCLAW_CONFIG_PATH: config.openclawConfigPath,
    OPENCLAW_WORKSPACE_DIR: posix.join(config.openclawStateDir, "workspace"),
    OPENCLAW_CLI_PATH: config.openclawCliPath,
    OPENCLAW_NODE_PATH: config.nodePath,
    OPENCLAW_BRIDGE_HOST: "127.0.0.1",
    OPENCLAW_BRIDGE_PORT: String(config.bridgePort),
    OPENCLAW_GATEWAY_PORT: String(config.gatewayPort),
    OPENCLAW_BRIDGE_AGENT: config.agentId || "main",
    OPENCLAW_BRIDGE_SUPERVISED: "1",
  };
}

export function validatePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid " + label + " port: " + value);
  return port;
}

export async function readLinuxConfig(configPath = process.env.OPENCLAW_BRIDGE_CONFIG || linuxPaths().configPath) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  for (const key of ["openclawConfigPath", "openclawCliPath", "openclawStateDir", "openclawHome",
    "nodePath", "tunnelClientPath", "tunnelProfilePath"]) {
    if (typeof config[key] !== "string" || !config[key]) throw new Error("Invalid local config: " + key);
  }
  for (const key of ["gatewayPort", "bridgePort", "tunnelHealthPort"]) validatePort(config[key], key);
  return config;
}