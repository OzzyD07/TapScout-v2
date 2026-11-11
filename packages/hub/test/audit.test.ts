import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { boxContrast } from "../src/audit.js";

type Rgb = [number, number, number];

/**
 * A 300×40 JPEG like a screenshot crop: background (with ±noise), and "text": vertical strokes 2 px
 * wide every 6 px over the middle rows, with one anti-aliased column on each side.
 */
async function textImage(bg: Rgb, ink: Rgb | null, noise = 0) {
  const width = 300;
  const height = 40;
  const px = Buffer.alloc(width * height * 3);
  const edge = ink ? (ink.map((v, i) => Math.round((v + (bg[i] ?? 0)) / 2)) as Rgb) : bg;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inText = ink && y >= 12 && y < 28 && x >= 20 && x < 280;
      const col = x % 6;
      let c: Rgb = bg;
      if (inText && (col === 1 || col === 2)) c = ink;
      else if (inText && (col === 0 || col === 3)) c = edge;
      const n = noise ? ((x * 7 + y * 13) % (2 * noise + 1)) - noise : 0;
      const i = (y * width + x) * 3;
      px[i] = Math.max(0, Math.min(255, c[0] + n));
      px[i + 1] = Math.max(0, Math.min(255, c[1] + n));
      px[i + 2] = Math.max(0, Math.min(255, c[2] + n));
    }
  }
  const jpeg = await sharp(px, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { jpeg, rect: { x: 0, y: 0, width, height }, size: { width, height } };
}

describe("boxContrast", () => {
  it("reads grey text on a noisy dark background as readable (dark mode)", async () => {
    // The background straddles a 16-level boundary, which split colour clusters before.
    const { jpeg, rect, size } = await textImage([17, 16, 22], [152, 152, 160], 2);
    const ratio = await boxContrast(jpeg, rect, size);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThan(4.5);
  });

  it("finds low contrast text", async () => {
    const { jpeg, rect, size } = await textImage([255, 255, 255], [200, 200, 200]);
    const ratio = await boxContrast(jpeg, rect, size);
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThan(1.3);
    expect(ratio as number).toBeLessThan(2.2);
  });

  it("reads black text on white as high contrast", async () => {
    const { jpeg, rect, size } = await textImage([255, 255, 255], [0, 0, 0]);
    expect((await boxContrast(jpeg, rect, size)) as number).toBeGreaterThan(12);
  });

  it("gives no estimate for a box without text pixels", async () => {
    const { jpeg, rect, size } = await textImage([17, 16, 22], null, 2);
    expect(await boxContrast(jpeg, rect, size)).toBeNull();
  });
});
