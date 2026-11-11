// Local web server on 127.0.0.1 only: the web UI, its JSON API, the live MJPEG stream, the
// activity feed (SSE), session files and the MCP endpoint (/mcp, Streamable HTTP). Requests
// whose Host or Origin is not this machine are refused (DNS-rebinding protection).

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import http from "node:http";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type KeyName, viewToDevice } from "@tapscout/shared";
import { HUB_VERSION } from "./config.js";
import type { SessionManager } from "./manager.js";
import { createMcpServer } from "./mcp.js";
import { DeviceOps } from "./ops.js";
import { buildReport } from "./report.js";
import { type HubSession, type LiveFrame, SessionError } from "./session.js";
import { testStore } from "./tools-tests.js";
import type { Tunnel } from "./tunnel.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".xml": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ips": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new SessionError("too_large", "request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function summary(s: HubSession) {
  const r = s.record;
  return {
    id: r.id,
    label: r.label,
    platform: r.platform,
    target: r.target,
    state: r.state,
    stateMessage: r.stateMessage,
    createdAt: r.createdAt,
    build: { fileName: r.build.fileName, sizeBytes: r.build.sizeBytes },
    device: r.device,
    github: r.github,
    view: s.transform ? { width: s.transform.viewWidth, height: s.transform.viewHeight } : null,
    progress: s.progress.slice(-10),
    runnerConnected: s.runnerConnected,
  };
}

