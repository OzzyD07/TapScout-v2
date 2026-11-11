// Image work for the agent's views (sharp): the screen in view units, annotated variants
// (numbered element boxes, coordinate grid), zoomed regions with a grid labelled in view units,
// contact sheets of frame sequences, and a cheap difference score for "is the screen still?".

import type { Rect, ViewTransform } from "@tapscout/shared";
import { viewToPx } from "@tapscout/shared";
import sharp, { type OverlayOptions } from "sharp";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function toView(full: Buffer, t: ViewTransform, quality = 80): Promise<Buffer> {
  return sharp(full)
    .resize(t.viewWidth, t.viewHeight, { fit: "fill" })
    .jpeg({ quality })
    .toBuffer();
}

function gridStep(span: number): number {
  for (const step of [10, 20, 25, 50, 100, 200]) if (span / step <= 14) return step;
  return 250;
}

export interface Mark {
  label: string;
  rect: Rect;
  /** Box colour (default magenta). */
  color?: string;
}

/** Overlay: optional grid every `grid` units and numbered element boxes (view units). */
function overlaySvg(width: number, height: number, marks: Mark[], grid: number | null): string {
  const parts: string[] = [];
  if (grid) {
    for (let x = grid; x < width; x += grid) {
      parts.push(
        `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#00e5ff" stroke-opacity="0.45" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${x + 2}" y="12" font-size="11" fill="#00e5ff" stroke="#000" stroke-width="2.5" paint-order="stroke">${x}</text>`,
      );
    }
    for (let y = grid; y < height; y += grid) {
      parts.push(
        `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#00e5ff" stroke-opacity="0.45" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="2" y="${y - 2}" font-size="11" fill="#00e5ff" stroke="#000" stroke-width="2.5" paint-order="stroke">${y}</text>`,
      );
    }
  }
  for (const m of marks) {
    const { x, y, width: w, height: h } = m.rect;
    const tw = 7 * m.label.length + 6;
    const ty = y >= 14 ? y - 14 : y;
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${m.color ?? "#ff2d95"}" stroke-width="2"/>`,
    );
    parts.push(
      `<rect x="${x}" y="${ty}" width="${tw}" height="14" fill="${m.color ?? "#ff2d95"}"/>`,
    );
    parts.push(
      `<text x="${x + 3}" y="${ty + 11}" font-size="11" font-weight="bold" fill="#fff">${esc(m.label)}</text>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">${parts.join("")}</svg>`;
}

export async function annotate(
  view: Buffer,
  t: ViewTransform,
  opts: { marks?: Mark[]; grid?: boolean },
  quality = 80,
): Promise<Buffer> {
  const svg = overlaySvg(
    t.viewWidth,
    t.viewHeight,
    opts.marks ?? [],
    opts.grid ? gridStep(Math.max(t.viewWidth, t.viewHeight)) * (t.viewWidth > 700 ? 2 : 1) : null,
  );
  return sharp(view)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality })
    .toBuffer();
}

/**
 * A region of the full-resolution screenshot (region given in view units), enlarged up to
 * `maxEdge`. The grid is labelled in view units so a point read off the zoom can be used as is.
 */
