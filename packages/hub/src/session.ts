// One device session as the hub sees it: the record on disk, the runner's socket, commands in
// flight, the live frame ring buffer and everyone watching.

import { randomUUID } from "node:crypto";
import {
  type CommandName,
  type CommandResult,
  decodeBinary,
  type HubMessage,
  makeViewTransform,
  type RunnerMessage,
  type StreamSettings,
  type UiTree,
  type ViewTransform,
} from "@tapscout/shared";
import WebSocket from "ws";
import type { HubConfig } from "./config.js";
import {
  type SessionEvent,
  type SessionRecord,
  type SessionState,
  type Store,
  type StoredEvent,
  TERMINAL_STATES,
} from "./store.js";
import type { Recording } from "./tests.js";

export class SessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LiveFrame {
  seq: number;
  capturedAt: number;
  receivedAt: number;
  width: number;
  height: number;
  data: Buffer;
}

interface Pending {
  name: CommandName;
  resolve: (v: { data: unknown; payload?: Buffer }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CommandOutcome<N extends CommandName> {
  data: CommandResult<N>;
  payload?: Buffer;
}

export class HubSession {
  private runner: WebSocket | null = null;
  runnerHello: Extract<RunnerMessage, { t: "hello" }> | null = null;
  private lastRunnerMessage = 0;
  private readonly pending = new Map<string, Pending>();
  private eventSeq = 0;
  private sentStream: StreamSettings | null = null;
  private readonly stateWaiters = new Set<() => void>();
  readonly frameListeners = new Set<(f: LiveFrame) => void>();
  readonly eventListeners = new Set<(e: StoredEvent) => void>();
  /** Clients (MJPEG viewers) that want the higher stream rate. */
  viewers = 0;
  /** Temporary stream boost requested by a tool, until this time. */
  boostUntil = 0;
  ring: LiveFrame[] = [];
  transform: ViewTransform | null = null;
  lastScreen: { full: Buffer; capturedAt: number } | null = null;
  lastTree: { tree: UiTree; capturedAt: number; seq: number } | null = null;
  /** Increments on every action that may change the screen. */
  actionSeq = 0;
  lastActivity = Date.now();
  disconnectedAt: number | null = null;
  progress: string[] = [];
  /** Things the agent must hear about at its next tool call (late command outcomes, recovery). */
  notices: string[] = [];
  /** Test being recorded from the agent's actions on this session (test_record). */
  recording: Recording | null = null;
  /** Set while a test run drives the device (other actions are refused). */
  busyWith: string | null = null;
  agentImageSeq = 0;
  /** Set when a stop was requested; the runner's goodbye then ends the session as closed. */
  stopReason: string | null = null;

  constructor(
    public record: SessionRecord,
    private readonly store: Store,
    private readonly config: HubConfig,
    private readonly log: (m: string) => void,
  ) {
    if (record.device) this.refreshTransform();
  }

  get id() {
    return this.record.id;
  }

  get active(): boolean {
    return !TERMINAL_STATES.has(this.record.state);
  }

  get runnerConnected(): boolean {
    return this.runner?.readyState === WebSocket.OPEN;
  }

  get ready(): boolean {
    return this.record.state === "ready" && this.runnerConnected;
  }

  // ---- State and events ------------------------------------------------------------------

  async setState(state: SessionState, message: string): Promise<void> {
    if (this.record.state === state && this.record.stateMessage === message) return;
    if (TERMINAL_STATES.has(this.record.state) && !TERMINAL_STATES.has(state)) return;
    this.record.state = state;
    this.record.stateMessage = message;
    if (state === "ready" && !this.record.readyAt) this.record.readyAt = new Date().toISOString();
    if (TERMINAL_STATES.has(state)) {
      this.record.closedAt = new Date().toISOString();
      this.record.closeReason = message;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new SessionError("session_closed", `the session ended: ${message}`));
      }
      this.pending.clear();
    }
    await this.save();
    await this.event({ kind: "state", state, message });
    for (const w of this.stateWaiters) w();
  }

  async save() {
    await this.store.save(this.record);
  }

  async event(e: SessionEvent): Promise<void> {
    const stored = { ...e, ts: new Date().toISOString(), seq: ++this.eventSeq } as StoredEvent;
    try {
      await this.store.appendEvent(this.id, stored);
    } catch (error) {
      this.log(`event write failed: ${(error as Error).message}`);
    }
    for (const l of this.eventListeners) l(stored);
  }

