// Appium (WebdriverIO) device control. Every coordinate here is in device units: px on Android,
// pt on iOS. The hub converts from the agent's view space before a command reaches this file.

import {
  APP_STATE_NAMES,
  type CommandArgs,
  type CommandResult,
  FAST_SOURCE_EXCLUDED,
  type KeyName,
  type Platform,
  type Point,
  usableFastSource,
} from "@tapscout/shared";
import { remote } from "webdriverio";
import { ANDROID_KEYCODES, adb, pidOf } from "./android.js";
import { buildCapabilities, type SessionOptions } from "./capabilities.js";
import { sleep } from "./exec.js";

type Browser = Awaited<ReturnType<typeof remote>>;
type Pointer = {
  type: "pointer";
  id: string;
  parameters: { pointerType: "touch" };
  actions: object[];
};

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
/** Text the US on-screen keyboard can type directly (printable ASCII, newline, tab). */
const PLAIN_TYPABLE = /^[\x20-\x7e\n\t]*$/;

import { DeviceError } from "./errors.js";

export { DeviceError };

function finger(id: string, actions: object[]): Pointer {
  return { type: "pointer", id, parameters: { pointerType: "touch" }, actions };
}

const r = (n: number) => Math.round(n);

export class DeviceController {
  private constructor(
    readonly platform: Platform,
    readonly driver: Browser,
    readonly options: SessionOptions & { appiumUrl: string },
    readonly appId: string,
  ) {}

  static async open(
    options: SessionOptions & { appiumUrl: string; appId?: string },
  ): Promise<DeviceController> {
    const url = new URL(options.appiumUrl);
    const driver = await remote({
      protocol: url.protocol.replace(":", ""),
      hostname: url.hostname,
      port: Number(url.port || 4723),
      path: url.pathname || "/",
      logLevel: "warn",
      connectionRetryTimeout: 900_000,
      connectionRetryCount: 0,
      capabilities: buildCapabilities(options),
    });
    await driver.setTimeout({ implicit: 0 });
    const caps = driver.capabilities as Record<string, unknown>;
    const reported =
      caps.appPackage ?? caps["appium:appPackage"] ?? caps.bundleId ?? caps["appium:bundleId"];
    const appId = options.appId ?? (typeof reported === "string" ? reported : undefined);
    if (!appId) {
      await driver.deleteSession().catch(() => undefined);
      throw new Error("the driver did not report the app id of the build");
    }
    const device = new DeviceController(options.platform, driver, options, appId);
    if (options.platform === "ios" && options.keepAppData) {
      // A replacement session: bring the running app to the front as it is (no relaunch).
      await driver.activateApp(appId).catch(() => undefined);
    }
    if (options.platform === "android") {
      // Animations stay on (they are under test); only the idle wait is shortened so an animated
      // screen does not hold every command for 10 s.
      await driver.updateSettings({ waitForIdleTimeout: 1000 }).catch(() => undefined);
      await driver.activateApp(appId);
    }
    return device;
  }

  /** iOS launch arguments by purpose (language, text size); the app starts with all of them. */
  private readonly launchArgGroups = new Map<string, string[]>();

  setIosLaunchArguments(group: string, args: string[]) {
    if (args.length > 0) this.launchArgGroups.set(group, args);
    else this.launchArgGroups.delete(group);
  }

  /** Keeps the launch arguments of the session this one replaces. */
  copyLaunchArgumentsFrom(other: DeviceController) {
    for (const [group, args] of other.launchArgGroups) this.launchArgGroups.set(group, args);
  }

  private get launchArgs(): string[] {
    return [...this.launchArgGroups.values()].flat();
  }

  /** Starts the app (or brings it to the front), with the iOS launch arguments when set. */
  async launch(): Promise<void> {
    if (this.platform === "ios" && this.launchArgs.length > 0) {
      await this.driver.execute("mobile: launchApp", {
        bundleId: this.appId,
        arguments: this.launchArgs,
      });
      return;
    }
    await this.driver.activateApp(this.appId);
  }

  get capabilities() {
    return this.driver.capabilities as Record<string, unknown>;
  }

