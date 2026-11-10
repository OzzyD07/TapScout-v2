// Public URL of the runner gateway. Either a fixed TAPSCOUT_PUBLIC_URL (your own tunnel, port
// forward or reverse proxy) or a Cloudflare quick tunnel: `cloudflared tunnel --url`, free and
// without an account, with a random *.trycloudflare.com address that changes on every start.
// Only the gateway port is exposed; the UI, local API and MCP stay on 127.0.0.1.

import { type ChildProcess, spawn } from "node:child_process";
import type { HubConfig } from "./config.js";

const QUICK_URL = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/;

export class Tunnel {
  private proc: ChildProcess | null = null;
  private pending: Promise<string> | null = null;
  url: string | null = null;

  constructor(
    private readonly config: HubConfig,
    private readonly log: (m: string) => void,
  ) {}

  /** The public gateway URL, starting the quick tunnel on first use. */
  ensure(): Promise<string> {
    if (this.config.publicUrl) return Promise.resolve(this.config.publicUrl);
    if (this.url && this.proc) return Promise.resolve(this.url);
    if (this.config.tunnel === "none") {
      return Promise.reject(
        new Error(
          "GitHub sessions need a public gateway URL: set TAPSCOUT_PUBLIC_URL or allow the quick tunnel.",
        ),
      );
    }
    this.pending ??= this.start().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async start(): Promise<string> {
    const target = `http://127.0.0.1:${this.config.gatewayPort}`;
    this.log(`starting cloudflared quick tunnel → ${target}`);
    const proc = spawn(this.config.cloudflaredBin, ["tunnel", "--no-autoupdate", "--url", target], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("cloudflared did not report a URL in 60 s")),
        60_000,
      );
      const onData = (chunk: Buffer) => {
        const m = QUICK_URL.exec(chunk.toString("utf8"));
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      proc.once("error", (error) => {
        clearTimeout(timer);
        reject(
          new Error(
            `cloudflared could not start (${error.message}); run \`pnpm setup:local\` or set TAPSCOUT_PUBLIC_URL`,
          ),
        );
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited with ${code}`));
      });
    });
    proc.once("exit", () => {
      if (this.proc === proc) {
        this.log("cloudflared stopped; the next GitHub session starts a new tunnel");
        this.proc = null;
        this.url = null;
      }
    });
    // A new hostname needs a few seconds to route. The check is short and best effort: this
    // machine's resolver may cache the not-yet-existing name for a minute, while the runner only
    // connects minutes later (after booting the device) and retries on its own anyway.
    await new Promise((r) => setTimeout(r, 3_000));
    let reachable = false;
    const deadline = Date.now() + 20_000;
    while (!reachable && Date.now() < deadline) {
      try {
        reachable = (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5_000) })).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    this.url = url;
    this.log(`tunnel ${reachable ? "ready" : "started (not reachable from here yet)"}: ${url}`);
    return url;
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
    this.url = null;
  }
}
