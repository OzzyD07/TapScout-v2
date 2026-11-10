// UI tree normalisation: an Appium page source (UiAutomator2 or XCUITest XML) becomes one element
// list with the same vocabulary on both platforms, in screenshot pixels. Pure; never touches a
// device. Adapted from TapScout v1's observer (its heuristics were tuned on real apps: React Native,
// Flutter, Compose, SwiftUI); the planner-specific parts were removed.

import type { Platform, Rect } from "./protocol.js";

export type ElementRole =
  | "button"
  | "text"
  | "text_field"
  | "image"
  | "switch"
  | "checkbox"
  | "link"
  | "tab"
  | "list"
  | "cell"
  | "scroll_view"
  | "dialog"
  | "keyboard"
  | "web_view"
  | "other";

export interface UiElement {
  /** "e1", "e2"… valid only for the tree it came from. */
  ref: string;
  role: ElementRole;
  platformClass: string;
  label?: string;
  text?: string;
  /** Placeholder / hint text of a field. */
  hint?: string;
  /** Android resource-id (without package) or iOS accessibility identifier. */
  stableId?: string;
  /** Screenshot pixels. */
  bounds: Rect;
  enabled: boolean;
  focused: boolean;
  clickable: boolean;
  longClickable?: boolean;
  scrollable?: boolean;
  checked?: boolean;
  selected?: boolean;
  /** A password-like field: its value is never reported. */
  masked: boolean;
  /** Covered by the software keyboard: a tap would hit the keyboard. */
  covered?: boolean;
}

export interface SystemDialog {
  kind: "anr" | "crash" | "permission" | "sign_in" | "alert";
  title: string;
  message?: string;
  buttons: { label: string; bounds?: Rect }[];
  /** iOS SpringBoard alert: not in the app's tree; answered by label through the driver. */
  viaDriver?: boolean;
}

export interface UiTree {
  platform: Platform;
  /** Screen size in screenshot pixels from the hierarchy root (0 when unknown). */
  widthPx: number;
  heightPx: number;
  /** Package that owns most nodes (Android) or the app's bundle id (iOS). */
  topPackage?: string;
  /** Screen title guess: navigation bar / app bar title or the first heading. */
  title?: string;
  keyboardVisible: boolean;
  dialog: SystemDialog | null;
  /** A spinner or "Loading…" text is on screen. */
  loading: boolean;
  /** iOS system screens hosted in the app (share sheet, Quick Look). */
  systemUi: "share_sheet" | "quick_look" | null;
  elements: UiElement[];
  /** Elements dropped because of `maxElements`. */
  omitted: number;
}

export interface NormalizeOptions {
  /** Screenshot pixels per hierarchy unit: 1 on Android (px), the display scale on iOS (pt). */
  scale: number;
  maxElements?: number;
  /** Keep unnamed containers and caption duplicates too (debugging view). */
  includeAll?: boolean;
}

// ---- XML ----------------------------------------------------------------------------------

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Minimal XML reader for Appium page sources (elements and attributes only). */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: "#document", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const tags =
    /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"'/]|"[^"]*"|'[^']*'|\/(?!>))*)(\/?)>/g;
  const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of xml.matchAll(tags)) {
    const [, closing, tag, rawAttrs, selfClosing] = match;
    if (!tag) continue;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? "").matchAll(attrRe)) {
      if (a[1]) attrs[a[1]] = decode(a[2] ?? a[3] ?? "");
    }
    const node: XmlNode = { tag, attrs, children: [] };
    stack[stack.length - 1]?.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function* walk(node: XmlNode): Generator<XmlNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

// ---- Shared helpers -----------------------------------------------------------------------

const INTERACTIVE: ReadonlySet<ElementRole> = new Set([
  "button",
  "text_field",
  "switch",
  "checkbox",
  "link",
  "tab",
  "cell",
]);

const SECRET_HINT = /pass(word|code)?|\bpin\b|otp|secret|cvv|cvc|card.?number|iban/i;

