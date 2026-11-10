import { describe, expect, it } from "vitest";
import {
  clipViewRect,
  decodeBinary,
  encodeBinary,
  makeViewTransform,
  pxToView,
  viewToDevice,
  viewToPx,
} from "../src/index.js";

describe("binary envelope", () => {
  it("round-trips a header and payload", () => {
    const payload = Uint8Array.from([1, 2, 3, 255]);
    const frame = encodeBinary({ t: "frame", seq: 7 }, payload);
    const { header, payload: out } = decodeBinary<{ t: string; seq: number }>(frame);
    expect(header).toEqual({ t: "frame", seq: 7 });
    expect([...out]).toEqual([1, 2, 3, 255]);
  });

  it("rejects a header that overruns the frame", () => {
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(100, 0);
    expect(() => decodeBinary(bad)).toThrow(/overruns/);
  });
});

describe("view transform", () => {
  it("maps an Android screenshot to a 1280 long edge and back to device pixels", () => {
    const t = makeViewTransform(1080, 2400, 1);
    expect([t.viewWidth, t.viewHeight]).toEqual([576, 1280]);
    expect(viewToDevice(t, { x: 288, y: 640 })).toEqual({ x: 540, y: 1200 });
    expect(pxToView(t, { x: 1080 / 2, y: 0, width: 108, height: 240 })).toEqual({
      x: 288,
      y: 0,
      width: 58,
      height: 128,
    });
    expect(viewToPx(t, { x: 288, y: 640, width: 10, height: 10 })).toEqual({
      x: 540,
      y: 1200,
      width: 19,
      height: 19,
    });
  });

  it("maps iOS view points to device points through the display scale", () => {
    const t = makeViewTransform(1206, 2622, 3);
    expect(t.viewHeight).toBe(1280);
    const p = viewToDevice(t, { x: t.viewWidth / 2, y: t.viewHeight / 2 });
    expect(p.x).toBeCloseTo(201, 0);
    expect(p.y).toBeCloseTo(437, 0);
  });

  it("never upscales a small screen and clamps points onto it", () => {
    const t = makeViewTransform(400, 800, 1);
    expect(t.k).toBe(1);
    expect(viewToDevice(t, { x: -5, y: 9999 })).toEqual({ x: 0, y: 799 });
    expect(clipViewRect(t, { x: 390, y: 790, width: 50, height: 50 })).toEqual({
      x: 390,
      y: 790,
      width: 10,
      height: 10,
    });
    expect(clipViewRect(t, { x: 500, y: 0, width: 5, height: 5 })).toBeNull();
  });
});
