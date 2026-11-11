import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installRejection, simulatorPlatformProblem } from "../src/build-check.js";
import { buildCapabilities } from "../src/capabilities.js";
import { iosContentSize, iosLocaleArguments } from "../src/environment.js";
import { summarizeIps } from "../src/ios.js";
import { fromLogcat, fromOsLog, LogCapture } from "../src/logs.js";
// Loaded while collecting (it pulls in webdriverio, sharp and ffmpeg): an import inside a test
// counted against its 5 s timeout and failed under the load of a full `pnpm check`.
import { appCrashLines } from "../src/session.js";

describe("log lines", () => {
  it("reads logcat threadtime+epoch lines", () => {
    expect(fromLogcat(" 1762776000.123  4321  4330 E ReactNativeJS: boom")).toBe(
      "1762776000123 4321 E ReactNativeJS: boom",
    );
    expect(fromLogcat("--------- beginning of main")).toBeNull();
    expect(fromLogcat("1762776000.5 1 2 A libc: abort")).toMatch(/ F libc: abort$/);
  });

  it("reads os_log ndjson events", () => {
    const line = JSON.stringify({
      timestamp: "2026-11-10 12:00:00.123456+0000",
      messageType: "Error",
      eventMessage: "fetch failed\nretrying",
      processID: 77,
      subsystem: "com.example",
      category: "net",
    });
    expect(fromOsLog(line)).toBe(
      `${Date.parse("2026-11-10T12:00:00.123+0000")} 77 E com.example/net: fetch failed ⏎ retrying`,
    );
    expect(fromOsLog("not json")).toBeNull();
  });

  it("filters captured lines by time, level, app process and pattern", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tapscout-logs-"));
    const file = join(dir, "device.log");
    await writeFile(
      file,
      [
        "1000 10 I ActivityManager: Start proc dev.app",
        "2000 42 D App: hello",
        "3000 42 E App: crash here",
        "4000 99 E Other: unrelated",
      ].join("\n"),
    );
    const logs = new LogCapture(file, "logcat", "dev.app");
    logs.trackPid(42);
    const all = await logs.query({ maxLines: 10, appOnly: true });
    expect(all.lines).toHaveLength(3);
    const errors = await logs.query({ maxLines: 10, appOnly: true, minLevel: "error" });
    expect(errors.lines).toHaveLength(1);
    expect(errors.lines[0]).toMatch(/crash here/);
    const since = await logs.query({ maxLines: 10, sinceMs: 2500 });
    expect(since.lines).toHaveLength(2);
    const grep = await logs.query({ maxLines: 1, grep: "e" });
    expect(grep.truncated).toBe(true);
  });
});

describe("build checks", () => {
  it("explains install rejections", () => {
    expect(installRejection("android", "Failure [INSTALL_FAILED_NO_MATCHING_ABIS: ...]")).toMatch(
      /x86_64/,
    );
    expect(installRejection("ios", "Bad CPU type in executable")).toMatch(/Simulator/);
    expect(installRejection("android", "socket hang up")).toBeNull();
  });

  it("recognises device-only iOS builds", () => {
    expect(simulatorPlatformProblem({ CFBundleSupportedPlatforms: ["iPhoneOS"] })).toMatch(
      /device build/,
    );
    expect(
      simulatorPlatformProblem({ CFBundleSupportedPlatforms: ["iPhoneSimulator"] }),
    ).toBeNull();
  });
});

describe("capabilities", () => {
  it("never accepts alerts on its own and keeps animations testable", () => {
    const ios = buildCapabilities({ platform: "ios", appPath: "/a.app", udid: "U" });
    expect(ios["appium:autoAcceptAlerts"]).toBe(false);
    expect(ios["appium:mjpegServerPort"]).toBe(9100);
    const android = buildCapabilities({ platform: "android", appPath: "/a.apk" });
    expect(android["appium:autoGrantPermissions"]).toBe(false);
    expect(android["appium:autoLaunch"]).toBe(false);
    expect(Number(android["appium:newCommandTimeout"])).toBeGreaterThanOrEqual(1200);
  });

  it("always installs the given build, except in a replacement session", () => {
    for (const platform of ["android", "ios"] as const) {
      const fresh = buildCapabilities({ platform, appPath: "/a" });
      expect(fresh["appium:enforceAppInstall"]).toBe(true);
      expect(fresh["appium:noReset"]).toBe(false);
      const replacement = buildCapabilities({ platform, appPath: "/a", keepAppData: true });
      expect(replacement["appium:enforceAppInstall"]).toBe(false);
      expect(replacement["appium:noReset"]).toBe(true);
    }
  });
});

