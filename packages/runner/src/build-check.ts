// Uploaded builds that do not fit the device are an input problem with a clear explanation,
// never an infrastructure failure (kept from TapScout v1).

const ANDROID_CODES: Record<string, string> = {
  INSTALL_FAILED_NO_MATCHING_ABIS:
    "The APK has no native code the emulator can run: it runs x86_64 and, through ARM translation, arm64-v8a, but not 32-bit-only (armeabi-v7a) builds. Include arm64-v8a or x86_64 (or build a universal APK).",
  INSTALL_FAILED_OLDER_SDK: "The APK requires a newer Android version than the emulator.",
  INSTALL_FAILED_INVALID_APK: "Android rejected the APK as invalid.",
  INSTALL_FAILED_UPDATE_INCOMPATIBLE:
    "Android refused the APK because of a signature conflict with an installed app (uninstall it first).",
};

/** Explanation when an install error means the build itself cannot run here; null otherwise. */
export function installRejection(platform: "android" | "ios", message: string): string | null {
  const code = /\b(INSTALL_(?:FAILED|PARSE_FAILED)_[A-Z_]+)\b/.exec(message)?.[1];
  if (code) {
    if (code.startsWith("INSTALL_PARSE_FAILED")) {
      return `The file could not be read as an Android app (${code}).`;
    }
    return ANDROID_CODES[code] ?? `Android refused to install the APK (${code}).`;
  }
  if (
    platform === "ios" &&
    /bad cpu type|incompatible (?:architecture|platform)|not built for (?:the )?simulator|built for iOS(?! Simulator)|unable to install/i.test(
      message,
    )
  ) {
    return "The iOS Simulator could not install the app. Upload a build made for the iOS Simulator (xcodebuild -sdk iphonesimulator).";
  }
  return null;
}

/** Reads CFBundleSupportedPlatforms from an app's Info.plist (as JSON). */
export function simulatorPlatformProblem(infoPlist: unknown): string | null {
  const platforms = (infoPlist as { CFBundleSupportedPlatforms?: unknown } | null)
    ?.CFBundleSupportedPlatforms;
  if (!Array.isArray(platforms) || platforms.length === 0) return null;
  if (platforms.includes("iPhoneSimulator")) return null;
  return `This is a device build (${platforms.join(", ")}); an iOS Simulator build is needed (xcodebuild -sdk iphonesimulator).`;
}
