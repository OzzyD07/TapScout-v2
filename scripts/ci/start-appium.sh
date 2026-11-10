#!/usr/bin/env bash
# Starts a local Appium server bound to 127.0.0.1 (never exposed to the internet) and waits
# until it answers. Logs go to $OUT/appium.log so they are uploaded with the run artifacts.
set -euo pipefail

out="${OUT:-.artifacts/smoke}"
mkdir -p "$out"

appium --address 127.0.0.1 --port 4723 --log-timestamp --log-no-colors \
  --log "$out/appium.log" >/dev/null 2>&1 &
echo $! > "$out/appium.pid"

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:4723/status >/dev/null 2>&1; then
    echo "appium is up"
    exit 0
  fi
  sleep 1
done
echo "appium did not start; last log lines:" >&2
tail -n 50 "$out/appium.log" >&2 || true
exit 1
