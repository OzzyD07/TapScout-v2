#!/usr/bin/env bash
# Picks an available iPhone simulator on the newest installed iOS runtime, boots it and prints
# its UDID. Writes the chosen device and runtime to $OUT/ios/simulator.json.
set -euo pipefail

out="${OUT:-.artifacts/smoke}"
mkdir -p "$out/ios"

xcrun simctl list -j devices available > "$out/ios/simctl-devices.json"
udid=$(node scripts/ci/pick-simulator.mjs "$out/ios/simctl-devices.json" "$out/ios/simulator.json")

# Appium's first Xcode queries take ~80 s on a cold runner (run c0d42c0b); warm them up while
# the simulator boots.
( xcrun --sdk iphonesimulator --show-sdk-version && xcodebuild -version && xcodebuild -showsdks ) \
  > "$out/ios/xcode-warmup.txt" 2>&1 &
warmup=$!

xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
wait "$warmup" || true
echo "$udid"