export async function zoom(
  full: Buffer,
  t: ViewTransform,
  region: Rect,
  opts: { maxEdge?: number; grid?: boolean; quality?: number } = {},
): Promise<{ image: Buffer; width: number; height: number; scale: number }> {
  const px = viewToPx(t, region);
  const left = Math.max(0, Math.min(px.x, t.screenshotWidth - 2));
  const top = Math.max(0, Math.min(px.y, t.screenshotHeight - 2));
  const width = Math.max(2, Math.min(px.width, t.screenshotWidth - left));
  const height = Math.max(2, Math.min(px.height, t.screenshotHeight - top));
  const maxEdge = opts.maxEdge ?? 1024;
  // Never enlarge past 4× the device pixels: it only blurs.
  const s = Math.min(maxEdge / Math.max(width, height), 4);
  const outW = Math.max(1, Math.round(width * s));
  const outH = Math.max(1, Math.round(height * s));
  let img = sharp(full)
    .extract({ left, top, width, height })
    .resize(outW, outH, { fit: "fill", kernel: s > 1 ? "lanczos3" : "lanczos3" });
  // Units per output pixel and the view-unit origin of the crop.
  const scale = outW / (width * t.k);
  if (opts.grid !== false) {
    const vx0 = left * t.k;
    const vy0 = top * t.k;
    const vw = width * t.k;
    const vh = height * t.k;
    const step = gridStep(Math.max(vw, vh));
    const parts: string[] = [];
    for (let v = Math.ceil(vx0 / step) * step; v < vx0 + vw; v += step) {
      const x = Math.round((v - vx0) * scale);
      parts.push(
        `<line x1="${x}" y1="0" x2="${x}" y2="${outH}" stroke="#00e5ff" stroke-opacity="0.55" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${x + 3}" y="14" font-size="13" fill="#00e5ff" stroke="#000" stroke-width="3" paint-order="stroke">x=${v}</text>`,
      );
    }
    for (let v = Math.ceil(vy0 / step) * step; v < vy0 + vh; v += step) {
      const y = Math.round((v - vy0) * scale);
      parts.push(
        `<line x1="0" y1="${y}" x2="${outW}" y2="${y}" stroke="#00e5ff" stroke-opacity="0.55" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="3" y="${y - 3}" font-size="13" fill="#00e5ff" stroke="#000" stroke-width="3" paint-order="stroke">y=${v}</text>`,
      );
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">${parts.join("")}</svg>`;
    img = sharp(await img.png().toBuffer()).composite([
      { input: Buffer.from(svg), top: 0, left: 0 },
    ]);
  }
  const image = await img.jpeg({ quality: opts.quality ?? 85 }).toBuffer();
  return { image, width: outW, height: outH, scale };
}

/**
 * Frames side by side with their labels (e.g. "+0.40 s"), within `maxEdge` overall. One image
 * costs the model far fewer tokens than the same frames sent one by one.
 */
export async function contactSheet(
  frames: { data: Buffer; label: string }[],
  opts: { maxEdge?: number; columns?: number } = {},
): Promise<{ image: Buffer; width: number; height: number; columns: number; rows: number }> {
  if (frames.length === 0) throw new Error("no frames");
  const first = await sharp(frames[0]?.data).metadata();
  const aspect = (first.width ?? 9) / (first.height ?? 16);
  const maxEdge = opts.maxEdge ?? 1568;
  // Fewest rows for the frame count, then as few columns as fill them (8 frames: 2×4, not 6+2).
  const maxColumns = aspect < 1 ? 6 : 3;
  const columns = opts.columns ?? Math.ceil(frames.length / Math.ceil(frames.length / maxColumns));
  const rows = Math.ceil(frames.length / columns);
  const labelH = 20;
  const gap = 4;
  // Largest cell that keeps the whole sheet inside maxEdge on both sides.
  const cellW = Math.floor(
    Math.min(
      (maxEdge - gap * (columns + 1)) / columns,
      ((maxEdge - gap * (rows + 1)) / rows - labelH) * aspect,
    ),
  );
  const cellH = Math.round(cellW / aspect);
  const width = columns * cellW + gap * (columns + 1);
  const height = rows * (cellH + labelH) + gap * (rows + 1);
  const layers: OverlayOptions[] = [];
  const labels: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f) continue;
    const col = i % columns;
    const row = Math.floor(i / columns);
    const left = gap + col * (cellW + gap);
    const top = gap + row * (cellH + labelH + gap);
    layers.push({
      input: await sharp(f.data).resize(cellW, cellH, { fit: "fill" }).toBuffer(),
      left,
      top: top + labelH,
    });
    labels.push(
      `<text x="${left + 4}" y="${top + 15}" font-size="14" font-weight="bold" fill="#fff">${esc(`${i + 1}. ${f.label}`)}</text>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">${labels.join("")}</svg>`;
  layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
  const image = await sharp({
    create: { width, height, channels: 3, background: { r: 24, g: 24, b: 28 } },
  })
    .composite(layers)
    .jpeg({ quality: 78 })
    .toBuffer();
  return { image, width, height, columns, rows };
}

/** Mean absolute difference of two images on a small greyscale thumbnail, 0 (same) to 1. */
export async function diffScore(a: Buffer, b: Buffer): Promise<number> {
  const thumb = (img: Buffer) =>
    sharp(img).resize(36, 64, { fit: "fill" }).greyscale().raw().toBuffer();
  const [x, y] = await Promise.all([thumb(a), thumb(b)]);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs((x[i] ?? 0) - (y[i] ?? 0));
  return sum / (x.length * 255);
}
