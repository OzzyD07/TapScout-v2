// Continuous device log capture into one file per session, in a common line format:
//   <epoch ms> <pid> <level V|D|I|W|E|F> <tag/subsystem>: <message>
// Android: adb logcat (main, system, crash). iOS: `log stream` of the app's process.

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { LogLevel } from "@tapscout/shared";
import { adb, adbBin } from "./android.js";

const LEVELS = ["V", "D", "I", "W", "E", "F"] as const;
const LEVEL_OF: Record<LogLevel, (typeof LEVELS)[number]> = {
  verbose: "V",
  debug: "D",
  info: "I",
  warn: "W",
  error: "E",
  fatal: "F",
};

/** logcat `-v threadtime -v epoch` line → common format, or null for headers. */
export function fromLogcat(line: string): string | null {
  const m = /^\s*(\d+)\.(\d+)\s+(\d+)\s+\d+\s+([VDIWEFA])\s+(.*)$/.exec(line);
  if (!m) return null;
  const ms = Number(m[1]) * 1000 + Number((m[2] ?? "0").padEnd(3, "0").slice(0, 3));
  const level = m[4] === "A" ? "F" : m[4];
  return `${ms} ${m[3]} ${level} ${m[5]}`;
}

/** `log stream --style ndjson` line → common format. */
export function fromOsLog(line: string): string | null {
  try {
    const e = JSON.parse(line) as {
      timestamp?: string;
      messageType?: string;
      eventMessage?: string;
      processID?: number;
      subsystem?: string;
      category?: string;
    };
    if (!e.eventMessage) return null;
    const ms = Date.parse((e.timestamp ?? "").replace(" ", "T").replace(/(\.\d{3})\d+/, "$1"));
    const level =
      e.messageType === "Fault"
        ? "F"
        : e.messageType === "Error"
          ? "E"
          : e.messageType === "Debug"
            ? "D"
            : "I";
    const tag = [e.subsystem, e.category].filter(Boolean).join("/") || "app";
    const message = e.eventMessage.replace(/\s*\n\s*/g, " ⏎ ");
    return `${Number.isFinite(ms) ? ms : Date.now()} ${e.processID ?? 0} ${level} ${tag}: ${message}`;
  } catch {
    return null;
  }
}

export interface LogQuery {
  sinceMs?: number;
  grep?: string;
  minLevel?: LogLevel;
  /** Android: only lines of the app's processes (or naming its package). */
  appOnly?: boolean;
  maxLines: number;
}

export class LogCapture {
  private proc: ChildProcess | null = null;
  private out: WriteStream | null = null;
  private pending = "";
  readonly pids = new Set<number>();

  constructor(
    readonly file: string,
    readonly source: string,
    private readonly appId: string,
  ) {}

  /** Android: clears the old buffers and follows main, system and crash. */
  static async android(file: string, appId: string): Promise<LogCapture> {
    const capture = new LogCapture(file, "logcat", appId);
    await adb(["logcat", "-b", "all", "-c"], 15_000).catch(() => undefined);
    capture.follow(
      adbBin(),
      ["logcat", "-v", "threadtime", "-v", "epoch", "-b", "main,system,crash"],
      fromLogcat,
    );
    return capture;
  }

  /** iOS: follows the app's process only (the simulator's full log is far too noisy). */
  static ios(file: string, udid: string, executable: string, appId: string): LogCapture {
    const capture = new LogCapture(file, "os_log", appId);
    capture.follow(
      "xcrun",
      [
        "simctl",
        "spawn",
        udid,
        "log",
        "stream",
        "--style",
        "ndjson",
        "--level",
        "debug",
        "--predicate",
        `process == "${executable.replace(/"/g, "")}"`,
      ],
      fromOsLog,
    );
    return capture;
  }

  private follow(cmd: string, args: string[], convert: (line: string) => string | null) {
    this.out = createWriteStream(this.file, { flags: "a" });
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = this.pending + chunk.toString("utf8");
      const lines = text.split(/\r?\n/);
      this.pending = lines.pop() ?? "";
      for (const line of lines) {
        const converted = convert(line);
        if (converted) this.out?.write(`${converted}\n`);
      }
    });
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = null;
    });
  }

  get running() {
    return this.proc !== null;
  }

  trackPid(pid: number | undefined) {
    if (pid) this.pids.add(pid);
  }

  /** Matching lines, newest last; reads at most the last 16 MB of the file. */
  async query(q: LogQuery): Promise<{ lines: string[]; truncated: boolean }> {
    const info = await stat(this.file).catch(() => null);
    if (!info) return { lines: [], truncated: false };
    const window = 16 * 1024 * 1024;
    const start = Math.max(0, info.size - window);
    const handle = await open(this.file, "r");
    const buf = Buffer.alloc(info.size - start);
    try {
      await handle.read(buf, 0, buf.length, start);
    } finally {
      await handle.close();
    }
    const min = LEVELS.indexOf(LEVEL_OF[q.minLevel ?? "verbose"]);
    let grep: RegExp | null = null;
    if (q.grep) {
      try {
        grep = new RegExp(q.grep, "i");
      } catch {
        grep = new RegExp(q.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
    }
    const matched: string[] = [];
    for (const line of buf.toString("utf8").split("\n")) {
      const m = /^(\d+) (\d+) ([VDIWEF]) (.*)$/.exec(line);
      if (!m) continue;
      const at = Number(m[1]);
      if (q.sinceMs && at < q.sinceMs) continue;
      if (LEVELS.indexOf(m[3] as (typeof LEVELS)[number]) < min) continue;
      const rest = m[4] ?? "";
      if (q.appOnly && this.source === "logcat") {
        if (!this.pids.has(Number(m[2])) && !rest.includes(this.appId)) continue;
      }
      if (grep && !grep.test(rest)) continue;
      matched.push(`${new Date(at).toISOString().slice(11, 23)} ${m[2]} ${m[3]} ${rest}`);
    }
    const truncated = matched.length > q.maxLines;
    return { lines: truncated ? matched.slice(-q.maxLines) : matched, truncated };
  }

  async stop(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
    await new Promise<void>((resolve) => {
      if (!this.out) return resolve();
      this.out.end(() => resolve());
    });
    this.out = null;
  }
}
