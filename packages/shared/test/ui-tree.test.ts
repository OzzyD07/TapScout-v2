import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { iosDriverAlert, jpegSize, normalizeTree, parseXml, pngSize } from "../src/index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), "utf8");

describe("parseXml", () => {
  it("reads attributes, entities and self-closing tags", () => {
    const root = parseXml(
      `<?xml version="1.0"?><a x="1 &amp; 2" y='&#x41;'><b/><c t="&lt;ok&gt;"></c></a>`,
    );
    const a = root.children[0];
    expect(a?.attrs).toEqual({ x: "1 & 2", y: "A" });
    expect(a?.children.map((c) => c.tag)).toEqual(["b", "c"]);
    expect(a?.children[1]?.attrs.t).toBe("<ok>");
  });
});

describe("normalizeTree", () => {
  it("normalises the Android registration form", () => {
    const s = normalizeTree("android", fixture("android-register"), { scale: 1 });
    expect(s.topPackage).toBe("dev.tapscout.fieldnotes");
    expect(s.dialog).toBeNull();
    const name = s.elements.find((e) => e.stableId === "register-name");
    expect(name).toMatchObject({ role: "text_field", masked: false });
    expect(name?.bounds).toEqual({ x: 53, y: 636, width: 975, height: 126 });
    const cont = s.elements.find((e) => e.stableId === "register-continue");
    expect(cont).toMatchObject({ role: "button", label: "Continue" });
    // The caption text inside the button is not listed separately.
    expect(s.elements.filter((e) => (e.text ?? e.label) === "Continue")).toHaveLength(1);
    expect(s.elements.map((e) => e.ref)).toEqual(s.elements.map((_, i) => `e${i + 1}`));
  });

  it("normalises the same iOS screen into the same vocabulary, in screenshot pixels", () => {
    const s = normalizeTree("ios", fixture("ios-register"), { scale: 3 });
    expect(s.topPackage).toBe("dev.tapscout.fieldnotes");
    expect(s.title).toBe("Create profile");
    const name = s.elements.find((e) => e.stableId === "register-name");
    expect(name).toMatchObject({ role: "text_field", label: "Name" });
    expect(name?.bounds).toEqual({ x: 63, y: 735, width: 1080, height: 141 });
    expect(s.elements.some((e) => /scroll bar/i.test(e.label ?? ""))).toBe(false);
  });

  it("reports an ANR dialog with all of its buttons", () => {
    const s = normalizeTree("android", fixture("android-anr"), { scale: 1 });
    expect(s.dialog?.kind).toBe("anr");
    expect(s.dialog?.title).toBe("Pixel Launcher isn't responding");
    expect(s.dialog?.buttons.map((b) => b.label)).toEqual(
      expect.arrayContaining(["Wait", "Close app"]),
    );
  });

  it("reports an Android permission request with its buttons", () => {
    const s = normalizeTree("android", fixture("android-permission"), { scale: 1 });
    expect(s.dialog).toMatchObject({
      kind: "permission",
      title: "Allow Read You to send you notifications?",
    });
    expect(s.dialog?.buttons.map((b) => b.label)).toContain("Allow");
    expect(s.dialog?.buttons.every((b) => b.bounds)).toBe(true);
  });

  it("tells iOS system permission alerts from the app's own alerts", () => {
    const s = normalizeTree("ios", fixture("ios-permission"), { scale: 3 });
    expect(s.dialog?.kind).toBe("permission");
    const allow = s.dialog?.buttons.find((b) => b.label === "Allow");
    expect(allow?.bounds).toEqual({ x: 603, y: 1497, width: 405, height: 132 });
    const own = fixture("ios-permission").replaceAll(
      "“Habo” Would Like to Send You Notifications",
      "Delete this habit?",
    );
    expect(normalizeTree("ios", own, { scale: 3 }).dialog?.kind).toBe("alert");
  });

  it("reads SpringBoard alerts reported by the driver", () => {
    expect(
      iosDriverAlert("“Ice Cubes” Would Like to Send You Notifications\nMay include alerts.", [
        "Don’t Allow",
        "Allow",
      ]),
    ).toMatchObject({
      kind: "permission",
      message: "May include alerts.",
      buttons: [{ label: "Don’t Allow" }, { label: "Allow" }],
      viaDriver: true,
    });
    expect(iosDriverAlert("Sign in to Apple Account", ["Cancel", "OK"])?.kind).toBe("sign_in");
  });

  it("recognises iOS system screens hosted in the app", () => {
    expect(normalizeTree("ios", fixture("ios-share-sheet"), { scale: 3 }).systemUi).toBe(
      "share_sheet",
    );
    expect(normalizeTree("ios", fixture("ios-quick-look"), { scale: 3 }).systemUi).toBe(
      "quick_look",
    );
    expect(normalizeTree("ios", fixture("ios-welcome"), { scale: 3 }).systemUi).toBeNull();
  });

  it("names a Flutter screen by the content description in the app bar", () => {
    const xml = `<hierarchy width="1080" height="2400">
      <android.view.View class="android.view.View" package="com.pavlenko.Habo" text="" content-desc="Statistics" clickable="false" enabled="true" bounds="[189,140][620,250]" displayed="true"/>
      <android.widget.Button class="android.widget.Button" package="com.pavlenko.Habo" text="" content-desc="Back" clickable="true" enabled="true" bounds="[21,140][147,266]" displayed="true"/>
    </hierarchy>`;
    expect(normalizeTree("android", xml, { scale: 1 }).title).toBe("Statistics");
  });

  it("tells a busy spinner from a progress bar", () => {
    const page = (bounds: string) => `<hierarchy width="1080" height="2400">
      <android.widget.ProgressBar class="android.widget.ProgressBar" package="p" text="" enabled="true" bounds="${bounds}" displayed="true"/>
      <android.widget.TextView class="android.widget.TextView" package="p" text="Episodes" enabled="true" bounds="[42,160][400,230]" displayed="true"/>
    </hierarchy>`;
    expect(normalizeTree("android", page("[480,1100][600,1220]"), { scale: 1 }).loading).toBe(true);
    expect(normalizeTree("android", page("[40,900][1040,912]"), { scale: 1 }).loading).toBe(false);
  });

  it("never reports the value of a secret field", () => {
    const xml = `<hierarchy width="1080" height="2400">
      <android.widget.EditText class="android.widget.EditText" package="p" text="••••" content-desc="Password" password="true" enabled="true" clickable="true" bounds="[0,100][500,200]" displayed="true"/>
    </hierarchy>`;
    const s = normalizeTree("android", xml, { scale: 1 });
    expect(s.elements[0]).toMatchObject({ masked: true });
    expect(s.elements[0]?.text).toBeUndefined();
  });

  it("keeps interactive elements first when the screen has too many", () => {
    const rows = Array.from(
      { length: 30 },
      (_, i) =>
        `<android.widget.TextView class="android.widget.TextView" package="p" text="Row ${i}" bounds="[0,${i * 10}][100,${i * 10 + 9}]" displayed="true"/>`,
    ).join("");
    const xml = `<hierarchy width="1080" height="2400">${rows}<android.widget.Button class="android.widget.Button" package="p" text="Save" clickable="true" enabled="true" bounds="[0,2000][500,2100]" displayed="true"/></hierarchy>`;
    const s = normalizeTree("android", xml, { scale: 1, maxElements: 10 });
    expect(s.omitted).toBe(21);
    expect(s.elements).toHaveLength(10);
    expect(s.elements.some((e) => e.text === "Save")).toBe(true);
  });

  it("marks iOS controls under the keyboard as covered and hides the keys", () => {
    const s = normalizeTree("ios", fixture("ios-register-keyboard"), { scale: 3 });
    expect(s.keyboardVisible).toBe(true);
    const cont = s.elements.find((e) => e.stableId === "register-continue");
    expect(cont).toMatchObject({ role: "button", label: "Continue", covered: true });
    expect(s.elements.find((e) => e.stableId === "register-name")?.covered).toBeUndefined();
    expect(s.elements.some((e) => e.platformClass === "Key")).toBe(false);
  });
});

describe("image sizes", () => {
  it("reads PNG IHDR dimensions", () => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47], 0);
    new DataView(b.buffer).setUint32(16, 1206);
    new DataView(b.buffer).setUint32(20, 2622);
    expect(pngSize(b)).toEqual({ width: 1206, height: 2622 });
    expect(pngSize(new Uint8Array(4))).toBeNull();
  });

  it("reads JPEG SOF dimensions", () => {
    // SOI, APP0 (length 4), SOF0 with height 0x0500 (1280) and width 0x0240 (576).
    const b = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x00,
      0x02, 0x40, 0x03,
    ]);
    expect(jpegSize(b)).toEqual({ width: 576, height: 1280 });
  });
});
