import { describe, expect, it } from "vitest";
import { classify, type TestResult, type TestRun, type TestStatus } from "../src/tests.js";

const result = (status: TestStatus): TestResult => ({
  testId: "t",
  testName: "t",
  testVersion: 1,
  status,
  durationMs: 1,
  steps: [],
  evidence: [],
});

let seq = 0;
const run = (sha: string, status: TestStatus): TestRun => ({
  id: `run-${++seq}`,
  sessionId: "s",
  platform: "ios",
  build: { sha256: sha.padEnd(64, "0"), fileName: `${sha}.zip` },
  startedAt: new Date(Date.UTC(2026, 10, 11, 0, seq)).toISOString(),
  state: "done",
  testIds: ["t"],
  tests: [result(status)],
});

/** History is newest first, as TestStore.runs() returns it. */
const history = (...runs: TestRun[]) => [...runs].reverse();

describe("classify", () => {
  it("marks a failure after a pass on another build as a regression", () => {
    const fixed = run("aaa", "passed");
    const now = run("bbb", "failed");
    expect(classify(now.tests[0] as TestResult, now, history(fixed, now)).classification).toBe(
      "regression",
    );
  });

  it("does not classify an error and does not compare with one", () => {
    const fixed = run("aaa", "passed");
    const broken = run("bbb", "error");
    expect(classify(broken.tests[0] as TestResult, broken, history(fixed, broken))).toEqual({});
    // The next build is compared with the last conclusive result (the pass), not the error.
    const next = run("ccc", "failed");
    const c = classify(next.tests[0] as TestResult, next, history(fixed, broken, next));
    expect(c.classification).toBe("regression");
    expect(c.previous?.status).toBe("passed");
  });

  it("ignores earlier runs of the same build", () => {
    const seeded = run("bbb", "failed");
    const fixed = run("aaa", "passed");
    const again = run("aaa", "passed");
    const c = classify(again.tests[0] as TestResult, again, history(seeded, fixed, again));
    expect(c.classification).toBe("fixed");
    expect(c.previous?.build).toContain("bbb");
  });
});
