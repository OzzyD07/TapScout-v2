#!/usr/bin/env node
// stdio ⇄ Streamable HTTP bridge for MCP clients that launch servers as processes (Claude
// Desktop, Claude Code stdio config). Device sessions live in the long-running hub, so they
// survive client restarts: the bridge starts the hub in the background when none is running and
// forwards every JSON-RPC message unchanged. If the hub restarts, the bridge initialises a new
// MCP session with the same parameters and retries the message.

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const base = `http://127.0.0.1:${config.uiPort}`;
const err = (m: string) => process.stderr.write(`[tapscout-mcp] ${m}\n`);

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_500) })).ok;
  } catch {
    return false;
  }
}

async function ensureHub() {
  if (await healthy()) return;
  mkdirSync(config.dataDir, { recursive: true });
  const logFd = openSync(join(config.dataDir, "hub.log"), "a");
  const envFile = join(config.rootDir, ".env");
  spawn(
    process.execPath,
    [`--env-file-if-exists=${envFile}`, join(import.meta.dirname, "main.js")],
    {
      cwd: config.rootDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    },
  ).unref();
  for (let i = 0; i < 40; i++) {
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the hub did not start; see ${join(config.dataDir, "hub.log")}`);
}

await ensureHub();

const stdio = new StdioServerTransport();
let initialize: JSONRPCMessage | null = null;
let http: StreamableHTTPClientTransport;
/** Ids of our own replayed initialize requests, whose answers the client must not see. */
const swallow = new Set<string | number>();

function connect(): StreamableHTTPClientTransport {
  const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  t.onmessage = (m) => {
    if ("id" in m && m.id !== undefined && swallow.has(m.id) && !("method" in m)) {
      swallow.delete(m.id);
      return;
    }
    void stdio.send(m);
  };
  t.onerror = (e) => err(`hub connection: ${e.message}`);
  return t;
}

async function reconnect() {
  await http.close().catch(() => undefined);
  await ensureHub();
  http = connect();
  await http.start();
  if (initialize && "method" in initialize) {
    const id = `bridge-reinit-${Date.now()}`;
    swallow.add(id);
    await http.send({ ...initialize, id } as JSONRPCMessage);
    await http.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
}

http = connect();
await http.start();

stdio.onmessage = async (m) => {
  if ("method" in m && m.method === "initialize") initialize = m;
  try {
    await http.send(m);
  } catch (error) {
    const message = (error as Error).message ?? "";
    if (
      /404|Session not found|ECONNREFUSED|fetch failed/i.test(message) &&
      initialize &&
      m !== initialize
    ) {
      err("hub session lost; reconnecting");
      try {
        await reconnect();
        await http.send(m);
        return;
      } catch (again) {
        err(`reconnect failed: ${(again as Error).message}`);
      }
    }
    if ("id" in m && "method" in m) {
      await stdio.send({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32603, message: `TapScout hub unavailable: ${message}` },
      });
    }
  }
};
stdio.onclose = () => {
  void http.close().finally(() => process.exit(0));
};
await stdio.start();
