import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { usableFastSource } from "../src/index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), "utf8").replaceAll(
    / visible="\w+"/g,
    "",
  );

const app = (...windows: string[]) =>
  `<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="App">${windows
    .map(
      (w) =>
        `<XCUIElementTypeWindow type="XCUIElementTypeWindow" x="0" y="0">${w}</XCUIElementTypeWindow>`,
    )
    .join("")}</XCUIElementTypeApplication></AppiumAUT>`;
const el = (type: string, name: string, children = "") =>
  children
    ? `<XCUIElementType${type} type="XCUIElementType${type}" name="${name}">${children}</XCUIElementType${type}>`
    : `<XCUIElementType${type} type="XCUIElementType${type}" name="${name}"/>`;

describe("usableFastSource", () => {
  it("keeps the fast source for a plain app screen", () => {
    const welcome = fixture("ios-welcome");
    expect(usableFastSource(welcome)).toBe(welcome);
    expect(usableFastSource(fixture("ios-register"))).not.toBeNull();
    // Empty extra windows (status bar, keyboard host while closed) do not count, and iOS 26 keeps
    // a dimming overlay on plain screens.
    const plain = app(
      el("Button", "Save") + el("Image", "AdditionalDimmingOverlay"),
      `<XCUIElementTypeOther type="XCUIElementTypeOther"/>`,
    );
    expect(usableFastSource(plain)).toBe(plain);
  });

  it("asks for the full source where only visible tells what is covered", () => {
    expect(usableFastSource(fixture("ios-register-keyboard"))).toBeNull();
    expect(usableFastSource(fixture("ios-permission"))).toBeNull();
    expect(usableFastSource(fixture("ios-share-sheet"))).toBeNull();
    // Content in a second window.
    expect(usableFastSource(app(el("Button", "Save"), el("Button", "Done")))).toBeNull();
  });

  it("marks the screen behind a presented one as not visible (Ice Cubes Add Account)", () => {
    const behind = el(
      "Other",
      "timeline",
      el("NavigationBar", "_TtGC7SwiftUI29PresentationHosting", el("Button", "Add Account")) +
        el("Cell", "Post by someone"),
    );
    const front = el(
      "Other",
      "sheet",
      el("NavigationBar", "Add Account", el("Button", "Cancel")) + el("TextField", "Instance URL"),
    );
    const out = usableFastSource(app(el("Other", "root", behind + front)));
    expect(out).not.toBeNull();
    const hidden = [...(out ?? "").matchAll(/name="([^"]+)" visible="false"/g)].map((m) => m[1]);
    expect(hidden).toEqual([
      "timeline",
      "_TtGC7SwiftUI29PresentationHosting",
      "Add Account",
      "Post by someone",
    ]);
    expect(out).toContain(`name="Cancel"/>`);
    expect(out).toContain(`name="Instance URL"/>`);
  });

  it("falls back to the full source when the screens are not told apart plainly", () => {
    // Both bars inside one screen: no subtree holds only the earlier one.
    const nested = app(el("Other", "screen", el("NavigationBar", "A", el("NavigationBar", "B"))));
    expect(usableFastSource(nested)).toBeNull();
  });
});
