import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const defaultPath = join(process.env.LOCALAPPDATA || homedir(),
  "OpenClawChatGPTBridge", "browser-cursor.disabled");

export function createBrowserCursorPreference(filePath = defaultPath) {
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
