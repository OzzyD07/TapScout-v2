// Reusable agent tests: steps and expectations recorded from what the agent did (or written by
// it), replayed by the hub on later builds without the agent deciding anything, and compared
// across builds to tell regressions from fixes.
//
//   .data/tests/<id>/test.json             the test (versioned on every change)
//   .data/tests/<id>/baselines/<n>.jpg     screens for "screen" expectations
//   .data/test-runs/<runId>.json           one run of tests on one session (one build/device)
//   sessions/<sid>/evidence/tests/<runId>/ failure evidence of that run

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandArgs,
  center,
  type DeviceInfo,
  type KeyName,
  type Platform,
  pxToView,
  type Rect,
  type UiElement,
  type UiTree,
} from "@tapscout/shared";
import sharp from "sharp";
import { z } from "zod";
import { contactSheet, toView } from "./images.js";
import type { DeviceOps } from "./ops.js";
import { type HubSession, SessionError } from "./session.js";
import type { Store } from "./store.js";

// ---- Model -----------------------------------------------------------------------------------

/** Where an element is: identity first (portable across builds and screens), point as fallback. */
export const Target = z
  .object({
    id: z.string().optional().describe("resource-id / accessibility identifier"),
    text: z.string().optional().describe("visible text or accessibility label"),
    role: z.string().optional().describe("button, text_field, text, switch, …"),
    nth: z.number().int().min(0).optional().describe("index among several matches"),
    x: z.number().min(0).max(1).optional().describe("fallback: fraction of the screen width"),
    y: z.number().min(0).max(1).optional().describe("fallback: fraction of the screen height"),
  })
  .describe("Element by id/text/role (preferred) or a point as screen fractions");
export type Target = z.infer<typeof Target>;

const Region = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

export const Step = z.discriminatedUnion("do", [
  z.object({
    do: z.literal("tap"),
    target: Target,
    count: z.number().int().min(1).max(3).optional(),
  }),
  z.object({
    do: z.literal("long_press"),
    target: Target,
    duration_ms: z.number().int().optional(),
  }),
  z.object({
    do: z.literal("type"),
    target: Target.optional(),
    text: z.string(),
    mode: z.enum(["append", "replace"]).optional(),
    submit: z.boolean().optional(),
    secret: z.boolean().optional(),
  }),
  z.object({ do: z.literal("key"), key: z.string() }),
  z.object({ do: z.literal("hide_keyboard") }),
  z.object({
    do: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    target: Target.optional(),
    amount: z.number().min(0.1).max(0.95).optional(),
  }),
  z.object({
    do: z.literal("swipe"),
    from: Target,
    to: Target,
    duration_ms: z.number().int().optional(),
  }),
  z.object({
    do: z.literal("drag"),
    from: Target,
    to: Target,
    hold_ms: z.number().int().optional(),
  }),
  z.object({ do: z.literal("answer_dialog"), button: z.string() }),
  z.object({ do: z.literal("restart_app"), clear_data: z.boolean().optional() }),
  z.object({ do: z.literal("background_app"), seconds: z.number().int().min(1).max(60) }),
  z.object({ do: z.literal("open_url"), url: z.string() }),
  z.object({ do: z.literal("rotate"), orientation: z.enum(["portrait", "landscape"]) }),
  z.object({
    do: z.literal("environment"),
    settings: z.object({
      appearance: z.enum(["dark", "light"]).optional(),
      locale: z.string().optional(),
      font_scale: z.number().optional(),
      location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
      network: z.enum(["offline", "online"]).optional(),
    }),
  }),
  z.object({
    do: z.literal("wait"),
    ms: z.number().int().min(0).max(30_000).optional(),
    for: z.enum(["idle", "text", "text_gone"]).optional(),
    text: z.string().optional(),
    timeout_ms: z.number().int().optional(),
  }),
  z.object({
    do: z.literal("expect"),
    expect: z.enum(["visible", "not_visible", "text", "screen", "no_crash", "app_running"]),
    target: Target.optional(),
    value: z.string().optional(),
    match: z.enum(["equals", "contains"]).optional(),
    timeout_ms: z.number().int().min(0).max(30_000).optional(),
    baseline: z.string().optional().describe("screen: baseline file name (set by test_expect)"),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("screen: allowed share of changed pixels (default 0.02)"),
    ignore: z.array(Region).optional().describe("screen: regions to ignore, as screen fractions"),
  }),
]);
export type Step = z.infer<typeof Step>;

