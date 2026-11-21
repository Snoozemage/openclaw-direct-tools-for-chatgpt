# Linux support — OpenClaw Direct Tools for ChatGPT

## Scope and current status

The Linux implementation operates the same MCP Bridge and Secure MCP Tunnel used by Windows, but manages them as unprivileged `systemd --user` services. The OpenClaw Gateway stays under OpenClaw's own service manager. It does **not** install OpenClaw, change Windows service registration, or implicitly grant root access.

Validated locally on **Fedora 45 KDE Plasma / Wayland**, using OpenClaw **2026.11.6**: Gateway, Bridge and Tunnel were all active and their health checks succeeded. A KDE Qt6 system tray companion now matches the Windows status colors, tool/computer activity glyphs, and context-menu controls. Full desktop CUA support has not been ported.

## Requirements

- Node.js 22.17+ and npm, Git, ripgrep, `systemd --user`, `secret-tool` (libsecret), and an unlocked desktop Secret Service keyring.
- For the Linux tray: Python 3, Qt6/PySide6 (`python3-pyside6` on Fedora), and a KDE desktop session with a system tray.
- OpenClaw configured at `~/.openclaw/openclaw.json`; an already working OpenClaw Gateway service.
- Official [OpenAI tunnel-client](https://github.com/openai/tunnel-client/releases/latest), verified for the system architecture.
- A Secure MCP Tunnel ID and appropriately permissioned OpenAI Platform API key.

On Fedora, system dependencies:

```bash
sudo dnf install git libsecret ripgrep python3-pyside6
```

OpenClaw can be installed independently of Fedora's RPM package. The current machine's OpenClaw CLI resides at `~/.openclaw/bin/openclaw` and its private Node toolchain under `~/.openclaw/tools/node/bin`. **Do not reinstall the old Fedora RPM just to get a `node` or `npm` command.** Add the private toolchain to your interactive shell's `PATH` if needed:

```bash
export PATH="$HOME/.openclaw/tools/node/bin:$HOME/.local/bin:$PATH"
```

Persistent shell configuration is a user preference; the managed Bridge service uses absolute paths rather than depending on shell startup files.

## Setup and layout

From a checkout on the desired branch:

```bash
npm ci
npm run setup
npm start
npm run status
npm run autostart:install
```

`npm run setup` discovers the OpenClaw CLI (including standalone `~/.openclaw/tools/node-v*/lib/node_modules/openclaw/openclaw.mjs`), checks the Gateway configuration and tunnel-client path, and prompts for the Tunnel ID / Platform key when necessary. The API key is stored in Secret Service, **not** in a repository file or generated config.

Generated paths:

| Component | Location |
|---|---|
| Local Bridge config | `~/.config/openclaw-chatgpt-bridge/config.json` |
| Tunnel profiles | `~/.config/openclaw-chatgpt-bridge/tunnel-profiles/` |
| Bridge and Tunnel units | `~/.config/systemd/user/openclaw-chatgpt-{bridge,tunnel}.service` |
| KDE tray login autostart | `~/.config/autostart/openclaw-direct-tools-tray.desktop` |
| KDE tray log | `~/.local/state/openclaw-chatgpt-bridge/tray.log` |
| Gateway config / state | `~/.openclaw/` (owned by OpenClaw) |

Default local ports are Gateway **18789**, Bridge **19002**, Tunnel health **8081**. They can be overridden during setup using the existing `OPENCLAW_*_PORT` environment variables. Monitor: `http://127.0.0.1:19002/monitor`.

The Tunnel service waits for Bridge HTTP health before starting the tunnel-client. Both services restart under their generated systemd policies; the Gateway is deliberately not supervised by the Bridge.

## Lifecycle commands

| Command | Action |
|---|---|
| `npm start` | Start or reconcile Gateway, start Bridge/Tunnel, and launch KDE tray if available |
| `npm stop` | Stop Bridge/Tunnel and exit the tray; leave Gateway untouched |
| `npm run status` | Check Gateway, Bridge, Tunnel services and HTTP readiness; nonzero exit if unhealthy |
| `npm run bridge:restart` | Restart only the Bridge |
| `npm run tray:start` | Launch the singleton KDE tray using a transient user service |
| `npm run tray:stop` | Exit the tray without stopping Gateway/Bridge/Tunnel |
| `npm run tray:status` | Print the current tray status, or fail if it is not running |
| `npm run logs` | Show the latest 100 Gateway/Bridge/Tunnel journal entries |
| `npm run autostart:install` | Enable Bridge/Tunnel and KDE tray at user login |
| `npm run autostart:uninstall` | Disable Bridge/Tunnel and KDE tray login autostart without stopping active services |
| `npm run test:credential-store` | Test temporary Secret Service store/lookup/clear and remove test data |
| `npm run check` | Syntax-check JS source |
| `npm run test:unit` | Run JS unit tests |

### Run directly using shell scripts

From the repository root, use these executable Linux launchers (or prefix them with `bash`):

```bash
./scripts/linux/start.sh           # Start Gateway if needed, Bridge, Tunnel and KDE tray
./scripts/linux/stop.sh            # Stop Bridge/Tunnel and tray, keep Gateway running
./scripts/linux/restart.sh         # Restart Bridge, Tunnel and tray together
./scripts/linux/restart-bridge.sh  # Restart Bridge only; leave Tunnel and Gateway running
./scripts/linux/status.sh          # Check service and HTTP health
./scripts/linux/logs.sh            # Show recent Gateway/Bridge/Tunnel logs
```

These wrappers call the existing Linux lifecycle manager, so they do not install or duplicate services. They work from any current directory, use OpenClaw's bundled Node.js when available, and also accept `OPENCLAW_NODE=/absolute/path/to/node`. For a tunnel that is not polling, use `restart.sh` rather than the Bridge-only restart. Run them from a terminal to see the output.

`openclaw_bridge_restart` asks the existing Bridge supervisor to restart it; it does not touch Gateway or Tunnel. To inspect services directly, use `systemctl --user status <unit>` or `journalctl --user -u <unit>`.

## Windows parity and intentional differences

Shared JS MCP tools, Monitor, browser integration and Git/file tools work on Linux where corresponding OpenClaw runtime capabilities exist. Linux uses systemd user units and journald instead of the Windows background supervisor and Windows startup shortcut. The Linux PySide6 tray reproduces the Windows status (green/yellow/red), activity (blue/purple), 3.5-second status polling, 500-ms activity polling, cursor toggle, Monitor single left-click (also double-click), Bridge restart, service stop and tray-only exit. KDE renders the native context menu, so its styling can differ from WinForms. The Linux Stop action stops Bridge/Tunnel but intentionally leaves OpenClaw's independently owned Gateway running. The Windows native screen border and computer/CUA node are **not** automatically supported on Fedora: they require a separately compatible Linux desktop driver.

Chrome auto-discovery checks Linux executable paths and XDG profiles. Windows path resolution explicitly uses Windows path rules, including when tests run on Linux; Windows behavior does not depend on the operating system running the tests.

The local native exec wrapper initializes OpenClaw's runtime configuration snapshot before obtaining tools. That fixes the `captureRuntimeConfigAsyncReader()()` failure seen after modifying approval rules. The host's own approval policy still governs these tools.

## Administrative actions, KDE and passwords

The Bridge and Tunnel systemd units deliberately set `NoNewPrivileges=true`, and native exec can inherit the same restriction. A PTY, terminal UI or tool-approval setting does **not** override this. Never paste a sudo password into ChatGPT or send it as an MCP argument. A desktop notification is not an authorization decision; ensure requests are explicitly user-approved before dispatching them.

Fedora KDE provides native authentication through Polkit. The Linux-only **`openclaw_admin`** tool runs **user-approved non-interactive shell commands as root**, without using `sudo` inside the Bridge's restricted `openclaw_exec`.

```json
{
  "action": "run",
  "command": "dnf install -y /home/user/Downloads/dbeaver-ce-latest-linux-x86_64.rpm",
  "purpose": "Cài DBeaver Community"
}
```

Pass the shell command **without a leading `sudo`**; Bash supports commands, pipelines, redirection and scripts. Commands that require interactive terminal input (such as text editors and password prompts) are not supported; stdin is closed. Optional `workdir` sets an absolute working directory and `timeoutSeconds` controls the time limit (1–3600 seconds; default 900). Check completion using `{"action":"status","jobId":"<returned jobId>"}`. The tool returns captured exit status, stdout and stderr (output is truncated to the last 10 KB per stream).

How it works:

1. The Bridge validates the request format and starts a one-off, **unprivileged** `systemd --user` helper with `NoNewPrivileges=no`. The Bridge and Tunnel keep `NoNewPrivileges=true`.
2. The helper displays the **user-facing purpose** in a KDE notification; if that notification cannot be sent, it does not proceed. The supplied purpose must accurately describe the command; it is *not* independently verified.
3. `pkexec` requests Polkit authorization, then runs `/usr/bin/bash -c <command>` as root. Polkit may reuse a previous authorization; there is no second Yes/No dialog. The password never enters ChatGPT or the Bridge.
4. The helper records the result in a private, temporary per-user job directory.

**Security:** This is a general root shell, not an allowlisted command launcher. A mistaken or malicious command can damage the system, even when authentication is cached. The assistant must obtain the user's authorization for the actual action, not merely rely on a previously approved login. Neither the notification nor cached Polkit authentication constitutes per-command consent. Do not put passwords or secrets into commands because tool arguments and results may appear in the local monitor. Never run the persistent Bridge/Gateway/Tunnel as root or install a blanket passwordless `sudo` rule.

## Validation and limitations

Fedora validation (20 November 2026): 52 JavaScript modules syntax-checked, 168 unit tests passed and one optional integration test skipped because the installed OpenClaw relay test package was unavailable. The general admin command `id -u` completed through `pkexec` with exit code 0 and stdout `0`; KDE accepted the purpose notification. This verifies the root-shell launch path, not every possible command. A notification delivery response alone cannot prove what was visible on the desktop, and Polkit may reuse cached authorization.

- Browser extension attachment depends on Chrome and OpenClaw permissions and may require a desktop session.
- A locked keyring can prevent the Tunnel from finding its API key.
- OpenClaw's tool policy is separate from Linux's `sudo`/Polkit checks; successful tool approval does not provide root authority.
- Shell `PATH` may not include a standalone OpenClaw Node/npm toolchain; the unit files use absolute runtime paths.

Do not remove or alter user data or system services as a workaround for a missing privilege boundary.
