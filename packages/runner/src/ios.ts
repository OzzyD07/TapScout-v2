// iOS Simulator helpers (macOS only): xcrun simctl and the host's crash report folder.

import { type ChildProcess, spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CrashReport } from "@tapscout/shared";
import { execText, sleep } from "./exec.js";

export async function simulatorName(udid: string | undefined): Promise<string | undefined> {
  if (!udid) return undefined;
  try {
    const list = JSON.parse(await execText("xcrun", ["simctl", "list", "-j", "devices"])) as {
      devices: Record<string, { udid: string; name: string }[]>;
    };
    return Object.values(list.devices)
      .flat()
      .find((d) => d.udid === udid)?.name;
  } catch {
    return undefined;
  }
}

/** The booted simulator's UDID when none was given. */
export async function bootedSimulator(): Promise<string | undefined> {
  try {
    const list = JSON.parse(
      await execText("xcrun", ["simctl", "list", "-j", "devices", "booted"]),
    ) as { devices: Record<string, { udid: string }[]> };
    return Object.values(list.devices).flat()[0]?.udid;
  } catch {
    return undefined;
  }
}

/** simctl screenshot into a temp file; independent of WebDriverAgent. */
export async function simctlScreenshot(udid: string, file: string): Promise<Buffer> {
  await execText("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", file], {
    timeoutMs: 15_000,
  });
  return readFile(file);
}

/** simctl video recording; stopped with SIGINT so the MP4 is finalised. */
export class SimctlRecord {
  private proc: ChildProcess | null = null;
  private done: Promise<void> | null = null;
  startedAt = 0;

  get active() {
    return this.proc !== null;
  }

  start(udid: string, file: string) {
    this.proc = spawn(
      "xcrun",
      ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", file],
      { stdio: "ignore" },
    );
    this.startedAt = Date.now();
    this.done = new Promise((resolve) => {
      this.proc?.once("exit", () => resolve());
      this.proc?.once("error", () => resolve());
    });
  }

  /** Stops the recording; `stoppedAt` is when SIGINT was sent (where the video ends). */
  async stop(): Promise<{ durationMs: number; stoppedAt: number }> {
    const stoppedAt = Date.now();
    const durationMs = stoppedAt - this.startedAt;
    if (this.proc) {
      this.proc.kill("SIGINT");
      await Promise.race([this.done, sleep(10_000)]);
      this.proc = null;
    }
    return { durationMs, stoppedAt };
  }
}

const REPORTS_DIR = join(homedir(), "Library", "Logs", "DiagnosticReports");

interface IpsBody {
  exception?: { type?: string; signal?: string; codes?: string };
  termination?: { indicator?: string; reasons?: string[] };
  faultingThread?: number;
  threads?: { frames?: { symbol?: string; imageIndex?: number }[] }[];
  usedImages?: { name?: string }[];
  asi?: Record<string, string[]>;
}

/** A readable summary of an .ips crash report (first line: JSON header; rest: JSON body). */
export function summarizeIps(text: string): string {
  const nl = text.indexOf("\n");
  try {
    const header = JSON.parse(text.slice(0, nl)) as Record<string, unknown>;
    const body = JSON.parse(text.slice(nl + 1)) as IpsBody;
    const thread = body.threads?.[body.faultingThread ?? 0];
    const frames = (thread?.frames ?? []).slice(0, 12).map((f, i) => {
      const image = body.usedImages?.[f.imageIndex ?? -1]?.name ?? "?";
      return `  ${i} ${image} ${f.symbol ?? "???"}`;
    });
    const asi = Object.values(body.asi ?? {})
      .flat()
      .slice(0, 3);
    return [
      `${String(header.app_name ?? header.name ?? "app")} ${String(header.app_version ?? "")} crashed at ${String(header.timestamp ?? "?")}`,
      `Exception: ${body.exception?.type ?? "?"} (${body.exception?.signal ?? "?"}) ${body.exception?.codes ?? ""}`,
      body.termination?.indicator ? `Termination: ${body.termination.indicator}` : "",
      ...asi.map((a) => `Note: ${a}`),
      "Crashed thread:",
      ...frames,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return text.slice(0, 2_000);
  }
}

/** Crash reports of the app written since `sinceMs`. */
export async function iosCrashReports(executable: string, sinceMs: number) {
  const out: (CrashReport & { path: string })[] = [];
  let names: string[] = [];
  try {
    names = await readdir(REPORTS_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".ips") || !name.startsWith(executable)) continue;
    const path = join(REPORTS_DIR, name);
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) continue;
    const text = await readFile(path, "utf8");
    const summary = summarizeIps(text);
    out.push({
      source: "ios_diagnostic_report",
      at: info.mtimeMs,
      summary: summary.split("\n").slice(0, 2).join(" "),
      text: summary,
      path,
    });
  }
  return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}
