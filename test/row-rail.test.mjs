/**
 * The sub-session guide rail must meet the collapse button above it.
 *
 * The bug (m00002 ⑤): the rail was positioned with a fixed offset from the
 * row's left edge, while the `.twist` chevron it belongs to moves with the
 * indentation. At depth 1 the line therefore sat ~22px left of the chevron.
 *
 * The geometry is not one formula, because the name cell keeps an 8px padding
 * at depth 0 and zeroes it deeper down:
 *
 *   depth 0 row: 32px check column + 8px name padding, twist at -4px → centre 43px
 *   depth d row: 32px check column + d*16px indent, twist at -4px → centre 19 + d*16
 *
 * So a child at depth d hangs its rail under the centre of its parent's chevron
 * at depth d-1: 43 for depth 1, and 19 + d*16 from depth 2 on.
 *
 * This file pins both halves of that agreement: the value SessionRow computes,
 * and the CSS rule that consumes it.
 */
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// ── the CSS half ───────────────────────────────────────────────────────────
test("the rail is drawn at the row's own --rail, not a fixed offset", () => {
  assert.match(
    source,
    /\.se-shell \.row\.sub-row::after\{left:calc\(var\(--rail, 43px\) - \.5px\)\}/,
    "the rail rule follows the per-row --rail",
  );
  // The retired rule anchored the line to --indent plus a constant; that is the
  // shape that drifted away from the chevron.
  assert.doesNotMatch(source, /\.se-shell \.row\.sub-row::after\{left:calc\(var\(--indent,0px\) \+ 5px\)\}/);
});

// ── the row half ───────────────────────────────────────────────────────────
// The components are module-private, so the bundle is loaded with one extra
// export line, exactly like test/render-smoke.mjs does.
const React = {
  // PanelBoundary extends this, so the stub needs a base class even though this
  // file never renders it.
  Component: class {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
    setState() {}
  },
  createElement: (type, props, ...children) => {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged, children };
  },
  Fragment: Symbol("Fragment"),
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};
const store = new Map();
let mod = null;
globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => { mod = factory((name) => {
    if (name === "react") return React;
    throw new Error("unexpected require: " + name);
  }); } },
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
  innerWidth: 1280,
  innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  getElementById: () => null,
  createTextNode: () => ({}),
};
globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: {} }), status: 200 });

const bundle = source.replace(
  "    exports.apply = apply;",
  "    exports.__test = { SessionRow };\n    exports.apply = apply;",
);
new Function("window", "document", "navigator", "fetch", bundle)(
  globalThis.window,
  globalThis.document,
  { clipboard: { writeText: async () => {} } },
  globalThis.fetch,
);
if (!mod) throw new Error("the module factory did not run");
const { SessionRow } = mod.__test;

const noop = () => {};
const session = {
  id: "session-child",
  title: "子会话",
  displayTitle: "子会话",
  workspaceId: "ws-1",
  workspaceTitle: "project",
  cwd: "C:\\work",
  activityAt: 0,
  createdAt: 0,
  sizeBytes: 0,
  tags: [],
  note: "",
  isSubagent: true,
  parentSession: "session-parent",
  delegationDepth: 1,
};

/** Render one row and hand back the props of its root element. */
function rowAt(depth) {
  const element = SessionRow({
    session,
    selected: false,
    now: Date.now(),
    onSelect: noop,
    checked: false,
    onCheck: noop,
    depth,
    childCount: 0,
    onBeginRename: noop,
    rename: null,
  });
  return element.props;
}

test("a top-level row draws no rail and carries no indent", () => {
  const props = rowAt(0);
  assert.doesNotMatch(props.className, /\bsub-row\b/);
  assert.equal(props.style, undefined);
});

test("a child row hangs its rail under the parent's chevron", () => {
  // Depth 1: the parent is a depth-0 row, whose twist centre is 43px.
  assert.equal(rowAt(1).style["--rail"], "43px");
  assert.equal(rowAt(1).style["--indent"], "16px");
  // Depth 2 and deeper: the parent zeroed the 8px name padding, so the centre
  // is 19px + indent.
  assert.equal(rowAt(2).style["--rail"], "51px");
  assert.equal(rowAt(3).style["--rail"], "67px");
  // From depth 2 on every level moves right by exactly one indent step, so the
  // rail and the name cell never drift apart. Depth 1 to 2 is the one 8px step:
  // depth 0 is the row that still pays the name cell's padding.
  for (const depth of [3, 4]) {
    assert.equal(
      parseFloat(rowAt(depth).style["--rail"]) - parseFloat(rowAt(depth - 1).style["--rail"]),
      16,
      `depth ${depth} sits one step right of depth ${depth - 1}`,
    );
  }
  assert.equal(parseFloat(rowAt(2).style["--rail"]) - parseFloat(rowAt(1).style["--rail"]), 8);
});

test("the rail value is per row, so a nested row never reads its ancestor's", () => {
  // Both depths are computed from the row's own depth; a shared CSS variable
  // would make depth 2 inherit depth 1's 43px and drift.
  assert.notEqual(rowAt(1).style["--rail"], rowAt(2).style["--rail"]);
  assert.match(rowAt(1).className, /\bsub-row\b/);
});
