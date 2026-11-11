// Performance measurements of the app under test.
//  Android (emulator, over adb): CPU from /proc/<pid>/stat deltas, memory from dumpsys meminfo,
//    frame timing and jank from dumpsys gfxinfo, start time from `am start -W`.
//  iOS Simulator: the app is a process of the Mac, so CPU time and memory come from `ps` on the
//    host; there is no frame-timing API outside an XCTest bundle, so smoothness is measured
//    visually from the screen video (both platforms get that measure).
// Emulators and simulators share the host's CPU and GPU (Android CI images even render in
// software): use the numbers to compare builds and screens on the same setup, not as real-device
// figures.

import type { DeviceInfo, FrameStats, ProcessStats, VisualTiming } from "@tapscout/shared";
import sharp from "sharp";
import { adb, pidOf } from "./android.js";
import { execText, sleep } from "./exec.js";

export const PERF_NOTE =
  "Measured on an emulator/simulator that shares the host's CPU and GPU: compare builds and screens on the same setup; absolute values differ from real devices.";

const num = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const mb = (kb: number | undefined) => (kb === undefined ? undefined : Math.round(kb / 102.4) / 10);

// ---- Process: pid, CPU time, memory -------------------------------------------------------

/** CPU seconds the process has used so far. */
export async function cpuSeconds(info: DeviceInfo, pid: number): Promise<number | undefined> {
  if (info.platform === "android") {
    const stat = await adb(["shell", "cat", `/proc/${pid}/stat`], 10_000).catch(() => "");
    // Fields after the parenthesised command name: utime is field 14, stime 15 (1-based).
    const rest = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const utime = num(rest[11]);
    const stime = num(rest[12]);
    return utime !== undefined && stime !== undefined ? (utime + stime) / 100 : undefined;
  }
  const out = await execText("ps", ["-o", "time=", "-p", String(pid)], { timeoutMs: 5_000 }).catch(
    () => "",
  );
  // [[dd-]hh:]mm:ss.cc
  const parts = out.trim().split(/[-:]/).map(Number);
  if (parts.length < 2 || parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export async function appPid(info: DeviceInfo, udid?: string): Promise<number | undefined> {
  if (info.platform === "android") return pidOf(info.appId);
  if (!udid) return undefined;
  const list = await execText("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], {
    timeoutMs: 15_000,
  }).catch(() => "");
  for (const line of list.split("\n")) {
    if (!line.includes(`UIKitApplication:${info.appId}[`)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return undefined;
}

/** Memory and threads now (Android: dumpsys meminfo, iOS: ps on the host). */
export async function memory(info: DeviceInfo, pid: number): Promise<Omit<ProcessStats, "pid">> {
  if (info.platform === "android") {
    const out = await adb(["shell", "dumpsys", "meminfo", info.appId], 20_000).catch(() => "");
    const pick = (re: RegExp) => mb(num(re.exec(out)?.[1]));
    const status = await adb(["shell", "cat", `/proc/${pid}/status`], 10_000).catch(() => "");
    const rss = pick(/TOTAL RSS:\s+(\d+)/) ?? mb(num(/VmRSS:\s+(\d+)/.exec(status)?.[1]));
    const stats: Omit<ProcessStats, "pid"> = {};
    const pss = pick(/TOTAL PSS:\s+(\d+)/) ?? pick(/^\s*TOTAL\s+(\d+)/m);
    if (pss !== undefined) stats.pssMb = pss;
    if (rss !== undefined) stats.rssMb = rss;
    const java = pick(/Java Heap:\s+(\d+)/);
    if (java !== undefined) stats.javaHeapMb = java;
    const native = pick(/Native Heap:\s+(\d+)/);
    if (native !== undefined) stats.nativeHeapMb = native;
    const graphics = pick(/Graphics:\s+(\d+)/);
    if (graphics !== undefined) stats.graphicsMb = graphics;
    const threads = num(/Threads:\s+(\d+)/.exec(status)?.[1]);
    if (threads !== undefined) stats.threads = threads;
    return stats;
  }
  const out = await execText("ps", ["-o", "rss=", "-p", String(pid)], { timeoutMs: 5_000 }).catch(
    () => "",
  );
  const threadsOut = await execText("ps", ["-M", "-p", String(pid)], { timeoutMs: 5_000 }).catch(
    () => "",
  );
  const stats: Omit<ProcessStats, "pid"> = {};
  const rss = mb(num(out.trim()));
  if (rss !== undefined) stats.rssMb = rss;
  const lines = threadsOut.trim().split("\n").length - 1;
  if (lines > 0) stats.threads = lines;
  return stats;
}

/** Process stats with CPU averaged over `windowMs` (percent of one core). */
export async function processStats(
  info: DeviceInfo,
  udid: string | undefined,
  windowMs = 1_000,
): Promise<ProcessStats | null> {
  const pid = await appPid(info, udid);
  if (!pid) return null;
  const t0 = Date.now();
  const c0 = await cpuSeconds(info, pid);
  await sleep(windowMs);
  const c1 = await cpuSeconds(info, pid);
  const elapsed = (Date.now() - t0) / 1000;
  const stats: ProcessStats = { pid, ...(await memory(info, pid)) };
  if (c0 !== undefined && c1 !== undefined && elapsed > 0) {
    stats.cpuPercent = Math.round(((c1 - c0) / elapsed) * 1000) / 10;
  }
  return stats;
}

/** CPU and resident memory every `intervalMs` for `durationMs`. */
export async function sampleProcess(
  info: DeviceInfo,
  udid: string | undefined,
  durationMs: number,
  intervalMs: number,
): Promise<{ pid: number; samples: { atMs: number; cpuPercent: number; rssMb: number }[] } | null> {
  const pid = await appPid(info, udid);
  if (!pid) return null;
  const samples: { atMs: number; cpuPercent: number; rssMb: number }[] = [];
  const start = Date.now();
  let lastT = start;
  let lastC = await cpuSeconds(info, pid);
  while (Date.now() - start < durationMs) {
    await sleep(Math.max(250, intervalMs - (Date.now() - lastT)));
    const t = Date.now();
    const c = await cpuSeconds(info, pid);
    const rss =
      info.platform === "android"
        ? mb(
            num(
              /VmRSS:\s+(\d+)/.exec(
                await adb(["shell", "cat", `/proc/${pid}/status`], 10_000).catch(() => ""),
              )?.[1],
            ),
          )
        : (await memory(info, pid)).rssMb;
    if (c !== undefined && lastC !== undefined) {
      samples.push({
        atMs: t - start,
        cpuPercent: Math.round(((c - lastC) / ((t - lastT) / 1000)) * 1000) / 10,
        rssMb: rss ?? 0,
      });
    }
    lastT = t;
    lastC = c;
  }
  return { pid, samples };
}

// ---- Android frame timing -------------------------------------------------------------------

export async function gfxReset(appId: string) {
  await adb(["shell", "dumpsys", "gfxinfo", appId, "reset"], 15_000).catch(() => undefined);
}

export function parseGfxinfo(out: string): FrameStats | null {
  const total = num(/Total frames rendered:\s*(\d+)/.exec(out)?.[1]);
  if (total === undefined) return null;
  const janky = /Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/.exec(out);
  const field = (label: string) => num(new RegExp(`${label}:\\s*(\\d+)`).exec(out)?.[1]);
  const pct = (p: number) => num(new RegExp(`^${p}th percentile:\\s*(\\d+)ms`, "m").exec(out)?.[1]);
  const stats: FrameStats = {
    source: "gfxinfo",
    totalFrames: total,
    jankyFrames: num(janky?.[1]) ?? 0,
    jankyPercent: num(janky?.[2]) ?? 0,
  };
  const set = (key: keyof FrameStats, value: number | undefined) => {
    if (value !== undefined) (stats as unknown as Record<string, number>)[key] = value;
  };
  set("p50Ms", pct(50));
  set("p90Ms", pct(90));
  set("p95Ms", pct(95));
  set("p99Ms", pct(99));
  set("missedVsync", field("Number Missed Vsync"));
  set("slowUiThread", field("Number Slow UI thread"));
  set("slowBitmapUploads", field("Number Slow bitmap uploads"));
  set("slowDrawCommands", field("Number Slow issue draw commands"));
  set("deadlineMissed", field("Number Frame deadline missed"));
  set("highInputLatency", field("Number High input latency"));
  return stats;
}

export async function gfxRead(appId: string): Promise<FrameStats | null> {
  return parseGfxinfo(await adb(["shell", "dumpsys", "gfxinfo", appId], 20_000).catch(() => ""));
}

// ---- Start time -------------------------------------------------------------------------------

/** Android: TotalTime/WaitTime/LaunchState of `am start -W` (after force-stop when cold). */
export async function androidLaunch(appId: string, cold: boolean) {
  const resolved = await adb([
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-c",
    "android.intent.category.LAUNCHER",
    appId,
  ]);
  const component = resolved.trim().split("\n").pop()?.trim();
  if (!component?.includes("/")) throw new Error(`no launcher activity for ${appId}`);
  if (cold) await adb(["shell", "am", "force-stop", appId]);
  else await adb(["shell", "input", "keyevent", "3"]);
  await sleep(cold ? 800 : 1_200);
  const started = Date.now();
  const out = await adb(["shell", "am", "start", "-W", "-n", component], 60_000);
  return {
    started,
    totalTimeMs: num(/TotalTime:\s*(\d+)/.exec(out)?.[1]),
    waitTimeMs: num(/WaitTime:\s*(\d+)/.exec(out)?.[1]),
    launchState: /LaunchState:\s*(\w+)/.exec(out)?.[1],
  };
}

// ---- Visual timing --------------------------------------------------------------------------

/** Mean absolute difference of two frames on a small greyscale thumbnail, 0–1. */
export async function frameDiff(a: Buffer, b: Buffer): Promise<number> {
  const thumb = (img: Buffer) =>
    sharp(img).resize(48, 96, { fit: "fill" }).greyscale().raw().toBuffer();
  const [x, y] = await Promise.all([thumb(a), thumb(b)]);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs((x[i] ?? 0) - (y[i] ?? 0));
  return sum / (x.length * 255);
}

/**
 * Response, settle time and smoothness from timestamped frames (pure; `diffs[i]` is the change
 * from frame i-1 to frame i). A frame "changes" when its diff exceeds `threshold`.
 */
export function visualTiming(
  times: number[],
  diffs: number[],
  actionAt: number,
  method: VisualTiming["method"],
  threshold = 0.002,
): VisualTiming {
  const changed: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const t = times[i] as number;
    if (t >= actionAt - 50 && (diffs[i] ?? 0) > threshold) changed.push(t);
  }
  if (changed.length === 0) return { changedFrames: 0, method };
  const first = changed[0] as number;
  const last = changed[changed.length - 1] as number;
  let longestGap = 0;
  for (let i = 1; i < changed.length; i++) {
    longestGap = Math.max(longestGap, (changed[i] as number) - (changed[i - 1] as number));
  }
  const span = last - first;
  return {
    firstChangeMs: Math.max(0, Math.round(first - actionAt)),
    settledMs: Math.max(0, Math.round(last - actionAt)),
    ...(span >= 100 ? { visualFps: Math.round(((changed.length - 1) / span) * 10_000) / 10 } : {}),
    ...(changed.length > 1 ? { longestGapMs: Math.round(longestGap) } : {}),
    changedFrames: changed.length,
    method,
  };
}

/** Time from `since` until two consecutive screenshots no longer differ (max `limitMs`). */
export async function waitVisuallyReady(
  grab: () => Promise<Buffer>,
  since: number,
  limitMs = 15_000,
): Promise<number | undefined> {
  let prev = await grab();
  let lastChange = Date.now();
  let still = 0;
  while (Date.now() - since < limitMs) {
    await sleep(150);
    const next = await grab();
    if ((await frameDiff(prev, next)) > 0.002) {
      lastChange = Date.now();
      still = 0;
    } else if (++still >= 3) {
      return lastChange - since;
    }
    prev = next;
  }
  return undefined;
}
