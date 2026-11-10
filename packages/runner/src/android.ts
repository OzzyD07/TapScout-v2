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

  /**
   * `size` should keep the display aspect ratio: without it screenrecord falls back to an
   * encoder size of its own on tall displays and pillarboxes the picture.
   */
  start(maxSeconds: number, bitRate = 6_000_000, size?: { width: number; height: number }) {
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
        ...(size ? ["--size", `${size.width}x${size.height}`] : []),
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
  /**
   * Polls the output file until it has bytes, which happens when the encoder delivers its first
   * frame: that moment is the video's time zero. Null when it does not happen in time.
   */
  async waitFirstFrame(timeoutMs = 3_000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const t0 = Date.now();
      const out = await adb(["shell", "stat", "-c", "%s", this.remotePath], 5_000).catch(() => "");
      const t1 = Date.now();
      if (Number(out.trim()) > 0) return Math.round((t0 + t1) / 2);
      await sleep(15);
    }
    return null;
  }

  /**
   * Stops the recording and pulls the file to `localPath`. `stoppedAt` estimates when the
   * device received SIGINT (the middle of the adb round trip), i.e. where the video ends.
   */
  async stop(localPath: string): Promise<{ durationMs: number; stoppedAt: number }> {
    const durationMs = Date.now() - this.startedAt;
    let stoppedAt = Date.now();
    if (this.proc) {
      const t0 = Date.now();
      await adb(["shell", "pkill", "-INT", "screenrecord"], 10_000).catch(() => undefined);
      stoppedAt = Math.round((t0 + Date.now()) / 2);
      await Promise.race([this.done, sleep(8_000)]);
      this.proc.kill();
      this.proc = null;
    }
    // screenrecord needs a moment to write the moov atom after SIGINT.
    await sleep(700);
    await adb(["pull", this.remotePath, localPath], 120_000);
    await adb(["shell", "rm", "-f", this.remotePath], 10_000).catch(() => undefined);
    return { durationMs, stoppedAt };
  }
}

/** A recording size with the screen's aspect ratio, long edge ≤ `longEdge`, multiples of 16. */
export function recordSize(width: number, height: number, longEdge = 1280) {
  if (!width || !height) return undefined;
  const k = Math.min(1, longEdge / Math.max(width, height));
  const even = (n: number) => Math.max(16, Math.round((n * k) / 16) * 16);
  return { width: even(width), height: even(height) };
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
