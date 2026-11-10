#!/usr/bin/env node
// TapScout hub: local web UI + MCP (127.0.0.1:4780), runner gateway (127.0.0.1:4781, exposed
// through a tunnel only for GitHub sessions), file-based session store in .data/.
//   node packages/hub/dist/main.js          start the hub
//   node packages/hub/dist/main.js --stop   stop a running hub (its sessions are stopped first)

import { mkdir } from "node:fs/promises";
import { HubAuth } from "./auth.js";
import { HUB_VERSION, loadConfig } from "./config.js";
import { createGateway } from "./gateway.js";
import { SessionManager } from "./manager.js";
import { Store } from "./store.js";
import { Tunnel } from "./tunnel.js";
import { createWebServer } from "./web.js";

const config = loadConfig();
const base = `http://127.0.0.1:${config.uiPort}`;

if (process.argv.includes("--stop")) {
  try {
    await fetch(`${base}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(5_000) });
    console.log("hub is stopping");
  } catch {
    console.log("no hub is running");
  }
  process.exit(0);
}

const log = (m: string) => console.log(`[hub ${new Date().toISOString().slice(11, 19)}] ${m}`);

async function running(): Promise<boolean> {
  try {
    return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_500) })).ok;
  } catch {
    return false;
  }
}

if (await running()) {
  log(`a hub is already running at ${base}`);
  process.exit(0);
}

await mkdir(config.dataDir, { recursive: true });
const auth = await HubAuth.load(config.dataDir);
const store = new Store(config.dataDir);
const tunnel = new Tunnel(config, log);
const manager = new SessionManager(config, store, auth, tunnel, log);
await manager.init();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("shutting down: stopping active sessions");
  await manager.shutdown().catch(() => undefined);
  tunnel.stop();
  await web.closeMcp().catch(() => undefined);
  web.server.close();
  gateway.close();
  setTimeout(() => process.exit(0), 300);
}

const gateway = createGateway(manager, auth);
const web = createWebServer(manager, tunnel, () => void shutdown());

const listen = (server: import("node:http").Server, port: number, what: string) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`${what} port ${port} is in use (set TAPSCOUT_PORT / TAPSCOUT_GATEWAY_PORT)`)
          : error,
      );
    });
    server.listen(port, config.host, () => resolve());
  });

try {
  await listen(gateway, config.gatewayPort, "gateway");
  await listen(web.server, config.uiPort, "web");
} catch (error) {
  log((error as Error).message);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown());

log(`TapScout hub ${HUB_VERSION}`);
log(`web UI:  ${base}`);
log(`MCP:     ${base}/mcp  (stdio: node packages/hub/dist/mcp-stdio.js)`);
log(
  `gateway: http://127.0.0.1:${config.gatewayPort}${config.publicUrl ? ` (public ${config.publicUrl})` : " (quick tunnel starts with the first GitHub session)"}`,
);
log(
  `GitHub:  ${config.github.repo ?? "not configured (local sessions only)"} · ${config.github.workflow}@${config.github.ref}`,
);
log(`data:    ${config.dataDir}`);
