// Device environment for tests: appearance, app language, text size, location, network, push,
// biometrics and media. Every setting is applied and reported on its own, so one unsupported
// setting never hides the result of the others. Android: emulator commands over adb (all checked
// on an Android 16 emulator). iOS: xcrun simctl and XCUITest.

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DeviceInfo, EnvArgs, EnvResult } from "@tapscout/shared";
import { adb } from "./android.js";
import type { DeviceController } from "./device.js";
import { execText, sleep } from "./exec.js";

export interface EnvContext {
  device: DeviceController;
  info: DeviceInfo;
  udid?: string;
  outDir: string;
}

/** iOS content size categories and the text scale each roughly stands for. */
const IOS_SIZES: [number, string][] = [
  [0.8, "extra-small"],
  [0.88, "small"],
  [0.94, "medium"],
  [1.0, "large"],
  [1.12, "extra-large"],
  [1.24, "extra-extra-large"],
  [1.35, "extra-extra-extra-large"],
  [1.65, "accessibility-medium"],
  [2.0, "accessibility-large"],
  [2.4, "accessibility-extra-large"],
  [2.8, "accessibility-extra-extra-large"],
  [3.1, "accessibility-extra-extra-extra-large"],
];

export function iosContentSize(scale: number): string {
  let best = IOS_SIZES[3] as [number, string];
  for (const entry of IOS_SIZES) {
    if (Math.abs(entry[0] - scale) < Math.abs(best[0] - scale)) best = entry;
  }
  return best[1];
}

/** "tr-TR" → AppleLanguages "(tr)" and AppleLocale "tr_TR"; "zh-Hans-CN" → "(zh-Hans)", "zh_CN". */
export function iosLocaleArguments(tag: string): string[] {
  const parts = tag.trim().split(/[-_]/).filter(Boolean);
  const language = parts[0]?.toLowerCase();
  if (!language) return [];
  const script = parts.find((p, i) => i > 0 && p.length === 4);
  const region = parts.find((p, i) => i > 0 && (p.length === 2 || /^\d{3}$/.test(p)));
  const languageTag = script
    ? `${language}-${script[0]?.toUpperCase()}${script.slice(1).toLowerCase()}`
    : language;
  const locale = region ? `${language}_${region.toUpperCase()}` : language;
  return ["-AppleLanguages", `(${languageTag})`, "-AppleLocale", locale];
}

const simctl = (args: string[], timeoutMs = 30_000) =>
  execText("xcrun", ["simctl", ...args], { timeoutMs });

const MEDIA_VIDEO = /\.(mp4|mov|m4v|3gp|webm)$/i;

