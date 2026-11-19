// Keep browser cursor tests independent from the operator's persistent UI setting.
// Use an untouched throwaway preference path; never disable or remove their setting.
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

process.env.OPENCLAW_BROWSER_CURSOR_PREFERENCE_PATH =
  join(tmpdir(), "openclaw-bridge-browser-cursor-tests", String(process.pid), "browser-cursor.disabled");
