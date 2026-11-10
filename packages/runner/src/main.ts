#!/usr/bin/env node
// TapScout v2 device runner.
//   connect to the hub (GitHub OIDC or local token) → download and verify the build → Appium
//   session (install + launch) → report "ready" → execute the agent's commands, stream frames →
//   on shutdown (hub request, deadline, lost hub, signal) upload final logs and clean up.
// Never prints tokens, screen content or typed text: on a public repository the job log is public.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type DeviceInfo,
  type HubMessage,
  type Platform,
  PROTOCOL_VERSION,
  pngSize,
  type RunnerConfig,
  type StreamSettings,
} from "@tapscout/shared";
import { recoverEmulator } from "./android.js";
import { installRejection, simulatorPlatformProblem } from "./build-check.js";
import { fetchGithubOidcToken, HubConnection, HubRejected } from "./connection.js";
import { DeviceController, DeviceError } from "./device.js";
import { sleep } from "./exec.js";
import { findFfmpeg } from "./frames.js";
import { bootedSimulator, simulatorName } from "./ios.js";
import { ensureAndroidDevice, ensureAppium } from "./local.js";
import { LogCapture } from "./logs.js";
import { DeviceSession } from "./session.js";

const RUNNER_VERSION = "2.0.0";

const { values } = parseArgs({
  options: {
    hub: { type: "string", default: process.env.TAPSCOUT_HUB_URL },
    session: { type: "string", default: process.env.TAPSCOUT_SESSION_ID },
    platform: { type: "string" },
    auth: { type: "string", default: "github" },
    audience: { type: "string", default: process.env.TAPSCOUT_OIDC_AUDIENCE ?? "tapscout-v2" },
    udid: { type: "string" },
    serial: { type: "string" },
    avd: { type: "string" },
    wda: { type: "string" },
    out: { type: "string", default: ".artifacts/session" },
    "appium-url": { type: "string", default: "http://127.0.0.1:4723" },
    "appium-log": { type: "string", default: process.env.APPIUM_LOG },
    "start-appium": { type: "boolean", default: false },
    "max-minutes": { type: "string", default: "60" },
  },
});

const rawPlatform = values.platform as Platform | undefined;
if ((rawPlatform !== "android" && rawPlatform !== "ios") || !values.hub || !values.session) {
  console.error(
    "usage: tapscout-runner --platform android|ios --hub <url> --session <id> [--auth github|token]",
  );
  process.exit(2);
}
const platform: Platform = rawPlatform;
const hubUrl = values.hub;
const sessionId = values.session;
const host = values.auth === "github" ? "github" : "local";
const localToken = process.env.TAPSCOUT_RUNNER_TOKEN;
if (host === "local" && !localToken) {
  console.error("TAPSCOUT_RUNNER_TOKEN is required with --auth token");
  process.exit(2);
}
const outDir = resolve(values.out ?? ".artifacts/session");
await mkdir(outDir, { recursive: true });
const maxMinutes = Math.max(5, Math.min(Number(values["max-minutes"]) || 60, 350));
const deadline = Date.now() + maxMinutes * 60_000;
const log = (m: string) => console.log(`runner: ${m}`);

let config: RunnerConfig | null = null;
let session = null as DeviceSession | null;
let preparing = false;
let streamSettings: StreamSettings = { fps: 0, maxEdge: 720, quality: 60 };
let frameSeq = 0;
let finishReason: string | null = null;
let failed = false;
let wakeMain: () => void = () => undefined;
const finished = new Promise<void>((resolveFinished) => {
  wakeMain = resolveFinished;
});
function finish(reason: string, isFailure = false) {
  if (finishReason) return;
  finishReason = reason;
  failed = isFailure;
  wakeMain();
}

const conn = new HubConnection({
  hubUrl,
  sessionId,
  credential: async () =>
    host === "github"
      ? fetchGithubOidcToken(values.audience ?? "tapscout-v2")
      : (localToken as string),
  hello: () => ({
    t: "hello",
    protocol: PROTOCOL_VERSION,
    runnerVersion: RUNNER_VERSION,
    platform,
    host,
    resumed: session !== null,
  }),
  onOpen: () => log("connected to hub"),
  onDisconnect: () => {
    log("hub connection lost; reconnecting");
    session?.stream.stop();
  },
  onMessage: (msg) => void handle(msg),
  log,
  graceMs: () => (config?.reconnectGraceSeconds ?? 600) * 1000,
});

function status(state: Parameters<typeof conn.send>[0] & { t: "status" }) {
  conn.send(state);
  log(`${state.state}: ${state.message}`);
}

function event(level: "info" | "warn" | "error", message: string) {
  conn.send({ t: "event", level, message });
  if (level !== "info") log(`${level}: ${message}`);
}