interface Candidate extends Omit<UiElement, "ref"> {
  order: number;
  /** iOS reported the node as not visible (e.g. occluded by the keyboard). */
  osHidden?: boolean;
}

function clip(text: string | undefined, max = 300): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function onScreen(b: Rect, width: number, height: number): boolean {
  return (
    b.width > 1 &&
    b.height > 1 &&
    b.x < width &&
    b.y < height &&
    b.x + b.width > 0 &&
    b.y + b.height > 0
  );
}

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

// ---- Android ------------------------------------------------------------------------------

/** Content descriptions of navigation icons; never a screen's title. */
const NAV_LABEL =
  /^(back|close|navigate up|menu|more options|search|cancel|open navigation drawer|done|share)$/i;
const PERMISSION_PACKAGE = /^com\.(google\.)?android\.permissioncontroller$/;

function androidRole(cls: string, clickable: boolean, checkable: boolean): ElementRole {
  const name = cls.slice(cls.lastIndexOf(".") + 1);
  if (/EditText|AutoCompleteTextView/.test(name)) return "text_field";
  if (/Switch|ToggleButton/.test(name)) return "switch";
  if (/CheckBox|RadioButton|CheckedTextView/.test(name)) return "checkbox";
  if (/Button/.test(name)) return "button";
  if (/WebView/.test(name)) return "web_view";
  if (/RecyclerView|ListView|GridView/.test(name)) return "list";
  if (/ScrollView|ViewPager/.test(name)) return "scroll_view";
  if (checkable) return "checkbox";
  if (clickable) return "button";
  if (/TextView/.test(name)) return "text";
  if (/Image/.test(name)) return "image";
  return "other";
}

function parseAndroidBounds(value: string | undefined): Rect | null {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value ?? "");
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number];
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