  note(message: string) {
    this.progress.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
    if (this.progress.length > 30) this.progress.splice(0, this.progress.length - 30);
  }

  /** Resolves when `done()` is true or the timeout passes; returns `done()` at the end. */
  async waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
    if (done()) return true;
    return new Promise((resolve) => {
      const check = () => {
        if (done()) finish();
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        this.stateWaiters.delete(check);
        resolve(done());
      };
      this.stateWaiters.add(check);
    });
  }

  // ---- Runner link -----------------------------------------------------------------------

  attachRunner(ws: WebSocket, welcome: () => Promise<HubMessage>) {
    if (this.runner && this.runner !== ws) {
      this.log(`session ${this.id.slice(0, 8)}: a new runner connection replaces the old one`);
      this.runner.terminate();
    }
    this.runner = ws;
    this.lastRunnerMessage = Date.now();
    this.disconnectedAt = null;
    this.sentStream = null;
    ws.on("message", (data, isBinary) => {
      this.lastRunnerMessage = Date.now();
      if (isBinary) {
        this.onBinary(data as Buffer);
        return;
      }
      let msg: RunnerMessage;
      try {
        msg = JSON.parse(data.toString()) as RunnerMessage;
      } catch {
        return;
      }
      if (msg.t === "hello") {
        this.runnerHello = msg;
        void welcome().then((w) => this.send(w));
        return;
      }
      void this.onMessage(msg);
    });
    ws.on("close", () => {
      if (this.runner !== ws) return;
      this.runner = null;
      void this.onRunnerGone();
    });
    ws.on("error", () => undefined);
  }

  private async onRunnerGone() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new SessionError(
          "runner_disconnected",
          "the runner disconnected; it reconnects on its own if it can",
        ),
      );
    }
    this.pending.clear();
    if (!this.active) return;
    if (this.stopReason) {
      await this.setState("closed", this.stopReason);
      return;
    }
    this.disconnectedAt = Date.now();
    if (this.record.state === "ready" || this.record.state === "preparing") {
      await this.setState("disconnected", "runner connection lost; waiting for it to reconnect");
    }
  }

  /** Called by the manager's monitor: drops a runner that went silent. */
  checkRunnerHealth() {
    const ws = this.runner;
    if (!ws) return;
    if (Date.now() - this.lastRunnerMessage > 45_000) {
      this.log(`session ${this.id.slice(0, 8)}: runner silent for 45 s; dropping the connection`);
      ws.terminate();
      return;
    }
    this.send({ t: "ping", at: Date.now() });
  }

  send(msg: HubMessage): boolean {
    if (this.runner?.readyState !== WebSocket.OPEN) return false;
    this.runner.send(JSON.stringify(msg));
    return true;
  }

  closeRunner() {
    this.runner?.close(1000, "session ended");
  }

  private async onMessage(msg: RunnerMessage) {
    switch (msg.t) {
      case "status":
        this.note(`${msg.state}: ${msg.message}`);
        if (msg.state === "error") {
          await this.setState("failed", `runner: ${msg.message}`);
        } else if (msg.state === "stopping") {
          // The runner is cleaning up; its goodbye follows.
        } else if (this.record.state !== "ready") {
          await this.setState("preparing", msg.message);
        }
        return;
      case "ready": {
        this.record.device = msg.device;
        this.refreshTransform();
        const g = msg.device.github;
        if (g) {
          this.record.github = {
            ...this.record.github,
            runId: g.runId,
            ...(g.jobUrl ? { runUrl: g.jobUrl } : {}),
          };
        }
        this.note("device ready");
        await this.setState(
          "ready",
          `${msg.device.deviceName} · ${msg.device.platform} ${msg.device.osVersion}`,
        );
        this.updateStream();
        return;
      }
      case "res":
        this.settle(msg, undefined);
        return;
      case "event":
        this.note(msg.message);
        if (/session replaced|session restored/i.test(msg.message)) {
          this.actionSeq += 1;
          this.notices.push(`Device: ${msg.message}`);
        }
        await this.event({ kind: "runner", level: msg.level, message: msg.message });
        return;
      case "late": {
        // The screen may have changed after the agent was told the command timed out.
        this.actionSeq += 1;
        const text = `An earlier ${msg.name} that timed out ${msg.outcome === "completed" ? "completed" : msg.outcome === "failed" ? `failed (${msg.error ?? "error"})` : "was abandoned with its device session"} ${Math.round(msg.lateByMs / 1000)} s after its timeout; the screen may have changed since — look again before acting.`;
        this.notices.push(text);
        this.note(text);
        await this.event({ kind: "runner", level: "warn", message: text });
        return;
      }
      case "bye":
        this.note(`runner: ${msg.reason}`);
        this.stopReason ??= `runner stopped: ${msg.reason}`;
        return;
      case "ping":
        this.send({ t: "pong", at: msg.at });
        return;
      default:
        return;
    }
  }

  private onBinary(buf: Buffer) {
    let decoded: { header: RunnerMessage; payload: Buffer };
    try {
      decoded = decodeBinary<RunnerMessage>(buf);
    } catch {
      return;
    }
    const { header, payload } = decoded;
    if (header.t === "frame") {
      const frame: LiveFrame = {
        seq: header.seq,
        capturedAt: header.capturedAt,
        receivedAt: Date.now(),
        width: header.width,
        height: header.height,
        data: Buffer.from(payload),
      };
      this.ring.push(frame);
      const cutoff = Date.now() - this.config.ringSeconds * 1000;
      while (this.ring.length > 0 && (this.ring[0]?.receivedAt ?? 0) < cutoff) this.ring.shift();
      for (const l of this.frameListeners) l(frame);
    } else if (header.t === "res") {
      this.settle(header, Buffer.from(payload));
    }
  }

  private settle(msg: Extract<RunnerMessage, { t: "res" }>, payload: Buffer | undefined) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve({ data: msg.data, ...(payload ? { payload } : {}) });
    else p.reject(new SessionError(msg.error.code, msg.error.message));
  }

  /** Sends one command to the runner and waits for its answer. */
  command<N extends CommandName>(
    name: N,
    args: object,
    requestedTimeoutMs = 30_000,
  ): Promise<CommandOutcome<N>> {
    const timeoutMs = Math.max(1_000, Math.round(requestedTimeoutMs * this.config.timeoutFactor));
    if (!this.active) {
      return Promise.reject(new SessionError("session_closed", `session is ${this.record.state}`));
    }
    if (!this.runnerConnected) {
      return Promise.reject(
        new SessionError(
          "runner_not_connected",
          this.record.state === "disconnected"
            ? "the runner is disconnected (network drop); retry in a few seconds"
            : `the device is not ready yet (state: ${this.record.state})`,
        ),
      );
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new SessionError(
            "timeout",
            `${name} got no answer within ${Math.round(timeoutMs / 1000)} s`,
          ),
        );
      }, timeoutMs + 5_000);
      this.pending.set(id, {
        name,
        resolve: resolve as Pending["resolve"],
        reject,
        timer,
      });
      this.send({ t: "cmd", id, name, args, timeoutMs });
    });
  }

  // ---- Geometry and streaming ------------------------------------------------------------

  refreshTransform(width?: number, height?: number) {
    const d = this.record.device;
    if (!d) return;
    const w = width ?? d.screenshotWidth;
    const h = height ?? d.screenshotHeight;
    if (!w || !h) return;
    if (
      this.transform &&
      this.transform.screenshotWidth === w &&
      this.transform.screenshotHeight === h
    )
      return;
    this.transform = makeViewTransform(w, h, d.pixelsPerUnit, this.config.viewLongEdge);
    d.screenshotWidth = w;
    d.screenshotHeight = h;
    d.orientation = w > h ? "landscape" : "portrait";
  }

  desiredStream(): StreamSettings {
    const s = this.config.stream;
    const watching = this.viewers > 0 || Date.now() < this.boostUntil;
    return {
      fps: watching ? s.viewerFps : s.backgroundFps,
      maxEdge: s.maxEdge,
      quality: s.quality,
    };
  }

  updateStream() {
    if (!this.ready) return;
    const want = this.desiredStream();
    const sent = this.sentStream;
    if (
      sent &&
      sent.fps === want.fps &&
      sent.maxEdge === want.maxEdge &&
      sent.quality === want.quality
    ) {
      return;
    }
    if (this.send({ t: "stream", settings: want })) this.sentStream = want;
  }
}
