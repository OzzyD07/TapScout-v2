// Executes hub commands on one device. Device commands run one at a time in arrival order;
// log and crash queries do not wait for them.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type CrashReport,
  type DeviceInfo,
  type FramePart,
  pngSize,
  type RunnerAction,
  type StreamSettings,
} from "@tapscout/shared";
import sharp from "sharp";
import { AndroidScreenRecord, adb, pidOf, recoverEmulator, screencapPng } from "./android.js";
import { type DeviceController, DeviceError } from "./device.js";
import { sleep } from "./exec.js";
import {
  extractFrames,
  type Frame,
  findFfmpeg,
  LiveStream,
  MjpegReader,
  pollFrames,
  readFrameFile,
  toJpeg,
} from "./frames.js";
import { iosCrashReports, SimctlRecord, simctlScreenshot } from "./ios.js";
import type { LogCapture } from "./logs.js";

export interface CommandOutput {
  data: unknown;
  payload?: Buffer;
}

export interface DeviceSessionDeps {
  device: DeviceController;
  info: DeviceInfo;
  outDir: string;
  logs: LogCapture | null;
  udid?: string;
  mjpegPort?: number;
  reopen: () => Promise<DeviceController>;
  upload: (name: string, file: string | Buffer) => Promise<void>;
  onFrame: (frame: Frame) => void;
  log: (message: string) => void;
  event: (level: "info" | "warn" | "error", message: string) => void;
}

/** Appium errors after which the driver session is gone. */
export function isSessionDead(error: unknown): boolean {
  return /invalid session id|session is either terminated|not started|ECONNREFUSED|socket hang up|instrumentation process is not running|device offline|device .* not found/i.test(
    (error as Error)?.message ?? "",
  );
}

export class DeviceSession {
  device: DeviceController;
  info: DeviceInfo;
  readonly stream: LiveStream;
  readonly startedAt = Date.now();
  private queue: Promise<unknown> = Promise.resolve();
  private recorder: AndroidScreenRecord | SimctlRecord | null = null;
  private recordingFile: string | null = null;
  private recordingName: string | null = null;
  private counter = 0;

