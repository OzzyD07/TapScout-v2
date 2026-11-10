// Wire protocol between the local hub and a device runner (GitHub Actions job or local process).
//
// One WebSocket per runner, opened by the runner (outbound only, so it works behind NAT and through
// a tunnel). Text frames carry one JSON message. Binary frames carry a JSON header plus bytes
// (screenshots, stream frames): [u32 big-endian header length][header JSON, UTF-8][payload].
// Coordinates inside commands are device units: px on Android, pt on iOS. The hub converts
// to and from the agent's "view" space (geometry.ts).

export const PROTOCOL_VERSION = 1;

/** Paths served by the hub's runner gateway (the only port a tunnel exposes). */
export const GATEWAY_PATHS = {
  connect: "/runner/connect",
  build: "/runner/build",
  upload: "/runner/upload",
  health: "/healthz",
} as const;

export type Platform = "android" | "ios";
export type RunnerHost = "github" | "local";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DeviceInfo {
  platform: Platform;
  host: RunnerHost;
  osVersion: string;
  deviceName: string;
  udid?: string;
  /** Android package or iOS bundle id of the app under test. */
  appId: string;
  /** iOS: CFBundleExecutable, used to filter logs and crash reports. */
  appExecutable?: string;
  /** Screenshot size in pixels for the current orientation. */
  screenshotWidth: number;
  screenshotHeight: number;
  /** Screenshot pixels per device unit: 1 on Android (px), the display scale on iOS (pt). */
  pixelsPerUnit: number;
  orientation: "portrait" | "landscape";
  automation: { appium: string; driver: string; driverVersion: string };
  /** What the runner can do on this device; the hub reports unsupported tools instead of guessing. */
  features: {
    liveStream: "mjpeg" | "poll" | "none";
    frameCapture: "video" | "mjpeg" | "poll";
    recording: boolean;
    logs: boolean;
    crashReports: boolean;
  };
  github?: { runId: number; runAttempt: number; jobUrl?: string };
}

export type RunnerState =
  | "connecting"
  | "downloading_build"
  | "installing"
  | "starting_app"
  | "ready"
  | "busy"
  | "stopping"
  | "error";

export interface StreamSettings {
  /** Frames per second; 0 stops the stream. */
  fps: number;
  /** Long edge of streamed frames in pixels. */
  maxEdge: number;
  /** JPEG quality 1–100. */
  quality: number;
}

export interface RunnerConfig {
  /** Seconds between application-level pings; the hub drops a runner that misses three. */
  pingIntervalSeconds: number;
  /** How long the runner keeps the device alive while the hub is unreachable. */
  reconnectGraceSeconds: number;
  stream: StreamSettings;
  /** iOS only: keep app data between restarts unless asked (Appium noReset). */
  keepAppData: boolean;
}

// ---- Commands (hub → runner) -------------------------------------------------------------------

export type KeyName =
  | "enter"
  | "backspace"
  | "delete"
  | "tab"
  | "escape"
  | "space"
  | "back"
  | "home"
  | "app_switch"
  | "menu"
  | "search"
  | "volume_up"
  | "volume_down"
  | "power"
  | "dpad_up"
  | "dpad_down"
  | "dpad_left"
  | "dpad_right"
  | "dpad_center"
  | "move_home"
  | "move_end"
  | "select_all";

export interface CommandMap {
  screenshot: {
    args: { format?: "jpeg" | "png"; quality?: number };
    result: {
      width: number;
      height: number;
      capturedAt: number;
      orientation: "portrait" | "landscape";
    };
  };
  /** iOS also returns the SpringBoard alert in front, which the app's source does not contain. */
  source: {
    args: Record<string, never>;
    result: { xml: string; capturedAt: number; alert?: { text: string; buttons: string[] } };
  };
  /** iOS: answers the system alert in front by its button label. */
  alert: { args: { button: string }; result: Record<string, never> };
  tap: {
    args: { x: number; y: number; count?: number; intervalMs?: number };
    result: Record<string, never>;
  };
  long_press: { args: { x: number; y: number; durationMs: number }; result: Record<string, never> };
  /** A finger path: swipe, scroll or drag (hold first, then move). */
  path: {
    args: { points: Point[]; durationMs: number; holdMs?: number; endHoldMs?: number };
    result: Record<string, never>;
  };
  pinch: {
    args: { x: number; y: number; scale: number; durationMs: number; spread: number };
    result: Record<string, never>;
  };
  type: {
    args: { text: string; mode: "append" | "replace" };
    result: { focused: boolean; value?: string };
  };
  key: { args: { key: KeyName; times?: number }; result: Record<string, never> };
  keyboard: { args: { action: "status" | "hide" }; result: { shown: boolean } };
  app: {
    args: {
      action:
        | "launch"
        | "terminate"
        | "restart"
        | "background"
        | "state"
        | "clear_data"
        | "open_url";
      seconds?: number;
      clearData?: boolean;
      url?: string;
    };
    result: { state: number; stateName: string; pid?: number };
  };
  orientation: {
    args: { set?: "portrait" | "landscape" };
    result: { orientation: "portrait" | "landscape" };
  };
  info: { args: Record<string, never>; result: DeviceInfo };
  logs: {
    args: {
      sinceMs?: number;
      grep?: string;
      minLevel?: LogLevel;
      appOnly?: boolean;
      maxLines: number;
    };
    result: { lines: string[]; truncated: boolean; source: string };
  };
  crashes: {
    args: { sinceMs?: number };
    result: { reports: CrashReport[] };
  };
  /** Timestamped frames for animations; the optional action starts after `actionDelayMs`. */
  capture_frames: {
    args: {
      durationMs: number;
      fps: number;
      maxEdge: number;
      quality: number;
      action?: RunnerAction;
      actionDelayMs?: number;
    };
    result: {
      frames: FramePart[];
      method: "video" | "mjpeg" | "poll";
      startedAt: number;
      actionAt?: number;
      actionError?: string;
    };
  };
  record: {
    args: { action: "start" | "stop"; maxSeconds?: number };
    result: { recording: boolean; uploaded?: string; sizeBytes?: number; durationMs?: number };
  };
}

