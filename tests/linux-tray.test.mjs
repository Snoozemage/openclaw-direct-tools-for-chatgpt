import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

test("Linux Qt tray reproduces status colors and Windows menu labels", (t) => {
  if (process.platform !== "linux") return t.skip("Linux-only system tray");
  const available = spawnSync("python3", ["-c", "from PySide6.QtWidgets import QApplication"], {
    encoding: "utf8",
  });
  if (available.status !== 0) return t.skip("System PySide6 is not installed");

  const code = `
import importlib.util
import tempfile
from pathlib import Path
from PySide6.QtWidgets import QApplication

source = Path("scripts/linux/tray.py")
spec = importlib.util.spec_from_file_location("openclaw_linux_tray", source)
tray = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tray)

app = QApplication([])
for key, hex_color in tray.COLORS.items():
    icon = tray.make_icon(key)
    assert not icon.isNull(), key
    if key in ("Ready", "Pending", "Offline"):
        actual = icon.pixmap(32, 32).toImage().pixelColor(16, 16).name()
        assert actual == hex_color, (key, actual, hex_color)

base = {"Configured": True, "Gateway": True, "Bridge": True, "Tunnel": True}
assert tray.classify_status(base, ever_ready=False, startup_grace_until=0, restart_until=0, now=1) == "READY"
assert tray.classify_status({**base, "Tunnel": False}, ever_ready=True, startup_grace_until=0, restart_until=0, now=1) == "PARTIAL"
assert tray.classify_status({**base, "Gateway": False, "Bridge": False, "Tunnel": False},
                            ever_ready=True, startup_grace_until=0, restart_until=0, now=1) == "OFFLINE"
assert tray.classify_status({**base, "Bridge": False}, ever_ready=True,
                            startup_grace_until=0, restart_until=100, now=1) == "RESTARTING"
assert tray.classify_status({**base, "Gateway": False}, ever_ready=False,
                            startup_grace_until=100, restart_until=0, now=1) == "STARTING"
assert tray.classify_status({**base, "Configured": False}, ever_ready=False,
                            startup_grace_until=100, restart_until=0, now=1) == "CONFIG MISSING"

with tempfile.TemporaryDirectory() as temp:
    tray.SOCKET_FILE = Path(temp) / "tray.sock"
    tray.CONFIG_FILE = Path(temp) / "missing-config.json"
    companion = tray.TrayCompanion(app)
    labels = [action.text() for action in companion.menu.actions()]
    for item in ("Open Monitor", "Show AI Cursor", "Restart Bridge",
                 "Stop OpenClaw Direct Tools", "Exit tray app"):
        assert item in labels, (item, labels)
    assert companion.last_state == "CONFIG MISSING"
    companion.cleanup()
app.quit()
`;
  const result = spawnSync("python3", ["-c", code], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, QT_QPA_PLATFORM: "offscreen", PYTHONDONTWRITEBYTECODE: "1" },
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
