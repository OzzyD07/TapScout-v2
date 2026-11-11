// Test tools: record the agent's flows as tests, add expectations, replay them on new builds
// (several sessions in parallel), and compare results across builds to find regressions.

import { join } from "node:path";
import { z } from "zod";
import { toView } from "./images.js";
import { elementSpec, sessionId, type ToolKit } from "./mcp.js";
import type { DeviceOps } from "./ops.js";
import { type HubSession, SessionError } from "./session.js";
import {
  buildLabel,
  newRun,
  type Step,
  stepFromTool,
  stepLabel,
  type Target,
  type TestCase,
  TestExecutor,
  TestInput,
  type TestRun,
  TestStore,
  targetFor,
} from "./tests.js";

const stores = new Map<string, TestStore>();
export function testStore(dataDir: string): TestStore {
  let s = stores.get(dataDir);
  if (!s) {
    s = new TestStore(dataDir);
    stores.set(dataDir, s);
  }
  return s;
}

/** Runs in progress in this hub process. */
const running = new Map<string, Promise<TestRun>>();

const ICON: Record<string, string> = { passed: "✓", failed: "✗", error: "!", skipped: "–" };

/** Appends the step a successful tool call stands for to the session's recording. */
export function recordStep(
  tool: string,
  args: Record<string, unknown>,
  s: HubSession,
  ops: DeviceOps,
): Step | null {
  const rec = s.recording;
  const view = s.transform;
  if (!rec || !view) return null;
  const dims = { width: view.viewWidth, height: view.viewHeight };
  const step = stepFromTool(tool, args, {
    target: (slot) => {
      const r = ops.resolved[slot ?? "main"];
      if (r) return targetFor(r.el, r.point, dims, r.tree);
      if (tool === "device_swipe") {
        const p =
          slot === "to"
            ? { x: Number(args.to_x), y: Number(args.to_y) }
            : { x: Number(args.from_x), y: Number(args.from_y) };
        return targetFor(null, p, dims, null);
      }
      return null;
    },
  });
  if (step) rec.steps.push(step);
  return step;
}

export function formatRun(run: TestRun, fileUrl: (sid: string, rel: string) => string): string {
  const counts = { passed: 0, failed: 0, error: 0, skipped: 0 };
  const classes: Record<string, number> = {};
  for (const t of run.tests) {
    counts[t.status] += 1;
    if (t.classification) classes[t.classification] = (classes[t.classification] ?? 0) + 1;
  }
  const lines = [
    `Run ${run.id} · ${run.platform}${run.device ? ` · ${run.device}` : ""} · build ${buildLabel(run.build)} (${run.build.fileName}) · ${run.state}${run.error ? `: ${run.error}` : ""}`,
    `${run.tests.length}/${run.testIds.length} tests: ${counts.passed} passed, ${counts.failed} failed, ${counts.error} errors, ${counts.skipped} skipped${classes.regression ? ` · ${classes.regression} REGRESSION${classes.regression > 1 ? "S" : ""}` : ""}${classes.fixed ? ` · ${classes.fixed} fixed` : ""}`,
  ];
  for (const t of run.tests) {
    const cls =
      t.classification && t.classification !== "new"
        ? ` [${t.classification.toUpperCase()}${t.previous ? ` vs ${t.previous.build}` : ""}]`
        : t.classification === "new"
          ? " [new: no earlier build]"
          : "";
    lines.push(
      `${ICON[t.status]} ${t.testId} (v${t.testVersion}) ${t.status}${cls} · ${(t.durationMs / 1000).toFixed(1)} s`,
    );
    if (t.message) lines.push(`    ${t.message}`);
    if (t.previous && t.previous.testVersion !== t.testVersion) {
      lines.push(
        `    note: the test changed since that run (v${t.previous.testVersion} → v${t.testVersion})`,
      );
    }
    for (const e of t.evidence) lines.push(`    evidence: ${fileUrl(run.sessionId, e)}`);
  }
  return lines.join("\n");
}

