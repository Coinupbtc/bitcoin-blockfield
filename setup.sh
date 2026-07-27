#!/usr/bin/env bash
# One-command local preview for Blockfield
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8080}"
echo "==> Blockfield on http://127.0.0.1:${PORT}/"
echo "    (Ctrl+C to stop)"
echo
exec python3 -m http.server "$PORT" --bind 127.0.0.1