const shortId = (id: string) => id.replace(/^[\w.]+:id\//, "");

function androidDialog(hierarchy: XmlNode): SystemDialog | null {
  let alertTitle = "";
  let message = "";
  let anr = false;
  let crash = false;
  let permission = false;
  const buttons: { label: string; bounds?: Rect }[] = [];
  for (const node of walk(hierarchy)) {
    const a = node.attrs;
    const id = a["resource-id"] ?? "";
    const bounds = parseAndroidBounds(a.bounds) ?? undefined;
    if (id === "android:id/alertTitle") alertTitle = a.text ?? "";
    if (id === "android:id/message" && a.text) message = a.text;
    if (id === "android:id/aerr_wait") anr = true;
    if (id === "android:id/aerr_close") crash = true;
    if (PERMISSION_PACKAGE.test(a.package ?? "")) {
      const sid = shortId(id);
      if (sid === "permission_message" && a.text) message = a.text;
      if (/^permission_.*button$/.test(sid)) permission = true;
    }
    const isDialogButton =
      /^android:id\/(button[123]|aerr_\w+)$/.test(id) ||
      (PERMISSION_PACKAGE.test(a.package ?? "") && /button$/.test(shortId(id)));
    if (isDialogButton && a.displayed !== "false") {
      buttons.push({ label: a.text || a["content-desc"] || shortId(id), bounds });
    }
  }
  if (anr || crash) {
    return {
      kind: anr ? "anr" : "crash",
      title: alertTitle,
      ...(message ? { message } : {}),
      buttons,
    };
  }
  if (permission) {
    return { kind: "permission", title: message || "Permission request", buttons };
  }
  if (alertTitle || (message && buttons.length > 0)) {
    return {
      kind: "alert",
      title: alertTitle || message,
      ...(message ? { message } : {}),
      buttons,
    };
  }
  return null;
}

function androidCandidates(root: XmlNode) {
  const hierarchy = root.children.find((n) => n.tag === "hierarchy") ?? root;
  const widthPx = Number(hierarchy.attrs.width) || 0;
  const heightPx = Number(hierarchy.attrs.height) || 0;
  const packages = new Map<string, number>();
  const candidates: Candidate[] = [];
  let title: string | undefined;
  let heading: string | undefined;
  let order = 0;

  for (const node of walk(hierarchy)) {
    const a = node.attrs;
    if (!a.class) continue;
    if (a.package) packages.set(a.package, (packages.get(a.package) ?? 0) + 1);
    const bounds = parseAndroidBounds(a.bounds);
    if (!bounds || a.displayed === "false") continue;
    const clickable = a.clickable === "true";
    const checkable = a.checkable === "true";
    const role = androidRole(a.class, clickable, checkable);
    const text = clip(a.text);
    const label = clip(a["content-desc"]);
    const hint = clip(a.hint);
    const id = a["resource-id"] ?? "";
    const stableId = id ? shortId(id) : undefined;
    // The app bar title (a plain text in the top band) names the screen; Flutter exposes its
    // texts as content descriptions, so a plain labelled view in the band names it as well.
    const plain = role === "text" || role === "other";
    const named = text ?? (plain && label && !NAV_LABEL.test(label) ? label : undefined);
    if (!title && named && !clickable && plain && heightPx > 0) {
      if (bounds.y + bounds.height <= heightPx * 0.13) title = named;
    }
    if (!heading && a.heading === "true" && text) heading = text;
    candidates.push({
      order: order++,
      role,
      platformClass: a.class,
      label: label ?? (role === "text_field" ? undefined : hint),
      text,
      hint: role === "text_field" ? hint : undefined,
      stableId: stableId || undefined,
      bounds,
      enabled: a.enabled !== "false",
      focused: a.focused === "true",
      clickable,
      longClickable: a["long-clickable"] === "true" || undefined,
      scrollable: a.scrollable === "true" || undefined,
      checked: checkable ? a.checked === "true" : undefined,
      selected: a.selected === "true" || undefined,
      masked: a.password === "true",
    });
  }
  title ??= heading;
  const topPackage = [...packages.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  return {
    candidates,
    widthPx,
    heightPx,
    topPackage,
    title,
    dialog: androidDialog(hierarchy),
    systemUi: null,
    keyboardVisible: false,
  };
}

// ---- iOS ----------------------------------------------------------------------------------

/** Title of an iOS system permission alert (an app's own alerts are app behaviour). */
const IOS_PERMISSION_TITLE =
  /would like to (send you notifications|access|use|find and connect|add to)|wants to use|track your activity|would like to/i;
const IOS_SIGN_IN = /\bsign in\b/i;
/** SwiftUI/UIKit internal navigation bar names; never a screen title. */
const IOS_INTERNAL_NAME = /^_Tt|HostingController|PresentationHosting/;
const SHARE_SHEET = /^(ShareSheet\.|shareSheet\.|UIActivityContentView$|ActivityListView$)/;
const QUICK_LOOK = /^QL(PreviewControllerView|Markup|Overlay)/;

function iosRole(type: string): ElementRole {
  const name = type.replace("XCUIElementType", "");
  const map: Record<string, ElementRole> = {
    Button: "button",
    StaticText: "text",
    TextField: "text_field",
    SecureTextField: "text_field",
    SearchField: "text_field",
    TextView: "text_field",
    Image: "image",
    Icon: "image",
    Switch: "switch",
    Toggle: "switch",
    Link: "link",
    Tab: "tab",
    Cell: "cell",
    Table: "list",
    CollectionView: "list",
    ScrollView: "scroll_view",
    Alert: "dialog",
    Sheet: "dialog",
    Keyboard: "keyboard",
    WebView: "web_view",
  };
  return map[name] ?? "other";
}

function iosKind(title: string): SystemDialog["kind"] {
  if (IOS_SIGN_IN.test(title)) return "sign_in";
  if (IOS_PERMISSION_TITLE.test(title)) return "permission";
  return "alert";
}

function iosDialog(root: XmlNode, scale: number): SystemDialog | null {
  for (const alert of walk(root)) {
    if ((alert.attrs.type ?? alert.tag) !== "XCUIElementTypeAlert") continue;
    const title = clip(alert.attrs.label ?? alert.attrs.name) ?? "";
    const buttons = [...walk(alert)]
      .filter(
        (n) => (n.attrs.type ?? n.tag) === "XCUIElementTypeButton" && n.attrs.visible !== "false",
      )
      .map((n) => {
        const bounds = {
          x: Math.round(Number(n.attrs.x) * scale),
          y: Math.round(Number(n.attrs.y) * scale),
          width: Math.round(Number(n.attrs.width) * scale),
          height: Math.round(Number(n.attrs.height) * scale),
        };
        const ok = Number.isFinite(bounds.x + bounds.y + bounds.width + bounds.height);
        return {
          label: (n.attrs.label ?? n.attrs.name ?? "").trim(),
          ...(ok ? { bounds } : {}),
        };
      });
    return { kind: iosKind(title), title, buttons };
  }
  return null;
}

/**
 * A SpringBoard alert read through the driver (WDA's alert endpoint): on iOS 26 notification
 * requests are not in the app's page source.
 */
export function iosDriverAlert(text: string, buttons: string[]): SystemDialog | null {
  const lines = text.trim().split("\n");
  const title = lines[0]?.trim() ?? "";
  if (!title && buttons.length === 0) return null;
  const message = lines.slice(1).join(" ").trim();
  return {
    kind: iosKind(title),
    title: clip(title) ?? "Alert",
    ...(message ? { message: clip(message) } : {}),
    buttons: buttons.map((label) => ({ label: label.trim() })),
    viaDriver: true,
  };
}

function iosCandidates(root: XmlNode, scale: number) {
  const app = [...walk(root)].find((n) => n.tag === "XCUIElementTypeApplication");
  const widthPx = Math.round(Number(app?.attrs.width ?? 0) * scale);
  const heightPx = Math.round(Number(app?.attrs.height ?? 0) * scale);
  const candidates: Candidate[] = [];
  let keyboardVisible = false;
  let title: string | undefined;
  let order = 0;

  const insideKeyboard = new Set<XmlNode>();
  let keyboardTop: number | null = null;
  for (const node of app ? walk(app) : []) {
    if ((node.attrs.type ?? node.tag) === "XCUIElementTypeKeyboard") {
      const y = Number(node.attrs.y) * scale;
      if (node.attrs.visible !== "false" && Number.isFinite(y) && y > 0) {
        keyboardTop = keyboardTop === null ? y : Math.min(keyboardTop, y);
      }
      for (const child of walk(node)) if (child !== node) insideKeyboard.add(child);
    }
  }
  for (const node of app ? walk(app) : []) {
    const a = node.attrs;
    const type = a.type ?? node.tag;
    if (!type.startsWith("XCUIElementType") || type === "XCUIElementTypeApplication") continue;
    const role = iosRole(type);
    if (role === "keyboard") keyboardVisible = true;
    // Keys of the software keyboard are not app UI.
    if (insideKeyboard.has(node)) continue;
    if (
      type === "XCUIElementTypeNavigationBar" &&
      a.name &&
      a.visible !== "false" &&
      !IOS_INTERNAL_NAME.test(a.name)
    ) {
      title ??= clip(a.name);
    }
    const osHidden = a.visible === "false";
    const bounds: Rect = {
      x: Math.round(Number(a.x) * scale),
      y: Math.round(Number(a.y) * scale),
      width: Math.round(Number(a.width) * scale),
      height: Math.round(Number(a.height) * scale),
    };
    if (!Number.isFinite(bounds.x + bounds.y + bounds.width + bounds.height)) continue;
    const label = clip(a.label);
    const value = clip(a.value);
    const name = a.name;
    // React Native puts testID into `name`; when it only repeats the label it is not an id.
    const stableId = name && name !== a.label && name !== a.value ? name : undefined;
    const secure = type === "XCUIElementTypeSecureTextField";
    if (!title && !osHidden && /Header/.test(a.traits ?? "") && label) title = label;
    const isField = role === "text_field";
    candidates.push({
      order: order++,
      role,
      platformClass: type.replace("XCUIElementType", ""),
      label,
      text: role === "text" ? (value ?? label) : value,
      hint: isField ? clip(a.placeholderValue) : undefined,
      stableId,
      bounds,
      enabled: a.enabled !== "false",
      focused: a.focused === "true" || a.hasKeyboardFocus === "true",
      clickable: INTERACTIVE.has(role),
      scrollable: role === "scroll_view" || role === "list" || undefined,
      checked: role === "switch" ? value === "1" : undefined,
      selected: a.selected === "true" || undefined,
      masked: secure,
      osHidden,
    });
  }
  // Controls whose centre lies in the keyboard band are covered by it.
  const inKeyboardBand = (c: Candidate) =>
    keyboardTop !== null && c.bounds.y + c.bounds.height / 2 >= keyboardTop;
  for (const c of candidates) if (inKeyboardBand(c)) c.covered = true;
  const shown = candidates.filter((c) => !c.osHidden || inKeyboardBand(c));

  let systemUi: UiTree["systemUi"] = null;
  if (app) {
    const visibleNames = [...walk(app)]
      .filter((n) => n.attrs.visible !== "false")
      .map((n) => n.attrs.name ?? "");
    if (visibleNames.some((n) => SHARE_SHEET.test(n))) systemUi = "share_sheet";
    else if (visibleNames.some((n) => QUICK_LOOK.test(n))) systemUi = "quick_look";
  }
  return {
    candidates: shown,
    widthPx,
    heightPx,
    topPackage: app?.attrs.bundleId,
    title,
    dialog: iosDialog(root, scale),
    systemUi,
    keyboardVisible,
  };
}

// ---- Normalisation ------------------------------------------------------------------------

function isUseful(c: Candidate, includeAll: boolean): boolean {
  if (includeAll) return true;
  if (INTERACTIVE.has(c.role) || c.role === "dialog" || c.role === "web_view") return true;
  if (c.scrollable || c.role === "scroll_view" || c.role === "list") return true;
  if (/scroll bar/i.test(c.label ?? "")) return false;
  return Boolean(c.label || c.text);
}

/** A text node that only repeats the caption of the control around it. */
function isCaptionOf(c: Candidate, controls: Candidate[]): boolean {
  if (c.role !== "text" && c.role !== "other") return false;
  const caption = c.text ?? c.label;
  return controls.some(
    (k) =>
      k !== c &&
      inside(c.bounds, k.bounds) &&
      caption !== undefined &&
      (k.label === caption || k.text === caption),
  );
}

const LOADING_TEXT = /^(loading|connecting|please wait|one moment)(\.\.\.|…)?$/i;

function showsLoading(platform: Platform, xml: string, elements: UiElement[]): boolean {
  if (
    elements.some((e) => e.role === "text" && LOADING_TEXT.test((e.text ?? e.label ?? "").trim()))
  ) {
    return true;
  }
  const spinner =
    platform === "android"
      ? /<android\.widget\.ProgressBar\b[^>]*>/g
      : /<XCUIElementTypeActivityIndicator\b[^>]*>/g;
  for (const m of xml.matchAll(spinner)) {
    const node = m[0];
    if (/ (displayed|visible)="false"/.test(node)) continue;
    let w = 0;
    let h = 0;
    const b = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(node);
    if (b) {
      w = Number(b[3]) - Number(b[1]);
      h = Number(b[4]) - Number(b[2]);
    } else {
      w = Number(/ width="([\d.]+)"/.exec(node)?.[1] ?? 0);
      h = Number(/ height="([\d.]+)"/.exec(node)?.[1] ?? 0);
    }
    // A roughly square indicator is a spinner; a wide thin bar shows progress of something else.
    if (w > 0 && h > 0 && Math.max(w, h) <= 2 * Math.min(w, h)) return true;
  }
  return false;
}

export function normalizeTree(platform: Platform, xml: string, options: NormalizeOptions): UiTree {
  const includeAll = options.includeAll ?? false;
  const root = parseXml(xml);
  const raw = platform === "android" ? androidCandidates(root) : iosCandidates(root, options.scale);
  const width = raw.widthPx || Number.MAX_SAFE_INTEGER;
  const height = raw.heightPx || Number.MAX_SAFE_INTEGER;

  // Keep useful, on-screen nodes; drop exact duplicates (RN nests a text inside a same-label text).
  const seen = new Set<string>();
  const kept: Candidate[] = [];
  for (const c of raw.candidates) {
    if (!onScreen(c.bounds, width, height) || !isUseful(c, includeAll)) continue;
    const key = `${c.label ?? ""}|${c.text ?? ""}|${c.bounds.x},${c.bounds.y},${c.bounds.width},${c.bounds.height}`;
    const interactiveKey = `${key}|${INTERACTIVE.has(c.role)}`;
    if (!includeAll) {
      if (seen.has(key) && !INTERACTIVE.has(c.role)) continue;
      if (seen.has(interactiveKey)) continue;
    }
    seen.add(key);
    seen.add(interactiveKey);
    kept.push(c.role === "other" && !c.clickable && !c.scrollable ? { ...c, role: "text" } : c);
  }
  const controls = kept.filter((c) => INTERACTIVE.has(c.role));
  // A clickable container without its own name is announced by the texts inside it.
  for (const c of controls) {
    if (c.label || c.text || c.role === "text_field") continue;
    const inner = kept
      .filter(
        (t) => t !== c && t.role === "text" && (t.text ?? t.label) && inside(t.bounds, c.bounds),
      )
      .map((t) => (t.text ?? t.label) as string);
    if (inner.length > 0) c.text = clip(inner.slice(0, 3).join(" "));
  }
  if (!includeAll) {
    for (let i = kept.length - 1; i >= 0; i--) {
      const c = kept[i];
      if (c && isCaptionOf(c, controls)) kept.splice(i, 1);
    }
  }

  // Interactive elements first when the screen is too big; document order otherwise.
  const max = options.maxElements ?? 200;
  let chosen = kept;
  if (kept.length > max) {
    const interactive = kept.filter((c) => INTERACTIVE.has(c.role));
    const rest = kept.filter((c) => !INTERACTIVE.has(c.role));
    chosen = [...interactive, ...rest].slice(0, max).sort((x, y) => x.order - y.order);
  }

  const elements: UiElement[] = chosen.map((c, i) => {
    const { order: _order, osHidden: _osHidden, ...rest } = c;
    const masked =
      c.masked ||
      (c.role === "text_field" && SECRET_HINT.test(`${c.stableId ?? ""} ${c.label ?? ""}`));
    const out: UiElement = { ...rest, ref: `e${i + 1}`, masked };
    if (masked) delete out.text;
    for (const k of Object.keys(out) as (keyof UiElement)[]) {
      if (out[k] === undefined) delete out[k];
    }
    return out;
  });

  return {
    platform,
    widthPx: raw.widthPx,
    heightPx: raw.heightPx,
    topPackage: raw.topPackage,
    title: raw.title ?? elements.find((e) => e.role === "text" && e.text)?.text,
    keyboardVisible: raw.keyboardVisible,
    dialog: raw.dialog,
    loading: showsLoading(platform, xml, elements),
    systemUi: raw.systemUi,
    elements,
    omitted: kept.length - chosen.length,
  };
}

/** Width and height of a PNG from its IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Width and height of a baseline/progressive JPEG from its SOF marker. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1] ?? 0;
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}
