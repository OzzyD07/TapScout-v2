// Visual quality audit of one screen: deterministic checks on the UI tree and the screenshot that
// point the agent at likely design problems. They are candidates with a confidence level, not
// verdicts: the agent looks at the evidence (numbered boxes on the screenshot, zoom) and decides.

import type { DeviceInfo, Rect, UiElement, UiTree } from "@tapscout/shared";
import sharp from "sharp";

export type AuditCheck =
  | "contrast"
  | "small_target"
  | "missing_label"
  | "overlap"
  | "offscreen"
  | "truncated"
  | "misaligned"
  | "system_area";

export const ALL_CHECKS: AuditCheck[] = [
  "contrast",
  "small_target",
  "missing_label",
  "overlap",
  "offscreen",
  "truncated",
  "misaligned",
  "system_area",
];

export interface AuditIssue {
  n: number;
  check: AuditCheck;
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  message: string;
  /** Screenshot pixels. */
  rect: Rect;
  refs: string[];
}

const TAPPABLE = new Set(["button", "link", "checkbox", "switch", "tab", "cell", "text_field"]);
const LOADING = /^(loading|please wait|connecting)(\.\.\.|…)$/i;

const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);
function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const bt = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, bt - y) };
}
const contains = (outer: Rect, inner: Rect, slack = 2) =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;
const name = (e: UiElement) => {
  const t = e.label ?? e.text ?? e.stableId ?? "";
  return `${e.ref} ${e.role}${t ? ` "${t.length > 40 ? `${t.slice(0, 39)}…` : t}"` : ""}`;
};

