import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_VIEW_LONG_EDGE } from "@tapscout/shared";

export const HUB_VERSION = "2.0.0";

export interface HubConfig {
  rootDir: string;
  dataDir: string;
  host: string;
  /** Web UI, local API and MCP (never exposed). */
  uiPort: number;
  /** Runner gateway: the only port a tunnel exposes. */
  gatewayPort: number;
  /** Fixed public URL of the gateway (own tunnel / port forward); disables the quick tunnel. */
  publicUrl?: string;
  tunnel: "cloudflared" | "none";
  cloudflaredBin: string;
  github: {
    repo?: string;
    workflow: string;
    ref: string;
    audience: string;
  };
  idleMinutes: number;
  defaultMaxMinutes: number;
  viewLongEdge: number;
  stream: { backgroundFps: number; viewerFps: number; maxEdge: number; quality: number };
  ringSeconds: number;
  reconnectGraceSeconds: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : d;
};

/** owner/repo of the origin remote, for dispatching the workflow of this checkout. */
function originRepo(rootDir: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", rootDir, "remote", "get-url", "origin"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
      .toString("utf8")
      .trim();
    return /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url)?.[1];
  } catch {
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const rootDir = resolve(import.meta.dirname, "..", "..", "..");
  const toolsBin = join(
    rootDir,
    ".tools",
    process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
  return {
    rootDir,
    dataDir: resolve(env.TAPSCOUT_DATA_DIR ?? join(rootDir, ".data")),
    host: "127.0.0.1",
    uiPort: num(env.TAPSCOUT_PORT, 4780),
    gatewayPort: num(env.TAPSCOUT_GATEWAY_PORT, 4781),
    publicUrl: env.TAPSCOUT_PUBLIC_URL?.replace(/\/$/, "") || undefined,
    tunnel: env.TAPSCOUT_TUNNEL === "none" ? "none" : "cloudflared",
    cloudflaredBin: env.TAPSCOUT_CLOUDFLARED ?? (existsSync(toolsBin) ? toolsBin : "cloudflared"),
    github: {
      repo: env.TAPSCOUT_GITHUB_REPO ?? originRepo(rootDir),
      workflow: env.TAPSCOUT_GITHUB_WORKFLOW ?? "device-session.yml",
      ref: env.TAPSCOUT_GITHUB_REF ?? "main",
      audience: env.TAPSCOUT_OIDC_AUDIENCE ?? "tapscout-v2",
    },
    idleMinutes: num(env.TAPSCOUT_IDLE_MINUTES, 20),
    defaultMaxMinutes: num(env.TAPSCOUT_MAX_MINUTES, 60),
    viewLongEdge: num(env.TAPSCOUT_VIEW_LONG_EDGE, DEFAULT_VIEW_LONG_EDGE),
    stream: {
      backgroundFps: num(env.TAPSCOUT_BACKGROUND_FPS, 2),
      viewerFps: num(env.TAPSCOUT_VIEWER_FPS, 6),
      maxEdge: num(env.TAPSCOUT_STREAM_MAX_EDGE, 720),
      quality: num(env.TAPSCOUT_STREAM_QUALITY, 60),
    },
    ringSeconds: num(env.TAPSCOUT_RING_SECONDS, 30),
    reconnectGraceSeconds: num(env.TAPSCOUT_RECONNECT_GRACE_SECONDS, 600),
  };
}
