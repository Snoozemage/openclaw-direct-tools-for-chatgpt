import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { homedir } from "node:os";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export function chromeLaunchCandidates(env = process.env, platform = process.platform) {
  if (platform === "linux") return [
    env.OPENCLAW_CHROME_PATH,
    "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter(Boolean);
  if (platform !== "win32") return [];
  return [
    env.PROGRAMFILES && win32.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    env["PROGRAMFILES(X86)"] && win32.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
}

export async function resolveChromeLaunchConfig({ env = process.env, exists = existsSync,
  platform = process.platform, home = homedir() } = {}) {
  if (!["win32", "linux"].includes(platform)) throw new Error("Automatic personal Chrome launch is not supported on this platform.");

  const executable = chromeLaunchCandidates(env, platform).find((candidate) => exists(candidate));
  if (!executable) throw new Error("Could not locate Chrome or Chromium. Set OPENCLAW_CHROME_PATH to its executable.");

  const isChromium = platform === "linux" && /chromium/u.test(executable);
  const path = platform === "linux" ? posix : win32;
  const userDataDir = platform === "win32"
    ? win32.join(env.LOCALAPPDATA || "", "Google", "Chrome", "User Data")
    : (env.OPENCLAW_CHROME_USER_DATA_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), isChromium ? "chromium" : "google-chrome"));
  const localStatePath = path.join(userDataDir, "Local State");
  let profileDirectory = "Default";
  try {
    const localState = JSON.parse(await readFile(localStatePath, "utf8"));
    const lastUsed = localState?.profile?.last_used;
    if (typeof lastUsed === "string" && lastUsed.trim() && exists(path.join(userDataDir, lastUsed))) {
      profileDirectory = lastUsed;
    }
  } catch {
    // Use Chrome's conventional Default profile if Local State cannot be read.
  }

  return { executable, userDataDir, profileDirectory };
}

async function isChromeRunning(platform = process.platform) {
  try {
    if (platform === "linux") {
      const { stdout } = await execFile("pgrep", ["-u", String(process.getuid()), "-f", "(google-chrome|chromium|/chrome)( |$)"], {
        timeout: 3000, encoding: "utf8",
      });
      return Boolean(stdout.trim());
    }
    const { stdout } = await execFile("tasklist.exe", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"], {
      windowsHide: true, timeout: 3000, encoding: "utf8",
    });
    return stdout.split("\n").some((line) => line.split(",")[0].replaceAll('"', "").trim().toLowerCase() === "chrome.exe");
  } catch { return false; }
}

export async function ensurePersonalChromeRunning() {
  if (!["win32", "linux"].includes(process.platform)) return { launched: false };
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { launched: false };
  if (await isChromeRunning()) return { launched: false };

  const config = await resolveChromeLaunchConfig();
  await new Promise((resolve, reject) => {
    const child = spawn(config.executable, [
      `--user-data-dir=${config.userDataDir}`,
      `--profile-directory=${config.profileDirectory}`,
      "--new-window",
      "about:blank",
    ], { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

  // Give Chrome time to start its extension before the native Browser request.
  await new Promise((resolve) => setTimeout(resolve, 1800));
  return { launched: true, profileDirectory: config.profileDirectory };
}