/** WCAG relative luminance of an sRGB colour (0–255 channels). */
export function luminance(r: number, g: number, b: number): number {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Text vs background contrast inside a box: the most common colour is the background; the text
 * colour is the cluster (≥3 % of pixels) that contrasts most with it. Null when unclear.
 */
export async function boxContrast(full: Buffer, r: Rect, size: { width: number; height: number }) {
  const inset = { x: Math.round(r.width * 0.04), y: Math.round(r.height * 0.1) };
  const left = Math.max(0, r.x + inset.x);
  const top = Math.max(0, r.y + inset.y);
  const width = Math.min(size.width - left, r.width - 2 * inset.x);
  const height = Math.min(size.height - top, r.height - 2 * inset.y);
  if (width < 6 || height < 6) return null;
  const scale = Math.min(1, 96 / width);
  const { data, info } = await sharp(full)
    .extract({ left, top, width, height })
    .resize({ width: Math.max(4, Math.round(width * scale)), kernel: "nearest" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const pixels = info.width * info.height;
  for (let i = 0; i < data.length; i += 3) {
    const r0 = data[i] ?? 0;
    const g0 = data[i + 1] ?? 0;
    const b0 = data[i + 2] ?? 0;
    const key = ((r0 >> 4) << 8) | ((g0 >> 4) << 4) | (b0 >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1;
    bucket.r += r0;
    bucket.g += g0;
    bucket.b += b0;
    buckets.set(key, bucket);
  }
  const clusters = [...buckets.values()]
    .map((c) => ({ share: c.n / pixels, lum: luminance(c.r / c.n, c.g / c.n, c.b / c.n) }))
    .sort((a, b) => b.share - a.share);
  const bg = clusters[0];
  if (!bg || bg.share < 0.3) return null;
  let best: number | null = null;
  for (const c of clusters.slice(1)) {
    if (c.share < 0.03) continue;
    const ratio = contrastRatio(bg.lum, c.lum);
    if (best === null || ratio > best) best = ratio;
  }
  return best;
}

export interface AuditInput {
  tree: UiTree;
  full: Buffer;
  device: DeviceInfo;
  size: { width: number; height: number };
  checks?: AuditCheck[];
}

export async function auditScreen(input: AuditInput): Promise<AuditIssue[]> {
  const { tree, device, size } = input;
  const want = new Set(input.checks ?? ALL_CHECKS);
  const ios = device.platform === "ios";
  // Screenshot pixels per dp (Android) / pt (iOS).
  const ds = device.densityScale ?? (ios ? device.pixelsPerUnit : 2.625);
  const unit = ios ? "pt" : "dp";
  const issues: Omit<AuditIssue, "n">[] = [];
  const screen: Rect = { x: 0, y: 0, width: size.width, height: size.height };
  const visible = tree.elements.filter((e) => !e.covered && area(intersect(e.bounds, screen)) > 0);
  const tappable = visible.filter((e) => e.clickable || TAPPABLE.has(e.role));
  const scrollers = visible.filter((e) => e.scrollable);
  const inScroller = (e: UiElement) => {
    const onScreen = intersect(e.bounds, screen);
    return scrollers.some(
      (s) => s !== e && area(intersect(onScreen, s.bounds)) >= 0.8 * area(onScreen),
    );
  };

  if (want.has("missing_label")) {
    for (const e of tappable) {
      if (e.label || e.text || e.hint) continue;
      issues.push({
        check: "missing_label",
        severity: "medium",
        confidence: "high",
        message: `${name(e)}${e.stableId ? ` (#${e.stableId})` : ""} has no accessibility label or text: screen readers announce nothing useful`,
        rect: e.bounds,
        refs: [e.ref],
      });
    }
  }

  if (want.has("small_target")) {
    const min = ios ? 44 : 48;
    for (const e of tappable) {
      if (e.role === "cell" || e.role === "text_field") continue;
      const w = e.bounds.width / ds;
      const h = e.bounds.height / ds;
      if (Math.min(w, h) >= min - 0.5) continue;
      if (!contains(screen, e.bounds)) continue;
      issues.push({
        check: "small_target",
        severity: Math.min(w, h) < min * 0.66 ? "medium" : "low",
        confidence: "high",
        message: `${name(e)} is ${Math.round(w)}×${Math.round(h)} ${unit}; touch targets should be at least ${min}×${min} ${unit}`,
        rect: e.bounds,
        refs: [e.ref],
      });
    }
  }

  if (want.has("overlap")) {
    const pairs = (list: UiElement[], minShare: number, label: string) => {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i] as UiElement;
          const b = list[j] as UiElement;
          if (contains(a.bounds, b.bounds) || contains(b.bounds, a.bounds)) continue;
          const shared = area(intersect(a.bounds, b.bounds));
          const smaller = Math.min(area(a.bounds), area(b.bounds));
          if (smaller === 0 || shared / smaller < minShare) continue;
          issues.push({
            check: "overlap",
            severity: label === "controls" ? "high" : "medium",
            confidence: "medium",
            message: `${name(a)} and ${name(b)} overlap (${Math.round((shared / smaller) * 100)} % of the smaller one)`,
            rect: intersect(a.bounds, b.bounds),
            refs: [a.ref, b.ref],
          });
        }
      }
    };
    pairs(tappable, 0.25, "controls");
    pairs(
      visible.filter((e) => e.role === "text" && (e.text ?? e.label)),
      0.3,
      "texts",
    );
  }

  if (want.has("offscreen")) {
    for (const e of [...tappable, ...visible.filter((x) => x.role === "text")]) {
      const b = e.bounds;
      const overflowX = b.x < -2 || b.x + b.width > size.width + 2;
      const overflowY = b.y + b.height > size.height + 2 || b.y < -2;
      if (!overflowX && !overflowY) continue;
      if (inScroller(e)) continue;
      const shown = area(intersect(b, screen)) / Math.max(1, area(b));
      issues.push({
        check: "offscreen",
        severity: TAPPABLE.has(e.role) || e.clickable ? "high" : "medium",
        confidence: "medium",
        message: `${name(e)} extends past the ${overflowX ? "side" : "top/bottom"} of the screen (${Math.round(shown * 100)} % visible) and is not inside a scrolling container`,
        rect: intersect(b, screen),
        refs: [e.ref],
      });
    }
  }

  if (want.has("truncated")) {
    for (const e of visible) {
      const t = (e.text ?? e.label ?? "").trim();
      if (t.length < 4 || LOADING.test(t)) continue;
      if (!/(…|\.\.\.)$/.test(t)) continue;
      issues.push({
        check: "truncated",
        severity: "low",
        confidence: "medium",
        message: `${name(e)} ends with an ellipsis: the text is probably cut off (check whether that is intended)`,
        rect: e.bounds,
        refs: [e.ref],
      });
    }
  }

  if (want.has("system_area")) {
    const top = (ios ? 54 : 24) * ds;
    const bottom = size.height - (ios ? 34 : 16) * ds;
    for (const e of tappable) {
      const cy = e.bounds.y + e.bounds.height / 2;
      if (cy > top && cy < bottom) continue;
      issues.push({
        check: "system_area",
        severity: "medium",
        confidence: "low",
        message: `${name(e)} sits in the ${cy <= top ? "status bar / notch" : "home indicator / navigation bar"} area, where it is hard to reach or hidden (edge-to-edge insets?)`,
        rect: e.bounds,
        refs: [e.ref],
      });
    }
  }

  if (want.has("misaligned")) {
    // Left edges that almost, but not quite, line up with a column several elements share.
    const items = visible.filter(
      (e) => (e.role === "text" || tappable.includes(e)) && e.bounds.width < size.width * 0.95,
    );
    const lefts = new Map<number, UiElement[]>();
    for (const e of items) {
      const key = Math.round(e.bounds.x / ds);
      lefts.set(key, [...(lefts.get(key) ?? []), e]);
    }
    const columns = [...lefts.entries()].filter(([, list]) => list.length >= 3).map(([k]) => k);
    for (const e of items) {
      const x = e.bounds.x / ds;
      for (const col of columns) {
        const off = Math.abs(x - col);
        if (off >= 1.5 && off <= 4) {
          issues.push({
            check: "misaligned",
            severity: "low",
            confidence: "low",
            message: `${name(e)} starts ${off.toFixed(1)} ${unit} away from the left edge ${col} ${unit} that ${lefts.get(col)?.length} other elements share`,
            rect: e.bounds,
            refs: [e.ref],
          });
          break;
        }
      }
    }
  }

  if (want.has("contrast")) {
    const texts = visible.filter(
      (e) =>
        !e.masked &&
        (e.text ?? e.label) &&
        (e.role === "text" || e.role === "button" || e.role === "link") &&
        contains(screen, e.bounds) &&
        e.bounds.height >= 8,
    );
    for (const e of texts.slice(0, 80)) {
      const ratio = await boxContrast(input.full, e.bounds, size).catch(() => null);
      if (ratio === null) continue;
      // Single-line boxes of ≥ 27 dp/pt roughly hold large text (≥ 18 pt).
      const large = e.bounds.height / ds >= 27;
      const need = large ? 3 : 4.5;
      if (ratio >= need) continue;
      issues.push({
        check: "contrast",
        severity: ratio < (large ? 2 : 3) ? "high" : "medium",
        confidence: "medium",
        message: `${name(e)}: contrast about ${ratio.toFixed(1)}:1, WCAG AA needs ${need}:1 for ${large ? "large" : "normal"} text (estimated from the screenshot)`,
        rect: e.bounds,
        refs: [e.ref],
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  return issues
    .sort((a, b) => order[a.severity] - order[b.severity] || a.rect.y - b.rect.y)
    .map((issue, i) => ({ ...issue, n: i + 1 }));
}