  constructor(private readonly deps: DeviceSessionDeps) {
    this.device = deps.device;
    this.info = deps.info;
    const ios = this.info.platform === "ios";
    this.stream = new LiveStream({
      grab: () => this.grab(),
      ...(ios && deps.mjpegPort
        ? {
            mjpeg: {
              url: `http://127.0.0.1:${deps.mjpegPort}`,
              configure: (s) => this.enqueue(() => this.configureMjpeg(s)),
            },
          }
        : {}),
      onFrame: deps.onFrame,
      log: deps.log,
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** A raw full-resolution screenshot without Appium (stream and fast captures). */
  async grab(): Promise<Buffer> {
    if (this.info.platform === "android") return screencapPng();
    if (this.deps.udid) {
      return simctlScreenshot(this.deps.udid, join(this.deps.outDir, `grab-${process.pid}.png`));
    }
    return this.device.screenshotPng();
  }

  private async configureMjpeg(s: StreamSettings) {
    const long = Math.max(this.info.screenshotWidth, this.info.screenshotHeight);
    await this.device.driver.updateSettings({
      mjpegServerFramerate: Math.max(1, Math.min(30, Math.round(s.fps))),
      mjpegScalingFactor: Math.max(10, Math.min(100, Math.round((s.maxEdge / long) * 100))),
      mjpegServerScreenshotQuality: Math.max(10, Math.min(100, s.quality)),
    });
  }

  async execute(name: CommandName, args: unknown, timeoutMs: number): Promise<CommandOutput> {
    const parallel = name === "logs" || name === "crashes" || name === "info";
    const run = () => this.withRecovery(name, () => this.dispatch(name, args));
    const task = parallel ? run() : this.enqueue(run);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DeviceError("timeout", `${name} took longer than ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([task, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A dead Appium session is replaced once (app data kept) and the command retried. */
  private async withRecovery(name: CommandName, fn: () => Promise<CommandOutput>) {
    try {
      return await fn();
    } catch (error) {
      if (!isSessionDead(error)) throw error;
      this.deps.event(
        "warn",
        `Device session broke during ${name} (${(error as Error).message.slice(0, 160)}); reconnecting.`,
      );
      await this.device.close().catch(() => undefined);
      if (this.info.platform === "android") await recoverEmulator();
      this.device = await this.deps.reopen();
      this.deps.event("info", "Device session restored; the app was kept with its data.");
      return fn();
    }
  }

  private async dispatch(name: CommandName, rawArgs: unknown): Promise<CommandOutput> {
    const d = this.device;
    switch (name) {
      case "screenshot": {
        const a = rawArgs as CommandArgs<"screenshot">;
        const png = await d.screenshotPng();
        const capturedAt = Date.now();
        const size = pngSize(png);
        const orientation = size && size.width > size.height ? "landscape" : "portrait";
        this.noteSize(size);
        const payload =
          a.format === "png"
            ? png
            : await sharp(png)
                .jpeg({ quality: a.quality ?? 90 })
                .toBuffer();
        const data: CommandResult<"screenshot"> = {
          width: size?.width ?? 0,
          height: size?.height ?? 0,
          capturedAt,
          orientation,
        };
        return { data, payload };
      }
      case "source": {
        const xml = await d.source();
        let alert: { text: string; buttons: string[] } | null = null;
        if (this.info.platform === "ios") alert = await d.systemAlert();
        return { data: { xml, capturedAt: Date.now(), ...(alert ? { alert } : {}) } };
      }
      case "alert": {
        if (this.info.platform !== "ios") {
          throw new DeviceError(
            "unsupported",
            "Android dialogs are in the UI tree; tap their buttons",
          );
        }
        await d.answerAlert((rawArgs as CommandArgs<"alert">).button);
        return { data: {} };
      }
      case "tap":
        await d.tap(rawArgs as CommandArgs<"tap">);
        return { data: {} };
      case "long_press":
        await d.longPress(rawArgs as CommandArgs<"long_press">);
        return { data: {} };
      case "path":
        await d.path(rawArgs as CommandArgs<"path">);
        return { data: {} };
      case "pinch":
        await d.pinch(rawArgs as CommandArgs<"pinch">);
        return { data: {} };
      case "type":
        return { data: await d.type(rawArgs as CommandArgs<"type">) };
      case "key":
        await d.key(rawArgs as CommandArgs<"key">);
        return { data: {} };
      case "keyboard": {
        const a = rawArgs as CommandArgs<"keyboard">;
        const shown = a.action === "hide" ? await d.hideKeyboard() : await d.keyboardShown();
        return { data: { shown } };
      }
      case "app": {
        const result = await d.app(rawArgs as CommandArgs<"app">);
        this.deps.logs?.trackPid(result.pid);
        return { data: result };
      }
      case "orientation": {
        const a = rawArgs as CommandArgs<"orientation">;
        const orientation = await d.orientation(a.set);
        this.info = { ...this.info, orientation };
        return { data: { orientation } };
      }
      case "info":
        return { data: this.info };
      case "logs":
        return { data: await this.logs(rawArgs as CommandArgs<"logs">) };
      case "crashes":
        return { data: await this.crashes(rawArgs as CommandArgs<"crashes">) };
      case "capture_frames":
        return this.captureFrames(rawArgs as CommandArgs<"capture_frames">);
      case "record":
        return { data: await this.record(rawArgs as CommandArgs<"record">) };
      default:
        throw new DeviceError("unknown_command", `unknown command ${String(name)}`);
    }
  }

  private noteSize(size: { width: number; height: number } | null) {
    if (!size) return;
    if (size.width !== this.info.screenshotWidth || size.height !== this.info.screenshotHeight) {
      this.info = {
        ...this.info,
        screenshotWidth: size.width,
        screenshotHeight: size.height,
        orientation: size.width > size.height ? "landscape" : "portrait",
      };
    }
  }

  async runAction(action: RunnerAction): Promise<void> {
    const d = this.device;
    switch (action.name) {
      case "tap":
        return d.tap(action.args);
      case "long_press":
        return d.longPress(action.args);
      case "path":
        return d.path(action.args);
      case "pinch":
        return d.pinch(action.args);
      case "key":
        return d.key(action.args);
      case "app":
        await d.app(action.args);
        return;
    }
  }

  // ---- Logs and crashes ------------------------------------------------------------------

  private async logs(a: CommandArgs<"logs">): Promise<CommandResult<"logs">> {
    const logs = this.deps.logs;
    if (!logs) return { lines: [], truncated: false, source: "none" };
    if (this.info.platform === "android") logs.trackPid(await pidOf(this.info.appId));
    const result = await logs.query({ ...a, sinceMs: a.sinceMs ?? this.startedAt });
    return { ...result, source: logs.source };
  }

  private async crashes(a: CommandArgs<"crashes">): Promise<CommandResult<"crashes">> {
    const since = a.sinceMs ?? this.startedAt;
    const reports: CrashReport[] = [];
    if (this.info.platform === "android") {
      const raw = await adb(
        ["logcat", "-b", "crash", "-d", "-v", "threadtime", "-v", "epoch"],
        15_000,
      ).catch(() => "");
      const lines = raw.split(/\r?\n/).filter((l) => {
        const m = /^\s*(\d+)\.(\d+)/.exec(l);
        return m ? Number(m[1]) * 1000 >= since - 1000 : false;
      });
      if (lines.length > 0) {
        const text = lines.join("\n");
        const head =
          lines.find((l) => /FATAL EXCEPTION|Process: |Exception|Error:/.test(l)) ?? lines[0] ?? "";
        const name = `crashes/android-crash-${++this.counter}.txt`;
        await this.deps.upload(name, Buffer.from(text)).catch(() => undefined);
        reports.push({
          source: "android_crash_buffer",
          at: Date.now(),
          summary: head.replace(/^\s*[\d.]+\s+\d+\s+\d+\s+\w\s+/, "").slice(0, 300),
          text: text.slice(-12_000),
          uploaded: name,
        });
      }
      const anr = await this.deps.logs?.query({
        sinceMs: since,
        grep: `ANR in ${this.info.appId}`,
        maxLines: 20,
      });
      if (anr && anr.lines.length > 0) {
        reports.push({
          source: "android_anr",
          summary: anr.lines[0]?.slice(0, 300) ?? "ANR",
          text: anr.lines.join("\n"),
        });
      }
    } else if (this.info.appExecutable) {
      for (const r of await iosCrashReports(this.info.appExecutable, since)) {
        const name = `crashes/${r.path.split("/").pop() ?? "crash.ips"}`;
        await this.deps.upload(name, r.path).catch(() => undefined);
        const { path: _path, ...report } = r;
        reports.push({ ...report, uploaded: name });
      }
    }
    const state = await this.device.appState().catch(() => -1);
    if (state === 1 || state === 0) {
      reports.push({
        source: "app_not_running",
        summary: state === 0 ? "The app is not installed." : "The app is not running.",
        text: "",
      });
    }
    return { reports };
  }

  // ---- Frames and recordings -------------------------------------------------------------

  private async captureFrames(a: CommandArgs<"capture_frames">): Promise<CommandOutput> {
    const durationMs = Math.max(300, Math.min(a.durationMs, 15_000));
    const fps = Math.max(1, Math.min(a.fps, 30));
    const delay = Math.max(0, a.actionDelayMs ?? 300);
    let actionAt: number | undefined;
    let actionError: string | undefined;
    const runAction = async () => {
      if (!a.action) return;
      actionAt = Date.now();
      try {
        await this.runAction(a.action);
      } catch (error) {
        actionError = (error as Error).message.slice(0, 300);
      }
    };

    let frames: Frame[] = [];
    let method: "video" | "mjpeg" | "poll" = "poll";
    let startedAt = Date.now();
    const android = this.info.platform === "android";

    if (android && !this.recorder && fps > 3 && (await findFfmpeg())) {
      method = "video";
      const rec = new AndroidScreenRecord(`cap-${Date.now()}`);
      const spawnedAt = Date.now();
      rec.start(Math.ceil((durationMs + delay) / 1000) + 3, 8_000_000);
      await sleep(500);
      startedAt = Date.now();
      const actionDone = sleep(delay).then(runAction);
      await sleep(durationMs);
      await actionDone;
      const stopAt = Date.now();
      const dir = join(this.deps.outDir, `cap-${this.counter++}`);
      await mkdir(dir, { recursive: true });
      const mp4 = join(dir, "capture.mp4");
      await rec.stop(mp4);
      const extracted = await extractFrames(mp4, join(dir, "frames"), fps, a.maxEdge, a.quality);
      // The video's first frame is the moment recording started; align its end with the stop.
      const videoStart = Math.max(spawnedAt, stopAt - extracted.durationMs);
      frames = await Promise.all(
        extracted.frames.map((f) => readFrameFile(f.file, videoStart + f.offsetMs)),
      );
      frames = frames.filter((f) => f.capturedAt >= startedAt - 250);
    } else if (!android && this.deps.mjpegPort) {
      method = "mjpeg";
      await this.configureMjpeg({ fps, maxEdge: a.maxEdge, quality: a.quality });
      const got: Frame[] = [];
      let first = false;
      const reader = new MjpegReader(
        `http://127.0.0.1:${this.deps.mjpegPort}`,
        (jpeg, at) => {
          first = true;
          got.push({ data: jpeg, width: 0, height: 0, capturedAt: at });
        },
        () => undefined,
      );
      reader.start();
      startedAt = Date.now();
      const actionDone = sleep(delay).then(runAction);
      await sleep(durationMs);
      await actionDone;
      reader.stop();
      if (!first) {
        method = "poll";
      } else {
        frames = await Promise.all(
          got.map(async (f) => ({
            ...(await toJpeg(f.data, a.maxEdge, a.quality)),
            capturedAt: f.capturedAt,
          })),
        );
      }
    }
    if (method === "poll") {
      startedAt = Date.now();
      const actionDone = sleep(delay).then(runAction);
      frames = await pollFrames(() => this.grab(), durationMs, fps, a.maxEdge, a.quality);
      await actionDone;
    }

    const cap = 150;
    if (frames.length > cap) {
      const step = frames.length / cap;
      frames = Array.from({ length: cap }, (_, i) => frames[Math.floor(i * step)] as Frame);
    }
    const parts: FramePart[] = [];
    let offset = 0;
    for (const f of frames) {
      parts.push({
        offset,
        length: f.data.length,
        capturedAt: f.capturedAt,
        width: f.width,
        height: f.height,
      });
      offset += f.data.length;
    }
    const data: CommandResult<"capture_frames"> = {
      frames: parts,
      method,
      startedAt,
      ...(actionAt ? { actionAt } : {}),
      ...(actionError ? { actionError } : {}),
    };
    return { data, payload: Buffer.concat(frames.map((f) => f.data)) };
  }

  private async record(a: CommandArgs<"record">): Promise<CommandResult<"record">> {
    if (a.action === "start") {
      if (this.recorder) return { recording: true };
      const name = `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`;
      const file = join(this.deps.outDir, name);
      if (this.info.platform === "android") {
        const rec = new AndroidScreenRecord(`rec-${Date.now()}`);
        rec.start(a.maxSeconds ?? 180);
        this.recorder = rec;
      } else {
        if (!this.deps.udid)
          throw new DeviceError("unsupported", "recording needs the simulator UDID");
        const rec = new SimctlRecord();
        rec.start(this.deps.udid, file);
        this.recorder = rec;
      }
      this.recordingFile = file;
      this.recordingName = name;
      return { recording: true };
    }
    return this.stopRecording();
  }

  async stopRecording(): Promise<CommandResult<"record">> {
    const rec = this.recorder;
    const file = this.recordingFile;
    const name = this.recordingName;
    if (!rec || !file || !name) return { recording: false };
    this.recorder = null;
    const { durationMs } =
      rec instanceof AndroidScreenRecord ? await rec.stop(file) : await rec.stop();
    const uploaded = `recordings/${name}`;
    const { stat } = await import("node:fs/promises");
    const sizeBytes = (await stat(file)).size;
    await this.deps.upload(uploaded, file);
    return { recording: false, uploaded, sizeBytes, durationMs };
  }

  async shutdown(): Promise<void> {
    this.stream.stop();
    if (this.recorder) await this.stopRecording().catch(() => undefined);
  }
}
