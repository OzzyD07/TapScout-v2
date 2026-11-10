#!/usr/bin/env node
// Picks an available iPhone on the newest iOS runtime from `xcrun simctl list -j devices available`.
// Usage: pick-simulator.mjs <devices.json> <out.json>  → prints the UDID.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
const data = JSON.parse(readFileSync(input, "utf8"));

const version = (runtime) => (runtime.match(/iOS-(\d+)-(\d+)/) ?? []).slice(1).map(Number);
const runtimes = Object.keys(data.devices)
  .filter((r) => /SimRuntime\.iOS-\d+-\d+/.test(r))
  .sort((a, b) => {
    const [a1, a2] = version(a);
    const [b1, b2] = version(b);
    return b1 - a1 || b2 - a2;
  });

for (const runtime of runtimes) {
  const devices = data.devices[runtime].filter((d) => d.isAvailable);
  // Prefer the plain model (e.g. "iPhone 17") over Pro/Max/Plus variants for a stable profile.
  const phone =
    devices.find((d) => /^iPhone \d+$/.test(d.name)) ??
    devices.find((d) => d.name.startsWith("iPhone"));
  if (phone) {
    writeFileSync(
      output,
      `${JSON.stringify({ runtime, name: phone.name, udid: phone.udid }, null, 2)}\n`,
    );
    console.log(phone.udid);
    process.exit(0);
  }
}
console.error("no available iPhone simulator found");
process.exit(1);
