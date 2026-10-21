/**
 * The list rows must open their own rename editor.
 *
 * `test/render-smoke.mjs` renders each component once with hooks that return
 * their initial values, so it can never see what a *click* does. This file
 * covers that gap for one behaviour that has broken twice: clicking the pencil
 * on a folder/workspace row in the main list must put that row into editing,
 * even if the panel never hands the row a `rename`.
 *
 * It loads the real bundle against a stub React whose `useState` keeps its
 * value across re-renders (hooks are addressed by call order inside one tree,
 * exactly as React resolves them), then clicks the pencil and re-renders.
 */
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { decorateTree } from "../lib/domain/tree-rules.js";

// ── a stub React with real useState ────────────────────────────────────────
const cells = new Map();
let slot = 0;
const resetHooks = () => {
  slot = 0;
};
const React = {
  Component: class {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
    setState() {}
  },
  Fragment: Symbol("Fragment"),
  createElement: (type, props, ...children) => {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged, children };
  },
  createPortal: (node) => node,
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => {
    const key = String(slot++);
    if (!cells.has(key)) cells.set(key, typeof initial === "function" ? initial() : initial);
    return [cells.get(key), (next) => cells.set(key, typeof next === "function" ? next(cells.get(key)) : next)];
  },
  useEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

const store = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      mod = factory(requireShim);
    },
  },
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

let mod = null;
const requireShim = (name) => {
  if (name === "react") return React;
  throw new Error("unexpected require: " + name);
};
// Same trick as render-smoke: append the export line to a copy of the bundle,
// so the production module keeps its private surface.
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8").replace(
  "    exports.apply = apply;",
  "    exports.__test = { ContainerRow };\n    exports.apply = apply;",
);
new Function("window", "document", "navigator", "fetch", source)(
  globalThis.window,
  globalThis.document,
  { clipboard: { writeText: async () => {} } },
  globalThis.fetch,
);
if (!mod) throw new Error("the module factory did not run");
const { ContainerRow } = mod.__test;

/** Evaluate every function component once, children included. */
function render(element) {
  if (element === null || element === undefined || element === false || element === true) return null;
  if (Array.isArray(element)) return element.map(render);
  if (typeof element !== "object") return element;
  if (typeof element.type === "function") return render(element.type(element.props, ...(element.children ?? [])));
  return { type: element.type, props: element.props, children: (element.children ?? []).flatMap(render) };
}
const findAll = (element, match, out = []) => {
  if (!element || typeof element !== "object") return out;
  if (Array.isArray(element)) {
    for (const child of element) findAll(child, match, out);
    return out;
  }
  const cls = typeof element.props?.className === "string" ? element.props.className : "";
  if (cls && match(cls)) out.push(element);
  for (const child of element.children ?? []) findAll(child, match, out);
  return out;
};
const hasClass = (name) => (cls) => cls.split(" ").includes(name);

// ── the row under test ─────────────────────────────────────────────────────
const tree = decorateTree({ nodes: {}, rootIds: [] });
const folder = { id: "d-1", type: "folder", kind: "folder", name: "报表", fixed: false, parent: "f-root", order: 1 };
tree.nodes["d-1"] = folder;
tree.nodes["f-root"] = { id: "f-root", type: "fixed", kind: "root", name: "根目录", children: ["d-1"] };
const noop = () => {};
const row = (extra = {}) => ({
  node: folder,
  count: 0,
  selected: true,
  checked: false,
  onCheck: noop,
  onOpen: noop,
  onSelect: noop,
  rename: null,
  onBeginRename: noop,
  onRename: noop,
  onNodeContextMenu: () => {},
  tree,
  ...extra,
});
const draw = (extra) => {
  resetHooks();
  return render({ type: ContainerRow, props: row(extra), children: [] });
};
const click = (element) => {
  element.props.onClick({ stopPropagation() {}, preventDefault() {} });
};

test("the pencil opens the row's editor without a rename prop from the panel", () => {
  cells.clear();
  const before = draw();
  assert.equal(findAll(before, hasClass("nm-edit")).length, 0, "no editor before the click");
  const pencil = findAll(before, hasClass("nm-editbtn"))[0];
  assert.ok(pencil, "the folder row draws a pencil");
  click(pencil);
  const after = draw();
  const editor = findAll(after, hasClass("nm-edit"))[0];
  assert.ok(editor, "the click must open the editor even when the panel answers nothing");
  assert.equal(editor.props.value, "报表", "the editor starts from the row's own name");
});

test("committing reports the new name to the panel exactly once", () => {
  cells.clear();
  click(findAll(draw(), hasClass("nm-editbtn"))[0]);
  const typed = draw();
  findAll(typed, hasClass("nm-edit"))[0].props.onChange({ target: { value: "新名字" } });
  const seen = [];
  const committed = draw({ onRename: (kind, id, value) => seen.push([kind, id, value]) });
  const live = findAll(committed, hasClass("nm-edit"))[0];
  assert.ok(live, "the editor is still open before commit");
  if (typeof live.props.onCommit === "function") live.props.onCommit();
  else if (typeof live.props.onKeyDown === "function") live.props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  else live.props.onBlur();
  assert.deepEqual(seen, [["folder", "d-1", "新名字"]]);
});

test("cancelling closes the editor and renames nothing", () => {
  cells.clear();
  click(findAll(draw(), hasClass("nm-editbtn"))[0]);
  const seen = [];
  const open = draw({ onRename: (kind, id, value) => seen.push([kind, id, value]) });
  const live = findAll(open, hasClass("nm-edit"))[0];
  if (typeof live.props.onCancel === "function") live.props.onCancel();
  else live.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(seen, []);
  assert.equal(findAll(draw({ onRename: (kind, id, value) => seen.push([kind, id, value]) }), hasClass("nm-edit")).length, 0, "the editor closes");
});
