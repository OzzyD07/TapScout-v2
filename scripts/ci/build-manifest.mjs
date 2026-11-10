#!/usr/bin/env node
// Writes <file>.manifest.json next to a sample or benchmark build: hash, size, variant, source
// commit and toolchain. The ground-truth defect list is never part of this manifest (docs/04 §6).
// Benchmark builds (docs/07 A5) pass --app, --benchmark <key> and the upstream --source/--ref.
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    platform: { type: "string" },
    variant: { type: "string" },
    arch: { type: "string" },
    toolchain: { type: "string", default: "" },
    app: { type: "string", default: "FieldNotes" },
    benchmark: { type: "string" },
    source: { type: "string" },
    ref: { type: "string" },
  },
});
if (!values.file || !values.platform || !values.variant) {
  console.error(
    "usage: build-manifest.mjs --file <path> --platform android|ios --variant <v> [--arch] [--toolchain]",
  );
  process.exit(2);
}

const bytes = await readFile(values.file);
const manifest = {
  app: values.app,
  benchmark: values.benchmark ?? null,
  upstream: values.source ? { source: values.source, ref: values.ref ?? null } : null,
  platform: values.platform,
  environment: values.platform === "ios" ? "ios_simulator" : "android_emulator",
  variant: values.variant,
  arch: values.arch ?? null,
  file: basename(values.file),
  sizeBytes: (await stat(values.file)).size,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sourceCommit: process.env.GITHUB_SHA ?? null,
  workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  toolchain: values.toolchain,
  builtAt: new Date().toISOString(),
};
await writeFile(`${values.file}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const mb = (manifest.sizeBytes / 1024 / 1024).toFixed(1);
  await writeFile(
    process.env.GITHUB_STEP_SUMMARY,
    `| ${manifest.file} | ${mb} MB | \`${manifest.sha256.slice(0, 16)}…\` |\n`,
    { flag: "a" },
  );
}
