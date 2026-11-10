#!/usr/bin/env node
// Calls one TapScout MCP tool from the command line, exactly as an agent would, and saves any
// images it returns. Handy for scripting and for checking a session by hand.
//   node packages/hub/dist/call.js <tool> ['<json arguments>'] [--out <dir>]
//   node packages/hub/dist/call.js --list

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? (argv[outIdx + 1] ?? ".") : ".");
const positional = outIdx >= 0 ? argv.filter((_, i) => i !== outIdx && i !== outIdx + 1) : argv;
const config = loadConfig();
const client = new Client({ name: "tapscout-call", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.uiPort}/mcp`)),
);

if (positional[0] === "--list" || positional.length === 0) {
  for (const t of (await client.listTools()).tools)
    console.log(`${t.name}: ${t.description?.split(". ")[0]}`);
  await client.close();
  process.exit(0);
}

const [name, json] = positional;
const started = Date.now();
const result = await client.callTool(
  { name: name as string, arguments: json ? (JSON.parse(json) as Record<string, unknown>) : {} },
  undefined,
  { timeout: 120_000 },
);
const content = result.content as {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}[];
let n = 0;
for (const c of content) {
  if (c.type === "text") console.log(c.text);
  if (c.type === "image" && c.data) {
    await mkdir(outDir, { recursive: true });
    const file = join(
      outDir,
      `${name}-${Date.now()}-${++n}.${c.mimeType === "image/png" ? "png" : "jpg"}`,
    );
    await writeFile(file, Buffer.from(c.data, "base64"));
    console.log(`[image saved: ${file}]`);
  }
}
console.log(`[${result.isError ? "ERROR" : "ok"} in ${Date.now() - started} ms]`);
await client.close();
process.exit(result.isError ? 1 : 0);
