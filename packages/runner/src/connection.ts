// The runner's only link to the hub: one outbound WebSocket (works behind NAT and through a quick
// tunnel), plus authenticated HTTP for the build download and evidence uploads.
//
// Authentication: the first connection presents a GitHub Actions OIDC token (or a one-time local
// token); the hub answers with a hub-signed session token used for every reconnect and HTTP call.
// When the hub no longer accepts the session token (hub restarted with a new secret), the runner
// falls back to a fresh OIDC token.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { encodeBinary, GATEWAY_PATHS, type HubMessage, type RunnerMessage } from "@tapscout/shared";
import WebSocket from "ws";
import { sleep } from "./exec.js";

export class HubRejected extends Error {}

export interface HubConnectionOptions {
  hubUrl: string;
  sessionId: string;
  /** OIDC token (GitHub) or one-time local token; called again whenever it is needed. */
  credential: () => Promise<string>;
  hello: () => Extract<RunnerMessage, { t: "hello" }>;
  onMessage: (msg: HubMessage) => void;
  onOpen: () => void;
  onDisconnect: () => void;
  log: (message: string) => void;
  /** How long the hub may stay unreachable before the runner gives up. */
  graceMs: () => number;
}

const SILENCE_LIMIT_MS = 45_000;

export class HubConnection {
  private ws: WebSocket | null = null;
  sessionToken: string | null = null;
  private stopped = false;
  private lastSeen = 0;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(private readonly o: HubConnectionOptions) {}

  private wsUrl(): string {
    const u = new URL(GATEWAY_PATHS.connect, this.o.hubUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("session", this.o.sessionId);
    return u.toString();
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Keeps the connection up until `stop()`; rejects with HubRejected when the hub refuses the
   * session for good, or with an Error when the hub stayed unreachable longer than the grace.
   */
  async run(): Promise<void> {
    let downSince: number | null = null;
    let attempt = 0;
    while (!this.stopped) {
      const outcome = await this.connectOnce();
      if (this.stopped) return;
      if (outcome === "opened") {
        downSince = null;
        attempt = 0;
        this.o.onDisconnect();
      } else if (outcome === "retry_now") {
        continue;
      }
      downSince ??= Date.now();
      if (Date.now() - downSince > this.o.graceMs()) {
        throw new Error(`hub unreachable for ${Math.round((Date.now() - downSince) / 1000)} s`);
      }
      attempt += 1;
      await sleep(Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4)));
    }
  }

