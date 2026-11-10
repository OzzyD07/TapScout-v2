// The runner gateway: the only server a tunnel exposes. It serves exactly
//   GET  /healthz                         liveness for the tunnel check
//   WS   /runner/connect?session=<id>     the runner's command channel (bearer auth before upgrade)
//   GET  /runner/build?session=<id>       the build (hub session token)
//   PUT  /runner/upload?session=<id>&name= evidence from the runner (hub session token)
// Everything else answers 404. Errors never echo tokens.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import http from "node:http";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { GATEWAY_PATHS } from "@tapscout/shared";
import { WebSocketServer } from "ws";
import { AuthRejected, bearer, type HubAuth } from "./auth.js";
import type { SessionManager } from "./manager.js";
import { SessionError } from "./session.js";

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const SAFE_NAME = /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/;

export function createGateway(manager: SessionManager, auth: HubAuth) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  const fail = (res: http.ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  };

  /** Hub session token for HTTP calls; returns the session id it is valid for. */
  async function sessionFromToken(req: http.IncomingMessage, url: URL): Promise<string> {
    const token = bearer(req.headers.authorization);
    const sid = url.searchParams.get("session") ?? "";
    if (!token) throw new AuthRejected("missing bearer token");
    const claims = await auth.verify(token);
    if (claims.sid !== sid) throw new AuthRejected("token is for another session");
    const s = manager.sessions.get(sid);
    if (!s?.active) throw new SessionError("gone", "session is not active");
    return sid;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    try {
      if (req.method === "GET" && url.pathname === GATEWAY_PATHS.health) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "GET" && url.pathname === GATEWAY_PATHS.build) {
        const sid = await sessionFromToken(req, url);
        const s = manager.get(sid);
        const info = await stat(s.record.build.path);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(info.size),
        });
        await pipeline(createReadStream(s.record.build.path), res);
        s.note("build downloaded by the runner");
        return;
      }
      if (req.method === "PUT" && url.pathname === GATEWAY_PATHS.upload) {
        const sid = await sessionFromToken(req, url);
        const name = url.searchParams.get("name") ?? "";
        if (!SAFE_NAME.test(name) || name.includes("..")) return fail(res, 400, "bad file name");
        const declared = Number(req.headers["content-length"] ?? 0);
        if (declared > MAX_UPLOAD_BYTES) return fail(res, 413, "file too large");
        const s = manager.get(sid);
        const full = manager.store.sessionPath(sid, "evidence", "runner", name);
        await mkdir(dirname(full), { recursive: true });
        let size = 0;
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_UPLOAD_BYTES) req.destroy(new Error("file too large"));
        });
        await pipeline(req, createWriteStream(full));
        await s.event({ kind: "file", name: `runner/${name}`, sizeBytes: size });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sizeBytes: size }));
        return;
      }
      fail(res, 404, "not found");
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof AuthRejected) return fail(res, 401, "unauthorized");
      if (error instanceof SessionError)
        return fail(res, error.code === "gone" ? 410 : 404, error.message);
      manager.log(`gateway error: ${(error as Error).message}`);
      fail(res, 500, "internal error");
    }
  });

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== GATEWAY_PATHS.connect) return reject(404, "Not Found");
    const sid = url.searchParams.get("session") ?? "";
    const token = bearer(req.headers.authorization);
    if (!token) return reject(401, "Unauthorized");
    try {
      const claims = await manager.authenticateRunner(sid, token);
      wss.handleUpgrade(req, socket, head, (ws) => manager.attach(sid, ws, claims));
    } catch (error) {
      if (error instanceof SessionError) {
        return reject(
          error.code === "gone" ? 410 : 404,
          error.code === "gone" ? "Gone" : "Not Found",
        );
      }
      manager.log(`runner refused for ${sid.slice(0, 8)}: ${(error as Error).message}`);
      reject(401, "Unauthorized");
    }
  });

  return server;
}