export const TestInput = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,60}$/)
    .optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  platforms: z
    .array(z.enum(["android", "ios"]))
    .min(1)
    .default(["android", "ios"]),
  tags: z.array(z.string().max(40)).max(20).default([]),
  setup: z
    .object({ restart_app: z.boolean().default(true), clear_data: z.boolean().default(false) })
    .default({ restart_app: true, clear_data: false }),
  steps: z.array(Step).min(1).max(300),
});
export type TestInput = z.infer<typeof TestInput>;

export interface TestCase extends Omit<TestInput, "id"> {
  id: string;
  appId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  recordedOn?: { sessionId: string; platform: Platform; build: string };
}

export type TestStatus = "passed" | "failed" | "error" | "skipped";
export type Classification = "new" | "stable" | "regression" | "fixed" | "still_failing";

export interface StepResult {
  index: number;
  label: string;
  status: "passed" | "failed" | "error";
  ms: number;
  message?: string;
}

export interface TestResult {
  testId: string;
  testName: string;
  testVersion: number;
  status: TestStatus;
  classification?: Classification;
  previous?: { runId: string; status: TestStatus; build: string; at: string; testVersion: number };
  durationMs: number;
  failedStep?: number;
  message?: string;
  steps: StepResult[];
  /** Paths relative to the session folder. */
  evidence: string[];
}

export interface BuildRef {
  sha256: string;
  fileName: string;
  appVersion?: string;
  appBuild?: string;
}

export interface TestRun {
  id: string;
  sessionId: string;
  platform: Platform;
  device?: string;
  build: BuildRef;
  startedAt: string;
  finishedAt?: string;
  state: "running" | "done" | "failed";
  testIds: string[];
  tests: TestResult[];
  error?: string;
}

export const buildLabel = (b: BuildRef) =>
  `${b.appVersion ? `v${b.appVersion}${b.appBuild ? ` (${b.appBuild})` : ""} ` : ""}${b.sha256.slice(0, 8)}`;

export function stepLabel(s: Step): string {
  const t = (x?: Target) =>
    !x
      ? ""
      : x.id
        ? `#${x.id}`
        : x.text
          ? `"${x.text}"`
          : x.x !== undefined
            ? `(${Math.round((x.x ?? 0) * 100)}%, ${Math.round((x.y ?? 0) * 100)}%)`
            : "?";
  switch (s.do) {
    case "tap":
      return `${s.count === 2 ? "double-tap" : "tap"} ${t(s.target)}`;
    case "long_press":
      return `long-press ${t(s.target)}`;
    case "type":
      return `type ${s.secret ? "•••" : JSON.stringify(s.text)}${s.target ? ` into ${t(s.target)}` : ""}`;
    case "key":
      return `key ${s.key}`;
    case "scroll":
      return `scroll ${s.direction}${s.target ? ` in ${t(s.target)}` : ""}`;
    case "swipe":
      return `swipe ${t(s.from)} → ${t(s.to)}`;
    case "drag":
      return `drag ${t(s.from)} → ${t(s.to)}`;
    case "answer_dialog":
      return `answer dialog "${s.button}"`;
    case "environment":
      return `environment ${JSON.stringify(s.settings)}`;
    case "wait":
      return s.for ? `wait for ${s.for}${s.text ? ` "${s.text}"` : ""}` : `wait ${s.ms ?? 0} ms`;
    case "expect":
      return `expect ${s.expect}${s.target ? ` ${t(s.target)}` : ""}${s.value !== undefined ? ` ${s.match ?? "equals"} "${s.value}"` : ""}`;
    default:
      return s.do.replace("_", " ");
  }
}

// ---- Storage ----------------------------------------------------------------------------------

export class TestStore {
  readonly testsDir: string;
  readonly runsDir: string;

  constructor(dataDir: string) {
    this.testsDir = join(dataDir, "tests");
    this.runsDir = join(dataDir, "test-runs");
  }

  dir(id: string) {
    if (!/^[a-z0-9_][a-z0-9-_]{0,80}$/.test(id))
      throw new SessionError("bad_args", `invalid test id ${id}`);
    return join(this.testsDir, id);
  }

