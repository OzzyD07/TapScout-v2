// Session lifecycle: create (copy and hash the build), start a runner (GitHub workflow or local
// process), authenticate runner connections, watch for idle / lost / finished sessions and clean
// up (graceful shutdown, then cancelling the GitHub run if the runner does not leave by itself).

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HubMessage, Platform } from "@tapscout/shared";
import type WebSocket from "ws";
import {
  AuthRejected,
  type HubAuth,
  matchesHash,
  newLocalToken,
  tokenKind,
  verifyGithubOidc,
} from "./auth.js";
import type { HubConfig } from "./config.js";
import { GitHubClient } from "./github.js";
import { HubSession, SessionError } from "./session.js";
import type { SessionRecord, Store } from "./store.js";
import type { Tunnel } from "./tunnel.js";

export interface StartOptions {
  platform: Platform;
  buildPath: string;
  target: "github" | "local";
  label?: string;
  appId?: string;
  maxMinutes?: number;
  avd?: string;
  serial?: string;
  udid?: string;
  /** Tests only: register the session and its local token without spawning a runner. */
  launch?: boolean;
}

const ORPHAN_GRACE_MS = 3 * 60_000;

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class SessionManager {
  readonly sessions = new Map<string, HubSession>();
  private readonly localProcs = new Map<string, ChildProcess>();
  private readonly localTokens = new Map<string, string>();
  private github: GitHubClient | null = null;
  private monitor: NodeJS.Timeout | null = null;
  private githubPollAt = new Map<string, number>();

  constructor(
    readonly config: HubConfig,
    readonly store: Store,
    private readonly auth: HubAuth,
    private readonly tunnel: Tunnel,
    readonly log: (m: string) => void,
  ) {
    if (config.github.repo) this.github = new GitHubClient(config.github.repo);
  }

  async init() {
    await this.store.init();
    for (const record of await this.store.list()) {
      const s = new HubSession(record, this.store, this.config, this.log);
      this.sessions.set(record.id, s);
      if (s.active) {
        // The hub restarted under a live session: a runner may come back (its session token
        // survives hub restarts); otherwise the orphan check below ends it.
        s.disconnectedAt = Date.now();
        if (record.state !== "disconnected") {
          await s.setState("disconnected", "hub restarted; waiting for the runner to reconnect");
        }
      }
    }
    this.monitor = setInterval(() => void this.tick(), 10_000);
  }

  // ---- Lookup ----------------------------------------------------------------------------

  list(): HubSession[] {
    return [...this.sessions.values()].sort((a, b) =>
      b.record.createdAt.localeCompare(a.record.createdAt),
    );
  }

  /** The session by id, or the most recent active one when no id is given. */
  get(id?: string): HubSession {
    if (id) {
      const s = this.sessions.get(id) ?? this.list().find((x) => x.id.startsWith(id));
      if (!s) throw new SessionError("not_found", `no session ${id}`);
      return s;
    }
    const active = this.list().filter((s) => s.active);
    if (active.length === 0)
      throw new SessionError("not_found", "no active session; start one with session_start");
    return active[0] as HubSession;
  }

  // ---- Create and start -----------------------------------------------------------------

  async create(o: StartOptions): Promise<HubSession> {
    const info = await stat(o.buildPath).catch(() => null);
    if (!info?.isFile()) throw new SessionError("bad_build", `build not found: ${o.buildPath}`);
    const name = basename(o.buildPath);
    if (o.platform === "android" && !/\.apk$/i.test(name)) {
      throw new SessionError(
        "bad_build",
        "Android sessions need an .apk (not .aab or split APKs).",
      );
    }
    if (o.platform === "ios" && !/\.zip$/i.test(name)) {
      throw new SessionError(
        "bad_build",
        "iOS sessions need a .zip of an iOS Simulator .app (xcodebuild -sdk iphonesimulator, then `ditto -c -k --keepParent App.app App.zip`).",
      );
    }
    if (o.target === "local" && o.platform === "ios" && process.platform !== "darwin") {
      throw new SessionError("unsupported", 'Local iOS sessions need macOS; use target "github".');
    }
    if (o.target === "github") {
      if (!this.github) {
        throw new SessionError(
          "no_github",
          "GitHub sessions need TAPSCOUT_GITHUB_REPO (owner/repo) or an origin remote on github.com.",
        );
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const dir = this.store.sessionDir(id);
    await mkdir(join(dir, "build"), { recursive: true });
    const stored = join(dir, "build", name.replace(/[^\w.-]/g, "_"));
    await copyFile(o.buildPath, stored);
    const record: SessionRecord = {
      id,
      createdAt: now,
      updatedAt: now,
      platform: o.platform,
      target: o.target,
      ...(o.label ? { label: o.label } : {}),
      build: {
        fileName: name,
        path: stored,
        sizeBytes: info.size,
        sha256: await sha256File(stored),
      },
      ...(o.appId ? { appId: o.appId } : {}),
      state: "queued",
      stateMessage: "created",
      options: {
        maxMinutes: Math.max(5, Math.min(o.maxMinutes ?? this.config.defaultMaxMinutes, 330)),
        idleMinutes: this.config.idleMinutes,
      },
      ...(o.target === "local"
        ? {
            local: {
              ...(o.avd ? { avd: o.avd } : {}),
              ...(o.serial ? { serial: o.serial } : {}),
              ...(o.udid ? { udid: o.udid } : {}),
            },
          }
        : {}),
    };
    const session = new HubSession(record, this.store, this.config, this.log);
    this.sessions.set(id, session);
    await session.save();
    await session.event({
      kind: "state",
      state: "queued",
      message: `build ${name}, ${info.size} bytes`,
    });
    const start =
      o.target === "github"
        ? this.startGithub(session)
        : this.startLocal(session, o.launch ?? true);
    start.catch(async (error) => {
      this.log(`session ${id.slice(0, 8)} failed to start: ${(error as Error).message}`);
      await session.setState("failed", (error as Error).message);
    });
    return session;
  }

  private async startGithub(s: HubSession) {
    const gh = this.github as GitHubClient;
    await s.setState("dispatching", "starting the public tunnel");
    const hubUrl = await this.tunnel.ensure();
    // Stopped while the tunnel came up: nothing was started on GitHub yet.
    if (!s.active) return;
    await s.setState("dispatching", `dispatching ${this.config.github.workflow} on ${gh.repo}`);
    const since = new Date();
    const dispatched = await gh.dispatch(this.config.github.workflow, this.config.github.ref, {
      session_id: s.id,
      platform: s.record.platform,
      hub_url: hubUrl,
      max_minutes: String(s.record.options.maxMinutes),
    });
    s.record.github = {
      ...(dispatched.runId ? { runId: dispatched.runId } : {}),
      ...(dispatched.htmlUrl ? { runUrl: dispatched.htmlUrl } : {}),
    };
    if (!dispatched.runId) {
      for (let i = 0; i < 12 && !s.record.github.runId; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        const run = await gh.findRun(this.config.github.workflow, s.id, since).catch(() => null);
        if (run) s.record.github = { runId: run.id, runUrl: run.htmlUrl, status: run.status };
      }
    }
    await s.save();
    if (s.record.state === "dispatching") {
      await s.setState(
        "waiting_for_runner",
        `GitHub run ${s.record.github.runId ?? "(looking up)"} queued; a runner boots the device (≈3–8 min)`,
      );
    }
  }

  /** The one-time token a local runner of this session authenticates with (tests, tooling). */
  localToken(id: string): string | undefined {
    return this.localTokens.get(id);
  }

  private async startLocal(s: HubSession, launch = true) {
    const { token, hash } = newLocalToken();
    s.record.localTokenHash = hash;
    this.localTokens.set(s.id, token);
    if (!launch) {
      await s.setState("waiting_for_runner", "waiting for an external runner");
      return;
    }
    const runnerMain = join(this.config.rootDir, "packages", "runner", "dist", "main.js");
    if (!existsSync(runnerMain)) throw new Error("the runner is not built; run `pnpm build`");
    const outDir = join(this.store.sessionDir(s.id), "runner");
    await mkdir(outDir, { recursive: true });
    const args = [
      runnerMain,
      "--platform",
      s.record.platform,
      "--hub",
      `http://127.0.0.1:${this.config.gatewayPort}`,
      "--session",
      s.id,
      "--auth",
      "token",
      "--start-appium",
      "--out",
      outDir,
      "--max-minutes",
      String(s.record.options.maxMinutes),
    ];
    const l = s.record.local ?? {};
    if (l.avd) args.push("--avd", l.avd);
    if (l.serial) args.push("--serial", l.serial);
    if (l.udid) args.push("--udid", l.udid);
    const logFile = join(this.store.sessionDir(s.id), "runner.log");
    const out = createWriteStream(logFile, { flags: "a" });
    const proc = spawn(process.execPath, args, {
      cwd: this.config.rootDir,
      env: { ...process.env, TAPSCOUT_RUNNER_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    proc.stdout?.pipe(out);
    proc.stderr?.pipe(out);
    this.localProcs.set(s.id, proc);
    s.record.local = { ...l, ...(proc.pid ? { pid: proc.pid } : {}) };
    await s.save();
    await s.setState("waiting_for_runner", "local runner starting (Appium, device, install)");
    proc.on("exit", (code) => {
      this.localProcs.delete(s.id);
      if (!s.active) return;
      void (async () => {
        const tail = await this.tail(logFile, 1_500);
        await s.setState(
          s.stopReason && code === 0 ? "closed" : "failed",
          s.stopReason ?? `local runner exited with code ${code}: ${tail}`,
        );
      })();
    });
  }

  private async tail(file: string, bytes: number): Promise<string> {
    try {
      const info = await stat(file);
      const h = await open(file, "r");
      const buf = Buffer.alloc(Math.min(bytes, info.size));
      await h.read(buf, 0, buf.length, Math.max(0, info.size - buf.length));
      await h.close();
      return buf.toString("utf8").trim().split("\n").slice(-6).join(" | ");
    } catch {
      return "";
    }
  }

  // ---- Runner authentication -------------------------------------------------------------

  /** Verifies a runner's bearer token for this session; throws AuthRejected / SessionError. */
  async authenticateRunner(sessionId: string, token: string): Promise<{ run?: number }> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new SessionError("not_found", "unknown session");
    if (!s.active) throw new SessionError("gone", `session is ${s.record.state}`);
    const kind = tokenKind(token);
    if (kind === "hub_session") {
      const claims = await this.auth.verify(token);
      if (claims.sid !== sessionId) throw new AuthRejected("token is for another session");
      return claims.run ? { run: claims.run } : {};
    }
    if (kind === "github_oidc") {
      if (s.record.target !== "github") throw new AuthRejected("not a GitHub session");
      const repo = this.config.github.repo;
      if (!repo) throw new AuthRejected("no GitHub repository configured");
      const wf = await verifyGithubOidc(token, {
        audience: this.config.github.audience,
        repository: repo,
        workflowFile: this.config.github.workflow,
        ref: `refs/heads/${this.config.github.ref}`,
      });
      const bound = s.record.github?.runId;
      if (bound && bound !== wf.runId)
        throw new AuthRejected("a different workflow run owns this session");
      s.record.github = { ...s.record.github, runId: wf.runId };
      await s.save();
      return { run: wf.runId };
    }
    if (s.record.target !== "local" || !matchesHash(token, s.record.localTokenHash)) {
      throw new AuthRejected("invalid runner token");
    }
    return {};
  }

  /** Binds an authenticated socket to its session and answers the runner's hello. */
  attach(sessionId: string, ws: WebSocket, claims: { run?: number }) {
    const s = this.get(sessionId);
    s.attachRunner(ws, async (): Promise<HubMessage> => {
      s.note("runner connected");
      if (s.record.state === "disconnected" && s.record.device) {
        await s.setState("ready", "runner reconnected");
      } else if (s.record.state === "waiting_for_runner" || s.record.state === "dispatching") {
        await s.setState("preparing", "runner connected; downloading the build");
      }
      return {
        t: "welcome",
        sessionId: s.id,
        sessionToken: await this.auth.issue({
          sid: s.id,
          ...(claims.run ? { run: claims.run } : {}),
        }),
        build: {
          fileName: s.record.build.fileName,
          sizeBytes: s.record.build.sizeBytes,
          sha256: s.record.build.sha256,
        },
        ...(s.record.appId ? { appId: s.record.appId } : {}),
        config: {
          pingIntervalSeconds: 15,
          reconnectGraceSeconds: this.config.reconnectGraceSeconds,
          stream: s.desiredStream(),
          keepAppData: false,
        },
      };
    });
  }

  // ---- Stop and monitor ------------------------------------------------------------------

  /** Graceful stop: the runner uploads its logs and leaves; the GitHub run is cancelled if not. */
  async stop(id: string, reason: string, waitMs = 40_000): Promise<HubSession> {
    const s = this.get(id);
    if (!s.active) return s;
    s.stopReason = reason;
    await s.setState("stopping", reason);
    const told = s.send({ t: "shutdown", reason });
    if (told) {
      await s.waitFor(() => !s.runnerConnected || !s.active, waitMs);
    }
    if (s.active) {
      s.closeRunner();
      const proc = this.localProcs.get(s.id);
      if (proc && proc.exitCode === null) proc.kill();
      await s.setState("closed", reason);
    }
    const runId = s.record.github?.runId;
    if (runId && this.github) {
      // Give the job a moment to finish on its own before cancelling it.
      setTimeout(() => void this.cancelIfRunning(s, runId), told ? 60_000 : 0);
    }
    return s;
  }

  private async cancelIfRunning(s: HubSession, runId: number) {
    try {
      const run = await (this.github as GitHubClient).run(runId);
      s.record.github = {
        ...s.record.github,
        status: run.status,
        conclusion: run.conclusion ?? undefined,
      };
      if (run.status !== "completed") {
        this.log(`cancelling GitHub run ${runId}`);
        await (this.github as GitHubClient).cancel(runId);
        await s.event({ kind: "runner", level: "info", message: `GitHub run ${runId} cancelled` });
      }
      await s.save();
    } catch (error) {
      this.log(`could not cancel run ${runId}: ${(error as Error).message}`);
    }
  }

  private async tick() {
    for (const s of this.sessions.values()) {
      if (!s.active) continue;
      try {
        s.checkRunnerHealth();
        s.updateStream();
        const now = Date.now();
        const idleMs = s.record.options.idleMinutes * 60_000;
        if (s.ready && now - s.lastActivity > idleMs) {
          await this.stop(s.id, `idle for ${s.record.options.idleMinutes} minutes`);
          continue;
        }
        if (s.record.state === "disconnected" && s.disconnectedAt) {
          const grace = Math.min(this.config.reconnectGraceSeconds * 1000, ORPHAN_GRACE_MS * 3);
          if (now - s.disconnectedAt > grace) {
            await s.setState(
              "failed",
              "the runner did not come back after the connection was lost",
            );
            const runId = s.record.github?.runId;
            if (runId) void this.cancelIfRunning(s, runId);
            continue;
          }
        }
        const created = Date.parse(s.record.createdAt);
        if (now - created > (s.record.options.maxMinutes + 40) * 60_000) {
          await this.stop(s.id, "session exceeded its maximum length");
          continue;
        }
        if (s.record.target === "github") await this.pollGithub(s, now);
      } catch (error) {
        this.log(`monitor ${s.id.slice(0, 8)}: ${(error as Error).message}`);
      }
    }
  }

  /** Progress before the runner connects; failure when the run ends without a runner. */
  private async pollGithub(s: HubSession, now: number) {
    const runId = s.record.github?.runId;
    if (!runId || !this.github) return;
    const early = s.record.state === "waiting_for_runner" || s.record.state === "dispatching";
    const every = early ? 10_000 : 60_000;
    if (now - (this.githubPollAt.get(s.id) ?? 0) < every) return;
    this.githubPollAt.set(s.id, now);
    const run = await this.github.run(runId);
    s.record.github = {
      ...s.record.github,
      runId,
      runUrl: run.htmlUrl,
      status: run.status,
      conclusion: run.conclusion ?? undefined,
    };
    if (early && run.status !== "completed") {
      const step = await this.github.currentStep(runId).catch(() => undefined);
      if (step && step !== s.record.github.step) {
        s.record.github.step = step;
        s.note(`GitHub: ${step}`);
        await s.setState("waiting_for_runner", `GitHub ${run.status}: ${step}`);
      }
    }
    if (run.status === "completed" && !s.runnerConnected) {
      await s.setState(
        s.stopReason ? "closed" : "failed",
        s.stopReason ??
          `GitHub run ended (${run.conclusion}) without a connected runner; see ${run.htmlUrl}`,
      );
    }
    await s.save();
  }

  async shutdown() {
    if (this.monitor) clearInterval(this.monitor);
    await Promise.all(
      this.list()
        .filter((s) => s.active)
        .map((s) => this.stop(s.id, "hub shutting down", 20_000).catch(() => undefined)),
    );
    for (const p of this.localProcs.values()) p.kill();
  }
}