async function handle(msg: HubMessage) {
  switch (msg.t) {
    case "welcome":
      config = msg.config;
      streamSettings = msg.config.stream;
      if (session) {
        conn.send({ t: "ready", device: session.info });
        session.stream.update(streamSettings);
      } else if (!preparing) {
        preparing = true;
        prepare(msg).catch((error) => {
          const text = (error as Error).message ?? String(error);
          status({ t: "status", state: "error", message: text.slice(0, 1_000) });
          finish(`preparation failed: ${text.slice(0, 300)}`, true);
        });
      }
      return;
    case "stream":
      streamSettings = msg.settings;
      session?.stream.update(msg.settings);
      return;
    case "shutdown":
      finish(`hub asked to stop: ${msg.reason}`);
      return;
    case "cmd": {
      if (!session) {
        conn.send({
          t: "res",
          id: msg.id,
          ok: false,
          error: { code: "not_ready", message: "the device is not ready yet" },
        });
        return;
      }
      try {
        const out = await session.execute(msg.name, msg.args, msg.timeoutMs);
        if (out.payload) {
          conn.sendBinary({ t: "res", id: msg.id, ok: true, data: out.data }, out.payload);
        } else {
          conn.send({ t: "res", id: msg.id, ok: true, data: out.data });
        }
      } catch (error) {
        const code = error instanceof DeviceError ? error.code : "device_error";
        const message = ((error as Error).message ?? String(error)).split("\n")[0]?.slice(0, 600);
        conn.send({ t: "res", id: msg.id, ok: false, error: { code, message: message ?? code } });
      }
      return;
    }
    default:
      return;
  }
}

let appiumHandle = null as { stop: () => void } | null;
let logs = null as LogCapture | null;
let udid = values.udid;

async function prepare(w: Extract<HubMessage, { t: "welcome" }>) {
  // ---- Build -------------------------------------------------------------------------------
  status({
    t: "status",
    state: "downloading_build",
    message: `downloading ${w.build.sizeBytes} bytes`,
  });
  const buildDir = join(outDir, "build");
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  const buildFile = join(buildDir, w.build.fileName.replace(/[^\w.-]/g, "_"));
  const got = await conn.downloadBuild(buildFile);
  if (got.sizeBytes !== w.build.sizeBytes || got.sha256 !== w.build.sha256) {
    throw new Error(
      `build download mismatch (${got.sizeBytes} bytes, sha256 ${got.sha256.slice(0, 12)}…)`,
    );
  }
  let appPath = buildFile;
  let executable: string | undefined;
  if (platform === "ios") {
    const unpacked = join(buildDir, "unpacked");
    execFileSync("ditto", ["-x", "-k", buildFile, unpacked]);
    const entries = await readdir(unpacked);
    const app = entries.find((f) => f.endsWith(".app"));
    if (!app) {
      throw new Error(
        entries.includes("Payload")
          ? "This is an .ipa device build; a ZIP of an iOS Simulator .app is needed."
          : "The ZIP does not contain an iOS Simulator .app at its top level.",
      );
    }
    appPath = join(unpacked, app);
    try {
      const plist = JSON.parse(
        execFileSync("plutil", [
          "-convert",
          "json",
          "-o",
          "-",
          join(appPath, "Info.plist"),
        ]).toString("utf8"),
      ) as { CFBundleExecutable?: string };
      executable = plist.CFBundleExecutable;
      const problem = simulatorPlatformProblem(plist);
      if (problem) throw new Error(problem);
    } catch (error) {
      if (/device build/.test((error as Error).message)) throw error;
    }
    udid ??= await bootedSimulator();
  }

  // ---- Device ------------------------------------------------------------------------------
  status({ t: "status", state: "installing", message: "installing the build through Appium" });
  if (host === "local" && platform === "android") {
    const serial = await ensureAndroidDevice(values.serial, values.avd, log);
    process.env.ANDROID_SERIAL = serial;
    udid = serial;
  }
  const appiumLog = values["appium-log"] ?? join(outDir, "appium.log");
  if (values["start-appium"])
    appiumHandle = await ensureAppium(values["appium-url"] as string, appiumLog);

  const mjpegPort = platform === "ios" ? 9100 : undefined;
  const open = (keepAppData: boolean) =>
    DeviceController.open({
      platform,
      appPath,
      udid,
      prebuiltWdaPath: values.wda,
      keepAppData,
      appiumUrl: values["appium-url"] as string,
      mjpegPort,
      ...(w.appId ? { appId: w.appId } : {}),
    });
  let device: DeviceController;
  try {
    device = await open(false);
  } catch (error) {
    const message = (error as Error).message ?? "";
    const rejection = installRejection(platform, message);
    if (rejection) throw new Error(rejection);
    if (platform !== "android" || !/device offline|device not found|adbExec/i.test(message)) {
      throw error;
    }
    log("the emulator went offline while the session started; retrying once");
    await recoverEmulator();
    device = await open(false);
  }

  status({ t: "status", state: "starting_app", message: "reading the device" });
  const png = await device.screenshotPng();
  const size = pngSize(png) ?? { width: 0, height: 0 };
  const win = await device.windowSize();
  const pixelsPerUnit = platform === "ios" && win.width > 0 ? size.width / win.width : 1;
  const ffmpeg = await findFfmpeg();
  const logFile = join(outDir, "device.log");
  try {
    logs =
      platform === "android"
        ? await LogCapture.android(logFile, device.appId)
        : udid && executable
          ? LogCapture.ios(logFile, udid, executable, device.appId)
          : null;
  } catch (error) {
    event("warn", `device log capture unavailable: ${(error as Error).message}`);
  }
  const caps = device.capabilities;
  const info: DeviceInfo = {
    platform,
    host,
    osVersion: device.osVersion(),
    deviceName:
      (platform === "ios" ? await simulatorName(udid) : await device.androidDeviceName()) ??
      String(caps.deviceName ?? "unknown"),
    ...(udid ? { udid } : {}),
    appId: device.appId,
    ...(executable ? { appExecutable: executable } : {}),
    screenshotWidth: size.width,
    screenshotHeight: size.height,
    pixelsPerUnit: Math.round(pixelsPerUnit * 1000) / 1000,
    orientation: size.width > size.height ? "landscape" : "portrait",
    automation: {
      appium: process.env.APPIUM_VERSION ?? "unknown",
      driver: platform === "ios" ? "xcuitest" : "uiautomator2",
      driverVersion:
        (platform === "ios" ? process.env.XCUITEST_VERSION : process.env.UIAUTOMATOR2_VERSION) ??
        "unknown",
    },
    features: {
      liveStream: platform === "ios" ? "mjpeg" : "poll",
      frameCapture: platform === "android" ? (ffmpeg ? "video" : "poll") : "mjpeg",
      recording: platform === "android" || Boolean(udid),
      logs: logs !== null,
      crashReports: platform === "android" || Boolean(executable),
    },
    ...(process.env.GITHUB_RUN_ID
      ? {
          github: {
            runId: Number(process.env.GITHUB_RUN_ID),
            runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
            jobUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
          },
        }
      : {}),
  };

  session = new DeviceSession({
    device,
    info,
    outDir,
    logs,
    ...(udid ? { udid } : {}),
    ...(mjpegPort ? { mjpegPort } : {}),
    reopen: () => open(true),
    upload: (name, file) => conn.upload(name, file),
    onFrame: (f) => {
      frameSeq += 1;
      conn.sendBinary(
        { t: "frame", seq: frameSeq, capturedAt: f.capturedAt, width: f.width, height: f.height },
        f.data,
      );
    },
    log,
    event,
  });
  conn.send({ t: "ready", device: info });
  log(`ready: ${platform} ${info.osVersion} ${info.deviceName}, ${size.width}x${size.height}`);
  session.stream.update(streamSettings);
}

