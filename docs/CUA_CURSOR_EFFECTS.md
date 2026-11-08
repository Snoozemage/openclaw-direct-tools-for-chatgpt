# Visible CUA cursor feedback on Windows

The bundled OpenClaw CUA SDK (0.33.4 on the inspected installation) does not accept the current cursor-effect options. Use the separately installed official Cua Driver instead of replacing OpenClaw's pinned SDK.

Install the standalone Windows driver from https://cua.ai/driver/install.ps1. When installing just for this bridge, opt out of connecting unrelated clients, extra autostart tasks and automatic UI tests:

```powershell
powershell -NoProfile -File <reviewed-installer.ps1> -Release 0.41.3 -NoConnect -NoTest -NoPathUpdate -NoAutoStart
```

From this repository, use the Node runtime bundled with your OpenClaw installation to run:

```text
node scripts/setup-cua-effects.mjs
```

Set OPENCLAW_CUA_DRIVER_PATH only if the executable is installed outside the normal per-user Cua directory. The script enables the halo, floating cursor, action marks, session badges, movement trail and click ripple/press effects. It then registers a filtered cua-driver MCP server through the Gateway's validated config.patch API with a fresh configuration hash. It preserves the existing authorization posture and does not replace OpenClaw's bundled driver.

Refresh the bridge after registration. The setup helper uses a temporary setup-owned daemon only to write preferences, then stops it. The bridge owns the subsequent CUA MCP process through OpenClaw's native MCP materializer and tool-policy constructor; no agent/model turn is needed. Discovery uses the exact policy-filtered native schemas, and dispatch refreshes configuration before every call, retains native before-call/approval hooks, and also enforces Gateway tool denials. It serializes desktop calls and disposes the MCP runtime on configuration changes or bridge shutdown. On Windows the MCP process owns its runtime; a separate daemon or Scheduled Task is not needed for this connection.

## Agent use

1. Discover tools with openclaw_tool_search, querying cua-driver.
2. Inspect exact schemas with openclaw_tool_describe.
3. Call the returned native IDs with openclaw_dispatch_action.
4. Start a named session with cursor_motion.idle_hide_ms set to 0, then explicitly enable its cursor with set_agent_cursor_enabled. Use the same session for observations, cursor settings and input.
5. Use fresh references from that CUA runtime; ordinary openclaw_computer frame IDs are from a different execution.
6. Call end_session in cleanup so the cursor disappears.

The ordinary openclaw_computer wrapper still uses the paired OpenClaw computer node. Cursor effects use the discovered CUA desktop tools. Both paths now share the screen-border indicator, and their calls are classified as computer activity by the bridge monitor and tray.

## Screen border

On Windows, a thin purple edge with a soft ten-pixel glow appears for active desktop sessions and stays visible between actions. The last end_session/close_execution closes it. Failed actions do not leave a new active lease; runtime disposal, configuration replacement, bridge shutdown, and five minutes of inactivity clear the relevant leases.

The renderer uses four small per-pixel-alpha windows per monitor, never activates, passes mouse input through, stays out of the taskbar, and excludes its windows from screen captures. Right and bottom positions use the actual window size after Show: WinForms can enlarge the requested ten-pixel strip to sixteen pixels. Run tests/screen-border-geometry.ps1 on Windows to verify the native outer-edge alignment. Display geometry changes rebuild the strips. The helper exits on stdin EOF, parent-process exit, or six seconds without a heartbeat. Rendering failure is reported through GET /api/computer-indicator without interrupting desktop tools or repeatedly launching processes. The helper starts only when desktop work starts and exits after the last lease closes.

scripts/windows/screen-border.ps1 loads ScreenBorder.cs. The IncludeInCapture switch is for visual verification only; production capture exclusion remains the default.

Cursor visibility indicates visual activity; CUA's own permission checks and OpenClaw's effective tool policy remain authoritative.