  private async connectOnce(): Promise<"opened" | "failed" | "retry_now"> {
    const usingSessionToken = this.sessionToken !== null;
    let token: string;
    try {
      token = this.sessionToken ?? (await this.o.credential());
    } catch (error) {
      this.o.log(`credential unavailable: ${(error as Error).message}`);
      return "failed";
    }
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(this.wsUrl(), {
        headers: { authorization: `Bearer ${token}` },
        handshakeTimeout: 30_000,
        maxPayload: 64 * 1024 * 1024,
      });
      this.ws = ws;
      ws.on("unexpected-response", (_req, res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        ws.terminate();
        if (status === 401 && usingSessionToken) {
          this.o.log("hub refused the session token; authenticating again");
          this.sessionToken = null;
          resolve("retry_now");
        } else if (status === 401 || status === 403 || status === 404 || status === 410) {
          reject(new HubRejected(`hub refused the runner (HTTP ${status})`));
        } else {
          this.o.log(`hub answered HTTP ${status}`);
          resolve("failed");
        }
      });
      ws.on("open", () => {
        opened = true;
        this.lastSeen = Date.now();
        this.send(this.o.hello());
        this.startWatchdog(ws);
        this.o.onOpen();
      });
      ws.on("message", (data, isBinary) => {
        this.lastSeen = Date.now();
        if (isBinary) return;
        let msg: HubMessage;
        try {
          msg = JSON.parse(data.toString()) as HubMessage;
        } catch {
          return;
        }
        if (msg.t === "welcome") this.sessionToken = msg.sessionToken;
        if (msg.t === "ping") {
          this.send({ t: "pong", at: msg.at });
          return;
        }
        if (msg.t === "pong") return;
        this.o.onMessage(msg);
      });
      ws.on("error", (error) => {
        if (!opened) this.o.log(`connect failed: ${error.message}`);
      });
      ws.on("close", () => {
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
        if (this.ws === ws) this.ws = null;
        resolve(opened ? "opened" : "failed");
      });
    });
  }

  /** Drops a connection that went silent (a tunnel can keep a dead socket "open"). */
  private startWatchdog(ws: WebSocket) {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastSeen > SILENCE_LIMIT_MS) {
        this.o.log("hub went silent; reconnecting");
        ws.terminate();
      } else if (ws.readyState === WebSocket.OPEN) {
        this.send({ t: "ping", at: Date.now() });
      }
    }, 15_000);
  }

  send(msg: RunnerMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendBinary(header: RunnerMessage, payload: Uint8Array): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    // Live frames are dropped rather than queued when the socket is congested.
    if (header.t === "frame" && this.ws.bufferedAmount > 2 * 1024 * 1024) return false;
    this.ws.send(encodeBinary(header, payload));
    return true;
  }

  async stop(reason: string): Promise<void> {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    const ws = this.ws;
    if (!ws) return;
    this.send({ t: "bye", reason });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 3_000);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.close(1000, reason.slice(0, 100));
    });
  }

  // ---- HTTP ---------------------------------------------------------------------------------

  private authHeader(): Record<string, string> {
    if (!this.sessionToken) throw new Error("no session token yet");
    return { authorization: `Bearer ${this.sessionToken}` };
  }

  private httpUrl(path: string, params: Record<string, string> = {}): URL {
    const u = new URL(path, this.o.hubUrl);
    u.searchParams.set("session", this.o.sessionId);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  }

  /** Streams the build to `dest`; returns its size and SHA-256. Retries transient failures. */
  async downloadBuild(dest: string): Promise<{ sizeBytes: number; sha256: string }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(this.httpUrl(GATEWAY_PATHS.build), {
          headers: this.authHeader(),
          signal: AbortSignal.timeout(15 * 60_000),
        });
        if (!res.ok || !res.body) throw new Error(`build download HTTP ${res.status}`);
        const hash = createHash("sha256");
        let size = 0;
        const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
        body.on("data", (chunk: Buffer) => {
          hash.update(chunk);
          size += chunk.length;
        });
        await pipeline(body, createWriteStream(dest));
        return { sizeBytes: size, sha256: hash.digest("hex") };
      } catch (error) {
        lastError = error;
        this.o.log(`build download attempt ${attempt} failed: ${(error as Error).message}`);
        await sleep(2_000 * attempt);
      }
    }
    throw lastError;
  }

  /** Uploads a file or bytes to the session's evidence folder under `name`. */
  async upload(name: string, data: Buffer | string, kind = "file"): Promise<void> {
    const body = typeof data === "string" ? await readFile(data) : data;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(this.httpUrl(GATEWAY_PATHS.upload, { name, kind }), {
          method: "PUT",
          headers: { ...this.authHeader(), "content-type": "application/octet-stream" },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(5 * 60_000),
        });
        if (!res.ok)
          throw new Error(`upload HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return;
      } catch (error) {
        lastError = error;
        await sleep(1_500 * attempt);
      }
    }
    throw lastError;
  }
}

/**
 * GitHub Actions OIDC token for the audience (needs `permissions: id-token: write`). The token
 * service answers 5xx now and then, so server errors and network failures are retried.
 */
export async function fetchGithubOidcToken(audience: string, pauseMs = 3_000): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) {
    throw new Error("GitHub OIDC is not available: the job needs `permissions: id-token: write`");
  }
  const attempts = 4;
  let res: Response | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
        headers: { authorization: `Bearer ${requestToken}` },
      });
      if (res.ok || res.status < 500 || attempt === attempts) break;
    } catch (error) {
      if (attempt === attempts) throw error;
    }
    await sleep(pauseMs * attempt);
  }
  if (!res?.ok) throw new Error(`OIDC token request failed with HTTP ${res?.status}`);
  const { value } = (await res.json()) as { value?: string };
  if (!value) throw new Error("OIDC token response had no value");
  return value;
}
