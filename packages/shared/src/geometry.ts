// Coordinate spaces:
//  - screenshot px: pixels of a full-resolution device screenshot;
//  - device units: what Appium gestures take (Android px = screenshot px, iOS pt = px / scale);
//  - view units: the agent's space. It is exactly the pixel grid of the default screenshot the
//    agent receives (long edge capped, e.g. 1280), so a point read off that image can be passed
//    back unchanged. Every tool input and output uses view units.

import type { Point, Rect } from "./protocol.js";

export const DEFAULT_VIEW_LONG_EDGE = 1280;

export interface ViewTransform {
  /** View units per screenshot pixel (≤ 1). */
  k: number;
  /** Screenshot pixels per device unit. */
  pixelsPerUnit: number;
  screenshotWidth: number;
  screenshotHeight: number;
  viewWidth: number;
  viewHeight: number;
}

export function makeViewTransform(
  screenshotWidth: number,
  screenshotHeight: number,
  pixelsPerUnit: number,
  longEdge = DEFAULT_VIEW_LONG_EDGE,
): ViewTransform {
  if (!(screenshotWidth > 0 && screenshotHeight > 0)) throw new Error("invalid screenshot size");
  const k = Math.min(1, longEdge / Math.max(screenshotWidth, screenshotHeight));
  return {
    k,
    pixelsPerUnit: pixelsPerUnit > 0 ? pixelsPerUnit : 1,
    screenshotWidth,
    screenshotHeight,
    viewWidth: Math.round(screenshotWidth * k),
    viewHeight: Math.round(screenshotHeight * k),
  };
}

/** View point → device units for a gesture; clamped onto the screen. */
export function viewToDevice(t: ViewTransform, p: Point): Point {
  const x = Math.min(Math.max(p.x, 0), t.viewWidth - 1);
  const y = Math.min(Math.max(p.y, 0), t.viewHeight - 1);
  return {
    x: Math.round((x / t.k / t.pixelsPerUnit) * 100) / 100,
    y: Math.round((y / t.k / t.pixelsPerUnit) * 100) / 100,
  };
}

export function viewToPx(t: ViewTransform, r: Rect): Rect {
  return {
    x: Math.round(r.x / t.k),
    y: Math.round(r.y / t.k),
    width: Math.round(r.width / t.k),
    height: Math.round(r.height / t.k),
  };
}

export function pxToView(t: ViewTransform, r: Rect): Rect {
  return {
    x: Math.round(r.x * t.k),
    y: Math.round(r.y * t.k),
    width: Math.round(r.width * t.k),
    height: Math.round(r.height * t.k),
  };
}

export function isInsideView(t: ViewTransform, p: Point): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < t.viewWidth && p.y < t.viewHeight;
}

/** A region clipped to the view; null when nothing of it is on screen. */
export function clipViewRect(t: ViewTransform, r: Rect): Rect | null {
  const x1 = Math.max(0, Math.round(r.x));
  const y1 = Math.max(0, Math.round(r.y));
  const x2 = Math.min(t.viewWidth, Math.round(r.x + r.width));
  const y2 = Math.min(t.viewHeight, Math.round(r.y + r.height));
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function center(r: Rect): Point {
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}