// ---- Lifecycle ------------------------------------------------------------------------------

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => finish(`received ${signal}`));
}
const deadlineTimer = setInterval(() => {
  const left = deadline - Date.now();
  if (left <= 0) finish("maximum session length reached");
  else if (left < 3 * 60_000 && left > 3 * 60_000 - 30_000) {
    event("warn", `The session reaches its ${maxMinutes}-minute limit in 3 minutes.`);
  }
}, 30_000);

conn.run().then(
  () => undefined,
  (error) => {
    if (error instanceof HubRejected) finish(error.message, true);
    else finish(`lost the hub: ${(error as Error).message}`, true);
  },
);

await finished;
clearInterval(deadlineTimer);
if (conn.open) status({ t: "status", state: "stopping", message: finishReason ?? "stopping" });

// Final evidence goes to the hub while it is reachable; nothing is printed to the job log.
try {
  await session?.shutdown();
} catch (error) {
  log(`stopping the stream/recording failed: ${(error as Error).message}`);
}
await logs?.stop().catch(() => undefined);
if (conn.open && conn.sessionToken) {
  const uploads: [string, string][] = [];
  if (logs && existsSync(logs.file)) uploads.push(["logs/device.log", logs.file]);
  const appiumLog = values["appium-log"] ?? join(outDir, "appium.log");
  if (existsSync(appiumLog)) uploads.push(["logs/appium.log", appiumLog]);
  for (const [name, file] of uploads) {
    await conn
      .upload(name, file)
      .catch((e) => log(`upload ${name} failed: ${(e as Error).message}`));
  }
}
if (session) await session.device.close().catch(() => undefined);
appiumHandle?.stop();
await conn.stop(finishReason ?? "stopped").catch(() => undefined);
await sleep(100);
process.exit(failed ? 1 : 0);
