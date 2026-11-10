// adb helpers. All of them honour ANDROID_SERIAL, which main.ts sets when a serial was chosen.

import { type ChildProcess, spawn } from "node:child_process";
import { execBuffer, execText, sleep } from "./exec.js";

export const adbBin = () => process.env.ADB ?? "adb";

export function adb(args: string[], timeoutMs = 30_000) {
  return execText(adbBin(), args, { timeoutMs });
}

/** Full-resolution PNG straight from the device, without going through Appium. */
export function screencapPng(): Promise<Buffer> {
  return execBuffer(adbBin(), ["exec-out", "screencap", "-p"], { timeoutMs: 15_000 });
}

export async function pidOf(pkg: string): Promise<number | undefined> {
  try {
    const out = (await adb(["shell", "pidof", pkg], 10_000)).trim();
    const pid = Number(out.split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The emulator sometimes drops off adb for a few seconds ("device offline"). Reconnect and wait
 * until it answers and reports a finished boot (kept from TapScout v1).
 */
export async function recoverEmulator(): Promise<void> {
  try {
    await adb(["reconnect", "offline"], 30_000);
    await adb(["wait-for-device"], 120_000);
  } catch {
    // The polling below reports the real state.
  }
  for (let i = 0; i < 30; i += 1) {
    try {
      if ((await adb(["shell", "getprop", "sys.boot_completed"], 10_000)).trim() === "1") return;
    } catch {
      // Still offline.
    }
    await sleep(2_000);
  }
}

export async function connectedDevices(): Promise<string[]> {
  const out = await adb(["devices"], 15_000);
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === "device" && p[0])
    .map((p) => p[0] as string);
}

/** On-device screen recording; stopped with SIGINT so the MP4 is finalised. */
export class AndroidScreenRecord {
  private proc: ChildProcess | null = null;
  private done: Promise<void> | null = null;
  readonly remotePath: string;
  startedAt = 0;

  constructor(name: string) {
    this.remotePath = `/sdcard/tapscout-${name}.mp4`;
  }

  get active() {
    return this.proc !== null;
  }

  start(maxSeconds: number, bitRate = 6_000_000) {
    const limit = Math.max(1, Math.min(180, Math.round(maxSeconds)));
    this.proc = spawn(
      adbBin(),
      [
        "shell",
        "screenrecord",
        "--bit-rate",
        String(bitRate),
        "--time-limit",
        String(limit),
        this.remotePath,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    this.startedAt = Date.now();
    this.done = new Promise((resolve) => {
      this.proc?.once("exit", () => resolve());
      this.proc?.once("error", () => resolve());
    });
  }

  /** Stops the recording and pulls the file to `localPath`. */
  async stop(localPath: string): Promise<{ durationMs: number }> {
    const durationMs = Date.now() - this.startedAt;
    if (this.proc) {
      await adb(["shell", "pkill", "-INT", "screenrecord"], 10_000).catch(() => undefined);
      await Promise.race([this.done, sleep(8_000)]);
      this.proc.kill();
      this.proc = null;
    }
    // screenrecord needs a moment to write the moov atom after SIGINT.
    await sleep(700);
    await adb(["pull", this.remotePath, localPath], 120_000);
    await adb(["shell", "rm", "-f", this.remotePath], 10_000).catch(() => undefined);
    return { durationMs };
  }
}

export const ANDROID_KEYCODES: Record<string, number | [number, number]> = {
  enter: 66,
  backspace: 67,
  delete: 112,
  tab: 61,
  escape: 111,
  space: 62,
  back: 4,
  home: 3,
  app_switch: 187,
  menu: 82,
  search: 84,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
  dpad_center: 23,
  move_home: 122,
  move_end: 123,
  // Ctrl+A: KEYCODE_A with META_CTRL_ON | META_CTRL_LEFT_ON.
  select_all: [29, 0x1000 | 0x2000],
};
