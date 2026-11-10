// File-based storage: one folder per session under the data dir. No database: a personal hub has
// a handful of sessions, and plain JSON/JSONL/JPEG files are easy to inspect and delete.
//
//   sessions/<id>/session.json   the session record (rewritten atomically)
//   sessions/<id>/events.jsonl   activity: state changes, tool calls, runner events
//   sessions/<id>/findings.json  findings the agent recorded
//   sessions/<id>/evidence/...   agent views, captures, runner uploads (logs, crashes, recordings)
//   sessions/<id>/build/...      the build served to the runner

import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, normalize, relative, resolve, sep } from "node:path";
import type { DeviceInfo, Platform } from "@tapscout/shared";

export type SessionState =
  | "queued"
  | "dispatching"
  | "waiting_for_runner"
  | "preparing"
  | "ready"
  | "disconnected"
  | "stopping"
  | "closed"
  | "failed";

export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(["closed", "failed"]);

export interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  platform: Platform;
  target: "github" | "local";
  label?: string;
  build: { fileName: string; path: string; sizeBytes: number; sha256: string };
  appId?: string;
  state: SessionState;
  stateMessage: string;
  device?: DeviceInfo;
  github?: { runId?: number; runUrl?: string; status?: string; conclusion?: string; step?: string };
  local?: { pid?: number; avd?: string; serial?: string; udid?: string };
  options: { maxMinutes: number; idleMinutes: number };
  /** sha256 of the one-time local runner token (the token itself is never stored). */
  localTokenHash?: string;
  /** Device environment settings the agent changed (setting → applied value). */
  environment?: Record<string, string>;
  readyAt?: string;
  closedAt?: string;
  closeReason?: string;
}

export interface Finding {
  id: string;
  createdAt: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  status: "confirmed" | "suspected" | "not_a_bug";
  category?: string;
  description: string;
  steps?: string[];
  expected?: string;
  actual?: string;
  evidence: string[];
}

export interface EvidenceItem {
  id: string;
  createdAt: string;
  label: string;
  note?: string;
  files: string[];
}

export type SessionEvent =
  | { kind: "state"; state: SessionState; message: string }
  | {
      kind: "tool";
      tool: string;
      args: Record<string, unknown>;
      ok: boolean;
      summary: string;
      images?: string[];
      ms: number;
    }
  | { kind: "runner"; level: "info" | "warn" | "error"; message: string }
  | { kind: "finding"; id: string; title: string; severity: string }
  | { kind: "evidence"; id: string; label: string }
  | { kind: "file"; name: string; sizeBytes: number };

export type StoredEvent = SessionEvent & { ts: string; seq: number };

export class Store {
  constructor(readonly dataDir: string) {}

  sessionDir(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid session id");
    return join(this.dataDir, "sessions", id);
  }

  /** A path inside the session folder; refuses anything that would leave it. */
  sessionPath(id: string, ...parts: string[]): string {
    const base = resolve(this.sessionDir(id));
    const full = resolve(base, normalize(join(...parts)));
    if (full !== base && !full.startsWith(base + sep)) throw new Error("path escapes the session");
    return full;
  }

  relative(id: string, full: string): string {
    return relative(this.sessionDir(id), full).split(sep).join("/");
  }

  async init() {
    await mkdir(join(this.dataDir, "sessions"), { recursive: true });
  }

  /**
   * Writes the record atomically (temp file + rename). Saves of one session are serialised:
   * concurrent state changes would otherwise race on the rename (Windows refuses it).
   */
  save(record: SessionRecord): Promise<void> {
    const previous = this.saving.get(record.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        record.updatedAt = new Date().toISOString();
        const dir = this.sessionDir(record.id);
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `session.json.${process.pid}.${++this.saveSeq}.tmp`);
        await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
        await rename(tmp, join(dir, "session.json"));
      });
    this.saving.set(record.id, next);
    void next.finally(() => {
      if (this.saving.get(record.id) === next) this.saving.delete(record.id);
    });
    return next;
  }

  private readonly saving = new Map<string, Promise<void>>();
  private saveSeq = 0;

  async load(id: string): Promise<SessionRecord | null> {
    try {
      return JSON.parse(await readFile(join(this.sessionDir(id), "session.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async list(): Promise<SessionRecord[]> {
    let ids: string[] = [];
    try {
      ids = await readdir(join(this.dataDir, "sessions"));
    } catch {
      return [];
    }
    const out: SessionRecord[] = [];
    for (const id of ids) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const r = await this.load(id);
      if (r) out.push(r);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async appendEvent(id: string, event: StoredEvent): Promise<void> {
    await appendFile(join(this.sessionDir(id), "events.jsonl"), `${JSON.stringify(event)}\n`);
  }

  async events(id: string, limit = 500): Promise<StoredEvent[]> {
    try {
      const text = await readFile(join(this.sessionDir(id), "events.jsonl"), "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .map((l) => JSON.parse(l) as StoredEvent);
    } catch {
      return [];
    }
  }

  async findings(id: string): Promise<Finding[]> {
    try {
      return JSON.parse(await readFile(join(this.sessionDir(id), "findings.json"), "utf8"));
    } catch {
      return [];
    }
  }

  async saveFindings(id: string, findings: Finding[]) {
    await writeFile(
      join(this.sessionDir(id), "findings.json"),
      `${JSON.stringify(findings, null, 2)}\n`,
    );
  }

  async evidence(id: string): Promise<EvidenceItem[]> {
    try {
      return JSON.parse(await readFile(join(this.sessionDir(id), "evidence.json"), "utf8"));
    } catch {
      return [];
    }
  }

  async saveEvidence(id: string, items: EvidenceItem[]) {
    await writeFile(
      join(this.sessionDir(id), "evidence.json"),
      `${JSON.stringify(items, null, 2)}\n`,
    );
  }

  /** Writes a file under the session folder (creating directories) and returns its path. */
  async writeFile(id: string, rel: string, data: Buffer | string): Promise<string> {
    const full = this.sessionPath(id, rel);
    await mkdir(resolve(full, ".."), { recursive: true });
    await writeFile(full, data);
    return full;
  }
}
