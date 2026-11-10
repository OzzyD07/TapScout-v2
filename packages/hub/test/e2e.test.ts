// End to end through real sockets: hub (gateway + web/MCP) ⇄ a fake runner that answers like a
// 1080×2400 Android device, driven by the MCP SDK client exactly as an agent would.

import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type DeviceInfo,
  encodeBinary,
  type FramePart,
  type HubMessage,
  type RunnerMessage,
} from "@tapscout/shared";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { HubAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/gateway.js";
import { SessionManager } from "../src/manager.js";
import { Store } from "../src/store.js";
import { Tunnel } from "../src/tunnel.js";
import { createWebServer } from "../src/web.js";

const SOURCE = readFileSync(
  new URL("../../shared/test/fixtures/android-register.xml", import.meta.url),
  "utf8",
);

const solid = (r: number, g: number, b: number, w = 1080, h = 2400) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
    .jpeg()
    .toBuffer();

class FakeRunner {
  ws!: WebSocket;
  commands: { name: string; args: Record<string, unknown> }[] = [];
  welcome: Extract<HubMessage, { t: "welcome" }> | null = null;
  shutdown: string | null = null;
  buildBytes = 0;

  constructor(
    private readonly gateway: string,
    private readonly sessionId: string,
  ) {}

  connect(token: string): Promise<number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(
        `${this.gateway.replace("http", "ws")}/runner/connect?session=${this.sessionId}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      this.ws = ws;
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => {
        this.send({
          t: "hello",
          protocol: 1,
          runnerVersion: "test",
          platform: "android",
          host: "local",
          resumed: false,
        });
        resolve(101);
      });
      ws.on("message", (data) => void this.onMessage(JSON.parse(data.toString()) as HubMessage));
      ws.on("error", () => undefined);
    });
  }

  send(m: RunnerMessage) {
    this.ws.send(JSON.stringify(m));
  }

  private async onMessage(m: HubMessage) {
    if (m.t === "welcome") {
      this.welcome = m;
      const res = await fetch(`${this.gateway}/runner/build?session=${this.sessionId}`, {
        headers: { authorization: `Bearer ${m.sessionToken}` },
      });
      this.buildBytes = (await res.arrayBuffer()).byteLength;
      const device: DeviceInfo = {
        platform: "android",
        host: "local",
        osVersion: "16",
        deviceName: "Fake Pixel",
        appId: "dev.tapscout.fieldnotes",
        screenshotWidth: 1080,
        screenshotHeight: 2400,
        pixelsPerUnit: 1,
        orientation: "portrait",
        automation: { appium: "test", driver: "uiautomator2", driverVersion: "test" },
        features: {
          liveStream: "poll",
          frameCapture: "poll",
          recording: true,
          logs: true,
          crashReports: true,
        },
      };
      this.send({ t: "ready", device });
      return;
    }
    if (m.t === "shutdown") {
      this.shutdown = m.reason;
      await fetch(`${this.gateway}/runner/upload?session=${this.sessionId}&name=logs/device.log`, {
        method: "PUT",
        headers: { authorization: `Bearer ${this.welcome?.sessionToken}` },
        body: "1 2 I test: bye\n",
      });
      this.send({ t: "bye", reason: m.reason });
      this.ws.close();
      return;
    }
    if (m.t !== "cmd") return;
    const args = m.args as Record<string, unknown>;
    this.commands.push({ name: m.name, args });
    const ok = (data: unknown) => this.send({ t: "res", id: m.id, ok: true, data });
    switch (m.name) {
      case "screenshot": {
        const img = await solid(40, 90, 200);
        this.ws.send(
          encodeBinary(
            {
              t: "res",
              id: m.id,
              ok: true,
              data: { width: 1080, height: 2400, capturedAt: Date.now(), orientation: "portrait" },
            },
            img,
          ),
        );
        return;
      }
      case "source":
        return ok({ xml: SOURCE, capturedAt: Date.now() });
      case "keyboard":
        return ok({ shown: false });
      case "logs":
        return ok({
          lines: ["12:00:00.000 123 E ReactNativeJS: boom"],
          truncated: false,
          source: "logcat",
        });
      case "crashes":
        return ok({ reports: [] });
      case "env": {
        const results = Object.keys(args).map((setting) =>
          setting === "network"
            ? { setting, ok: false, message: "not on this device" }
            : { setting, ok: true, message: `${setting} applied` },
        );
        return ok({ results });
      }
      case "app":
        return ok({ state: 4, stateName: "foreground", pid: 123 });
      case "capture_frames": {
        const frames: Buffer[] = [];
        for (let i = 0; i < 8; i++) frames.push(await solid(i * 30, 100, 255 - i * 30, 324, 720));
        const start = Date.now();
        const parts: FramePart[] = [];
        let offset = 0;
        frames.forEach((f, i) => {
          parts.push({
            offset,
            length: f.length,
            capturedAt: start + i * 125,
            width: 324,
            height: 720,
          });
          offset += f.length;
        });
        this.ws.send(
          encodeBinary(
            {
              t: "res",
              id: m.id,
              ok: true,
              data: { frames: parts, method: "poll", startedAt: start, actionAt: start + 250 },
            },
            Buffer.concat(frames),
          ),
        );
        return;
      }
      default:
        return ok({});
    }
  }
}

let manager: SessionManager;
let gatewayUrl: string;
let uiUrl: string;
let closeAll: () => Promise<void>;
let buildPath: string;

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "tapscout-e2e-"));
  const uiPort = 47000 + Math.floor(Math.random() * 1000);
  const config = loadConfig({
    TAPSCOUT_DATA_DIR: dataDir,
    TAPSCOUT_PORT: String(uiPort),
    TAPSCOUT_GATEWAY_PORT: "0",
    TAPSCOUT_TUNNEL: "none",
    TAPSCOUT_GITHUB_REPO: "OzzyD07/TapScout-v2",
  });
  const auth = await HubAuth.load(dataDir);
  const store = new Store(dataDir);
  const tunnel = new Tunnel(config, () => undefined);
  manager = new SessionManager(config, store, auth, tunnel, () => undefined);
  await manager.init();
  const gateway = createGateway(manager, auth);
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const web = createWebServer(manager, tunnel, () => undefined);
  await new Promise<void>((r) => web.server.listen(uiPort, "127.0.0.1", r));
  uiUrl = web.uiUrl;
  buildPath = join(dataDir, "app.apk");
  await writeFile(buildPath, Buffer.alloc(4096, 7));
  closeAll = async () => {
    await manager.shutdown();
    await web.closeMcp();
    web.server.closeAllConnections();
    gateway.closeAllConnections();
    web.server.close();
    gateway.close();
  };
});

afterAll(async () => {
  await closeAll();
});

describe("hub end to end", () => {
  it("authenticates runners, drives the device through MCP and cleans up", async () => {
    const s = await manager.create({
      platform: "android",
      buildPath,
      target: "local",
      launch: false,
      label: "e2e",
    });
    await s.waitFor(() => s.record.state === "waiting_for_runner", 5_000);
    const runner = new FakeRunner(gatewayUrl, s.id);

    // Wrong token, unknown session and an unauthenticated build download are refused.
    expect(await new FakeRunner(gatewayUrl, s.id).connect("tsl_wrong")).toBe(401);
    expect(
      await new FakeRunner(gatewayUrl, "00000000-0000-0000-0000-000000000000").connect("x"),
    ).toBe(404);
    expect((await fetch(`${gatewayUrl}/runner/build?session=${s.id}`)).status).toBe(401);
    expect((await fetch(`${gatewayUrl}/mcp`)).status).toBe(404);

    expect(await runner.connect(manager.localToken(s.id) as string)).toBe(101);
    expect(await s.waitFor(() => s.ready, 5_000)).toBe(true);
    expect(runner.buildBytes).toBe(4096);

    // The local UI refuses foreign hosts (DNS rebinding).
    const status403 = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        http
          .get(`${uiUrl}/api/sessions`, { headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on("error", () => resolve(0));
      });
    expect(await status403({ host: "evil.example" })).toBe(403);
    expect(await status403({ origin: "https://evil.example" })).toBe(403);

    const client = new Client({ name: "test-agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${uiUrl}/mcp`)));
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/VIEW UNITS/);
    expect(instructions.length).toBeLessThan(4096);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      "session_start",
      "session_status",
      "session_stop",
      "device_screenshot",
      "device_zoom",
      "device_ui_tree",
      "device_tap",
      "device_long_press",
      "device_swipe",
      "device_drag",
      "device_scroll",
      "device_pinch",
      "device_type",
      "device_key",
      "device_keyboard",
      "app_restart",
      "app_control",
      "device_capture_frames",
      "device_recent_frames",
      "device_recording",
      "device_logs",
      "device_crashes",
      "evidence_capture",
      "finding_record",
      "session_report",
    ]) {
      expect(tools).toContain(name);
    }

    const status = await client.callTool({ name: "session_status", arguments: {} });
    expect(JSON.stringify(status.content)).toMatch(/576×1280/);

    const shot = await client.callTool({
      name: "device_screenshot",
      arguments: { annotate: "both" },
    });
    const content = shot.content as { type: string; data?: string; text?: string }[];
    const image = content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    const meta = await sharp(Buffer.from(image?.data as string, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([576, 1280]);

    const tree = await client.callTool({ name: "device_ui_tree", arguments: {} });
    const treeText = (tree.content as { text: string }[])[0]?.text ?? "";
    expect(treeText).toMatch(/#register-continue/);

    // Tap by id: the runner receives the element's centre in device pixels.
    runner.commands.length = 0;
    const tap = await client.callTool({
      name: "device_tap",
      arguments: { element: "id:register-continue", observe: "none" },
    });
    expect(tap.isError).toBeFalsy();
    const sent = runner.commands.find((c) => c.name === "tap");
    expect(sent?.args.x).toBeGreaterThan(0);
    const cont = s.lastTree?.tree.elements.find((e) => e.stableId === "register-continue");
    expect(
      Math.abs(Number(sent?.args.x) - ((cont?.bounds.x ?? 0) + (cont?.bounds.width ?? 0) / 2)),
    ).toBeLessThan(3);

    // Point taps convert view units to device pixels (576×1280 → 1080×2400).
    runner.commands.length = 0;
    await client.callTool({ name: "device_tap", arguments: { x: 288, y: 640, observe: "none" } });
    expect(runner.commands.find((c) => c.name === "tap")?.args).toMatchObject({ x: 540, y: 1200 });
    const outside = await client.callTool({
      name: "device_tap",
      arguments: { x: 900, y: 10, observe: "none" },
    });
    expect(outside.isError).toBe(true);

    const scroll = await client.callTool({
      name: "device_scroll",
      arguments: { direction: "down", observe: "none" },
    });
    expect(scroll.isError).toBeFalsy();
    const path = runner.commands.find((c) => c.name === "path")?.args.points as { y: number }[];
    expect(path[0]?.y).toBeGreaterThan(path[1]?.y ?? 0);

    const frames = await client.callTool({
      name: "device_capture_frames",
      arguments: { duration_ms: 1000, fps: 8, action: { type: "tap", x: 100, y: 100 } },
    });
    const fcontent = frames.content as { type: string; text?: string }[];
    expect(fcontent.filter((c) => c.type === "image")).toHaveLength(1);
    expect(fcontent[0]?.text).toMatch(/8 frames/);

    const logs = await client.callTool({
      name: "device_logs",
      arguments: { since: "2m", level: "error" },
    });
    expect(JSON.stringify(logs.content)).toMatch(/boom/);
    const sinceArg = runner.commands.find((c) => c.name === "logs")?.args.sinceMs;
    expect(Number(sinceArg)).toBeGreaterThan(Date.now() - 200_000);

    const ev = await client.callTool({
      name: "evidence_capture",
      arguments: { label: "after tap", include: ["screenshot", "tree", "logs"] },
    });
    const evId = /Evidence (ev-\w+)/.exec(JSON.stringify(ev.content))?.[1];
    expect(evId).toBeDefined();
    const finding = await client.callTool({
      name: "finding_record",
      arguments: {
        title: "Continue does nothing",
        severity: "high",
        description: "Tapping Continue keeps the form.",
        evidence_ids: [evId],
      },
    });
    expect(JSON.stringify(finding.content)).toMatch(/Finding F1 recorded/);
    const bad = await client.callTool({
      name: "finding_record",
      arguments: { title: "x", severity: "low", description: "x", evidence_ids: ["ev-nope"] },
    });
    expect(bad.isError).toBe(true);

    const report = await client.callTool({ name: "session_report", arguments: {} });
    expect(JSON.stringify(report.content)).toMatch(/Continue does nothing/);

    // What the agent saw is kept and listed for the UI.
    const detail = (await (await fetch(`${uiUrl}/api/sessions/${s.id}`)).json()) as {
      events: { kind: string; images?: string[] }[];
    };
    const shown = detail.events.filter((e) => e.kind === "tool" && e.images?.length);
    expect(shown.length).toBeGreaterThanOrEqual(2);

    const stop = await client.callTool({ name: "session_stop", arguments: {} });
    expect(JSON.stringify(stop.content)).toMatch(/logs\/device\.log/);
    expect(runner.shutdown).toMatch(/stopped by the agent/);
    expect(s.record.state).toBe("closed");

    // A closed session refuses runners.
    expect(await new FakeRunner(gatewayUrl, s.id).connect(manager.localToken(s.id) as string)).toBe(
      410,
    );
    await client.close();
  }, 30_000);

  it("waits for a dropped runner and resumes with the session token", async () => {
    const s = await manager.create({
      platform: "android",
      buildPath,
      target: "local",
      launch: false,
    });
    await s.waitFor(() => s.record.state === "waiting_for_runner", 5_000);
    const first = new FakeRunner(gatewayUrl, s.id);
    await first.connect(manager.localToken(s.id) as string);
    await s.waitFor(() => s.ready, 5_000);
    const token = first.welcome?.sessionToken as string;
    first.ws.terminate();
    expect(await s.waitFor(() => s.record.state === "disconnected", 5_000)).toBe(true);
    await expect(s.command("tap", { x: 1, y: 1 })).rejects.toThrow(/disconnected/);
    const second = new FakeRunner(gatewayUrl, s.id);
    expect(await second.connect(token)).toBe(101);
    expect(await s.waitFor(() => s.ready, 5_000)).toBe(true);
    await manager.stop(s.id, "test done", 5_000);
    expect(s.record.state).toBe("closed");
  }, 20_000);
});
