#!/usr/bin/env sh
# Serve LapSim on http://localhost:8000
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "LapSim running at http://localhost:$PORT  (Ctrl+C to stop)"
if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  python -m http.server "$PORT"
else
  npx --yes serve -l "$PORT"
fi
