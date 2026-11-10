#!/usr/bin/env bash
# Runs inside ReactiveCircus/android-emulator-runner once the emulator has booted.
# Expects SESSION_ID, HUB_URL, MAX_MINUTES and OUT. The runner downloads the build from the hub.
set -euo pipefail

: "${SESSION_ID:?SESSION_ID is required}"
: "${HUB_URL:?HUB_URL is required}"
out="${OUT:-.artifacts/session}"
mkdir -p "$out"

adb devices -l > "$out/adb-devices.txt"

# The emulator's launcher often hangs after a cold boot and its "isn't responding" dialog then
# covers the app (TapScout v1 runs cdf5265f, 5af91f1f). Appium starts the app directly.
if [ "${KEEP_LAUNCHER:-false}" != "true" ]; then
  for launcher in com.google.android.apps.nexuslauncher com.android.launcher3; do
    adb shell pm disable-user --user 0 "$launcher" > /dev/null 2>&1 || true
  done
fi

OUT="$out" bash scripts/ci/start-appium.sh

status=0
node packages/runner/dist/main.js --platform android --hub "$HUB_URL" --session "$SESSION_ID" \
  --auth github --out "$out" --max-minutes "${MAX_MINUTES:-60}" --appium-log "$out/appium.log" \
  || status=$?

kill "$(cat "$out/appium.pid")" 2>/dev/null || true
exit "$status"
