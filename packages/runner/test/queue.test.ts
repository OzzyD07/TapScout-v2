import { describe, expect, it } from "vitest";
import { CommandQueue, type LateOutcome, type RunningCommand } from "../src/queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function queue(stuckAfterMs = 50) {
  const late: LateOutcome[] = [];
  const stuck: RunningCommand[] = [];
  const q = new CommandQueue(
    { onLate: (o) => late.push(o), onStuck: (c) => stuck.push(c) },
    stuckAfterMs,
  );
  return { q, late, stuck };
}

describe("CommandQueue", () => {
  it("runs commands one at a time in arrival order", async () => {
    const { q } = queue();
    const order: string[] = [];
    const a = q.run("1", "a", 1_000, async () => {
      await sleep(30);
      order.push("a");
      return 1;
    });
    const b = q.run("2", "b", 1_000, async () => {
      order.push("b");
      return 2;
    });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(order).toEqual(["a", "b"]);
  });

  it("cancels a command whose deadline passes while it waits: it never runs", async () => {
    const { q } = queue(10_000);
    let ranB = false;
    const a = q.run("1", "tap", 1_000, () => sleep(80));
    const b = q.run("2", "swipe", 20, async () => {
      ranB = true;
    });
    await expect(b).rejects.toMatchObject({
      code: "timeout",
      message: /cancelled before it started/,
    });
    await a;
    await sleep(10);
    expect(ranB).toBe(false);
  });

  it("reports a timed-out command's real outcome and refuses new work while it runs", async () => {
    const { q, late } = queue(10_000);
    const slow = q.run("1", "tap", 20, async () => {
      await sleep(80);
      return "done";
    });
    await expect(slow).rejects.toMatchObject({
      code: "timeout",
      message: /may still be executing/,
    });
    expect(q.busy).toBe(true);
    await expect(q.run("2", "type", 1_000, async () => 1)).rejects.toMatchObject({
      code: "device_busy",
      message: /earlier tap/,
    });
    await sleep(100);
    expect(late).toEqual([expect.objectContaining({ id: "1", name: "tap", outcome: "completed" })]);
    expect(late[0]?.lateByMs).toBeGreaterThan(30);
    expect(q.busy).toBe(false);
    await expect(q.run("3", "type", 1_000, async () => "ok")).resolves.toBe("ok");
  });

  it("reports a failure that happens after the timeout", async () => {
    const { q, late } = queue(10_000);
    await expect(
      q.run("1", "tap", 10, async () => {
        await sleep(40);
        throw new Error("element went stale");
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    await sleep(60);
    expect(late[0]).toMatchObject({ outcome: "failed", error: "element went stale" });
  });

  it("asks for a new session when a command stays stuck, and replace() abandons it", async () => {
    const { q, late, stuck } = queue(30);
    let release: () => void = () => undefined;
    const wedged = q.run("1", "source", 10, () => new Promise<void>((r) => (release = r)));
    await expect(wedged).rejects.toMatchObject({ code: "timeout" });
    await sleep(60);
    expect(stuck.map((c) => c.name)).toEqual(["source"]);

    const replaced: string[] = [];
    const replacement = q.replace(async () => {
      await sleep(20);
      replaced.push("new session");
    });
    expect(q.busy).toBe(true);
    // Accepted while the session is replaced, and run after it.
    const next = q.run("2", "screenshot", 1_000, async () => {
      replaced.push("screenshot");
      return 1;
    });
    await replacement;
    await expect(next).resolves.toBe(1);
    expect(replaced).toEqual(["new session", "screenshot"]);
    // The wedged call finally returns: reported as abandoned.
    release();
    await sleep(10);
    expect(late[0]).toMatchObject({ id: "1", outcome: "abandoned" });
  });
});
