// Quality tools: visual audit of a screen and performance measurements. They measure and point;
// the agent judges and records findings.

import { type CommandArgs, type PerfReport, pxToView } from "@tapscout/shared";
import { z } from "zod";
import { ALL_CHECKS, type AuditCheck, auditScreen } from "./audit.js";
import { annotate, toView } from "./images.js";
import { actionSchema, sessionId, type ToolKit } from "./mcp.js";
import { SessionError } from "./session.js";

const CHECK_COLORS: Record<AuditCheck, string> = {
  contrast: "#ff2d95",
  small_target: "#ff9500",
  missing_label: "#af52de",
  overlap: "#ff3b30",
  offscreen: "#ff3b30",
  truncated: "#ffcc00",
  misaligned: "#34c759",
  system_area: "#0a84ff",
};

const fmt = (v: number | undefined, unit = "") => (v === undefined ? "–" : `${v}${unit}`);

export function formatPerf(r: PerfReport): string {
  const lines: string[] = [];
  const p = r.process;
  if (p) {
    lines.push(
      `Process ${p.pid}: CPU ${fmt(p.cpuPercent, " % of one core")} · RSS ${fmt(p.rssMb, " MB")}${p.pssMb !== undefined ? ` · PSS ${p.pssMb} MB` : ""}${p.javaHeapMb !== undefined ? ` · Java heap ${p.javaHeapMb} MB` : ""}${p.nativeHeapMb !== undefined ? ` · native heap ${p.nativeHeapMb} MB` : ""}${p.graphicsMb !== undefined ? ` · graphics ${p.graphicsMb} MB` : ""}${p.threads !== undefined ? ` · ${p.threads} threads` : ""}`,
    );
  }
  if (r.samples?.length) {
    const cpu = r.samples.map((s) => s.cpuPercent);
    const rss = r.samples.map((s) => s.rssMb);
    const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
    lines.push(
      `${r.samples.length} samples: CPU avg ${avg(cpu)} % / max ${Math.max(...cpu)} % · RSS ${Math.min(...rss)}→${rss[rss.length - 1]} MB (max ${Math.max(...rss)})`,
      `Timeline (s: CPU %, RSS MB): ${r.samples.map((s) => `${(s.atMs / 1000).toFixed(1)}: ${s.cpuPercent}/${s.rssMb}`).join(" · ")}`,
    );
  }
  if (r.launch) {
    const l = r.launch;
    lines.push(
      `${l.kind === "cold" ? "Cold" : "Warm"} start: ${l.totalTimeMs !== undefined ? `${l.totalTimeMs} ms${r.environment === "android_emulator" ? " (am start TotalTime)" : " (launch call)"}` : "–"}${l.waitTimeMs !== undefined ? `, WaitTime ${l.waitTimeMs} ms` : ""}${l.launchState ? `, ${l.launchState}` : ""}; screen still after ${fmt(l.visualReadyMs, " ms")}`,
    );
  }
  if (r.visual) {
    const v = r.visual;
    lines.push(
      v.changedFrames === 0
        ? "The screen did not change after the action."
        : `Visual response: first change after ${fmt(v.firstChangeMs, " ms")}, still after ${fmt(v.settledMs, " ms")}; ${v.changedFrames} changed frames${v.visualFps !== undefined ? `, ~${v.visualFps} fps while moving` : ""}${v.longestGapMs !== undefined ? `, longest pause ${v.longestGapMs} ms` : ""} (${v.method})`,
    );
  }
  if (r.action?.actionMs !== undefined || r.action?.error) {
    lines.push(
      `The action call took ${fmt(r.action.actionMs, " ms")}${r.action.error ? ` and FAILED: ${r.action.error}` : ""}`,
    );
  }
  if (r.frames) {
    const f = r.frames;
    lines.push(
      `Frames (gfxinfo): ${f.totalFrames} rendered, ${f.jankyFrames} janky (${f.jankyPercent} %); p50 ${fmt(f.p50Ms, " ms")}, p90 ${fmt(f.p90Ms, " ms")}, p99 ${fmt(f.p99Ms, " ms")}; slow UI thread ${fmt(f.slowUiThread)}, deadline missed ${fmt(f.deadlineMissed)}, slow draw ${fmt(f.slowDrawCommands)}`,
    );
  }
  lines.push(...r.notes.map((n) => `Note: ${n}`));
  return lines.join("\n");
}

