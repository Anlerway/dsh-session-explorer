/**
 * Render smoke test for lib/client.js.
 *
 * The plugin has no build step and no bundler, so nothing type-checks it and
 * `node --check` only proves it parses. This harness closes the next gap: it
 * loads the real client bundle against a stub React (hooks return their initial
 * values, effects do not run) and invokes the components once, so a rename that
 * forgot a binding, or a prop that is read but never passed, throws here instead
 * of in the DSH renderer.
 *
 * It is deliberately not a DOM test: there is no jsdom in this repository and
 * adding one would break the zero-dependency rule. What it can prove is that
 * every component's render body evaluates against realistic data.
 */
import { readFileSync } from "node:fs";

const React = {
  Fragment: Symbol("Fragment"),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  createPortal: (node) => node,
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

const store = new Map();
globalThis.window = {
  __ModuleLoader__: { load: ({ factory }) => { mod = factory(requireShim); } },
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  },
  innerWidth: 1280,
  innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {} }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
  getElementById: () => null,
  createTextNode: () => ({}),
};
const navigatorShim = { clipboard: { writeText: async () => {} } };
globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: {} }), status: 200 });

let mod = null;
const requireShim = (name) => {
  if (name === "react") return React;
  throw new Error("unexpected require: " + name);
};

// The components are module-private. Instead of widening the production export
// surface just for a test, the harness appends its own export line to a copy of
// the bundle and compiles that.
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8")
  .replace(
    "    exports.apply = apply;",
    [
      "    exports.__test = { Trow, SessionRow, WorkspaceRow, TreePane, ListPane, DetailPane, FilterDialog, CommandMenu };",
      "    exports.apply = apply;",
    ].join("\n"),
  );

new Function("window", "document", "navigator", "fetch", source)(
  globalThis.window, globalThis.document, navigatorShim, globalThis.fetch,
);
if (!mod) throw new Error("the module factory did not run");

/** Walk an element tree, calling every function component once. */
function render(element) {
  if (element === null || element === undefined || element === false || element === true) return null;
  if (Array.isArray(element)) return element.map(render);
  if (typeof element !== "object") return element;
  if (typeof element.type === "function") return render(element.type(element.props));
  return { type: element.type, children: (element.children ?? []).flatMap(render) };
}

const registered = [];
const ctx = {
  effect: () => {},
  locale: { register: () => {}, bind: () => (key) => key },
  slots: {
    inject: (name, fn) => registered.push([name, fn()]),
    register: (meta, component) => ({ name: meta.name, component }),
  },
};
mod.apply(ctx);
console.log("slots:", registered.map(([name]) => name).join(", "));

const footer = registered.find(([name]) => name === "sidebar.footer.action")[1];
console.log("footer render ok:", Boolean(render({ type: footer.component, props: { wide: true, t: (k) => k } })));

// Open the panel and render it. Every identifier the shell body touches is read
// on this path, so a missing binding fails loudly.
mod.panelStore.set(true);
console.log("panel render ok:", Boolean(render({ type: footer.component, props: { wide: true, t: (k) => k } })));

const settings = registered.find(([name]) => name === "settings.section")[1];
console.log("settings render ok:", Boolean(render({ type: settings.component, props: {} })));

// ── components with data ────────────────────────────────────────────────────
// A render with boot.data === null only exercises the loading branch, so the
// row components are called directly with realistic props.
const { Trow, SessionRow, WorkspaceRow, TreePane, ListPane, DetailPane, FilterDialog, CommandMenu } = mod.__test;

const session = {
  id: "session-1",
  title: "示例会话",
  displayTitle: "示例会话",
  workspaceId: "ws-1",
  workspaceTitle: "project",
  cwd: "C:\\work",
  activityAt: Date.now() - 60_000,
  createdAt: Date.now() - 3_600_000,
  sizeBytes: 2048,
  tags: ["release"],
  note: "note",
  archived: false,
  pinned: true,
  running: false,
  isSubagent: false,
  isSeeded: false,
  formatVersion: 4,
  trashed: false,
  stats: { turns: 3, steps: 5, llmMs: 1200, ttftMs: 300, toolMs: 200 },
  tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  contextPressure: { pressureTokens: 100, surfaceTokens: 200, contextWindow: 1000 },
};

const noop = () => {};
const rename = { value: "示例会话", onChange: noop, onCommit: noop, onCancel: noop };