export async function applyEnvironment(ctx: EnvContext, args: EnvArgs): Promise<EnvResult[]> {
  const ios = ctx.info.platform === "ios";
  const results: EnvResult[] = [];
  const run = async (setting: keyof EnvArgs, fn: () => Promise<string>) => {
    try {
      results.push({ setting, ok: true, message: await fn() });
    } catch (error) {
      const message = ((error as Error).message ?? String(error)).split("\n")[0]?.slice(0, 400);
      results.push({ setting, ok: false, message: message ?? "failed" });
    }
  };
  // simctl/adb settings run in parallel (on a CI simulator appearance takes ~14 s and a push
  // ~19 s: one after another they overran the tool time limit); the ones that go through the
  // driver (relaunch for a language, biometrics) follow one at a time.
  const now: Promise<void>[] = [];
  const later: (() => Promise<void>)[] = [];
  const queueNow = (setting: keyof EnvArgs, fn: () => Promise<string>) => {
    now.push(run(setting, fn));
  };
  const queueLater = (setting: keyof EnvArgs, fn: () => Promise<string>) => {
    later.push(() => run(setting, fn));
  };
  const udid = () => {
    if (!ctx.udid) throw new Error("the simulator UDID is unknown");
    return ctx.udid;
  };
  const appId = ctx.info.appId;

  if (args.appearance) {
    queueNow("appearance", async () => {
      if (ios) await simctl(["ui", udid(), "appearance", args.appearance as string]);
      else
        await adb(["shell", "cmd", "uimode", "night", args.appearance === "dark" ? "yes" : "no"]);
      return `${args.appearance} mode`;
    });
  }

  if (args.fontScale !== undefined) {
    queueNow("fontScale", async () => {
      const scale = Math.max(0.8, Math.min(args.fontScale as number, 3.1));
      if (ios) {
        const size = iosContentSize(scale);
        await simctl(["ui", udid(), "content_size", size]);
        return `content size category ${size}`;
      }
      const android = Math.max(0.85, Math.min(scale, 2.0));
      await adb(["shell", "settings", "put", "system", "font_scale", String(android)]);
      return `font scale ${android}${android !== scale ? ` (Android allows 0.85–2.0)` : ""}`;
    });
  }

  if (args.locale !== undefined) {
    queueLater("locale", async () => {
      const tag = args.locale?.trim() ?? "";
      if (ios) {
        // Per-app language through launch arguments: the app is relaunched with them, now and
        // on every later launch/restart of this session.
        const launchArgs = tag ? iosLocaleArguments(tag) : [];
        ctx.device.setIosLaunchArguments(launchArgs);
        await ctx.device.driver.terminateApp(appId).catch(() => undefined);
        await ctx.device.launch();
        return tag
          ? `app relaunched in ${tag} (${launchArgs.join(" ")})`
          : "app relaunched in the device language";
      }
      // Android 13+: per-app language; the system recreates the app's activities.
      const out = await adb(["shell", "cmd", "locale", "set-app-locales", appId, "--locales", tag]);
      if (/error|unknown|exception/i.test(out)) throw new Error(out.trim());
      const now = (await adb(["shell", "cmd", "locale", "get-app-locales", appId])).trim();
      return `${now}${tag ? "" : " (device language)"}`;
    });
  }

  if (args.location) {
    queueNow("location", async () => {
      const { latitude, longitude, altitude } = args.location as NonNullable<EnvArgs["location"]>;
      if (ios) {
        await simctl(["location", udid(), "set", `${latitude},${longitude}`]);
      } else {
        // The emulator's console takes longitude first.
        const out = await adb([
          "emu",
          "geo",
          "fix",
          String(longitude),
          String(latitude),
          ...(altitude !== undefined ? [String(altitude)] : []),
        ]).catch(async (error) => {
          // Not an emulator: Appium's mock location provider.
          await ctx.device.driver.setGeoLocation({ latitude, longitude, altitude: altitude ?? 0 });
          return `mock location (${(error as Error).message.slice(0, 60)})`;
        });
        if (/KO|error/i.test(out)) throw new Error(out.trim());
      }
      return `${latitude}, ${longitude}${altitude !== undefined ? `, ${altitude} m` : ""}`;
    });
  }

  if (args.network) {
    queueNow("network", async () => {
      if (ios) {
        throw new Error(
          "the iOS Simulator uses the Mac's network and has no per-device offline switch; test offline behaviour on Android",
        );
      }
      const on = args.network === "offline";
      try {
        await adb(["shell", "cmd", "connectivity", "airplane-mode", on ? "enable" : "disable"]);
      } catch {
        await adb(["shell", "svc", "wifi", on ? "disable" : "enable"]);
        await adb(["shell", "svc", "data", on ? "disable" : "enable"]);
      }
      return on ? "airplane mode on (no network for the device)" : "airplane mode off";
    });
  }

  if (args.push) {
    queueNow("push", async () => {
      if (!ios) {
        throw new Error(
          "Android pushes arrive through FCM from the app's own server; send one from your backend or the Firebase console while the session runs",
        );
      }
      const p = args.push as NonNullable<EnvArgs["push"]>;
      const payload = {
        ...(p.data ?? {}),
        aps: {
          alert: { title: p.title, body: p.body },
          sound: "default",
          ...(p.badge !== undefined ? { badge: p.badge } : {}),
        },
      };
      const file = join(ctx.outDir, `push-${Date.now()}.json`);
      await writeFile(file, JSON.stringify(payload));
      await simctl(["push", udid(), appId, file]);
      return `notification "${p.title}" delivered to ${appId} (shown if the app may post notifications)`;
    });
  }

  if (args.biometric) {
    queueLater("biometric", async () => {
      const b = args.biometric as NonNullable<EnvArgs["biometric"]>;
      if (ios) {
        if (b === "enroll") {
          await ctx.device.driver.execute("mobile: enrollBiometric", { isEnabled: true });
          return "Face ID / Touch ID enrolled on the simulator";
        }
        const type = /\bSE\b|iPhone 8/.test(ctx.info.deviceName) ? "touchId" : "faceId";
        await ctx.device.driver.execute("mobile: sendBiometricMatch", {
          type,
          match: b === "match",
        });
        return `${type} ${b === "match" ? "matching" : "non-matching"} attempt sent`;
      }
      if (b === "enroll") {
        // Fingerprints need a screen lock; the enrolment itself runs through Settings.
        const disabled = (
          await adb(["shell", "locksettings", "get-disabled"]).catch(() => "")
        ).trim();
        let pin = "";
        if (disabled !== "false") {
          await adb(["shell", "locksettings", "set-pin", "1234"]);
          pin = "Screen lock PIN 1234 was set. ";
        }
        await adb(["shell", "am", "start", "-a", "android.settings.BIOMETRIC_ENROLL"]).catch(() =>
          adb(["shell", "am", "start", "-a", "android.settings.FINGERPRINT_ENROLL"]),
        );
        await sleep(1_500);
        return `${pin}The fingerprint enrolment screen is open: go through it with taps (PIN 1234 when asked) and send biometric "match" whenever it asks for the finger (several times).`;
      }
      // Finger 1 is the one enrolled through Settings; finger 7 never is.
      const out = await adb(["emu", "finger", "touch", b === "match" ? "1" : "7"]);
      if (/KO|error/i.test(out)) throw new Error(out.trim());
      return `${b === "match" ? "enrolled" : "unknown"} finger touched the sensor`;
    });
  }

  if (args.media) {
    queueNow("media", async () => {
      const m = args.media as NonNullable<EnvArgs["media"]>;
      const name = basename(m.fileName).replace(/[^\w.-]/g, "_");
      const dir = join(ctx.outDir, "media");
      await mkdir(dir, { recursive: true });
      const file = join(dir, name);
      const bytes = Buffer.from(m.dataBase64, "base64");
      await writeFile(file, bytes);
      if (ios) {
        await simctl(["addmedia", udid(), file], 60_000);
        return `${name} (${bytes.length} bytes) added to Photos`;
      }
      const remote = `/sdcard/${MEDIA_VIDEO.test(name) ? "Movies" : "Pictures"}/${name}`;
      await adb(["push", file, remote], 60_000);
      // Appium Settings scans media (the system broadcast is deprecated since API 30).
      await adb([
        "shell",
        "am",
        "broadcast",
        "-a",
        "io.appium.settings.scan_media",
        "--es",
        "path",
        remote,
      ]).catch(() =>
        adb([
          "shell",
          "am",
          "broadcast",
          "-a",
          "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
          "-d",
          `file://${remote}`,
        ]),
      );
      return `${name} (${bytes.length} bytes) added to the gallery (${remote})`;
    });
  }

  await Promise.all(now);
  for (const fn of later) await fn();
  const order: (keyof EnvArgs)[] = [
    "appearance",
    "fontScale",
    "locale",
    "location",
    "network",
    "push",
    "biometric",
    "media",
  ];
  return results.sort((a, b) => order.indexOf(a.setting) - order.indexOf(b.setting));
}