  async close(): Promise<void> {
    await this.driver.deleteSession();
  }

  /**
   * Ends the Appium session with a plain HTTP request and a short deadline, bypassing
   * WebdriverIO (whose own request for a stuck command may still be pending). Deleting the
   * session makes the driver drop whatever it was executing.
   */
  async forceClose(timeoutMs = 20_000): Promise<boolean> {
    const base = this.options.appiumUrl.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/session/${this.driver.sessionId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ---- Observation ------------------------------------------------------------------------

  async screenshotPng(): Promise<Buffer> {
    return Buffer.from(await this.driver.takeScreenshot(), "base64");
  }

  /** Window size in device units. */
  async windowSize(): Promise<{ width: number; height: number }> {
    const rect = await this.driver.getWindowRect();
    return { width: rect.width, height: rect.height };
  }

  /**
   * The page source. iOS reads it without WDA's costly `visible` attribute first and in full only
   * where something covers the app (TapScout v1: 0.5 s instead of 6–7 s per read).
   */
  async source(): Promise<string> {
    if (this.platform === "ios") {
      const fast = String(
        await this.driver.execute("mobile: source", {
          format: "xml",
          excludedAttributes: FAST_SOURCE_EXCLUDED,
        }),
      );
      const usable = usableFastSource(fast);
      if (usable !== null) return usable;
    }
    return this.driver.getPageSource();
  }

  /** iOS: the SpringBoard alert in front, which the app's source does not contain. */
  async systemAlert(): Promise<{ text: string; buttons: string[] } | null> {
    if (this.platform !== "ios") return null;
    try {
      const buttons = (await this.driver.execute("mobile: alert", {
        action: "getButtons",
      })) as unknown;
      if (!Array.isArray(buttons) || buttons.length === 0) return null;
      const text = String((await this.driver.getAlertText().catch(() => "")) ?? "");
      return { text, buttons: buttons.map(String) };
    } catch {
      return null;
    }
  }

  async answerAlert(label: string): Promise<void> {
    await this.driver.execute("mobile: alert", { action: "accept", buttonLabel: label });
  }

  async orientation(set?: "portrait" | "landscape"): Promise<"portrait" | "landscape"> {
    if (set) await this.driver.setOrientation(set === "portrait" ? "PORTRAIT" : "LANDSCAPE");
    const now = String(await this.driver.getOrientation()).toLowerCase();
    return now.startsWith("land") ? "landscape" : "portrait";
  }

  // ---- Gestures ---------------------------------------------------------------------------

  private async perform(pointers: Pointer[]): Promise<void> {
    try {
      await this.driver.performActions(pointers);
    } catch (error) {
      // UiAutomator2 sometimes refuses the very first action chain of a new session; once.
      if (!/Unable to perform W3C actions/i.test((error as Error).message)) throw error;
      await sleep(600);
      await this.driver.performActions(pointers);
    }
    await this.driver.releaseActions().catch(() => undefined);
  }

  async tap({ x, y, count = 1, intervalMs = 90 }: CommandArgs<"tap">): Promise<void> {
    const actions: object[] = [{ type: "pointerMove", duration: 0, x: r(x), y: r(y) }];
    for (let i = 0; i < Math.max(1, Math.min(count, 5)); i++) {
      if (i > 0) actions.push({ type: "pause", duration: intervalMs });
      actions.push(
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 60 },
        { type: "pointerUp", button: 0 },
      );
    }
    await this.perform([finger("finger1", actions)]);
  }

  async longPress({ x, y, durationMs }: CommandArgs<"long_press">): Promise<void> {
    await this.perform([
      finger("finger1", [
        { type: "pointerMove", duration: 0, x: r(x), y: r(y) },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: Math.max(100, durationMs) },
        { type: "pointerUp", button: 0 },
      ]),
    ]);
  }