console.log("Trow ok:", Boolean(render({
  type: Trow,
  props: { scope: "d-1", icon: "folder", label: "文件夹", count: 2, active: true, onSelect: noop, rename, onBeginRename: noop },
})));
console.log("Trow (no rename) ok:", Boolean(render({
  type: Trow,
  props: { scope: "f-root", icon: "folder", label: "根目录", count: 2, active: false, onSelect: noop, hasKids: true, expanded: true, onToggle: noop, onBeginRename: noop },
})));
console.log("SessionRow ok:", Boolean(render({
  type: SessionRow,
  props: { session, selected: true, now: Date.now(), onSelect: noop, checked: false, onCheck: noop, onBeginRename: noop, rename },
})));
console.log("SessionRow (trashed) ok:", Boolean(render({
  type: SessionRow,
  props: { session: { ...session, trashed: true }, selected: false, now: Date.now(), onSelect: noop, checked: false, onCheck: noop, onBeginRename: noop },
})));
console.log("WorkspaceRow ok:", Boolean(render({
  type: WorkspaceRow,
  props: {
    node: { id: "w-ws-1", workspaceId: "ws-1", name: "project", path: "C:\\work", type: "workspace" },
    count: 1, selected: false, onOpen: noop, checked: false, onCheck: noop, onSelect: noop, onBeginRename: noop, rename,
  },
})));

const tree = {
  nodes: {
    "f-root": { id: "f-root", type: "folder", name: "根目录", fixed: true, kind: "root", parent: null, order: 0 },
    "f-trash": { id: "f-trash", type: "folder", name: "回收站", fixed: true, kind: "trash", parent: null, order: 1 },
    "w-ws-1": { id: "w-ws-1", type: "workspace", name: "project", workspaceId: "ws-1", kind: "workspace", parent: "f-root", order: 2 },
    "d-1": { id: "d-1", type: "folder", name: "文件夹", fixed: false, kind: "folder", parent: "f-root", order: 3 },
  },
  children: { "f-root": ["w-ws-1", "d-1"], "f-trash": [], "w-ws-1": [], "d-1": [] },
  counts: { "f-root": 1, "f-trash": 0, "w-ws-1": 1, "d-1": 0 },
  roots: ["f-root", "f-trash"],
};
console.log("TreePane ok:", Boolean(render({
  type: TreePane,
  props: { tree, scope: "f-root", onSelect: noop, expanded: new Set(["f-root"]), onToggle: noop, width: 260, onMove: noop, rename, onBeginRename: noop },
})));
console.log("ListPane ok:", Boolean(render({
  type: ListPane,
  props: {
    sessions: [session], tree, scope: "f-root", selected: session.id, onSelect: noop, onCheck: noop,
    checked: new Set(), query: "", onQuery: noop, sortKey: "updated", onSort: noop, now: Date.now(),
    view: "details", onOpenWorkspace: noop, colWidths: { name: 260, tags: 116, note: 150, updated: 104, size: 74, status: 78 },
    onResizeColumn: noop, listRef: null, collapsed: new Set(), onToggleChildren: noop,
    rename, onBeginRename: noop,
  },
})));

const detailProps = {
  now: Date.now(), onClose: noop, onHint: noop, width: 320, parent: null, children: [], forks: [],
  forkSource: null, onOpen: noop, onEnterNode: noop, onOpenSession: noop, tagLibrary: [{ tag: "release", count: 1, preset: true }],
  onAddTag: noop, onRemoveTag: noop, onNewTag: noop, onDropTag: noop, onSetNote: noop, onToggleFlag: noop,
  onArchive: noop, onFork: noop, onRename: noop, onRestore: noop, onDelete: noop,
};
console.log("DetailPane (session) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session, node: null } })));
console.log("DetailPane (trashed) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session: { ...session, trashed: true }, node: null } })));
console.log("DetailPane (node) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session: null, node: tree.nodes["w-ws-1"] } })));
console.log("DetailPane (empty) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session: null, node: null } })));

console.log("FilterDialog open ok:", Boolean(render({
  type: FilterDialog,
  props: {
    open: true, value: { favorite: "all", archived: "all", todo: "all", tags: ["release"] },
    library: [{ tag: "release" }], onApply: noop, onClose: noop,
  },
})));
console.log("FilterDialog closed ok:", render({ type: FilterDialog, props: { open: false, value: { favorite: "all", archived: "all", todo: "all", tags: [] }, library: [], onApply: noop, onClose: noop } }) === null);
console.log("CommandMenu ok:", Boolean(render({
  type: CommandMenu,
  props: {
    anchor: { left: 400, bottom: 300, element: null },
    items: [{ label: "刷新", icon: "refresh", run: noop }, { sep: true }, { label: "撤销", run: noop }],
    onClose: noop,
  },
})));
