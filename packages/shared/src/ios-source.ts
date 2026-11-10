// iOS page source in two steps. WDA's `visible` attribute is ~90% of the source's cost (probe run
// 137cb3ce, Ice Cubes: 6–7.7 s with it, 0.5–0.7 s without, same elements). It only matters where
// something covers part of the app; elsewhere the screen bounds check already drops what is off
// screen. So the source is read without it first, and again in full only when it is needed.

/** Attributes left out of the fast source; the observer reads none of them as present. */
export const FAST_SOURCE_EXCLUDED = "visible,accessible,index";

/**
 * Covers only `visible` can resolve: keyboard, alert, sheet, popover. A dimming overlay is no
 * sign: iOS 26 keeps an "AdditionalDimmingOverlay" in every Ice Cubes screen.
 */
const COVERING =
  /<XCUIElementType(Keyboard|Alert|Sheet)\b|name="[^"]*PopoverDismiss[^"]*"|label="dismiss popup"/;
/** A screen presented over another (SwiftUI keeps the presenter in the tree behind it). */
const STACKED = /name="[^"]*PresentationHosting[^"]*"/;
const NAMED = /\s(name|label|value)="[^"]+"/;

const navigationBars = (xml: string) =>
  (xml.match(/<XCUIElementTypeNavigationBar\b/g) ?? []).length;

/** Content in a window after the app's own one (alerts, keyboard host, overlays). */
function secondWindow(xml: string): boolean {
  // [0] is what precedes the first window; [1] is the app's own window.
  const windows = xml.split("<XCUIElementTypeWindow").slice(2);
  return windows.some((w) => NAMED.test(w.slice(w.indexOf(">") + 1)));
}

/**
 * The fast source made usable, or null when only the full source will do. A screen presented
 * over another is resolved without `visible`: the screens behind it are marked not visible
 * (`markScreensBehind`).
 */
export function usableFastSource(fastXml: string): string | null {
  if (COVERING.test(fastXml) || secondWindow(fastXml)) return null;
  if (STACKED.test(fastXml) || navigationBars(fastXml) > 1) return markScreensBehind(fastXml);
  return fastXml;
}

interface TagNode {
  tag: string;
  /** Offset of "<", of the start tag's closing ">" (or "/>"), and past the element's end. */
  start: number;
  headEnd: number;
  end: number;
  parent: TagNode | null;
}

const TAGS =
  /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

function scan(xml: string): TagNode[] | null {
  const nodes: TagNode[] = [];
  const stack: TagNode[] = [];
  for (const m of xml.matchAll(TAGS)) {
    const [whole, closing, tag, , selfClosing] = m;
    if (!tag) continue;
    const at = m.index ?? 0;
    if (closing) {
      const open = stack.pop();
      if (!open || open.tag !== tag) return null;
      open.end = at + whole.length;
      continue;
    }
    const node: TagNode = {
      tag,
      start: at,
      headEnd: at + whole.length - (selfClosing ? 2 : 1),
      end: at + whole.length,
      parent: stack[stack.length - 1] ?? null,
    };
    nodes.push(node);
    if (!selfClosing) stack.push(node);
  }
  return stack.length === 0 ? nodes : null;
}

const contains = (outer: TagNode, inner: TagNode) =>
  inner.start >= outer.start && inner.end <= outer.end;

/**
 * A screen presented over another, read without `visible`: the last navigation bar in document
 * order belongs to the screen in front (UIKit and SwiftUI add a presented screen after its
 * presenter). Every subtree that holds an earlier bar but not that one is a screen behind it;
 * its elements get visible="false", as the full source would report them. Null when the
 * structure does not show this plainly.
 */
export function markScreensBehind(fastXml: string): string | null {
  const nodes = scan(fastXml);
  if (!nodes) return null;
  const bars = nodes.filter((n) => n.tag === "XCUIElementTypeNavigationBar");
  const front = bars[bars.length - 1];
  if (!front || bars.length < 2) return null;
  const behind = new Set<TagNode>();
  for (const bar of bars.slice(0, -1)) {
    // The highest ancestor of this bar that does not also hold the front screen's bar.
    let root: TagNode = bar;
    while (root.parent && !contains(root.parent, front)) root = root.parent;
    if (!root.parent || contains(root, front)) return null;
    behind.add(root);
  }
  const hidden = nodes.filter(
    (n) => n.tag.startsWith("XCUIElementType") && [...behind].some((r) => contains(r, n)),
  );
  let out = fastXml;
  for (const n of hidden.sort((a, b) => b.headEnd - a.headEnd)) {
    out = `${out.slice(0, n.headEnd)} visible="false"${out.slice(n.headEnd)}`;
  }
  return out;
}
