#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"

# Fedora's standalone OpenClaw Node installation may not be on PATH.
if [[ -n "${OPENCLAW_NODE:-}" ]]; then
  node_bin="$OPENCLAW_NODE"
elif [[ -x "$HOME/.openclaw/tools/node/bin/node" ]]; then
  node_bin="$HOME/.openclaw/tools/node/bin/node"
else
  node_bin="$(command -v node || true)"
fi

if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
  printf 'Node.js not found. Install Node.js >=22.17 or set OPENCLAW_NODE to its full path.\n' >&2
  exit 127
fi

exec "$node_bin" "$repo_root/scripts/platform.mjs" "$@"
