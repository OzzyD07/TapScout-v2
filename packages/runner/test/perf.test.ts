import { describe, expect, it } from "vitest";
import { parseGfxinfo, visualTiming } from "../src/perf.js";

// Captured from `dumpsys gfxinfo dev.tapscout.fieldnotes` on an Android 16 emulator.
const GFXINFO = `
Total frames rendered: 9
Janky frames: 5 (55.56%)
Janky frames (legacy): 8 (88.89%)
50th percentile: 36ms
90th percentile: 150ms
95th percentile: 150ms
99th percentile: 150ms
Number Missed Vsync: 0
Number High input latency: 8
Number Slow UI thread: 3
Number Slow bitmap uploads: 0
Number Slow issue draw commands: 4
Number Frame deadline missed: 5
50th gpu percentile: 13ms
`;

describe("gfxinfo", () => {
  it("reads frame counts, jank and percentiles", () => {
    expect(parseGfxinfo(GFXINFO)).toEqual({
      source: "gfxinfo",
      totalFrames: 9,
      jankyFrames: 5,
      jankyPercent: 55.56,
      p50Ms: 36,
      p90Ms: 150,
      p95Ms: 150,
      p99Ms: 150,
      missedVsync: 0,
      slowUiThread: 3,
      slowBitmapUploads: 0,
      slowDrawCommands: 4,
      deadlineMissed: 5,
      highInputLatency: 8,
    });
    expect(parseGfxinfo("no stats")).toBeNull();
  });
});

describe("visual timing", () => {
  it("measures response, settle time, smoothness and the longest hitch", () => {
    // Action at 1000; frames every 20 ms; the screen changes 1100–1300 with a 120 ms pause.
    const times = Array.from({ length: 40 }, (_, i) => 900 + i * 20);
    const diffs = times.map((t) => (t >= 1100 && t <= 1300 && !(t > 1160 && t < 1280) ? 0.05 : 0));
    const v = visualTiming(times, diffs, 1000, "video");
    expect(v.firstChangeMs).toBe(100);
    expect(v.settledMs).toBe(300);
    expect(v.longestGapMs).toBe(120);
    expect(v.changedFrames).toBe(6);
    expect(v.visualFps).toBeCloseTo(25, 0);
  });

  it("reports no change when the screen stayed still", () => {
    expect(visualTiming([0, 20, 40], [0, 0, 0], 10, "poll")).toEqual({
      changedFrames: 0,
      method: "poll",
    });
  });
});
