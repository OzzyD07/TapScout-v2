// Local-machine support: start Appium from .tools/ when none is running and boot an Android
// Virtual Device when no device is attached. Not used on GitHub runners (the workflow does both).

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { adb, connectedDevices } from "./android.js";
import { sleep } from "./exec.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

async function appiumUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("status", url.endsWith("/") ? url : `${url}/`), {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts Appium (repo .tools/ or TAPSCOUT_APPIUM_BIN) unless one already answers at `url`. */
export async function ensureAppium(
  url: string,
  logFile: string,
): Promise<{ stop: () => void; started: boolean }> {
  if (await appiumUp(url)) return { stop: () => undefined, started: false };
  const bin =
    process.env.TAPSCOUT_APPIUM_BIN ??
    join(repoRoot, ".tools", "appium", "node_modules", "appium", "index.js");
  if (!existsSync(bin)) {
    throw new Error(
      `Appium is not running at ${url} and was not found at ${bin}; run \`pnpm setup:local\` first.`,
    );
  }
  const u = new URL(url);
  const proc: ChildProcess = spawn(
    process.execPath,
    [
      bin,
      "--address",
      u.hostname,
      "--port",
      u.port || "4723",
      "--log-timestamp",
      "--log-no-colors",
      "--log",
      logFile,
    ],
    {
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        APPIUM_HOME: process.env.APPIUM_HOME ?? join(repoRoot, ".tools", "appium-home"),
      },
    },
  );
  for (let i = 0; i < 90; i++) {
    if (await appiumUp(url)) return { stop: () => proc.kill(), started: true };
    if (proc.exitCode !== null) break;
    await sleep(1_000);
  }
  proc.kill();
  throw new Error(`Appium did not start; see ${logFile}`);
}

function emulatorBin(): string {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const exe = process.platform === "win32" ? "emulator.exe" : "emulator";
  return sdk ? join(sdk, "emulator", exe) : exe;
}

/**
 * The serial to use: the given one, else the only/first attached device, else a freshly booted
 * AVD (left running afterwards so the next session starts fast).
 */
export async function ensureAndroidDevice(
  serial: string | undefined,
  avd: string | undefined,
  log: (m: string) => void,
): Promise<string> {
  const attached = await connectedDevices().catch(() => [] as string[]);
  if (serial) {
    if (!attached.includes(serial)) throw new Error(`device ${serial} is not attached`);
    return serial;
  }
  if (attached.length > 0 && !avd) return attached[0] as string;
  if (!avd) throw new Error("no Android device is attached; start an emulator or pass an AVD name");
  log(`booting AVD ${avd}`);
  const before = new Set(attached);
  spawn(emulatorBin(), ["-avd", avd, "-no-snapshot-save", "-no-boot-anim"], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const now = await connectedDevices().catch(() => [] as string[]);
    const fresh = now.find((d) => !before.has(d));
    if (fresh) {
      try {
        const booted = (
          await adb(["-s", fresh, "shell", "getprop", "sys.boot_completed"], 10_000)
        ).trim();
        if (booted === "1") return fresh;
      } catch {
        // Still booting.
      }
    }
    await sleep(3_000);
  }
  throw new Error(`AVD ${avd} did not boot within 6 minutes`);
}
