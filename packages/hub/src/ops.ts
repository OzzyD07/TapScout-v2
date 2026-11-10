// Device operations in the agent's view space, shared by the MCP tools and the web UI's manual
// controls: screenshots, UI tree, element resolution, actions with an optional observation
// afterwards, frame captures and the images the agent was actually shown.

import {
  type CommandArgs,
  type CommandName,
  center,
  clipViewRect,
  iosDriverAlert,
  normalizeTree,
  type Point,
  pxToView,
  type Rect,
  type RunnerAction,
  type UiElement,
  type UiTree,
  type ViewTransform,
  viewToDevice,
} from "@tapscout/shared";
import { annotate, contactSheet, diffScore, toView } from "./images.js";
import { type HubSession, SessionError } from "./session.js";
import type { Store } from "./store.js";

export type Observe = "screenshot" | "tree" | "both" | "none";

export interface ImagePart {
  data: Buffer;
  mimeType: "image/jpeg";
  /** Path relative to the session folder where the image the agent saw is kept. */
  saved: string;
}

export interface OpResult {
  text: string;
  images: ImagePart[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (ms: number) => new Date(ms).toISOString().slice(11, 23);

export function describeElement(e: UiElement, t: ViewTransform): string {
  const r = pxToView(t, e.bounds);
  const name =
    e.label && e.text && e.label !== e.text
      ? `"${e.label}" text="${e.text}"`
      : e.label || e.text
        ? `"${e.label ?? e.text}"`
        : "";
  const flags = [
    e.stableId ? `#${e.stableId}` : "",
    e.hint ? `hint="${e.hint}"` : "",
    !e.enabled ? "disabled" : "",
    e.focused ? "focused" : "",
    e.checked !== undefined ? (e.checked ? "checked" : "unchecked") : "",
    e.selected ? "selected" : "",
    e.scrollable ? "scrollable" : "",
    e.longClickable ? "long-clickable" : "",
    e.masked ? "secret" : "",
    e.covered ? "UNDER-KEYBOARD" : "",
  ].filter(Boolean);
  return `${e.ref} ${e.role}${name ? ` ${name}` : ""} @(${r.x},${r.y} ${r.width}×${r.height})${flags.length ? ` ${flags.join(" ")}` : ""}`;
}

export class DeviceOps {
  constructor(
    readonly s: HubSession,
    private readonly store: Store,
  ) {}

  private get t(): ViewTransform {
    if (!this.s.transform) {
      throw new SessionError("not_ready", "the device is not ready yet; call session_status");
    }
    return this.s.transform;
  }

  private requireReady() {
    if (!this.s.ready) {
      throw new SessionError(
        "not_ready",
        `the device is not ready (state: ${this.s.record.state} — ${this.s.record.stateMessage})`,
      );
    }
  }

  coordinateNote(): string {
    const t = this.t;
    return `View space: ${t.viewWidth}×${t.viewHeight} units (= pixels of the default screenshot); x right, y down.`;
  }

  toDevice(p: Point): Point {
    return viewToDevice(this.t, p);
  }

  async command<N extends CommandName>(name: N, args: CommandArgs<N>, timeoutMs = 30_000) {
    this.requireReady();
    return this.s.command(name, args as object, timeoutMs);
  }

  /** A command that may change the screen: invalidates element refs. */
  async act<N extends CommandName>(name: N, args: CommandArgs<N>, timeoutMs = 30_000) {
    const out = await this.command(name, args, timeoutMs);
    this.s.actionSeq += 1;
    return out;
  }

  // ---- Observation ---------------------------------------------------------------------

  /** Fresh full-resolution screenshot (JPEG); updates the transform on rotation. */
  async capture(): Promise<{ full: Buffer; capturedAt: number }> {
    const out = await this.command("screenshot", { format: "jpeg", quality: 90 });
    if (!out.payload) throw new SessionError("no_image", "the runner returned no image");
    this.s.refreshTransform(out.data.width, out.data.height);
    this.s.lastScreen = { full: out.payload, capturedAt: out.data.capturedAt };
    return this.s.lastScreen;
  }

  async saveAgentImage(data: Buffer, tool: string): Promise<ImagePart> {
    const n = ++this.s.agentImageSeq;
    const rel = `evidence/agent/${String(n).padStart(4, "0")}-${tool}.jpg`;
    await this.store.writeFile(this.s.id, rel, data);
    return { data, mimeType: "image/jpeg", saved: rel };
  }

  async screenshot(opts: { annotate?: "none" | "elements" | "grid" | "both"; tool: string }) {
    const { full, capturedAt } = await this.capture();
    let view = await toView(full, this.t);
    let tree: UiTree | null = null;
    const mode = opts.annotate ?? "none";
    if (mode !== "none") {
      if (mode === "elements" || mode === "both") tree = await this.tree();
      const marks = (tree?.elements ?? [])
        .filter((e) => e.clickable || e.role === "text_field" || e.scrollable)
        .map((e) => ({ label: e.ref, rect: pxToView(this.t, e.bounds) }));
      view = await annotate(view, this.t, { marks, grid: mode === "grid" || mode === "both" });
    }
    const image = await this.saveAgentImage(view, opts.tool);
    const lines = [
      `Screenshot ${this.t.viewWidth}×${this.t.viewHeight} at ${fmtTime(capturedAt)} UTC. ${this.coordinateNote()}`,
    ];
    if (tree)
      lines.push(
        `Boxes show element refs from a UI tree read just now:`,
        this.formatTree(tree, { interactiveOnly: true }),
      );
    return { text: lines.join("\n"), images: [image] };
  }

  async tree(opts: { includeAll?: boolean; maxElements?: number } = {}): Promise<UiTree> {
    const out = await this.command("source", {} as CommandArgs<"source">);
    const d = this.s.record.device;
    if (!d) throw new SessionError("not_ready", "no device info");
    const tree = normalizeTree(d.platform, out.data.xml, {
      scale: d.pixelsPerUnit,
      maxElements: opts.maxElements ?? 250,
      includeAll: opts.includeAll ?? false,
    });
    const alert = out.data.alert;
    if (alert && !tree.dialog) tree.dialog = iosDriverAlert(alert.text, alert.buttons);
    if (d.platform === "android") {
      const kb = await this.command("keyboard", { action: "status" }).catch(() => null);
      tree.keyboardVisible = kb?.data.shown ?? false;
    }
    if (tree.widthPx && tree.heightPx) this.s.refreshTransform(tree.widthPx, tree.heightPx);
    this.s.lastTree = { tree, capturedAt: out.data.capturedAt, seq: this.s.actionSeq };
    return tree;
  }

  formatTree(tree: UiTree, opts: { filter?: string; interactiveOnly?: boolean } = {}): string {
    const t = this.t;
    const appId = this.s.record.device?.appId;
    const head: string[] = [];
    head.push(
      `Screen ${t.viewWidth}×${t.viewHeight} view units${tree.title ? ` · title "${tree.title}"` : ""}${tree.topPackage && appId && tree.topPackage !== appId ? ` · FOREGROUND IS ${tree.topPackage}, not ${appId}` : ""}`,
    );
    head.push(
      `Keyboard: ${tree.keyboardVisible ? "shown" : "hidden"}${tree.loading ? " · Loading indicator visible" : ""}${tree.systemUi ? ` · iOS system UI: ${tree.systemUi}` : ""}`,
    );
    if (tree.dialog) {
      const buttons = tree.dialog.buttons
        .map((b) => {
          const r = b.bounds ? pxToView(t, b.bounds) : null;
          return r ? `[${b.label} @(${center(r).x},${center(r).y})]` : `[${b.label}]`;
        })
        .join(" ");
      head.push(
        `Dialog (${tree.dialog.kind}${tree.dialog.viaDriver ? ', system alert: answer with device_tap element="alert:<button>"' : ""}): "${tree.dialog.title}"${tree.dialog.message ? ` — ${tree.dialog.message}` : ""} ${buttons}`,
      );
    }
    let elements = tree.elements;
    if (opts.interactiveOnly) {
      elements = elements.filter((e) => e.clickable || e.role === "text_field" || e.scrollable);
    }
    if (opts.filter) {
      const f = opts.filter.toLowerCase();
      elements = elements.filter((e) =>
        [e.label, e.text, e.stableId, e.hint].some((v) => v?.toLowerCase().includes(f)),
      );
    }
    const lines = elements.map((e) => describeElement(e, t));
    const tail =
      tree.omitted > 0 ? [`(${tree.omitted} more elements omitted; raise max_elements)`] : [];
    return [...head, ...lines, ...tail].join("\n");
  }

  // ---- Targets -------------------------------------------------------------------------

  private match(tree: UiTree, spec: string): UiElement | null {
    const els = tree.elements;
    if (/^e\d+$/.test(spec)) return els.find((e) => e.ref === spec) ?? null;
    const [kind, ...rest] = spec.split(":");
    const value = (rest.length > 0 ? rest.join(":") : spec).trim().toLowerCase();
    const byId = (e: UiElement) => e.stableId?.toLowerCase() === value;
    const byText = (e: UiElement) =>
      [e.label, e.text, e.hint].some((v) => v?.toLowerCase() === value);
    const byContains = (e: UiElement) =>
      [e.label, e.text, e.hint].some((v) => v?.toLowerCase().includes(value));
    const pick = (pred: (e: UiElement) => boolean) => {
      const hits = els.filter(pred);
      return (
        hits.find((e) => (e.clickable || e.role === "text_field") && !e.covered) ?? hits[0] ?? null
      );
    };
    if (rest.length > 0 && kind === "id") return pick(byId);
    if (rest.length > 0 && (kind === "text" || kind === "label"))
      return pick(byText) ?? pick(byContains);
    return pick(byId) ?? pick(byText) ?? pick(byContains);
  }

  /** Same element in a newer tree: identity first, nearest position as the tiebreak. */
  private rematch(old: UiElement, tree: UiTree): UiElement | null {
    const same = tree.elements.filter(
      (e) =>
        e.role === old.role &&
        (e.stableId ?? "") === (old.stableId ?? "") &&
        (e.label ?? "") === (old.label ?? "") &&
        (old.masked || e.role === "text_field" || (e.text ?? "") === (old.text ?? "")),
    );
    const c = center(old.bounds);
    return (
      same.sort(
        (a, b) =>
          Math.hypot(center(a.bounds).x - c.x, center(a.bounds).y - c.y) -
          Math.hypot(center(b.bounds).x - c.x, center(b.bounds).y - c.y),
      )[0] ?? null
    );
  }

  /** Resolves an element spec (ref "e12", "id:…", "text:…" or plain text) to its view rect. */
  async resolveElement(spec: string): Promise<{ element: UiElement; rect: Rect; note: string }> {
    const last = this.s.lastTree;
    const fresh = last && last.seq === this.s.actionSeq;
    let note = "";
    let el: UiElement | null = null;
    if (/^e\d+$/.test(spec)) {
      if (!last)
        throw new SessionError(
          "no_tree",
          `no UI tree yet; call device_ui_tree before using ${spec}`,
        );
      const old = last.tree.elements.find((e) => e.ref === spec);
      if (!old) throw new SessionError("bad_ref", `${spec} is not in the last UI tree`);
      if (fresh) el = old;
      else {
        const tree = await this.tree();
        el = this.rematch(old, tree);
        if (!el) {
          throw new SessionError(
            "stale_ref",
            `${spec} (${old.role} "${old.label ?? old.text ?? old.stableId ?? ""}") is no longer on screen; read the UI tree again`,
          );
        }
        if (el.ref !== spec) note = ` (${spec} is now ${el.ref})`;
      }
    } else {
      const tree = await this.tree();
      el = this.match(tree, spec);
      if (!el)
        throw new SessionError("not_found", `no element matches "${spec}" on the current screen`);
    }
    const rect = pxToView(this.t, el.bounds);
    if (el.covered) note += " — WARNING: it is under the keyboard; hide the keyboard first";
    if (!el.enabled) note += " — note: the element is disabled";
    return { element: el, rect, note };
  }

  /** A view point from x/y or an element spec (centre of the element, or a point inside it). */
  async point(a: { x?: number; y?: number; element?: string; offset?: { x: number; y: number } }) {
    if (a.element) {
      const r = await this.resolveElement(a.element);
      const c = center(r.rect);
      const p = a.offset ? { x: r.rect.x + a.offset.x, y: r.rect.y + a.offset.y } : c;
      return {
        point: p,
        label: `${r.element.ref} ${r.element.role} "${r.element.label ?? r.element.text ?? r.element.stableId ?? ""}"${r.note}`,
        rect: r.rect,
      };
    }
    if (typeof a.x !== "number" || typeof a.y !== "number") {
      throw new SessionError("bad_args", "give x and y (view units) or element");
    }
    const t = this.t;
    if (a.x < 0 || a.y < 0 || a.x >= t.viewWidth || a.y >= t.viewHeight) {
      throw new SessionError(
        "out_of_screen",
        `(${a.x}, ${a.y}) is outside the screen ${t.viewWidth}×${t.viewHeight}`,
      );
    }
    return { point: { x: a.x, y: a.y }, label: `(${a.x}, ${a.y})`, rect: null as Rect | null };
  }

  /** Scroll region in view units: an element, a rect, or the middle of the screen. */
  async region(a: { element?: string; region?: Rect }): Promise<Rect> {
    if (a.element) return (await this.resolveElement(a.element)).rect;
    if (a.region) {
      const r = clipViewRect(this.t, a.region);
      if (!r) throw new SessionError("out_of_screen", "the region is outside the screen");
      return r;
    }
    const t = this.t;
    return {
      x: 0,
      y: Math.round(t.viewHeight * 0.15),
      width: t.viewWidth,
      height: Math.round(t.viewHeight * 0.7),
    };
  }

  /** Answers the dialog in front by button label: a tap when it has bounds, the driver otherwise. */
  async answerDialog(label: string): Promise<string> {
    const tree = await this.tree();
    const d = tree.dialog;
    if (!d) throw new SessionError("no_dialog", "no dialog or system alert is on screen");
    const want = label.trim().toLowerCase();
    const b =
      d.buttons.find((x) => x.label.toLowerCase() === want) ??
      d.buttons.find((x) => x.label.toLowerCase().includes(want));
    if (!b) {
      throw new SessionError(
        "not_found",
        `"${label}" is not a button of "${d.title}"; buttons: ${d.buttons.map((x) => x.label).join(", ")}`,
      );
    }
    if (b.bounds) {
      await this.act("tap", this.toDevice(center(pxToView(this.t, b.bounds))));
    } else {
      await this.act("alert", { button: b.label });
    }
    return `answered ${d.kind} "${d.title}" with "${b.label}"`;
  }

  // ---- After an action -----------------------------------------------------------------

  async observe(mode: Observe, settleMs: number, tool: string): Promise<OpResult> {
    if (mode === "none") return { text: "", images: [] };
    if (settleMs > 0) await sleep(settleMs);
    const parts: string[] = [];
    const images: ImagePart[] = [];
    if (mode === "screenshot" || mode === "both") {
      const { full, capturedAt } = await this.capture();
      images.push(await this.saveAgentImage(await toView(full, this.t), tool));
      parts.push(`Screen after the action (${fmtTime(capturedAt)} UTC):`);
    }
    if (mode === "tree" || mode === "both") {
      parts.push(this.formatTree(await this.tree(), {}));
    }
    return { text: parts.join("\n"), images };
  }

  // ---- Frames --------------------------------------------------------------------------

  /** Picks up to `max` frames that differ visibly from the previously picked one. */
  async selectDistinct<T extends { data: Buffer }>(frames: T[], max: number): Promise<T[]> {
    if (frames.length <= max) return frames;
    const picked: T[] = [];
    let last: T | null = null;
    for (const f of frames) {
      if (!last || (await diffScore(last.data, f.data)) > 0.006) {
        picked.push(f);
        last = f;
      }
    }
    const lastFrame = frames[frames.length - 1] as T;
    if (picked[picked.length - 1] !== lastFrame) picked.push(lastFrame);
    if (picked.length <= max) return picked;
    const step = (picked.length - 1) / (max - 1);
    return Array.from({ length: max }, (_, i) => picked[Math.round(i * step)] as T);
  }

  async sheet(frames: { data: Buffer; capturedAt: number }[], zeroAt: number, tool: string) {
    const sheet = await contactSheet(
      frames.map((f) => ({
        data: f.data,
        label: `${((f.capturedAt - zeroAt) / 1000).toFixed(2)} s`,
      })),
    );
    return { sheet, image: await this.saveAgentImage(sheet.image, tool) };
  }

  /** A runner action from a tool's action spec, with targets resolved now. */
  async runnerAction(spec: {
    type: "tap" | "double_tap" | "long_press" | "swipe" | "key" | "restart_app" | "launch_app";
    x?: number;
    y?: number;
    element?: string;
    to_x?: number;
    to_y?: number;
    key?: CommandArgs<"key">["key"];
    duration_ms?: number;
  }): Promise<{ action: RunnerAction; label: string }> {
    switch (spec.type) {
      case "tap":
      case "double_tap":
      case "long_press": {
        const p = await this.point(spec);
        const d = this.toDevice(p.point);
        if (spec.type === "long_press") {
          return {
            action: { name: "long_press", args: { ...d, durationMs: spec.duration_ms ?? 800 } },
            label: `long press ${p.label}`,
          };
        }
        return {
          action: { name: "tap", args: { ...d, count: spec.type === "double_tap" ? 2 : 1 } },
          label: `${spec.type.replace("_", " ")} ${p.label}`,
        };
      }
      case "swipe": {
        const from = await this.point(spec);
        if (typeof spec.to_x !== "number" || typeof spec.to_y !== "number") {
          throw new SessionError("bad_args", "a swipe action needs to_x and to_y");
        }
        return {
          action: {
            name: "path",
            args: {
              points: [this.toDevice(from.point), this.toDevice({ x: spec.to_x, y: spec.to_y })],
              durationMs: spec.duration_ms ?? 300,
            },
          },
          label: `swipe ${from.label} → (${spec.to_x}, ${spec.to_y})`,
        };
      }
      case "key":
        if (!spec.key) throw new SessionError("bad_args", "a key action needs key");
        return { action: { name: "key", args: { key: spec.key } }, label: `key ${spec.key}` };
      case "restart_app":
        return { action: { name: "app", args: { action: "restart" } }, label: "restart app" };
      case "launch_app":
        return { action: { name: "app", args: { action: "launch" } }, label: "launch app" };
    }
  }
}