describe("iOS crash reports", () => {
  it("summarises an .ips report", () => {
    const header = JSON.stringify({
      app_name: "FieldNotes",
      app_version: "1.0",
      timestamp: "2026-11-10 12:00:00",
    });
    const body = JSON.stringify({
      exception: { type: "EXC_CRASH", signal: "SIGABRT" },
      faultingThread: 0,
      threads: [
        {
          frames: [
            { imageIndex: 0, symbol: "abort" },
            { imageIndex: 1, symbol: "-[Notes save]" },
          ],
        },
      ],
      usedImages: [{ name: "libsystem_c.dylib" }, { name: "FieldNotes" }],
    });
    const s = summarizeIps(`${header}\n${body}`);
    expect(s).toMatch(/FieldNotes 1.0 crashed/);
    expect(s).toMatch(/EXC_CRASH \(SIGABRT\)/);
    expect(s).toMatch(/FieldNotes -\[Notes save\]/);
  });
});

describe("environment helpers", () => {
  it("maps text scale to iOS content size categories", async () => {
    expect(iosContentSize(1)).toBe("large");
    expect(iosContentSize(1.3)).toBe("extra-extra-extra-large");
    expect(iosContentSize(0.85)).toBe("small");
    expect(iosContentSize(3)).toBe("accessibility-extra-extra-extra-large");
  });

  it("turns BCP 47 tags into iOS launch arguments", async () => {
    expect(iosLocaleArguments("tr-TR")).toEqual([
      "-AppleLanguages",
      "(tr)",
      "-AppleLocale",
      "tr_TR",
    ]);
    expect(iosLocaleArguments("zh-Hans-CN")).toEqual([
      "-AppleLanguages",
      "(zh-Hans)",
      "-AppleLocale",
      "zh_CN",
    ]);
    expect(iosLocaleArguments("de")).toEqual(["-AppleLanguages", "(de)", "-AppleLocale", "de"]);
    expect(iosLocaleArguments("")).toEqual([]);
  });
});

describe("android crash buffer", () => {
  it("keeps the app's crashes and drops other processes'", async () => {
    const lines = [
      // A Google system app crashing natively on the emulator (seen during a recording).
      "1794403600.120  6815  6933 F libc    : Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x8 in tid 6933 (vkp-mediapipe-0), pid 6815 (ogle.android.as)",
      // The app under test crashing in Java.
      "1794403601.500  7992  7992 E AndroidRuntime: FATAL EXCEPTION: main",
      "1794403601.500  7992  7992 E AndroidRuntime: Process: dev.tapscout.fieldnotes, PID: 7992",
      "1794403601.501  7992  7992 E AndroidRuntime: java.lang.IllegalStateException: boom",
      // A native crash of the app, logged by crash_dump with the package name.
      "1794403602.000  8100  8100 F DEBUG   : pid: 8050, tid: 8050, name: dev.tapscout.fieldnotes  >>> dev.tapscout.fieldnotes <<<",
    ];
    const kept = appCrashLines(lines, "dev.tapscout.fieldnotes", new Set());
    expect(kept).toHaveLength(4);
    expect(kept.some((l) => l.includes("ogle.android.as"))).toBe(false);
    expect(appCrashLines(lines.slice(0, 1), "dev.tapscout.fieldnotes", new Set())).toEqual([]);
    // A tracked pid counts even when its lines do not name the package.
    expect(
      appCrashLines(
        ["1794403603.000  4242  4242 F libc    : Fatal signal 6"],
        "x.y",
        new Set([4242]),
      ),
    ).toHaveLength(1);
  });
});
