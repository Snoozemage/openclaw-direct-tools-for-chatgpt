# Desktop visual feedback on Windows

Desktop control can show a dedicated AI cursor, click effects and a purple screen border. Cursor effects come from the official Cua Driver; the screen border is provided by this bridge.

## Enable cursor effects

Cursor effects use a separately installed Cua Driver. This setup was verified with Driver 0.41.3; the bundled CUA SDK 0.33.4 on the inspected OpenClaw installation did not support these options.

1. Download and review the [official Windows installer](https://cua.ai/driver/install.ps1), then run the downloaded file in PowerShell. Replace the installer path below with your saved file:

   ```powershell
   powershell -NoProfile -File <path-to-installer.ps1> -Release 0.41.3 -NoConnect -NoTest -NoPathUpdate -NoAutoStart
   ```

2. From this repository, run the setup helper using the Node runtime bundled with your OpenClaw installation:

   ```text
   node scripts/setup-cua-effects.mjs
   ```

   If the driver is installed outside its normal per-user Cua directory, set `OPENCLAW_CUA_DRIVER_PATH` to its executable first. The helper enables the cursor, halo, action marks, session badges, movement trail and click effects, and registers the driver with OpenClaw.

3. Restart the bridge after setup. A separate Cua daemon or Windows Scheduled Task is not required for this connection.

## Use the cursor

Ask the agent to:

1. Search for `cua-driver` with `openclaw_tool_search`, inspect the returned schemas with `openclaw_tool_describe`, and invoke those native tools through `openclaw_dispatch_action`.
2. Start a named session with `cursor_motion.idle_hide_ms` set to `0`, then enable its cursor with `set_agent_cursor_enabled`.
3. Use that same session for observations and input, taking fresh observations when the screen changes.
4. Call `end_session` when finished.

The dedicated cursor appears when using these discovered CUA desktop tools. Ordinary `openclaw_computer` calls use a different execution and cannot share their screenshot references with a CUA session. Both routes show computer activity in the monitor and tray.

## Screen border

The purple border appears automatically during active desktop sessions, stays visible between actions, and closes when the last session ends. It also clears after five minutes of inactivity or when the bridge shuts down.

The border lets mouse input pass through and is excluded from screen captures by default. If it does not appear, check `GET /api/computer-indicator` on the local bridge for its status; desktop tools can still run if the indicator fails.

Cursor and border visibility show activity, not task success. OpenClaw and CUA permissions still apply.