  /** Swipe / scroll / drag along points; `holdMs` before moving turns it into a drag. */
  async path({ points, durationMs, holdMs = 0, endHoldMs = 0 }: CommandArgs<"path">) {
    const [first, ...rest] = points;
    if (!first || rest.length === 0) throw new DeviceError("bad_args", "a path needs 2+ points");
    const segment = Math.max(10, Math.round(durationMs / rest.length));
    const actions: object[] = [
      { type: "pointerMove", duration: 0, x: r(first.x), y: r(first.y) },
      { type: "pointerDown", button: 0 },
    ];
    if (holdMs > 0) actions.push({ type: "pause", duration: holdMs });
    for (const p of rest)
      actions.push({ type: "pointerMove", duration: segment, x: r(p.x), y: r(p.y) });
    if (endHoldMs > 0) actions.push({ type: "pause", duration: endHoldMs });
    actions.push({ type: "pointerUp", button: 0 });
    await this.perform([finger("finger1", actions)]);
  }

  /** Two-finger pinch around (x, y): scale > 1 spreads the fingers (zoom in), < 1 closes them. */
  async pinch({ x, y, scale, durationMs, spread }: CommandArgs<"pinch">): Promise<void> {
    const outer = Math.max(20, spread);
    const inner = Math.max(10, outer / Math.max(1.05, scale >= 1 ? scale : 1 / scale));
    const [from, to] = scale >= 1 ? [inner, outer] : [outer, inner];
    // Diagonal fingers stay clear of the screen edges better than horizontal ones.
    const d = (dist: number, sign: number): Point => ({
      x: r(x + sign * dist * Math.SQRT1_2),
      y: r(y + sign * dist * Math.SQRT1_2),
    });
    const one = (sign: number, id: string) =>
      finger(id, [
        { type: "pointerMove", duration: 0, ...d(from, sign) },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 50 },
        { type: "pointerMove", duration: Math.max(100, durationMs), ...d(to, sign) },
        { type: "pause", duration: 50 },
        { type: "pointerUp", button: 0 },
      ]);
    await this.perform([one(-1, "finger1"), one(1, "finger2")]);
  }

  // ---- Text and keys ----------------------------------------------------------------------

  private async activeElementId(): Promise<string | null> {
    try {
      const active = (await this.driver.getActiveElement()) as unknown as Record<string, string>;
      return active?.[ELEMENT_KEY] ?? active?.ELEMENT ?? null;
    } catch {
      return null;
    }
  }

  async type({ text, mode }: CommandArgs<"type">): Promise<CommandResult<"type">> {
    const id = await this.activeElementId();
    if (!id) {
      throw new DeviceError(
        "no_focused_field",
        "No focused input: tap the text field first (or pass `element` to device_type).",
      );
    }
    if (this.platform === "android") {
      if (mode === "replace") {
        await this.driver.execute("mobile: replaceElementValue", { elementId: id, text });
      } else if (text) {
        await this.driver.execute("mobile: type", { text });
      }
    } else {
      if (mode === "replace") await this.driver.elementClear(id);
      // XCTest types through the on-screen keyboard and stops at characters it does not have
      // ("ş", emoji: only "A" of "Ayşe" arrived on a GitHub runner). Other text is pasted.
      if (text && PLAIN_TYPABLE.test(text)) await this.typeIos(id, text);
      else if (text) await this.pasteIos(id, text);
    }
    const value = await this.driver
      .getElementAttribute(id, this.platform === "ios" ? "value" : "text")
      .catch(() => null);
    return { focused: true, ...(typeof value === "string" ? { value } : {}) };
  }

  /**
   * iOS: XCTest types through the keyboard, and keys sent while it is still sliding in can get
   * lost (only "A" of "Ayse" arrived on a GitHub runner). When the field then holds exactly its
   * old value plus the start of the text, the missing rest is typed once more. Any other value
   * (masked or secure fields, formatters, length limits) is left alone, so nothing is typed twice.
   */
  private async typeIos(elementId: string, text: string) {
    const before = (await this.fieldValue(elementId)) ?? "";
    await this.driver.elementSendKeys(elementId, text);
    if (/[\n\t]/.test(text)) return; // a newline may have submitted or moved focus
    const after = (await this.fieldValue(elementId)) ?? "";
    if (after === before + text) return;
    for (let k = text.length - 1; k >= 0; k--) {
      if (after === before + text.slice(0, k)) {
        await this.driver.elementSendKeys(elementId, text.slice(k));
        return;
      }
    }
  }

  /**
   * iOS Simulator: put the text on the pasteboard and paste it with ⌘V, edit menu as fallback.
   * ⌘V can do nothing without an error (seen right after clearing a field on a GitHub runner), so
   * every attempt is checked on the field's value; a later attempt only runs when the field is
   * still unchanged, so the text is never pasted twice.
   */
  private async pasteIos(elementId: string, text: string) {
    const before = await this.fieldValue(elementId);
    await this.driver.execute("mobile: setPasteboard", { content: text, encoding: "utf8" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const sent = await this.driver
        .execute("mobile: keys", { elementId, keys: [{ key: "v", modifierFlags: 1 << 4 }] })
        .then(
          () => true,
          () => false, // no hardware-keyboard events: use the edit menu
        );
      if (!sent) break;
      if (await this.valueChanged(elementId, before)) return;
    }
    await this.driver.execute("mobile: touchAndHold", { elementId, duration: 1.0 });
    await sleep(600);
    const paste = await this.driver.$('-ios predicate string:label == "Paste"');
    if (await paste.isExisting()) {
      await paste.click();
      if (await this.valueChanged(elementId, before)) return;
    }
    throw new DeviceError(
      "type_failed",
      "The text did not arrive: pasting it (needed for characters the iOS keyboard lacks) left the field unchanged. Check the field and try again.",
    );
  }

  /** The field's value; through the focused element when the reference went stale. */
  private async fieldValue(elementId: string): Promise<string | null> {
    const read = (id: string) => this.driver.getElementAttribute(id, "value").catch(() => null);
    let v = await read(elementId);
    if (v === null) {
      const active = await this.activeElementId();
      if (active && active !== elementId) v = await read(active);
    }
    return typeof v === "string" ? v : null;
  }

  /** Waits briefly for the field's value to differ from `before` (a paste lands asynchronously). */
  private async valueChanged(elementId: string, before: string | null): Promise<boolean> {
    for (let i = 0; i < 4; i++) {
      if ((await this.fieldValue(elementId)) !== before) return true;
      await sleep(300);
    }
    return false;
  }

  async key({ key, times = 1 }: CommandArgs<"key">): Promise<void> {
    const n = Math.max(1, Math.min(times, 50));
    for (let i = 0; i < n; i++) {
      if (this.platform === "android") await this.androidKey(key);
      else await this.iosKey(key);
    }
  }

  private async androidKey(key: KeyName) {
    const code = ANDROID_KEYCODES[key];
    if (code === undefined) throw new DeviceError("unsupported", `key ${key} is not supported`);
    if (Array.isArray(code)) await this.driver.pressKeyCode(code[0], code[1]);
    else await this.driver.pressKeyCode(code);
  }

  private async iosKey(key: KeyName) {
    const typed: Partial<Record<KeyName, string>> = {
      enter: "\n",
      backspace: "\b",
      tab: "\t",
      space: " ",
      escape: "\u001b",
    };
    const char = typed[key];
    if (char !== undefined) {
      await this.driver.keys([char]);
      return;
    }
    if (key === "home") {
      await this.driver.execute("mobile: pressButton", { name: "home" });
    } else if (key === "volume_up" || key === "volume_down") {
      await this.driver.execute("mobile: pressButton", {
        name: key === "volume_up" ? "volumeUp" : "volumeDown",
      });
    } else if (key === "power") {
      await this.driver.execute("mobile: lock", { seconds: 0 });
    } else if (key === "back") {
      // iOS has no back key: the interactive pop gesture from the left edge is the closest.
      const { width, height } = await this.windowSize();
      await this.path({
        points: [
          { x: 2, y: height * 0.5 },
          { x: width * 0.75, y: height * 0.5 },
        ],
        durationMs: 300,
      });
    } else {
      throw new DeviceError("unsupported", `key ${key} is not available on iOS`);
    }
  }

  async keyboardShown(): Promise<boolean> {
    try {
      return Boolean(await this.driver.isKeyboardShown());
    } catch {
      return false;
    }
  }

  /** Closes the keyboard; on iOS the keyboard's return-type keys are tried after the driver's own attempt. */
  /**
   * Closes the keyboard and returns whether it is still shown. iOS has no generic dismiss: the
   * driver's attempt, then the keyboard's own done/return keys, then the Return key (single-line
   * fields resign focus on submit). Nothing outside the keyboard is tapped.
   */
  /**
   * Hides the keyboard and returns whether it is still shown. iOS has no general way: a done/go
   * key of the keyboard is tapped, else Return is pressed, but only in a single-line field (in a
   * multi-line one it would add a line break to the user's text; such a keyboard stays and the
   * caller says so). The driver's own hideKeyboard is skipped on iOS: on an iPhone it only fails
   * ("Did not know how to dismiss the keyboard") after several seconds.
   */
  async hideKeyboard(): Promise<boolean> {
    if (this.platform !== "ios") {
      await this.driver.hideKeyboard();
      await sleep(250);
      return this.keyboardShown();
    }
    if (!(await this.keyboardShown())) return false;
    await this.driver
      .execute("mobile: hideKeyboard", {
        keys: ["done", "Done", "return", "Return", "go", "Go", "search", "Search"],
      })
      .catch(() => undefined);
    await sleep(250);
    if (!(await this.keyboardShown())) return false;
    const id = await this.activeElementId();
    const type = id ? await this.driver.getElementAttribute(id, "type").catch(() => null) : null;
    if (type === "XCUIElementTypeTextField" || type === "XCUIElementTypeSecureTextField") {
      await this.driver.keys(["\n"]).catch(() => undefined);
      await sleep(250);
    }
    return this.keyboardShown();
  }

  // ---- App lifecycle -----------------------------------------------------------------------

  async appState(): Promise<number> {
    return Number(await this.driver.queryAppState(this.appId));
  }

  async app(args: CommandArgs<"app">): Promise<CommandResult<"app">> {
    const id = this.appId;
    switch (args.action) {
      case "launch":
        await this.launch();
        break;
      case "terminate":
        await this.driver.terminateApp(id).catch(() => undefined);
        break;
      case "restart":
        await this.driver.terminateApp(id).catch(() => undefined);
        if (args.clearData) await this.clearData();
        await this.launch();
        break;
      case "clear_data":
        await this.driver.terminateApp(id).catch(() => undefined);
        await this.clearData();
        break;
      case "background":
        await this.driver.execute("mobile: backgroundApp", { seconds: args.seconds ?? 3 });
        break;
      case "open_url": {
        if (!args.url) throw new DeviceError("bad_args", "open_url needs a url");
        await this.driver.execute(
          "mobile: deepLink",
          this.platform === "android"
            ? { url: args.url, package: id, waitForLaunch: false }
            : { url: args.url, bundleId: id },
        );
        break;
      }
      case "state":
        break;
    }
    if (args.action === "launch" || args.action === "restart") await sleep(600);
    const state = await this.appState();
    const pid = this.platform === "android" ? await pidOf(id) : undefined;
    return { state, stateName: APP_STATE_NAMES[state] ?? String(state), ...(pid ? { pid } : {}) };
  }

  private async clearData() {
    if (this.platform === "android") {
      await this.driver.execute("mobile: clearApp", { appId: this.appId });
      return;
    }
    // iOS has no data reset for one app: reinstall it from the build.
    await this.driver.execute("mobile: removeApp", { bundleId: this.appId });
    await this.driver.execute("mobile: installApp", { app: this.options.appPath });
  }

  /** Android API level / iOS version string from the capabilities. */
  osVersion(): string {
    const caps = this.capabilities;
    return String(caps.platformVersion ?? caps["appium:platformVersion"] ?? "unknown");
  }

  async androidDeviceName(): Promise<string> {
    try {
      const model = (await adb(["shell", "getprop", "ro.product.model"], 10_000)).trim();
      return model || "Android emulator";
    } catch {
      return String(this.capabilities.deviceName ?? "Android emulator");
    }
  }
}