export function createWebServer(manager: SessionManager, tunnel: Tunnel, onShutdown: () => void) {
  const { config } = manager;
  const uiUrl = `http://127.0.0.1:${config.uiPort}`;
  const allowedHosts = new Set([`127.0.0.1:${config.uiPort}`, `localhost:${config.uiPort}`]);
  const publicDir = join(config.rootDir, "packages", "hub", "public");
  const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    const sid = req.headers["mcp-session-id"];
    const existing = typeof sid === "string" ? mcpTransports.get(sid) : undefined;
    let body: unknown;
    if (req.method === "POST") {
      const raw = await readBody(req, 4 * 1024 * 1024);
      body = raw ? JSON.parse(raw) : undefined;
    }
    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }
    if (typeof sid === "string") {
      // Unknown session (e.g. the hub restarted): the client must initialise again.
      json(res, 404, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      json(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: initialize first" },
        id: null,
      });
      return;
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        mcpTransports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) mcpTransports.delete(transport.sessionId);
    };
    const server = createMcpServer(manager, uiUrl);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  function mjpeg(s: HubSession, req: http.IncomingMessage, res: http.ServerResponse) {
    const boundary = "tapscoutframe";
    res.writeHead(200, {
      "content-type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "cache-control": "no-store",
      connection: "close",
    });
    const write = (f: LiveFrame) => {
      res.write(
        `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.data.length}\r\n\r\n`,
      );
      res.write(f.data);
      res.write("\r\n");
    };
    const last = s.ring[s.ring.length - 1];
    if (last) write(last);
    s.frameListeners.add(write);
    s.viewers += 1;
    s.updateStream();
    req.on("close", () => {
      s.frameListeners.delete(write);
      s.viewers = Math.max(0, s.viewers - 1);
      s.updateStream();
    });
  }

  async function events(s: HubSession, req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const listener = (e: unknown) => {
      send({ type: "event", event: e });
      send({ type: "session", session: summary(s) });
    };
    s.eventListeners.add(listener);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
    send({ type: "session", session: summary(s) });
    req.on("close", () => {
      clearInterval(keepAlive);
      s.eventListeners.delete(listener);
    });
  }

  /** Manual control from the web UI; coordinates are fractions (0–1) of the screen. */
  async function control(s: HubSession, body: Record<string, unknown>) {
    s.lastActivity = Date.now();
    const ops = new DeviceOps(s, manager.store);
    const t = s.transform;
    if (!t) throw new SessionError("not_ready", "device not ready");
    const at = (nx: unknown, ny: unknown) =>
      viewToDevice(t, { x: Number(nx) * t.viewWidth, y: Number(ny) * t.viewHeight });
    switch (body.action) {
      case "tap":
        await ops.act("tap", at(body.x, body.y));
        break;
      case "long_press":
        await ops.act("long_press", { ...at(body.x, body.y), durationMs: 800 });
        break;
      case "swipe":
        await ops.act("path", {
          points: [at(body.x, body.y), at(body.x2, body.y2)],
          durationMs: 300,
        });
        break;
      case "key":
        await ops.act("key", { key: String(body.key) as KeyName });
        break;
      case "type":
        await ops.act("type", { text: String(body.text ?? ""), mode: "append" });
        break;
      case "restart":
        await ops.act("app", { action: "restart" }, 120_000);
        break;
      default:
        throw new SessionError("bad_args", "unknown control action");
    }
    await s.event({
      kind: "tool",
      tool: `ui:${String(body.action)}`,
      args: { ...body, text: body.text ? "…" : undefined },
      ok: true,
      summary: "manual control from the web UI",
      ms: 0,
    });
  }

  const server = http.createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    const origin = req.headers.origin;
    if (
      !allowedHosts.has(host) ||
      (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
    ) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", uiUrl);
    const path = url.pathname;
    try {
      if (path === "/mcp") return await handleMcp(req, res);
      if (path === "/api/health") return json(res, 200, { ok: true, version: HUB_VERSION });
      if (path === "/api/shutdown" && req.method === "POST") {
        json(res, 200, { ok: true });
        setTimeout(onShutdown, 50);
        return;
      }
      if (path === "/api/config") {
        return json(res, 200, {
          version: HUB_VERSION,
          githubRepo: config.github.repo ?? null,
          workflow: config.github.workflow,
          tunnel: tunnel.url ?? config.publicUrl ?? null,
          mcpUrl: `${uiUrl}/mcp`,
          dataDir: config.dataDir,
        });
      }
      if (path === "/api/tests" && req.method === "GET") {
        const tests = testStore(config.dataDir);
        return json(res, 200, {
          tests: await tests.list(),
          runs: (await tests.runs()).slice(0, 50),
        });
      }
      const runMatch = /^\/api\/test-runs\/([0-9a-f-]{36})$/.exec(path);
      if (runMatch && req.method === "GET") {
        return json(res, 200, await testStore(config.dataDir).getRun(runMatch[1] as string));
      }
      if (path === "/api/sessions" && req.method === "GET") {
        return json(res, 200, manager.list().map(summary));
      }
      if (path === "/api/sessions" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as Record<string, string | number | undefined>;
        const s = await manager.create({
          platform: b.platform === "ios" ? "ios" : "android",
          buildPath: String(b.buildPath ?? ""),
          target: b.target === "local" ? "local" : "github",
          ...(b.label ? { label: String(b.label) } : {}),
          ...(b.maxMinutes ? { maxMinutes: Number(b.maxMinutes) } : {}),
          ...(b.avd ? { avd: String(b.avd) } : {}),
        });
        return json(res, 200, summary(s));
      }
      if (path === "/api/builds" && req.method === "PUT") {
        const name = (url.searchParams.get("name") ?? "build").replace(/[^\w.-]/g, "_");
        const dir = join(config.dataDir, "uploads");
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${Date.now()}-${name}`);
        await pipeline(req, createWriteStream(file));
        return json(res, 200, { path: file });
      }
      const m = /^\/api\/sessions\/([0-9a-f-]{36})(\/[\w.]+)?$/.exec(path);
      if (m) {
        const s = manager.get(m[1]);
        const sub = m[2] ?? "";
        if (sub === "" && req.method === "GET") {
          return json(res, 200, {
            ...summary(s),
            findings: await manager.store.findings(s.id),
            evidence: await manager.store.evidence(s.id),
            events: await manager.store.events(s.id, 400),
            sessionDir: manager.store.sessionDir(s.id),
          });
        }
        if (sub === "/events") return await events(s, req, res);
        if (sub === "/stream.mjpeg") return mjpeg(s, req, res);
        if (sub === "/frame.jpg") {
          const f = s.ring[s.ring.length - 1];
          if (!f) return json(res, 404, { error: "no frame yet" });
          res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
          return res.end(f.data);
        }
        if (sub === "/stop" && req.method === "POST") {
          await manager.stop(s.id, "stopped from the web UI");
          return json(res, 200, summary(s));
        }
        if (sub === "/control" && req.method === "POST") {
          await control(s, JSON.parse(await readBody(req)) as Record<string, unknown>);
          return json(res, 200, { ok: true });
        }
        if (sub === "/report" && req.method === "POST") {
          await buildReport(s, manager.store, (rel) => `/files/${s.id}/${rel}`);
          return json(res, 200, { url: `/files/${s.id}/report.html` });
        }
      }
      const f = /^\/files\/([0-9a-f-]{36})\/(.+)$/.exec(path);
      if (f && req.method === "GET") {
        const file = manager.store.sessionPath(f[1] as string, decodeURIComponent(f[2] as string));
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) return json(res, 404, { error: "not found" });
        res.writeHead(200, {
          "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-length": String(info.size),
        });
        await pipeline(createReadStream(file), res);
        return;
      }
      if (req.method === "GET") {
        const name = path === "/" ? "index.html" : path.slice(1);
        if (/^[\w.-]+$/.test(name)) {
          const data = await readFile(join(publicDir, name)).catch(() => null);
          if (data) {
            res.writeHead(200, {
              "content-type": TYPES[extname(name)] ?? "application/octet-stream",
            });
            return res.end(data);
          }
        }
      }
      json(res, 404, { error: "not found" });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof SessionError ? (error.code === "not_found" ? 404 : 400) : 500;
      json(res, status, { error: (error as Error).message });
    }
  });
  return {
    server,
    uiUrl,
    closeMcp: () => Promise.all([...mcpTransports.values()].map((t) => t.close())),
  };
}
