import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserCursorPreference } from "../src/tools/browser/cursor-preference.mjs";

test("AI cursor is shown by default and its tray preference persists across instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-cursor-"));
  const filePath = join(dir, "settings", "browser-cursor.disabled");
  try {
    const first = createBrowserCursorPreference(filePath);
    assert.equal(await first.getEnabled(), true);
    assert.equal(await first.setEnabled(false), false);
    assert.equal(await first.getEnabled(), false);
    assert.equal(await createBrowserCursorPreference(filePath).getEnabled(), false);
    assert.equal(await first.setEnabled(true), true);
    assert.equal(await createBrowserCursorPreference(filePath).getEnabled(), true);
    assert.equal(await first.setEnabled(true), true, "enabling repeatedly is safe");
    await assert.rejects(first.setEnabled("false"), /boolean/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
