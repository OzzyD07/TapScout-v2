// Screen frames: the live stream for the human viewer and timestamped frame captures for the
// agent. Frames are JPEG with a capped long edge.

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { jpegSize, type StreamSettings } from "@tapscout/shared";
import sharp from "sharp";
import { execText, sleep } from "./exec.js";

export interface Frame {
  data: Buffer;
  width: number;
  height: number;
  capturedAt: number;
}

export async function toJpeg(image: Buffer, maxEdge: number, quality: number): Promise<Frame> {
  const capturedAt = Date.now();
  const img = sharp(image);
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const k = w && h ? Math.min(1, maxEdge / Math.max(w, h)) : 1;
  const out = await img
    .resize({ width: Math.max(1, Math.round(w * k)) || undefined })
    .jpeg({ quality, mozjpeg: false })
    .toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height, capturedAt };
}

// ---- ffmpeg ---------------------------------------------------------------------------------

let ffmpegPath: string | null | undefined;

/** ffmpeg from the optional ffmpeg-static package or PATH; null when neither exists. */
export async function findFfmpeg(): Promise<string | null> {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const candidates: string[] = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    const bundled = createRequire(import.meta.url)("ffmpeg-static") as string | null;
    if (bundled) candidates.push(bundled);
  } catch {
    // Optional dependency not installed.
  }
  candidates.push("ffmpeg");
  for (const c of candidates) {
    try {
      await execText(c, ["-hide_banner", "-version"], { timeoutMs: 10_000 });
      ffmpegPath = c;
      return c;
    } catch {
      // Try the next one.
    }
  }
  ffmpegPath = null;
  return null;
}

/** Extracts frames of a video at `fps`; returns them with times relative to the video start. */
export async function extractFrames(
  video: string,
  dir: string,
  fps: number,
  maxEdge: number,
  quality: number,
): Promise<{ frames: { file: string; offsetMs: number }[]; durationMs: number }> {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg is not available");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const q = Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
  const scale = `scale='if(gte(iw,ih),min(${maxEdge},iw),-2)':'if(gte(iw,ih),-2,min(${maxEdge},ih))'`;
  const stderr = await new Promise<string>((resolve, reject) => {
    const p = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-i",
        video,
        "-vf",
        `fps=${fps},${scale}`,
        "-q:v",
        String(q),
        join(dir, "f%04d.jpg"),
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let err = "";
    p.stderr?.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve(err) : reject(new Error(err.slice(-400)))));
  });
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const durationMs = d ? (Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000 : 0;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
  return {
    frames: files.map((f, i) => ({ file: join(dir, f), offsetMs: Math.round((i * 1000) / fps) })),
    durationMs,
  };
}

// ---- MJPEG (WebDriverAgent's screen stream) ----------------------------------------------------

/** Reads JPEG frames from a multipart MJPEG HTTP stream until stopped. */
export class MjpegReader {
  private req: http.ClientRequest | null = null;
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly url: string,
    private readonly onFrame: (jpeg: Buffer, receivedAt: number) => void,
    private readonly onEnd: (error?: Error) => void,
  ) {}

  start() {
    this.req = http.get(this.url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        this.onEnd(new Error(`MJPEG stream answered HTTP ${res.statusCode}`));
        return;
      }
      res.on("data", (chunk: Buffer) => this.push(chunk));
      res.on("end", () => this.onEnd());
      res.on("error", (e) => this.onEnd(e));
    });
    this.req.on("error", (e) => this.onEnd(e));
  }

  private push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        if (this.buffer.length > 16 * 1024 * 1024) this.buffer = Buffer.alloc(0);
        return;
      }
      const jpeg = Buffer.from(this.buffer.subarray(start, end + 2));
      this.buffer = this.buffer.subarray(end + 2);
      this.onFrame(jpeg, Date.now());
    }
  }

  stop() {
    this.req?.destroy();
    this.req = null;
  }
}

// ---- Live stream ------------------------------------------------------------------------------

export interface LiveStreamDeps {
  /** One full screenshot (PNG or JPEG) without going through Appium's command queue. */
  grab: () => Promise<Buffer>;
  /** iOS: MJPEG URL of WDA's stream and a way to tune it; absent on Android. */
  mjpeg?: { url: string; configure: (s: StreamSettings) => Promise<void> };
  onFrame: (frame: Frame) => void;
  log: (message: string) => void;
}

/**
 * Streams frames while fps > 0. MJPEG first where available (smooth), polling screenshots as
 * the fallback (2–5 fps on an emulator).
 */
export class LiveStream {
  private settings: StreamSettings = { fps: 0, maxEdge: 720, quality: 60 };
  private loop: Promise<void> | null = null;
  private mjpeg: MjpegReader | null = null;
  private mjpegFailed = false;
  private lastSent = 0;
  private generation = 0;
  method: "mjpeg" | "poll" | "none" = "none";

