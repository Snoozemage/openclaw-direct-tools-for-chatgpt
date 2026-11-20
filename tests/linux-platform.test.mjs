import test from "node:test";
import assert from "node:assert/strict";
import { posix } from "node:path";
import {
  BRIDGE_UNIT, TUNNEL_UNIT, linuxPaths, renderLinuxUnit, bridgeEnvironment,
  systemdArg, validatePort, SECRET_ATTRIBUTES,
} from "../scripts/linux/core.mjs";
import { chromeLaunchCandidates, resolveChromeLaunchConfig } from "../src/tools/browser/chrome-launch.mjs";
import { browserCursorPreferencePath } from "../src/tools/browser/cursor-preference.mjs";
import { createComputerToolHandler } from "../src/tools/computer/handler.mjs";

test("Linux app paths honor XDG_CONFIG_HOME", () => {
  assert.equal(linuxPaths({ home: "/home/test", xdgConfigHome: "" }).configPath,
    posix.join("/home/test", ".config", "openclaw-chatgpt-bridge", "config.json"));
  assert.equal(linuxPaths({ home: "/home/test", xdgConfigHome: "/private/conf" }).unitDir,
    "/private/conf/systemd/user");
});

test("Linux services preserve the bridge restart contract and avoid embedding secrets", () => {
  const bridge = renderLinuxUnit({ role: "bridge", repoRoot: "/home/test/bridge workspace", nodePath: "/usr/bin/node" });
  const tunnel = renderLinuxUnit({ role: "tunnel", repoRoot: "/home/test/bridge workspace", nodePath: "/usr/bin/node" });
  assert.ok(bridge.includes('ExecStart="/usr/bin/node" "/home/test/bridge workspace/scripts/linux/run-bridge.mjs"'));
  assert.ok(bridge.includes("Restart=always"));
  assert.ok(tunnel.includes("Restart=on-failure"));
  assert.ok(tunnel.includes("After=network-online.target " + BRIDGE_UNIT));
  assert.ok(tunnel.includes("Wants=network-online.target " + BRIDGE_UNIT));
  assert.ok(!tunnel.includes("CONTROL_PLANE_API_KEY"));
  assert.notEqual(TUNNEL_UNIT, BRIDGE_UNIT);
  const customized = renderLinuxUnit({ role: "bridge", repoRoot: "/opt/bridge", nodePath: "/usr/bin/node", configPath: "/home/test/.config/bridge/config.json" });
  assert.ok(customized.includes('Environment="OPENCLAW_BRIDGE_CONFIG=/home/test/.config/bridge/config.json"'));
});

test("systemd arguments protect path quoting and specifier expansion", () => {
  assert.equal(systemdArg("/opt/my app/100%"), '"/opt/my app/100%%"');
  assert.equal(systemdArg('a"b'), '"a\\"b"');
  assert.throws(() => systemdArg("bad\npath"), /Unsafe systemd argument/);
});

test("bridge environment uses correct Linux paths and supervisor marker", () => {
  const env = bridgeEnvironment({
    openclawHome: "/home/test/.openclaw",
    openclawStateDir: "/home/test/.openclaw",
    openclawConfigPath: "/home/test/.openclaw/openclaw.json",
    openclawCliPath: "/opt/openclaw/openclaw.mjs",
    nodePath: "/usr/bin/node",
    bridgePort: 19002, gatewayPort: 18789,
  }, { PATH: "/usr/bin" });
  assert.equal(env.OPENCLAW_BRIDGE_SUPERVISED, "1");
  assert.equal(env.OPENCLAW_WORKSPACE_DIR, "/home/test/.openclaw/workspace");
  assert.equal(env.OPENCLAW_CLI_PATH, "/opt/openclaw/openclaw.mjs");
  assert.ok(!Object.hasOwn(env, "CONTROL_PLANE_API_KEY"));
  assert.deepEqual(SECRET_ATTRIBUTES, ["service", "OpenClawChatGPTBridge", "key", "CONTROL_PLANE_API_KEY"]);
});

test("invalid ports are rejected before starting services", () => {
  assert.equal(validatePort("19002", "bridge"), 19002);
  for (const value of [0, 123, 65536, NaN, "abc", 2000.5]) {
    assert.throws(() => validatePort(value, "bridge"), /Invalid bridge port/);
  }
});

test("Browser cursor preference lives in Linux XDG state; Windows path remains stable", () => {
  assert.equal(browserCursorPreferencePath({ env:{ XDG_CONFIG_HOME: "/home/test/config" }, platform:"linux", home:"/home/test" }),
    "/home/test/config/openclaw-chatgpt-bridge/browser-cursor.disabled");
  assert.equal(browserCursorPreferencePath({ env:{ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, platform:"win32", home:"ignored" }),
    "C:\\Users\\test\\AppData\\Local\\OpenClawChatGPTBridge\\browser-cursor.disabled");
});

test("Missing desktop computer node fails explicitly rather than calling a blank node", async () => {
  const handle = createComputerToolHandler({ idleTimeoutMs: 0 });
  const result = await handle("openclaw_computer", {action:"snapshot"}, {
    node: "", invokeNodeCommand: async () => { throw new Error("must not invoke"); },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /OPENCLAW_COMPUTER_NODE/);
});

test("Linux Chrome discovery honors custom executable and XDG profile", async () => {
  const env = { OPENCLAW_CHROME_PATH: "/opt/chrome/chrome", XDG_CONFIG_HOME: "/home/test/config" };
  assert.equal(chromeLaunchCandidates(env, "linux")[0], "/opt/chrome/chrome");
  const found = await resolveChromeLaunchConfig({
    env, platform: "linux", home: "/home/test", exists: (path) => path === "/opt/chrome/chrome",
  });
  assert.equal(found.userDataDir, "/home/test/config/google-chrome");
  assert.equal(found.profileDirectory, "Default");
});
