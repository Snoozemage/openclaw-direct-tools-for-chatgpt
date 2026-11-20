import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";

export function browserCursorPreferencePath({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.OPENCLAW_BROWSER_CURSOR_PREFERENCE_PATH) return env.OPENCLAW_BROWSER_CURSOR_PREFERENCE_PATH;
  return platform === "win32"
    ? win32.join(env.LOCALAPPDATA || home, "OpenClawChatGPTBridge", "browser-cursor.disabled")
    : posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), "openclaw-chatgpt-bridge", "browser-cursor.disabled");
}

export function createBrowserCursorPreference(filePath = browserCursorPreferencePath()) {
  return {
    async getEnabled() {
      try {
        await access(filePath);
        return false;
      } catch (error) {
        if (error?.code === "ENOENT") return true;
        throw error;
      }
    },
    async setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean.");
      if (enabled) {
        try { await unlink(filePath); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      } else {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, "disabled\n", { encoding: "utf8" });
      }
      return enabled;
    },
  };
}

export const browserCursorPreference = createBrowserCursorPreference();