  constructor(private readonly deps: LiveStreamDeps) {}

  update(settings: StreamSettings) {
    const changed =
      settings.fps !== this.settings.fps ||
      settings.maxEdge !== this.settings.maxEdge ||
      settings.quality !== this.settings.quality;
    this.settings = settings;
    if (!changed && (this.loop || this.mjpeg)) return;
    this.restart();
  }

  private restart() {
    this.generation += 1;
    this.mjpeg?.stop();
    this.mjpeg = null;
    this.method = "none";
    if (this.settings.fps <= 0) return;
    if (this.deps.mjpeg && !this.mjpegFailed) {
      void this.startMjpeg(this.generation);
    } else {
      this.startPoll(this.generation);
    }
  }

  private async startMjpeg(gen: number) {
    const m = this.deps.mjpeg;
    if (!m) return;
    try {
      await m.configure(this.settings);
    } catch (error) {
      this.deps.log(`mjpeg settings failed: ${(error as Error).message}`);
    }
    if (gen !== this.generation) return;
    let got = false;
    const reader = new MjpegReader(
      m.url,
      (jpeg, receivedAt) => {
        got = true;
        if (receivedAt - this.lastSent < 1000 / this.settings.fps - 5) return;
        this.lastSent = receivedAt;
        const size = jpegSize(jpeg);
        void this.emit(jpeg, size, receivedAt);
      },
      (error) => {
        if (gen !== this.generation) return;
        this.deps.log(`mjpeg stream ended${error ? `: ${error.message}` : ""}; polling instead`);
        if (!got) this.mjpegFailed = true;
        this.mjpeg = null;
        this.startPoll(gen);
      },
    );
    this.mjpeg = reader;
    this.method = "mjpeg";
    reader.start();
    // No frame in 8 s: WDA's stream is not usable on this machine.
    setTimeout(() => {
      if (!got && gen === this.generation && this.mjpeg === reader) {
        this.mjpegFailed = true;
        reader.stop();
        this.mjpeg = null;
        this.deps.log("mjpeg stream sent nothing; polling screenshots instead");
        this.startPoll(gen);
      }
    }, 8_000);
  }

  private async emit(jpeg: Buffer, size: { width: number; height: number } | null, at: number) {
    const s = this.settings;
    if (size && Math.max(size.width, size.height) <= s.maxEdge * 1.1) {
      this.deps.onFrame({ data: jpeg, width: size.width, height: size.height, capturedAt: at });
      return;
    }
    const f = await toJpeg(jpeg, s.maxEdge, s.quality);
    this.deps.onFrame({ ...f, capturedAt: at });
  }

  private startPoll(gen: number) {
    this.method = "poll";
    const run = async () => {
      let failures = 0;
      while (gen === this.generation && this.settings.fps > 0) {
        const t0 = Date.now();
        try {
          const raw = await this.deps.grab();
          const f = await toJpeg(raw, this.settings.maxEdge, this.settings.quality);
          if (gen !== this.generation) break;
          this.deps.onFrame({ ...f, capturedAt: Math.round((t0 + Date.now()) / 2) });
          failures = 0;
        } catch (error) {
          failures += 1;
          if (failures === 3) this.deps.log(`stream capture failing: ${(error as Error).message}`);
          await sleep(Math.min(5_000, 500 * failures));
        }
        const wait = 1000 / this.settings.fps - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
      }
    };
    this.loop = run().finally(() => {
      this.loop = null;
    });
  }

  stop() {
    this.settings = { ...this.settings, fps: 0 };
    this.restart();
  }
}

/** Polls screenshots as fast as `fps` allows for `durationMs`. */
export async function pollFrames(
  grab: () => Promise<Buffer>,
  durationMs: number,
  fps: number,
  maxEdge: number,
  quality: number,
  onTick?: (elapsedMs: number) => Promise<void>,
): Promise<Frame[]> {
  const frames: Frame[] = [];
  const start = Date.now();
  const pending: Promise<void>[] = [];
  while (Date.now() - start < durationMs) {
    const t0 = Date.now();
    await onTick?.(t0 - start);
    const raw = await grab();
    const at = Math.round((t0 + Date.now()) / 2);
    // Encoding runs in the background so the next grab starts at once.
    pending.push(
      toJpeg(raw, maxEdge, quality).then((f) => {
        frames.push({ ...f, capturedAt: at });
      }),
    );
    const wait = 1000 / fps - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  await Promise.all(pending);
  return frames.sort((a, b) => a.capturedAt - b.capturedAt);
}

export async function readFrameFile(file: string, capturedAt: number): Promise<Frame> {
  const data = await readFile(file);
  const size = jpegSize(data);
  return { data, width: size?.width ?? 0, height: size?.height ?? 0, capturedAt };
}