  async list(): Promise<TestCase[]> {
    const ids = await readdir(this.testsDir).catch(() => [] as string[]);
    const out: TestCase[] = [];
    for (const id of ids) {
      if (id.startsWith("_")) continue;
      const t = await this.get(id).catch(() => null);
      if (t) out.push(t);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<TestCase> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), "test.json"), "utf8")) as TestCase;
    } catch {
      throw new SessionError("not_found", `no test ${id}`);
    }
  }

  async save(input: TestInput, extra: Partial<TestCase> = {}): Promise<TestCase> {
    const base = slug(input.name);
    let id = input.id ?? base;
    const existing = input.id ? await this.get(input.id).catch(() => null) : null;
    if (!input.id) {
      // A new test never overwrites another one by name.
      for (let i = 2; await this.get(id).catch(() => null); i++) id = `${base}-${i}`;
    }
    const now = new Date().toISOString();
    const test: TestCase = {
      ...(existing ?? {}),
      ...extra,
      ...input,
      id,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await mkdir(join(this.dir(id), "baselines"), { recursive: true });
    await writeFile(join(this.dir(id), "test.json"), `${JSON.stringify(test, null, 2)}\n`);
    return test;
  }

  async delete(id: string) {
    await rm(this.dir(id), { recursive: true, force: true });
  }

  baselinePath(id: string, file: string) {
    if (!/^[\w.-]+$/.test(file)) throw new SessionError("bad_args", "invalid baseline name");
    return join(this.dir(id), "baselines", file);
  }

  /** Moves baselines recorded before the test had an id into its folder. */
  async adoptBaselines(fromDir: string, id: string) {
    const files = await readdir(fromDir).catch(() => [] as string[]);
    await mkdir(join(this.dir(id), "baselines"), { recursive: true });
    for (const f of files) await rename(join(fromDir, f), this.baselinePath(id, f));
    await rm(fromDir, { recursive: true, force: true });
  }

  async saveRun(run: TestRun) {
    await mkdir(this.runsDir, { recursive: true });
    const tmp = join(this.runsDir, `${run.id}.json.tmp`);
    await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`);
    await rename(tmp, join(this.runsDir, `${run.id}.json`));
  }

  /** A run by its id or the id's first characters (like session ids). */
  async getRun(id: string): Promise<TestRun> {
    if (!/^[0-9a-f-]{4,36}$/.test(id)) throw new SessionError("bad_args", "invalid run id");
    if (id.length < 36) {
      const names = await readdir(this.runsDir).catch(() => [] as string[]);
      const hits = names.filter((n) => n.startsWith(id) && n.endsWith(".json"));
      if (hits.length > 1) throw new SessionError("bad_args", `run id ${id} is ambiguous`);
      id = hits[0]?.slice(0, -5) ?? id;
    }
    try {
      return JSON.parse(await readFile(join(this.runsDir, `${id}.json`), "utf8")) as TestRun;
    } catch {
      throw new SessionError("not_found", `no test run ${id}`);
    }
  }

  async runs(): Promise<TestRun[]> {
    const names = await readdir(this.runsDir).catch(() => [] as string[]);
    const out: TestRun[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const r = await this.getRun(n.slice(0, -5)).catch(() => null);
      if (r) out.push(r);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return s.length >= 2 ? s : `test-${randomUUID().slice(0, 8)}`;
}

// ---- Targets ----------------------------------------------------------------------------------

const INTERACTIVE = new Set(["button", "link", "checkbox", "switch", "tab", "cell", "text_field"]);

/** A portable target for an element (identity), or for a point when there is no element. */
export function targetFor(
  el: UiElement | null,
  point: { x: number; y: number } | null,
  view: { width: number; height: number },
  tree: UiTree | null,
): Target {
  if (el) {
    const target: Target = {};
    if (el.stableId) target.id = el.stableId;
    else if (el.label || el.text) target.text = (el.label ?? el.text) as string;
    if (target.id || target.text) {
      target.role = el.role;
      // Disambiguate when the same identity appears more than once on that screen.
      if (tree) {
        const same = tree.elements.filter((e) => matches(e, target));
        const nth = same.findIndex((e) => e.ref === el.ref);
        if (same.length > 1 && nth >= 0) target.nth = nth;
      }
      return target;
    }
    const c = center(el.bounds);
    point = point ?? c;
  }
  const p = point ?? { x: 0, y: 0 };
  return {
    x: Math.round((p.x / view.width) * 1000) / 1000,
    y: Math.round((p.y / view.height) * 1000) / 1000,
  };
}

function matches(e: UiElement, t: Target, loose = false): boolean {
  if (
    t.role &&
    e.role !== t.role &&
    !(loose && INTERACTIVE.has(e.role) && INTERACTIVE.has(t.role))
  ) {
    return false;
  }
  if (t.id) return e.stableId === t.id;
  if (t.text) {
    const want = t.text.trim().toLowerCase();
    const have = [e.label, e.text, e.hint].map((v) => v?.trim().toLowerCase());
    return loose ? have.some((v) => v?.includes(want)) : have.some((v) => v === want);
  }
  return false;
}

/** The element a target means on this screen: exact identity first, then looser matches. */
export function findTarget(tree: UiTree, t: Target): UiElement | null {
  if (!t.id && !t.text) return null;
  for (const loose of [false, true]) {
    const hits = tree.elements.filter((e) => matches(e, t, loose));
    if (hits.length === 0) continue;
    const visible = hits.filter((e) => !e.covered);
    const pool = visible.length > 0 ? visible : hits;
    return pool[Math.min(t.nth ?? 0, pool.length - 1)] ?? null;
  }
  return null;
}

// ---- Screen comparison -------------------------------------------------------------------------

/** Share of pixels that differ visibly between two screens (ignoring regions given as fractions). */
export async function screenDifference(
  a: Buffer,
  b: Buffer,
  ignore: { x: number; y: number; width: number; height: number }[] = [],
): Promise<{ changed: number; diffImage: Buffer }> {
  const W = 180;
  const H = 390;
  const prep = (img: Buffer) =>
    sharp(img).resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer();
  const [x, y] = await Promise.all([prep(a), prep(b)]);
  const mask = new Uint8Array(W * H);
  for (const r of ignore) {
    for (let yy = Math.floor(r.y * H); yy < Math.min(H, Math.ceil((r.y + r.height) * H)); yy++) {
      for (let xx = Math.floor(r.x * W); xx < Math.min(W, Math.ceil((r.x + r.width) * W)); xx++) {
        mask[yy * W + xx] = 1;
      }
    }
  }
  const diff = Buffer.alloc(W * H * 3);
  let changed = 0;
  let counted = 0;
  for (let i = 0; i < W * H; i++) {
    const v = y[i] ?? 0;
    diff[i * 3] = diff[i * 3 + 1] = diff[i * 3 + 2] = Math.round(v * 0.35);
    if (mask[i]) continue;
    counted += 1;
    if (Math.abs((x[i] ?? 0) - v) > 28) {
      changed += 1;
      diff[i * 3] = 255;
      diff[i * 3 + 1] = 40;
      diff[i * 3 + 2] = 80;
    }
  }
  const diffImage = await sharp(diff, { raw: { width: W, height: H, channels: 3 } })
    .resize(W * 2, H * 2, { kernel: "nearest" })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { changed: counted ? changed / counted : 0, diffImage };
}

/** The status bar band (and home indicator), as fractions, ignored by screen comparisons. */
export function systemBands(
  device: DeviceInfo,
): { x: number; y: number; width: number; height: number }[] {
  const ds = device.densityScale ?? device.pixelsPerUnit;
  const h = device.screenshotHeight || 1;
  const ios = device.platform === "ios";
  const top = ((ios ? 54 : 30) * ds) / h;
  const bottom = ((ios ? 34 : 20) * ds) / h;
  return [
    { x: 0, y: 0, width: 1, height: top },
    { x: 0, y: 1 - bottom, width: 1, height: bottom },
  ];
}

// ---- Execution --------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs tests on one session; every action goes through the same device operations as tools. */
export class TestExecutor {
  constructor(
    private readonly tests: TestStore,
    private readonly store: Store,
    private readonly s: HubSession,
    private readonly ops: DeviceOps,
    private readonly runsSoFar: () => Promise<TestRun[]>,
  ) {}

  private get view() {
    const t = this.s.transform;
    if (!t) throw new SessionError("not_ready", "no screen geometry");
    return t;
  }

  private async tree(): Promise<UiTree> {
    return this.ops.tree();
  }

  /** Resolves a target to a view point, waiting up to `timeoutMs` for it to appear. */
  private async locate(
    t: Target,
    timeoutMs = 6_000,
  ): Promise<{ x: number; y: number; el?: UiElement }> {
    if (!t.id && !t.text) {
      if (t.x === undefined || t.y === undefined)
        throw new Error("target has neither identity nor point");
      return { x: t.x * this.view.viewWidth, y: t.y * this.view.viewHeight };
    }
    const deadline = Date.now() + timeoutMs;
    let hidKeyboard = false;
    for (;;) {
      const tree = await this.tree();
      const el = findTarget(tree, t);
      if (el?.covered && !hidKeyboard) {
        // Acting on it would hit a key and type into the focused field.
        hidKeyboard = true;
        await this.ops.act("keyboard", { action: "hide" }).catch(() => undefined);
        continue;
      }
      if (el?.covered) {
        throw new SessionError(
          "covered",
          `element ${t.id ? `#${t.id}` : `"${t.text}"`} is under the keyboard, which could not be hidden`,
        );
      }
      if (el) {
        const c = center(pxToView(this.view, el.bounds));
        return { ...c, el };
      }
      if (Date.now() > deadline) {
        if (t.x !== undefined && t.y !== undefined) {
          return { x: t.x * this.view.viewWidth, y: t.y * this.view.viewHeight };
        }
        throw new Error(`element ${t.id ? `#${t.id}` : `"${t.text}"`} not found on the screen`);
      }
      await sleep(600);
    }
  }

  private device(p: { x: number; y: number }) {
    return this.ops.toDevice(p);
  }

  async action(step: Step, startedAt: number): Promise<string | undefined> {
    const ops = this.ops;
    switch (step.do) {
      case "tap": {
        const p = await this.locate(step.target);
        await ops.act("tap", { ...this.device(p), count: step.count ?? 1 });
        return;
      }
      case "long_press": {
        const p = await this.locate(step.target);
        await ops.act(
          "long_press",
          { ...this.device(p), durationMs: step.duration_ms ?? 800 },
          40_000,
        );
        return;
      }
      case "type": {
        if (step.target) {
          const p = await this.locate(step.target);
          await ops.act("tap", this.device(p));
          await sleep(450);
        }
        await ops.act("type", { text: step.text, mode: step.mode ?? "append" }, 60_000);
        if (step.submit) await ops.act("key", { key: "enter" });
        return;
      }
      case "key":
        await ops.act("key", { key: step.key as KeyName });
        return;
      case "hide_keyboard":
        await ops.act("keyboard", { action: "hide" });
        return;
      case "scroll": {
        const r = step.target
          ? await this.locate(step.target).then((p) =>
              p.el
                ? pxToView(this.view, p.el.bounds)
                : { x: p.x - 50, y: p.y - 150, width: 100, height: 300 },
            )
          : await ops.region({});
        const c = center(r);
        const half = (step.amount ?? 0.6) / 2;
        const vertical = step.direction === "up" || step.direction === "down";
        const sign = step.direction === "down" || step.direction === "right" ? 1 : -1;
        const from = vertical
          ? { x: c.x, y: c.y + sign * r.height * half }
          : { x: c.x + sign * r.width * half, y: c.y };
        const to = vertical
          ? { x: c.x, y: c.y - sign * r.height * half }
          : { x: c.x - sign * r.width * half, y: c.y };
        await ops.act("path", {
          points: [this.device(from), this.device(to)],
          durationMs: 450,
          endHoldMs: 150,
        });
        return;
      }
      case "swipe":
      case "drag": {
        const from = await this.locate(step.from);
        const to = await this.locate(step.to);
        const drag = step.do === "drag";
        await ops.act(
          "path",
          {
            points: [this.device(from), this.device(to)],
            durationMs: drag ? 1_000 : (step.duration_ms ?? 300),
            ...(drag ? { holdMs: step.hold_ms ?? 600, endHoldMs: 200 } : {}),
          },
          40_000,
        );
        return;
      }
      case "answer_dialog":
        await ops.answerDialog(step.button);
        return;
      case "restart_app":
        await ops.act("app", { action: "restart", clearData: step.clear_data ?? false }, 120_000);
        await sleep(1_500);
        return;
      case "background_app":
        await ops.act(
          "app",
          { action: "background", seconds: step.seconds },
          60_000 + step.seconds * 1000,
        );
        return;
      case "open_url":
        await ops.act("app", { action: "open_url", url: step.url }, 60_000);
        return;
      case "rotate":
        await ops.act("orientation", { set: step.orientation });
        await sleep(800);
        await ops.capture();
        return;
      case "environment": {
        const s = step.settings;
        const args: CommandArgs<"env"> = {
          ...(s.appearance ? { appearance: s.appearance } : {}),
          ...(s.locale !== undefined ? { locale: s.locale } : {}),
          ...(s.font_scale !== undefined ? { fontScale: s.font_scale } : {}),
          ...(s.location ? { location: s.location } : {}),
          ...(s.network ? { network: s.network } : {}),
        };
        for (const [k, v] of Object.entries(args)) {
          const out = await ops.act("env", { [k]: v } as CommandArgs<"env">, 45_000);
          const bad = out.data.results.find((r) => !r.ok);
          if (bad) return `environment ${bad.setting} not applied: ${bad.message}`;
        }
        return;
      }
      case "wait": {
        if (!step.for) {
          await sleep(step.ms ?? 1_000);
          return;
        }
        const deadline = Date.now() + (step.timeout_ms ?? 10_000);
        if (step.for === "idle") {
          let prev = (await ops.capture()).full;
          while (Date.now() < deadline) {
            await sleep(400);
            const next = (await ops.capture()).full;
            if ((await screenDifference(prev, next)).changed < 0.002) return;
            prev = next;
          }
          return;
        }
        const want = (step.text ?? "").toLowerCase();
        while (Date.now() < deadline) {
          const tree = await this.tree();
          const found = tree.elements.some((e) =>
            [e.label, e.text, e.hint].some((v) => v?.toLowerCase().includes(want)),
          );
          if (found === (step.for === "text")) return;
          await sleep(600);
        }
        throw new Error(
          `timed out waiting for "${step.text}" to ${step.for === "text" ? "appear" : "disappear"}`,
        );
      }
      case "expect":
        await this.expect(step, startedAt);
        return;
    }
  }

  /** Throws when the expectation does not hold within its timeout. */
  async expect(step: Extract<Step, { do: "expect" }>, startedAt: number, testId?: string) {
    const timeout = step.timeout_ms ?? 5_000;
    const deadline = Date.now() + timeout;
    switch (step.expect) {
      case "visible":
      case "not_visible": {
        if (!step.target) throw new Error("expectation needs a target");
        for (;;) {
          const el = findTarget(await this.tree(), step.target);
          const ok = step.expect === "visible" ? el !== null && !el.covered : el === null;
          if (ok) return;
          if (Date.now() > deadline) {
            throw new Error(
              step.expect === "visible"
                ? `${stepLabel(step).replace("expect visible ", "")} is not on the screen${el?.covered ? " (it is under the keyboard)" : ""}`
                : `${stepLabel(step).replace("expect not_visible ", "")} is still on the screen`,
            );
          }
          await sleep(600);
        }
      }
      case "text": {
        if (!step.target || step.value === undefined)
          throw new Error("text expectation needs a target and a value");
        let last = "";
        for (;;) {
          const el = findTarget(await this.tree(), step.target);
          // iOS often reports the same string as label and value.
          const have = el
            ? [...new Set([el.text, el.label].filter(Boolean).map((v) => (v as string).trim()))]
            : [];
          last = have.join(" | ");
          const want = step.value.trim();
          const ok =
            step.match === "contains" ? have.some((v) => v.includes(want)) : have.includes(want);
          if (ok) return;
          if (Date.now() > deadline) {
            throw new Error(
              el ? `expected "${want}", found "${last}"` : "the element is not on the screen",
            );
          }
          await sleep(600);
        }
      }
      case "app_running": {
        const out = await this.ops.command("app", { action: "state" });
        if (out.data.state !== 4) throw new Error(`the app is ${out.data.stateName}`);
        return;
      }
      case "no_crash": {
        const out = await this.ops.command("crashes", { sinceMs: startedAt }, 60_000);
        const crash = out.data.reports.find((r) => r.source !== "app_not_running");
        if (crash) throw new Error(`crash: ${crash.summary}`);
        if (out.data.reports.length) throw new Error("the app is not running");
        return;
      }
      case "screen": {
        if (!step.baseline || !testId) throw new Error("screen expectation without a baseline");
        const baseline = await readFile(this.tests.baselinePath(testId, step.baseline));
        const device = this.s.record.device as DeviceInfo;
        const ignore = [...systemBands(device), ...(step.ignore ?? [])];
        let best = 1;
        let diff: Buffer | null = null;
        for (;;) {
          const { full } = await this.ops.capture();
          const now = await toView(full, this.view);
          const d = await screenDifference(baseline, now, ignore);
          if (d.changed <= (step.threshold ?? 0.02)) return;
          if (d.changed < best) {
            best = d.changed;
            diff = await contactSheet(
              [
                { data: baseline, label: "baseline" },
                { data: now, label: "now" },
                { data: d.diffImage, label: "difference" },
              ],
              { maxEdge: 1400 },
            ).then((c) => c.image);
          }
          if (Date.now() > deadline) {
            const err = new Error(
              `the screen differs from the baseline: ${(best * 100).toFixed(1)} % of pixels changed (allowed ${((step.threshold ?? 0.02) * 100).toFixed(1)} %)`,
            ) as Error & { image?: Buffer };
            if (diff) err.image = diff;
            throw err;
          }
          await sleep(700);
        }
      }
    }
  }

  /** Runs the tests one after another and records results into the run file as it goes. */
  async run(run: TestRun, tests: TestCase[], stopOnFailure: boolean): Promise<TestRun> {
    const history = await this.runsSoFar();
    for (const test of tests) {
      const started = Date.now();
      const result: TestResult = {
        testId: test.id,
        testName: test.name,
        testVersion: test.version,
        status: "passed",
        durationMs: 0,
        steps: [],
        evidence: [],
      };
      run.tests.push(result);
      if (!test.platforms.includes(run.platform)) {
        result.status = "skipped";
        result.message = `test is for ${test.platforms.join(", ")}`;
        await this.tests.saveRun(run);
        continue;
      }
      try {
        if (test.setup.clear_data || test.setup.restart_app) {
          await this.ops.act(
            "app",
            { action: "restart", clearData: test.setup.clear_data },
            120_000,
          );
          await sleep(2_000);
        }
        for (let i = 0; i < test.steps.length; i++) {
          const step = test.steps[i] as Step;
          const t0 = Date.now();
          try {
            const warning =
              step.do === "expect"
                ? await this.expect(step, started, test.id)
                : await this.action(step, started);
            result.steps.push({
              index: i + 1,
              label: stepLabel(step),
              status: "passed",
              ms: Date.now() - t0,
              ...(warning ? { message: warning } : {}),
            });
            if (step.do !== "expect" && step.do !== "wait") await sleep(600);
          } catch (error) {
            const e = error as Error & { image?: Buffer };
            const deviceProblem = error instanceof SessionError;
            result.steps.push({
              index: i + 1,
              label: stepLabel(step),
              status: deviceProblem ? "error" : "failed",
              ms: Date.now() - t0,
              message: e.message,
            });
            result.status = deviceProblem ? "error" : "failed";
            result.failedStep = i + 1;
            result.message = `step ${i + 1} (${stepLabel(step)}): ${e.message}`;
            result.evidence = await this.evidence(run, test, e.image);
            break;
          }
        }
        // A crash anywhere in the test fails it even when every expectation held.
        if (result.status === "passed") {
          const crashes = await this.ops
            .command("crashes", { sinceMs: started }, 60_000)
            .catch(() => null);
          const crash = crashes?.data.reports.find((r) => r.source !== "app_not_running");
          if (crash) {
            result.status = "failed";
            result.message = `the app crashed during the test: ${crash.summary}`;
            result.evidence = await this.evidence(run, test);
          }
        }
      } catch (error) {
        result.status = "error";
        result.message = (error as Error).message;
      }
      result.durationMs = Date.now() - started;
      Object.assign(result, classify(result, run, history));
      await this.tests.saveRun(run);
      if (stopOnFailure && result.status !== "passed") break;
    }
    return run;
  }

  /** Screenshot, UI tree and recent logs of the failure, in the session's evidence folder. */
  private async evidence(run: TestRun, test: TestCase, extra?: Buffer): Promise<string[]> {
    const base = `evidence/tests/${run.id}/${test.id}`;
    const files: string[] = [];
    try {
      const { full } = await this.ops.capture();
      files.push(
        this.store.relative(
          this.s.id,
          await this.store.writeFile(this.s.id, `${base}/screen.jpg`, full),
        ),
      );
      const tree = await this.ops.tree();
      files.push(
        this.store.relative(
          this.s.id,
          await this.store.writeFile(this.s.id, `${base}/tree.txt`, this.ops.formatTree(tree)),
        ),
      );
      const logs = await this.ops.command("logs", {
        sinceMs: Date.now() - 60_000,
        appOnly: true,
        maxLines: 300,
      });
      files.push(
        this.store.relative(
          this.s.id,
          await this.store.writeFile(this.s.id, `${base}/logs.txt`, logs.data.lines.join("\n")),
        ),
      );
    } catch {
      // Evidence is best effort: the device may be the reason the step failed.
    }
    if (extra) {
      files.push(
        this.store.relative(
          this.s.id,
          await this.store.writeFile(this.s.id, `${base}/screen-diff.jpg`, extra),
        ),
      );
    }
    return files;
  }
}

/** How this result compares with the latest result of the same test on another build. */
export function classify(
  result: TestResult,
  run: TestRun,
  history: TestRun[],
): Pick<TestResult, "classification" | "previous"> {
  // An error means TapScout could not perform a step (device timeout, lost session): it says
  // nothing about the app, so it is neither compared nor used as the earlier result.
  if (result.status === "skipped" || result.status === "error") return {};
  for (const prev of history) {
    if (prev.id === run.id || prev.platform !== run.platform) continue;
    if (prev.build.sha256 === run.build.sha256) continue;
    const r = prev.tests.find(
      (x) => x.testId === result.testId && x.status !== "skipped" && x.status !== "error",
    );
    if (!r) continue;
    const passedBefore = r.status === "passed";
    const passedNow = result.status === "passed";
    return {
      classification: passedBefore
        ? passedNow
          ? "stable"
          : "regression"
        : passedNow
          ? "fixed"
          : "still_failing",
      previous: {
        runId: prev.id,
        status: r.status,
        build: buildLabel(prev.build),
        at: prev.startedAt,
        testVersion: r.testVersion,
      },
    };
  }
  return { classification: "new" };
}

// ---- Recording ----------------------------------------------------------------------------------

export interface Recording {
  name: string;
  description?: string;
  platforms?: Platform[];
  tags: string[];
  setup: { restart_app: boolean; clear_data: boolean };
  steps: Step[];
  startedAt: string;
  /** Baselines captured before the test has an id. */
  baselineDir: string;
}

/** Turns a successful tool call into a test step (null when the tool is not a step). */
export function stepFromTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: { target: (slot?: "from" | "to") => Target | null },
): Step | null {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const num = (k: string) => (typeof args[k] === "number" ? (args[k] as number) : undefined);
  const flag = (k: string) => args[k] === true;
  switch (tool) {
    case "device_tap": {
      const el = str("element") ?? "";
      if (el.startsWith("alert:")) return { do: "answer_dialog", button: el.slice(6) };
      const target = ctx.target();
      const count = num("count");
      return target ? { do: "tap", target, ...(count && count !== 1 ? { count } : {}) } : null;
    }
    case "device_long_press": {
      const target = ctx.target();
      const duration = num("duration_ms");
      return target
        ? { do: "long_press", target, ...(duration ? { duration_ms: duration } : {}) }
        : null;
    }
    case "device_type": {
      const target = str("element") ? ctx.target() : null;
      return {
        do: "type",
        ...(target ? { target } : {}),
        text: str("text") ?? "",
        ...(str("mode") === "replace" ? { mode: "replace" as const } : {}),
        ...(flag("submit") ? { submit: true } : {}),
        ...(flag("secret") ? { secret: true } : {}),
      };
    }
    case "device_key":
      return { do: "key", key: str("key") ?? "enter" };
    case "device_keyboard":
      return str("action") === "hide" ? { do: "hide_keyboard" } : null;
    case "device_scroll": {
      const target = str("element") ? ctx.target() : null;
      const direction = (str("direction") ?? "down") as "up" | "down" | "left" | "right";
      const amount = num("amount");
      return {
        do: "scroll",
        direction,
        ...(target ? { target } : {}),
        ...(amount ? { amount } : {}),
      };
    }
    case "device_swipe":
    case "device_drag": {
      const from = ctx.target("from");
      const to = ctx.target("to");
      if (!from || !to) return null;
      if (tool === "device_swipe") {
        const duration = num("duration_ms");
        return { do: "swipe", from, to, ...(duration ? { duration_ms: duration } : {}) };
      }
      const hold = num("hold_ms");
      return { do: "drag", from, to, ...(hold !== undefined ? { hold_ms: hold } : {}) };
    }
    case "app_restart":
      return { do: "restart_app", ...(flag("clear_data") ? { clear_data: true } : {}) };
    case "app_control": {
      const action = str("action");
      if (action === "background")
        return { do: "background_app", seconds: Math.max(1, num("seconds") ?? 3) };
      const url = str("url");
      if (action === "open_url" && url) return { do: "open_url", url };
      if (action === "clear_data") return { do: "restart_app", clear_data: true };
      return null;
    }
    case "device_rotate":
      return {
        do: "rotate",
        orientation: str("orientation") === "landscape" ? "landscape" : "portrait",
      };
    case "device_environment": {
      const settings: Record<string, unknown> = {};
      for (const k of ["appearance", "locale", "font_scale", "location", "network"]) {
        if (args[k] !== undefined) settings[k] = args[k];
      }
      return Object.keys(settings).length
        ? {
            do: "environment",
            settings: settings as Extract<Step, { do: "environment" }>["settings"],
          }
        : null;
    }
    case "device_wait": {
      const kind = (str("for") ?? "idle") as "idle" | "text" | "text_gone";
      const text = str("text");
      const timeout = num("timeout_ms");
      return {
        do: "wait",
        for: kind,
        ...(text ? { text } : {}),
        ...(timeout ? { timeout_ms: timeout } : {}),
      };
    }
    default:
      return null;
  }
}

export function newRun(s: HubSession, testIds: string[]): TestRun {
  const r = s.record;
  const d = r.device;
  return {
    id: randomUUID(),
    sessionId: r.id,
    platform: r.platform,
    ...(d ? { device: `${d.deviceName} · ${d.platform} ${d.osVersion}` } : {}),
    build: {
      sha256: r.build.sha256,
      fileName: r.build.fileName,
      ...(d?.appVersion ? { appVersion: d.appVersion } : {}),
      ...(d?.appBuild ? { appBuild: d.appBuild } : {}),
    },
    startedAt: new Date().toISOString(),
    state: "running",
    testIds,
    tests: [],
  };
}

export type { Rect };
