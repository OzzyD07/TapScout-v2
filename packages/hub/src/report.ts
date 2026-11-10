// Session report written from what the agent recorded: findings (its judgement), evidence
// bundles, runner files (logs, crash reports, recordings) and an activity summary.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { HubSession } from "./session.js";
import type { Store } from "./store.js";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

async function walkFiles(dir: string, base = ""): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const info = await stat(full);
    const rel = base ? `${base}/${name}` : name;
    if (info.isDirectory()) out.push(...(await walkFiles(full, rel)));
    else out.push({ rel, size: info.size });
  }
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function buildReport(
  s: HubSession,
  store: Store,
  fileUrl: (rel: string) => string,
): Promise<{ markdown: string; html: string; mdPath: string; htmlPath: string }> {
  const r = s.record;
  const findings = (await store.findings(s.id)).sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const evidence = await store.evidence(s.id);
  const events = await store.events(s.id, 100_000);
  const tools = events.filter((e) => e.kind === "tool");
  const counts = new Map<string, number>();
  for (const e of tools) if (e.kind === "tool") counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
  const runnerFiles = await walkFiles(
    store.sessionPath(s.id, "evidence", "runner"),
    "evidence/runner",
  );
  const d = r.device;

  const md: string[] = [];
  md.push(`# TapScout session report${r.label ? `: ${r.label}` : ""}`, "");
  md.push(`- Session: \`${r.id}\` (${r.target}, ${r.platform})`);
  md.push(
    `- Build: ${r.build.fileName} (${r.build.sizeBytes} bytes, sha256 \`${r.build.sha256.slice(0, 16)}…\`)`,
  );
  if (d)
    md.push(
      `- Device: ${d.deviceName}, ${d.platform} ${d.osVersion} (${d.host === "github" ? "GitHub-hosted runner" : "local"}), app \`${d.appId}\``,
    );
  if (r.github?.runUrl) md.push(`- GitHub run: ${r.github.runUrl}`);
  md.push(
    `- Started: ${r.createdAt}${r.readyAt ? `, ready ${r.readyAt}` : ""}${r.closedAt ? `, ended ${r.closedAt} (${r.closeReason})` : ` — state: ${r.state}`}`,
  );
  md.push(
    `- Agent actions: ${tools.length} tool calls (${[...counts.entries()].map(([k, v]) => `${k} ×${v}`).join(", ") || "none"})`,
    "",
  );

  md.push(`## Findings (${findings.length})`, "");
  if (findings.length === 0) md.push("The agent recorded no findings.", "");
  for (const f of findings) {
    md.push(`### [${f.severity.toUpperCase()}] ${f.title}`, "");
    md.push(
      `Status: ${f.status}${f.category ? ` · Category: ${f.category}` : ""} · ${f.createdAt}`,
      "",
    );
    md.push(f.description, "");
    if (f.steps?.length) md.push("Steps:", ...f.steps.map((x, i) => `${i + 1}. ${x}`), "");
    if (f.expected) md.push(`Expected: ${f.expected}`, "");
    if (f.actual) md.push(`Actual: ${f.actual}`, "");
    for (const id of f.evidence) {
      const ev = evidence.find((e) => e.id === id);
      if (!ev) continue;
      md.push(`Evidence ${ev.id} — ${ev.label}${ev.note ? `: ${ev.note}` : ""}`);
      for (const file of ev.files) {
        md.push(/\.(jpe?g|png)$/i.test(file) ? `![${file}](${file})` : `- [${file}](${file})`);
      }
      md.push("");
    }
  }

  md.push(`## Evidence (${evidence.length})`, "");
  for (const ev of evidence) {
    md.push(
      `- ${ev.id} · ${ev.createdAt} · ${ev.label}${ev.note ? ` — ${ev.note}` : ""}: ${ev.files.map((f) => `[${f.split("/").pop()}](${f})`).join(", ")}`,
    );
  }
  md.push("", `## Device files (${runnerFiles.length})`, "");
  for (const f of runnerFiles) md.push(`- [${f.rel}](${f.rel}) (${f.size} bytes)`);
  md.push("");
  const markdown = md.join("\n");

  // HTML: the same content with images and links served by the local hub.
  const htmlParts: string[] = [];
  htmlParts.push(`<h1>TapScout session report${r.label ? `: ${esc(r.label)}` : ""}</h1>`);
  htmlParts.push(
    `<p>${esc(`${r.platform} · ${r.target} · ${d ? `${d.deviceName} ${d.osVersion}` : ""} · ${r.build.fileName}`)}${r.github?.runUrl ? ` · <a href="${esc(r.github.runUrl)}">GitHub run</a>` : ""}</p>`,
  );
  htmlParts.push(`<h2>Findings (${findings.length})</h2>`);
  for (const f of findings) {
    htmlParts.push(
      `<section class="finding ${f.severity}"><h3>[${f.severity.toUpperCase()}] ${esc(f.title)}</h3><p><em>${esc(f.status)}${f.category ? ` · ${esc(f.category)}` : ""}</em></p><p>${esc(f.description)}</p>`,
    );
    if (f.steps?.length)
      htmlParts.push(`<ol>${f.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`);
    if (f.expected) htmlParts.push(`<p><b>Expected:</b> ${esc(f.expected)}</p>`);
    if (f.actual) htmlParts.push(`<p><b>Actual:</b> ${esc(f.actual)}</p>`);
    for (const id of f.evidence) {
      const ev = evidence.find((e) => e.id === id);
      for (const file of ev?.files ?? []) {
        htmlParts.push(
          /\.(jpe?g|png)$/i.test(file)
            ? `<img src="${fileUrl(file)}" alt="${esc(file)}">`
            : `<a href="${fileUrl(file)}">${esc(file)}</a> `,
        );
      }
    }
    htmlParts.push("</section>");
  }
  htmlParts.push(
    `<h2>Device files</h2><ul>${runnerFiles.map((f) => `<li><a href="${fileUrl(f.rel)}">${esc(f.rel)}</a> (${f.size} bytes)</li>`).join("")}</ul>`,
  );
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TapScout report</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1d1d22;background:#fafafa}img{max-width:280px;margin:4px;border:1px solid #ccc;border-radius:6px}.finding{border-left:4px solid #888;padding:4px 12px;margin:12px 0;background:#fff}.critical,.high{border-color:#d33}.medium{border-color:#e90}.low,.info{border-color:#39c}</style></head><body>${htmlParts.join("\n")}</body></html>`;
  const mdPath = await store.writeFile(s.id, "report.md", markdown);
  const htmlPath = await store.writeFile(s.id, "report.html", html);
  return { markdown, html, mdPath, htmlPath };
}
