import type { Platform } from "@tapscout/shared";

export interface SessionOptions {
  platform: Platform;
  /** Path to the APK, or to the unpacked iOS Simulator `.app`. */
  appPath: string;
  /** iOS Simulator UDID or Android emulator serial. */
  udid?: string;
  /** iOS only: prebuilt WebDriverAgentRunner-Runner.app, so no xcodebuild runs at session start. */
  prebuiltWdaPath?: string;
  /** Keep the installed app and its data (Appium noReset), e.g. for a replacement session. */
  keepAppData?: boolean;
  /** iOS: port of WDA's MJPEG screen stream on the runner machine. */
  mjpegPort?: number;
}

/**
 * Appium capabilities. Alerts and permissions are never accepted automatically: the agent sees
 * them and decides. The command timeout is long because the agent may think between commands; the
 * hub's idle timeout ends forgotten sessions first.
 */
export function buildCapabilities(options: SessionOptions): Record<string, unknown> {
  const common = {
    "appium:app": options.appPath,
    "appium:newCommandTimeout": 1800,
    "appium:noReset": options.keepAppData ?? false,
    ...(options.udid ? { "appium:udid": options.udid } : {}),
  };

  if (options.platform === "android") {
    return {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:autoGrantPermissions": false,
      "appium:uiautomator2ServerInstallTimeout": 120_000,
      "appium:uiautomator2ServerLaunchTimeout": 120_000,
      "appium:adbExecTimeout": 120_000,
      "appium:androidInstallTimeout": 180_000,
      // Appium installs the app but does not start it: its launch waits for one activity and real
      // apps often finish a splash activity at once or redirect (TapScout v1 benchmark runs). The
      // runner starts the app itself without waiting.
      "appium:autoLaunch": false,
      ...common,
    };
  }

  return {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:autoAcceptAlerts": false,
    "appium:autoDismissAlerts": false,
    ...(options.prebuiltWdaPath
      ? { "appium:usePreinstalledWDA": true, "appium:prebuiltWDAPath": options.prebuiltWdaPath }
      : {}),
    // The CI simulator is booted headless; without this the driver restarts it with a window.
    "appium:isHeadless": process.env.CI === "true",
    // Typed text must arrive unchanged; the suggestion bar also slows typing down.
    "appium:keyboardAutocorrection": false,
    "appium:keyboardPrediction": false,
    // Animated screens would otherwise hold every action for up to 10 s.
    "appium:waitForIdleTimeout": 3,
    "appium:mjpegServerPort": options.mjpegPort ?? 9100,
    // A replacement session must not relaunch the app (XCUIApplication.launch restarts it and
    // the screen the agent was on would be lost); open() activates it instead.
    ...(options.keepAppData ? { "appium:autoLaunch": false } : {}),
    "appium:wdaLaunchTimeout": 600_000,
    "appium:wdaConnectionTimeout": 600_000,
    "appium:simulatorStartupTimeout": 300_000,
    ...common,
  };
}
