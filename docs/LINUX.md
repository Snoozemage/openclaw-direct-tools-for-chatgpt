# Linux / Fedora setup (experimental)

This is the Linux lifecycle for the OpenClaw Direct Tools **ChatGPT bridge**. It runs the MCP bridge and official OpenAI tunnel-client as **per-user systemd services**. It does not install OpenClaw itself, change an existing Windows installation, or install a Linux desktop-automation driver.

## Requirements

- A desktop Linux distribution with `systemd --user` (tested in code on Windows with simulated Linux paths; **real Fedora runtime validation still required**).
- Node.js **22.17+**, npm, Git, and ripgrep.
- OpenClaw installed and configured at `~/.openclaw/openclaw.json`, with a **string** `gateway.auth.token`. Install its Gateway service using `openclaw gateway install`, then check `openclaw gateway status --deep`.
- `secret-tool` and an unlocked Secret Service keyring (normally GNOME Keyring on Fedora Workstation).
- The [official Linux `tunnel-client` binary](https://github.com/openai/tunnel-client/releases/latest) downloaded for the correct architecture (x86_64/amd64 or arm64), verified against the publisher's checksums, extracted, made executable, and available on `PATH` or supplied via `OPENCLAW_TUNNEL_CLIENT_PATH`.
- An existing [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) linked to the relevant ChatGPT workspace and a Platform API key with **Tunnels Read + Use**.

For Fedora Workstation, install `libsecret` (provides `secret-tool`) and `ripgrep`:

```bash
sudo dnf install git libsecret ripgrep
node --version
npm --version
secret-tool --version
```

Install or upgrade Node separately if `node --version` reports less than v22.17; the Fedora repository version varies. Verify OpenClaw and the Gateway before bridge setup.

## Configure and run

Use the Linux branch while it is under development:

```bash
git clone https://github.com/Snoozemage/openclaw-direct-tools-for-chatgpt.git
cd openclaw-direct-tools-for-chatgpt
git switch feat/linux-support
npm run setup
npm start
npm run status
```

**Note:** The branch above must first be pushed to the remote repository; until then, copy your existing local branch or use an exported patch. Do not attempt `git switch` on a remote clone before it exists there.

Setup will:
1. Find `~/.openclaw/openclaw.json` and the global `openclaw.mjs` Node CLI (or use `OPENCLAW_CONFIG_PATH` / `OPENCLAW_CLI_PATH`).
2. Find the official `tunnel-client` (or `OPENCLAW_TUNNEL_CLIENT_PATH`).
3. Ask for the `tunnel_...` identifier and Platform API key. The key is entered without echo and stored in the Linux Secret Service keyring; it is **not** stored in the repository or generated JSON/YAML files. An existing keyring entry is reused.
4. Create `~/.config/openclaw-chatgpt-bridge/config.json` and an `env:CONTROL_PLANE_API_KEY` tunnel profile in `tunnel-profiles/`, with owner-only permissions.
5. Write `~/.config/systemd/user/openclaw-chatgpt-bridge.service` and `openclaw-chatgpt-tunnel.service`; reload systemd, then run `npm ci`.

The default ports are the existing OpenClaw Gateway port (usually 18789 on Linux), bridge 19002 and tunnel health 8081. Set `OPENCLAW_GATEWAY_PORT`, `OPENCLAW_BRIDGE_PORT`, and `OPENCLAW_TUNNEL_HEALTH_PORT` before setup to override them. The ports must be distinct. `OPENCLAW_TUNNEL_ID` can be supplied to skip the prompt.

Check the local Monitor at `http://127.0.0.1:19002/monitor` and use the same Secure MCP Tunnel when creating the ChatGPT custom MCP connection. The public MCP endpoint is local `/mcp`, reached through the tunnel.

## Lifecycle

```bash
npm start                     # Start/check the Gateway; start bridge and tunnel user units
npm run status                # Unit state and bridge /healthz
npm stop                     # Stop bridge and tunnel; leave Gateway managed by OpenClaw
npm run autostart:install     # Enable bridge and tunnel at user login
npm run autostart:uninstall   # Disable their login autostart (does not stop running units)
journalctl --user -u openclaw-chatgpt-bridge.service -f
journalctl --user -u openclaw-chatgpt-tunnel.service -f
```

`openclaw_bridge_restart` can restart the MCP bridge under its systemd unit; it deliberately does not restart the Gateway or tunnel.

Run the JS syntax and unit checks:

```bash
npm run check
npm run test:unit
```

Linux does not run the Windows Credential Manager test or Windows-specific PowerShell lifecycle checks.

## Platform differences and limitations

- **Desktop automation:** `openclaw_computer` requires a paired, compatible computer node. The Windows CUA node and Windows visual screen-border effect are not available on Fedora by default; set `OPENCLAW_COMPUTER_NODE` and install/authorize a suitable Linux-capable driver separately. No Linux desktop CUA support is promised by this bridge alone.
- **Browser:** Chrome/Chromium binary auto-discovery and Linux profile paths are supported; extension attachment remains subject to OpenClaw and Chrome policies. A background user service may not inherit `DISPLAY`/`WAYLAND_DISPLAY`. Start Chrome in your desktop session when automatic launch isn't possible. `OPENCLAW_CHROME_PATH` and `OPENCLAW_CHROME_USER_DATA_DIR` are optional overrides.
- **Keyring:** Secret Service must be accessible/unlocked in the user session. A locked keyring may prevent the tunnel service from starting, particularly before desktop login. Use `journalctl --user` for the error; do **not** place the Platform key in a world-readable environment file.
- **Startup and privileges:** No root service, `sudo npm`, or automatic Linux tray icon is created. Only bridge/tunnel systemd **user** units are managed; the OpenClaw Gateway is managed by OpenClaw. Native tool calls retain OpenClaw permissions.
- **Development status:** The Linux paths, services, and key storage are covered by cross-platform automated tests, but Fedora itself and end-to-end browser/Gateway/tunnel connectivity must be verified on a Fedora installation.