export function registerQualityTools({ tool, manager }: ToolKit) {
  tool(
    "device_visual_audit",
    "Check the current screen for visual and accessibility problems: low text contrast (measured on the screenshot), touch targets below 48 dp / 44 pt, controls without labels, overlapping controls or texts, elements cut off at the screen edge, ellipsized text, near-misaligned edges and controls under the status bar / home indicator. Returns numbered candidates with severity and confidence and the screenshot with the same numbers. Candidates are hints: confirm them on the image (or device_zoom) before recording a finding. Run it again after device_environment (dark mode, large text, other languages) or device_rotate to catch problems of those variants.",
    {
      session_id: sessionId,
      checks: z
        .array(z.enum(ALL_CHECKS as [AuditCheck, ...AuditCheck[]]))
        .optional()
        .describe("Subset of checks (default: all)"),
      image: z.boolean().default(true).describe("Return the annotated screenshot"),
      max_issues: z.number().int().min(1).max(100).default(40),
    },
    async (a, use) => {
      const { s, ops } = use(a.session_id);
      const { full } = await ops.capture();
      const tree = await ops.tree();
      const t = s.transform;
      const device = s.record.device;
      if (!t || !device) throw new SessionError("not_ready", "no screen geometry yet");
      const issues = await auditScreen({
        tree,
        full,
        device,
        size: { width: t.screenshotWidth, height: t.screenshotHeight },
        ...(a.checks ? { checks: a.checks } : {}),
      });
      const shown = issues.slice(0, a.max_issues);
      const stamp = Date.now();
      const rel = `evidence/audits/audit-${stamp}.json`;
      const env = s.record.environment ?? {};
      await manager.store.writeFile(
        s.id,
        rel,
        JSON.stringify(
          {
            capturedAt: new Date(stamp).toISOString(),
            title: tree.title,
            environment: env,
            orientation: device.orientation,
            issues: issues.map((i) => ({ ...i, viewRect: pxToView(t, i.rect) })),
          },
          null,
          2,
        ),
      );
      await manager.store.writeFile(s.id, `evidence/audits/audit-${stamp}.jpg`, full);
      const images = [];
      if (a.image) {
        const marks = shown.map((i) => ({
          label: String(i.n),
          rect: pxToView(t, i.rect),
          color: CHECK_COLORS[i.check],
        }));
        images.push(
          await ops.saveAgentImage(
            await annotate(await toView(full, t), t, { marks }),
            "device_visual_audit",
          ),
        );
      }
      const counts = { high: 0, medium: 0, low: 0 };
      for (const i of issues) counts[i.severity] += 1;
      const envText = Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      await s.event({ kind: "audit", file: rel, issues: issues.length, title: tree.title ?? "" });
      const lines = [
        `Visual audit of "${tree.title ?? "screen"}" (${device.orientation}${envText ? `, ${envText}` : ""}): ${issues.length} candidates — ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Coordinates are view units.`,
        ...shown.map((i) => {
          const r = pxToView(t, i.rect);
          return `#${i.n} [${i.severity}, ${i.confidence} confidence] ${i.check}: ${i.message} @(${r.x},${r.y} ${r.width}×${r.height})`;
        }),
      ];
      if (issues.length > shown.length)
        lines.push(`… ${issues.length - shown.length} more in ${rel}`);
      lines.push(`Evidence: ${rel} and the matching screenshot evidence/audits/audit-${stamp}.jpg`);
      return { text: lines.join("\n"), images };
    },
    { readOnly: true },
  );

  tool(
    "device_performance",
    'Measure the app\'s performance. mode "snapshot": CPU over 1 s and memory now; "sample": CPU and memory every interval over a window (idle cost, leaks); "launch": cold or warm start time (Android am start TotalTime; iOS the launch call) and time until the screen is still; "action": performs an action and measures the visual response (first change, time until still, fps while moving, longest pause), CPU during it and, on Android, frame timing and jank from gfxinfo. Emulator/simulator figures share the host machine: compare builds and screens on the same setup.',
    {
      session_id: sessionId,
      mode: z.enum(["snapshot", "sample", "launch", "action"]),
      duration_ms: z
        .number()
        .int()
        .min(800)
        .max(30_000)
        .optional()
        .describe("sample: 2–30 s (default 10 s); action: 0.8–2.5 s (default 2 s)"),
      interval_ms: z.number().int().min(500).max(5_000).optional(),
      cold: z
        .boolean()
        .default(true)
        .describe("launch: cold (process stopped) or warm (from the background)"),
      action: actionSchema.optional().describe("action mode: the action to measure"),
    },
    async (a, use) => {
      const { s, ops } = use(a.session_id);
      const args: CommandArgs<"perf"> = {
        mode: a.mode,
        ...(a.duration_ms ? { durationMs: a.duration_ms } : {}),
        ...(a.interval_ms ? { intervalMs: a.interval_ms } : {}),
        cold: a.cold,
      };
      let label = "";
      if (a.mode === "action") {
        if (!a.action) throw new SessionError("bad_args", "mode action needs an action");
        const act = await ops.runnerAction(a.action);
        args.action = act.action;
        label = act.label;
      }
      const timeout =
        a.mode === "sample"
          ? (a.duration_ms ?? 10_000) + 15_000
          : a.mode === "snapshot"
            ? 20_000
            : 50_000;
      const out =
        a.mode === "snapshot" || a.mode === "sample"
          ? await ops.command("perf", args, timeout)
          : await ops.act("perf", args, timeout);
      const report = out.data;
      const rel = `evidence/perf/perf-${a.mode}-${Date.now()}.json`;
      await manager.store.writeFile(
        s.id,
        rel,
        JSON.stringify({ ...report, label, environment: s.record.environment ?? {} }, null, 2),
      );
      const text = formatPerf(report);
      await s.event({
        kind: "perf",
        mode: a.mode,
        file: rel,
        summary: `${label ? `${label}: ` : ""}${text.split("\n")[0] ?? ""}`.slice(0, 300),
      });
      return { text: `${label ? `Measured: ${label}\n` : ""}${text}\nData: ${rel}`, images: [] };
    },
  );
}
