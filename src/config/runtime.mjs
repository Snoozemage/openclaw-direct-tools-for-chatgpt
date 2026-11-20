import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

const isWindows = process.platform === "win32";
export const root = process.env.OPENCLAW_HOME || (isWindows
  ? join(process.env.LOCALAPPDATA || process.cwd(), "OpenClawBeta")
  : join(homedir(), ".openclaw"));
const appRoot = process.env.OPENCLAW_APP_ROOT || join(root, "app", "node_modules");
export const stateDir = process.env.OPENCLAW_STATE_DIR || (isWindows ? join(root, "state") : root);
const bundledNode = join(root, "runtime", "node.exe");
export const runtimeNode = process.env.OPENCLAW_NODE_PATH || (isWindows && existsSync(bundledNode) ? bundledNode : process.execPath);
export const openclawCli = process.env.OPENCLAW_CLI_PATH || join(appRoot, "openclaw", "openclaw.mjs");
export const host = process.env.OPENCLAW_BRIDGE_HOST || "127.0.0.1";
export const port = Number(process.env.OPENCLAW_BRIDGE_PORT || 19002);
export const agentId = process.env.OPENCLAW_BRIDGE_AGENT || "main";
export const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || 19001);
export const invokeTimeoutMs = Number(process.env.OPENCLAW_BRIDGE_INVOKE_TIMEOUT_MS || 120000);
export const computerNode = process.env.OPENCLAW_COMPUTER_NODE || (isWindows ? "OpenClaw Windows CUA" : "");

process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(stateDir, "openclaw.json");
process.env.OPENCLAW_WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || join(stateDir, "workspace");
process.env.OPENCLAW_GATEWAY_PORT = String(gatewayPort);

if (!existsSync(runtimeNode)) throw new Error("Node.js executable not found: " + runtimeNode);
if (!existsSync(openclawCli)) throw new Error("OpenClaw CLI entry point not found: " + openclawCli + ". Set OPENCLAW_CLI_PATH in local configuration.");
if (!existsSync(process.env.OPENCLAW_CONFIG_PATH)) throw new Error("OpenClaw config not found: " + process.env.OPENCLAW_CONFIG_PATH + ". Set OPENCLAW_CONFIG_PATH in local configuration.");

const gatewayConfig = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
export const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ||
  (typeof gatewayConfig.gateway?.auth?.token === "string" ? gatewayConfig.gateway.auth.token : "");
if (!gatewayToken) throw new Error("OpenClaw Gateway token is missing. Configure gateway.auth.token or OPENCLAW_GATEWAY_TOKEN.");