export type CommandName = keyof CommandMap;
export type CommandArgs<N extends CommandName> = CommandMap[N]["args"];
export type CommandResult<N extends CommandName> = CommandMap[N]["result"];

/** A device action the runner can run inside another command (e.g. during a frame capture). */
export type RunnerAction =
  | { name: "tap"; args: CommandArgs<"tap"> }
  | { name: "long_press"; args: CommandArgs<"long_press"> }
  | { name: "path"; args: CommandArgs<"path"> }
  | { name: "pinch"; args: CommandArgs<"pinch"> }
  | { name: "key"; args: CommandArgs<"key"> }
  | { name: "app"; args: CommandArgs<"app"> };

export type LogLevel = "verbose" | "debug" | "info" | "warn" | "error" | "fatal";

export interface CrashReport {
  source: "android_crash_buffer" | "android_anr" | "ios_diagnostic_report" | "app_not_running";
  /** Epoch ms when known. */
  at?: number;
  summary: string;
  text: string;
  /** File name the runner uploaded with the full report, when it did. */
  uploaded?: string;
}

/** Location of one frame inside a binary payload. */
export interface FramePart {
  offset: number;
  length: number;
  capturedAt: number;
  width: number;
  height: number;
}

// ---- Messages -------------------------------------------------------------------------------

export type HubMessage =
  | {
      t: "welcome";
      sessionId: string;
      /** Hub-signed token for reconnects, build download and uploads. */
      sessionToken: string;
      build: { fileName: string; sizeBytes: number; sha256: string };
      appId?: string;
      config: RunnerConfig;
    }
  | { t: "cmd"; id: string; name: CommandName; args: unknown; timeoutMs: number }
  | { t: "stream"; settings: StreamSettings }
  | { t: "shutdown"; reason: string }
  | { t: "ping"; at: number }
  | { t: "pong"; at: number };

export type RunnerMessage =
  | {
      t: "hello";
      protocol: number;
      runnerVersion: string;
      platform: Platform;
      host: RunnerHost;
      /** True when the runner already has a device session (reconnect after a network drop). */
      resumed: boolean;
    }
  | { t: "status"; state: RunnerState; message: string }
  | { t: "ready"; device: DeviceInfo }
  | { t: "res"; id: string; ok: true; data: unknown }
  | { t: "res"; id: string; ok: false; error: { code: string; message: string } }
  | { t: "frame"; seq: number; capturedAt: number; width: number; height: number }
  | { t: "event"; level: "info" | "warn" | "error"; message: string }
  | { t: "bye"; reason: string }
  | { t: "ping"; at: number }
  | { t: "pong"; at: number };

// ---- Binary envelope ------------------------------------------------------------------------

export function encodeBinary(header: object, payload: Uint8Array): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const out = Buffer.allocUnsafe(4 + head.length + payload.length);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, 4 + head.length);
  return out;
}

export function decodeBinary<T = unknown>(data: Uint8Array): { header: T; payload: Buffer } {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 4) throw new Error("binary frame too short");
  const len = buf.readUInt32BE(0);
  if (4 + len > buf.length) throw new Error("binary frame header overruns the frame");
  const header = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")) as T;
  return { header, payload: buf.subarray(4 + len) };
}

export const APP_STATE_NAMES: Record<number, string> = {
  0: "not_installed",
  1: "not_running",
  2: "background_suspended",
  3: "background",
  4: "foreground",
};
