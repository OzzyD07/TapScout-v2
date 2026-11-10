#!/usr/bin/env node
// Installs what local sessions and GitHub sessions need on this machine, inside .tools/ (nothing
// global): Appium with the UiAutomator2 (and on macOS XCUITest) driver, and cloudflared for the
// free quick tunnel that lets GitHub runners reach the hub.
//
// Usage: node scripts/setup-local.mjs [--skip-appium] [--skip-cloudflared] [--force]

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tools = join(root, ".tools");
const args = new Set(process.argv.slice(2));
const force = args.has("--force");

const APPIUM_VERSION = "3.8.0";
const UIAUTOMATOR2_VERSION = "8.7.0";
const XCUITEST_VERSION = "12.16.0";

mkdirSync(tools, { recursive: true });

function run(cmd, cmdArgs, env = {}) {
  console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    // npm is a .cmd script on Windows and needs a shell; node itself must not get one (its path
    // contains spaces).
    shell: process.platform === "win32" && cmd === "npm",
  });
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
}

if (!args.has("--skip-appium")) {
  const prefix = join(tools, "appium");
  const home = join(tools, "appium-home");
  const bin = join(prefix, "node_modules", "appium", "index.js");
  if (force || !existsSync(bin)) {
    mkdirSync(prefix, { recursive: true });
    if (!existsSync(join(prefix, "package.json"))) {
      writeFileSync(join(prefix, "package.json"), '{ "private": true }\n');
    }
    run("npm", [
      "install",
      "--prefix",
      prefix,
      `appium@${APPIUM_VERSION}`,
      "--no-audit",
      "--no-fund",
    ]);
  }
  const drivers = [["uiautomator2", UIAUTOMATOR2_VERSION]];
  if (process.platform === "darwin") drivers.push(["xcuitest", XCUITEST_VERSION]);
  for (const [name, version] of drivers) {
    const marker = join(home, "node_modules", `appium-${name}-driver`, "package.json");
    if (!force && existsSync(marker)) {
      console.log(`appium driver ${name} already installed`);
      continue;
    }
    run(process.execPath, [bin, "driver", "install", `${name}@${version}`], { APPIUM_HOME: home });
  }
}

if (!args.has("--skip-cloudflared")) {
  const exe = join(tools, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (force || !existsSync(exe)) {
    const base = "https://github.com/cloudflare/cloudflared/releases/latest/download/";
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const asset =
      process.platform === "win32"
        ? `cloudflared-windows-${arch}.exe`
        : process.platform === "darwin"
          ? `cloudflared-darwin-${arch}.tgz`
          : `cloudflared-linux-${arch}`;
    console.log(`downloading ${asset}`);
    const res = await fetch(base + asset);
    if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (asset.endsWith(".tgz")) {
      const tgz = join(tools, asset);
      writeFileSync(tgz, bytes);
      run("tar", ["-xzf", tgz, "-C", tools]);
    } else {
      writeFileSync(exe, bytes);
    }
    if (process.platform !== "win32") chmodSync(exe, 0o755);
  }
  console.log(`cloudflared: ${exe}`);
}

console.log("local setup done");