export function registerTestTools({ tool, manager, fileUrl }: ToolKit) {
  const tests = testStore(manager.config.dataDir);

  const resolveTarget = async (
    ops: DeviceOps,
    s: HubSession,
    element: string,
  ): Promise<{ target: Target; text?: string }> => {
    const r = await ops.resolveElement(element);
    const t = s.transform;
    if (!t) throw new SessionError("not_ready", "no screen geometry");
    const dims = { width: t.viewWidth, height: t.viewHeight };
    const target = targetFor(
      r.element,
      { x: r.rect.x + r.rect.width / 2, y: r.rect.y + r.rect.height / 2 },
      dims,
      s.lastTree?.tree ?? null,
    );
    const text = r.element.text ?? r.element.label;
    return { target, ...(text ? { text } : {}) };
  };

  tool(
    "test_record",
    'Record a reusable test from what you do on this session. "start": from now on your actions (taps, typing, scrolls, keys, restarts, environment changes, waits) are saved as steps with portable element targets (id/text, not refs or pixels); add checks with test_expect. "stop": saves the test (it then replays on later builds with test_run). "status": the steps so far; "cancel": discard.',
    {
      session_id: sessionId,
      action: z.enum(["start", "stop", "status", "cancel"]),
      name: z.string().max(120).optional().describe("start: the test's name"),
      description: z.string().max(2_000).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      platforms: z
        .array(z.enum(["android", "ios"]))
        .optional()
        .describe("Default: both"),
      restart_app: z.boolean().default(true).describe("Replays start from a freshly restarted app"),
      clear_data: z
        .boolean()
        .default(false)
        .describe("Replays start with cleared app data (onboarding again)"),
    },
    async (a, use) => {
      const { s } = use(a.session_id);
      if (a.action === "start") {
        if (s.recording)
          throw new SessionError(
            "busy",
            `already recording "${s.recording.name}"; stop or cancel it first`,
          );
        if (!a.name) throw new SessionError("bad_args", "start needs a name");
        s.recording = {
          name: a.name,
          ...(a.description ? { description: a.description } : {}),
          ...(a.platforms ? { platforms: a.platforms } : {}),
          tags: a.tags ?? [],
          setup: { restart_app: a.restart_app, clear_data: a.clear_data },
          steps: [],
          startedAt: new Date().toISOString(),
          baselineDir: join(tests.testsDir, `_rec-${s.id}`),
        };
        await s.event({ kind: "test", message: `recording test "${a.name}"` });
        return {
          text: `Recording "${a.name}". Replays will start from ${a.clear_data ? "a cleared, restarted app" : a.restart_app ? "a restarted app" : "wherever the app is"}: if that differs from the current screen, call app_restart now so the recording starts the same way. Act as usual; add checks with test_expect; finish with test_record action="stop".`,
          images: [],
        };
      }
      const rec = s.recording;
      if (!rec)
        throw new SessionError("not_recording", "no test is being recorded on this session");
      if (a.action === "status") {
        return {
          text: `Recording "${rec.name}" since ${rec.startedAt}: ${rec.steps.length} steps\n${rec.steps.map((st, i) => `${i + 1}. ${stepLabel(st)}`).join("\n")}`,
          images: [],
        };
      }
      if (a.action === "cancel") {
        s.recording = null;
        await tests.adoptBaselines(rec.baselineDir, "_discard").catch(() => undefined);
        await tests.delete("_discard").catch(() => undefined);
        return { text: `Recording "${rec.name}" discarded.`, images: [] };
      }
      if (rec.steps.length === 0) throw new SessionError("bad_args", "nothing recorded yet");
      const input = TestInput.parse({
        name: rec.name,
        ...(rec.description ? { description: rec.description } : {}),
        platforms: rec.platforms ?? ["android", "ios"],
        tags: rec.tags,
        setup: rec.setup,
        steps: rec.steps,
      });
      const test = await tests.save(input, {
        ...(s.record.device?.appId ? { appId: s.record.device.appId } : {}),
        recordedOn: {
          sessionId: s.id,
          platform: s.record.platform,
          build: buildLabel({
            sha256: s.record.build.sha256,
            fileName: s.record.build.fileName,
            ...(s.record.device?.appVersion ? { appVersion: s.record.device.appVersion } : {}),
          }),
        },
      });
      await tests.adoptBaselines(rec.baselineDir, test.id);
      s.recording = null;
      await s.event({
        kind: "test",
        message: `saved test ${test.id} (${test.steps.length} steps)`,
      });
      const checks = test.steps.filter((st) => st.do === "expect").length;
      return {
        text: `Saved test "${test.id}" v${test.version}: ${test.steps.length} steps, ${checks} expectations${checks === 0 ? " (WARNING: no expectations — a replay only proves the steps can be performed; add some with test_expect test_id=…)" : ""}.\n${test.steps.map((st, i) => `${i + 1}. ${stepLabel(st)}`).join("\n")}`,
        images: [],
      };
    },
  );

  tool(
    "test_expect",
    'Add an expectation to the test being recorded (or, with test_id, to a saved test) and check it right now. "visible"/"not_visible": an element; "text": an element\'s text (value defaults to its current text); "screen": the current screen becomes a baseline image compared on replay (status bar ignored); "no_crash": no crash since the test started; "app_running": the app is in the foreground.',
    {
      session_id: sessionId,
      expect: z.enum(["visible", "not_visible", "text", "screen", "no_crash", "app_running"]),
      element: elementSpec.optional(),
      value: z.string().optional(),
      match: z.enum(["equals", "contains"]).default("equals"),
      timeout_ms: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .optional()
        .describe("How long a replay waits for it (default 5 s)"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("screen: allowed share of changed pixels (default 0.02)"),
      test_id: z.string().optional().describe("Append to this saved test instead of the recording"),
    },
    async (a, use) => {
      const { s, ops } = use(a.session_id);
      const rec = s.recording;
      if (!a.test_id && !rec)
        throw new SessionError("not_recording", "start a recording (test_record) or give test_id");
      let step: Extract<Step, { do: "expect" }> = { do: "expect", expect: a.expect };
      let current: string | undefined;
      if (a.expect === "visible" || a.expect === "not_visible" || a.expect === "text") {
        if (!a.element) throw new SessionError("bad_args", `${a.expect} needs element`);
        if (a.expect === "not_visible") {
          // The element must exist to name it; it is expected to be gone at that point of a replay.
          const r = await resolveTarget(ops, s, a.element);
          step.target = r.target;
        } else {
          const r = await resolveTarget(ops, s, a.element);
          step.target = r.target;
          current = r.text;
        }
        if (a.expect === "text") {
          const value = a.value ?? current;
          if (value === undefined)
            throw new SessionError("bad_args", "the element has no text; give value");
          step = { ...step, value, match: a.match };
        }
      }
      if (a.timeout_ms !== undefined) step.timeout_ms = a.timeout_ms;
      let baselineNote = "";
      if (a.expect === "screen") {
        const { full } = await ops.capture();
        const t = s.transform;
        if (!t) throw new SessionError("not_ready", "no screen geometry");
        const name = `b${Date.now()}.jpg`;
        const view = await toView(full, t);
        const dir = a.test_id
          ? join(tests.dir(a.test_id), "baselines")
          : (rec?.baselineDir as string);
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, name), view);
        step = {
          ...step,
          baseline: name,
          ...(a.threshold !== undefined ? { threshold: a.threshold } : {}),
        };
        baselineNote = ` (baseline ${name}, ${t.viewWidth}×${t.viewHeight})`;
      }
      // Check it now (a screen baseline was just taken, so it holds by definition).
      let verdict = "holds now ✓";
      if (a.expect !== "screen") {
        const exec = new TestExecutor(tests, manager.store, s, ops, () => tests.runs());
        try {
          await exec.expect({ ...step, timeout_ms: 0 }, Date.now() - 10 * 60_000, a.test_id);
        } catch (error) {
          verdict = `does NOT hold now ✗ (${(error as Error).message}) — added anyway`;
        }
      }
      if (a.test_id) {
        const test = await tests.get(a.test_id);
        const { id: _id, version: _v, createdAt: _c, updatedAt: _u, ...rest } = test;
        const saved = await tests.save(
          TestInput.parse({ ...rest, id: test.id, steps: [...test.steps, step] }),
          {},
        );
        return {
          text: `Added to ${saved.id} v${saved.version} as step ${saved.steps.length}: ${stepLabel(step)}${baselineNote} — ${verdict}`,
          images: [],
        };
      }
      rec?.steps.push(step);
      return {
        text: `Step ${rec?.steps.length}: ${stepLabel(step)}${baselineNote} — ${verdict}`,
        images: [],
      };
    },
  );

  tool(
    "test_save",
    "Create or replace a test from JSON (to write a test yourself or edit one from test_get: change steps, targets, expectations, setup). Keeping the id updates that test and raises its version. Step forms: {do:'tap'|'long_press', target}, {do:'type', target?, text, mode?, submit?}, {do:'key', key}, {do:'hide_keyboard'}, {do:'scroll', direction, target?}, {do:'swipe'|'drag', from, to}, {do:'answer_dialog', button}, {do:'restart_app', clear_data?}, {do:'background_app', seconds}, {do:'open_url', url}, {do:'rotate', orientation}, {do:'environment', settings}, {do:'wait', ms?|for, text?}, {do:'expect', expect, target?, value?, match?, timeout_ms?}. Targets: {id} or {text} (+ role, nth), or {x, y} as screen fractions.",
    { test: TestInput },
    async (a) => {
      if (a.test.id) await tests.get(a.test.id).catch(() => null);
      const test = await tests.save(a.test);
      return {
        text: `Saved ${test.id} v${test.version} (${test.steps.length} steps, platforms ${test.platforms.join(", ")}).`,
        images: [],
      };
    },
  );

  tool(
    "test_list",
    "List saved tests with their latest result per platform and build.",
    { platform: z.enum(["android", "ios"]).optional(), tag: z.string().optional() },
    async (a) => {
      const all = (await tests.list()).filter(
        (t) =>
          (!a.platform || t.platforms.includes(a.platform)) && (!a.tag || t.tags.includes(a.tag)),
      );
      if (all.length === 0)
        return { text: "No tests yet. Record one with test_record.", images: [] };
      const runs = await tests.runs();
      const lines = all.map((t) => {
        const last = (["android", "ios"] as const)
          .map((p) => {
            const run = runs.find(
              (r) =>
                r.platform === p &&
                r.tests.some((x) => x.testId === t.id && x.status !== "skipped"),
            );
            const r = run?.tests.find((x) => x.testId === t.id);
            return run && r
              ? `${p} ${ICON[r.status]} ${buildLabel(run.build)}${r.classification === "regression" ? " REGRESSION" : ""}`
              : null;
          })
          .filter(Boolean)
          .join(" · ");
        return `${t.id} v${t.version} "${t.name}" · ${t.platforms.join("/")} · ${t.steps.length} steps${t.tags.length ? ` · tags ${t.tags.join(", ")}` : ""}${last ? ` · last: ${last}` : ""}`;
      });
      return { text: lines.join("\n"), images: [] };
    },
    { readOnly: true },
  );

  tool(
    "test_get",
    "A saved test as JSON (to read or edit it, then test_save).",
    { test_id: z.string() },
    async (a) => {
      const t = await tests.get(a.test_id);
      return { text: JSON.stringify(t, null, 1), images: [] };
    },
    { readOnly: true },
  );

  tool(
    "test_delete",
    "Delete a saved test (its past run results stay).",
    { test_id: z.string() },
    async (a) => {
      await tests.get(a.test_id);
      await tests.delete(a.test_id);
      return { text: `Deleted ${a.test_id}.`, images: [] };
    },
    { destructive: true },
  );

  tool(
    "test_run",
    "Replay saved tests on one or more ready sessions — e.g. an Android and an iOS session of a new build in parallel. TapScout performs every step and checks every expectation itself (no decisions by you), collects evidence on failures and compares each result with the latest result on a different build: REGRESSION (passed before, fails now), fixed, still_failing, stable or new. Runs continue in the background; follow them with test_results. Do not drive a session while its tests run.",
    {
      session_ids: z
        .array(z.string())
        .optional()
        .describe("Default: the most recent active session"),
      test_ids: z
        .array(z.string())
        .optional()
        .describe("Default: every test for the session's platform"),
      tag: z.string().optional(),
      stop_on_failure: z.boolean().default(false),
      wait_seconds: z.number().int().min(0).max(45).default(20),
    },
    async (a, use) => {
      const sessions = (a.session_ids?.length ? a.session_ids : [undefined]).map((id) => use(id));
      let selected: TestCase[] = [];
      if (a.test_ids?.length) {
        for (const id of a.test_ids) selected.push(await tests.get(id));
      } else {
        selected = await tests.list();
      }
      if (a.tag) selected = selected.filter((t) => t.tags.includes(a.tag as string));
      const started: TestRun[] = [];
      for (const { s, ops } of sessions) {
        if (!s.ready)
          throw new SessionError("not_ready", `session ${s.id} is not ready (${s.record.state})`);
        if (s.busyWith)
          throw new SessionError(
            "busy",
            `session ${s.id} is already running tests (${s.busyWith})`,
          );
        const mine = selected.filter((t) => t.platforms.includes(s.record.platform));
        if (mine.length === 0)
          throw new SessionError("bad_args", `no tests for ${s.record.platform}`);
        const run = newRun(
          s,
          mine.map((t) => t.id),
        );
        await tests.saveRun(run);
        s.busyWith = `test run ${run.id}`;
        await s.event({
          kind: "test",
          message: `test run started (${mine.length} tests)`,
          runId: run.id,
        });
        const exec = new TestExecutor(tests, manager.store, s, ops, () => tests.runs());
        const job = exec
          .run(run, mine, a.stop_on_failure)
          .then(async (r) => {
            r.state = "done";
            return r;
          })
          .catch(async (error) => {
            run.state = "failed";
            run.error = (error as Error).message;
            return run;
          })
          .then(async (r) => {
            r.finishedAt = new Date().toISOString();
            await tests.saveRun(r);
            s.busyWith = null;
            s.lastActivity = Date.now();
            const regressions = r.tests.filter((t) => t.classification === "regression").length;
            await s.event({
              kind: "test",
              message: `test run ${r.state}: ${r.tests.filter((t) => t.status === "passed").length}/${r.tests.length} passed${regressions ? `, ${regressions} regressions` : ""}`,
              runId: r.id,
            });
            running.delete(r.id);
            return r;
          });
        running.set(run.id, job);
        started.push(run);
      }
      if (a.wait_seconds > 0) {
        await Promise.race([
          Promise.all(started.map((r) => running.get(r.id) ?? Promise.resolve(r))),
          new Promise((r) => setTimeout(r, a.wait_seconds * 1000)),
        ]);
      }
      const now = await Promise.all(started.map((r) => tests.getRun(r.id)));
      const pending = now.filter((r) => r.state === "running").map((r) => r.id);
      return {
        text: `${now.map((r) => formatRun(r, fileUrl)).join("\n\n")}${pending.length ? `\n\nStill running: ${pending.join(", ")} — call test_results with wait_seconds.` : ""}`,
        images: [],
      };
    },
  );

  tool(
    "test_results",
    "Results of a test run (waits up to wait_seconds while it is still running), with failed steps, evidence and regression classification.",
    {
      run_id: z.string().describe("Run id (or its first characters)"),
      wait_seconds: z.number().int().min(0).max(45).default(0),
    },
    async (a) => {
      const { id } = await tests.getRun(a.run_id);
      const job = running.get(id);
      if (job && a.wait_seconds > 0) {
        await Promise.race([job, new Promise((r) => setTimeout(r, a.wait_seconds * 1000))]);
      }
      return { text: formatRun(await tests.getRun(id), fileUrl), images: [] };
    },
    { readOnly: true },
  );

  tool(
    "test_compare",
    "Compare test results across builds: one row per test, one column per build (newest last), per platform. Marks regressions (passed on an earlier build, failing on a later one) and fixes.",
    {
      platform: z.enum(["android", "ios"]).optional(),
      test_ids: z.array(z.string()).optional(),
      builds: z.number().int().min(2).max(10).default(5),
    },
    async (a) => {
      const runs = (await tests.runs()).filter((r) => r.state !== "running").reverse();
      const out: string[] = [];
      for (const platform of a.platform ? [a.platform] : (["android", "ios"] as const)) {
        const mine = runs.filter((r) => r.platform === platform);
        if (mine.length === 0) continue;
        // Latest run per build, builds ordered by their first run.
        const builds: { label: string; sha: string; runs: TestRun[] }[] = [];
        for (const r of mine) {
          const b = builds.find((x) => x.sha === r.build.sha256);
          if (b) b.runs.push(r);
          else builds.push({ label: buildLabel(r.build), sha: r.build.sha256, runs: [r] });
        }
        const cols = builds.slice(-a.builds);
        const ids = a.test_ids ?? [...new Set(mine.flatMap((r) => r.tests.map((t) => t.testId)))];
        out.push(`${platform}: ${cols.map((c, i) => `[${i + 1}] ${c.label}`).join("  ")}`);
        for (const id of ids) {
          // A build's latest passed/failed result; an error (TapScout could not perform a step)
          // shows only when the build has nothing conclusive and is never compared.
          const cells = cols.map((c) => {
            const results = [...c.runs]
              .reverse()
              .flatMap((r) => r.tests.filter((x) => x.testId === id && x.status !== "skipped"));
            return (
              results.find((t) => t.status === "passed" || t.status === "failed")?.status ??
              results[0]?.status ??
              null
            );
          });
          const conclusive = (s: string | null | undefined) => s === "passed" || s === "failed";
          const marks: string[] = [];
          for (let i = 1; i < cells.length; i++) {
            const now = cells[i];
            if (!conclusive(now)) continue;
            const before = cells.slice(0, i).filter(conclusive).pop();
            if (before === "passed" && now === "failed") marks.push(`REGRESSION in [${i + 1}]`);
            if (before === "failed" && now === "passed") marks.push(`fixed in [${i + 1}]`);
          }
          out.push(
            `  ${id}: ${cells.map((c) => (c ? ICON[c] : "·")).join("  ")}${marks.length ? `   ${marks.join(", ")}` : ""}`,
          );
        }
      }
      return { text: out.length ? out.join("\n") : "No finished test runs yet.", images: [] };
    },
    { readOnly: true },
  );
}
