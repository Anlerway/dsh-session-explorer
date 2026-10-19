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
  // The primitives are optional in production too (the plugin degrades to its
  // own dialogs). The harness provides a stub so the *native* branch is the one
  // exercised here; a second, separate run covers the fallback.
  if (name === "@deepseek-ai/dsh-client-ui-primitives") {
    if (process.env.SE_SMOKE_NO_PRIMITIVES === "1") throw new Error("not provided");
    // The stubs must forward children: a component receives them as the third
    // argument of createElement, not only in props. Dropping them would hide
    // the whole panel — exactly what the presenter assertion is meant to catch.
    return {
      Modal: (props, ...children) => React.createElement("div", { "data-modal": true }, ...children),
      RiskConfirmation: (props, ...children) => React.createElement("div", { "data-risk": true }, ...children),
      Button: (props, ...children) => React.createElement("button", props, ...children),
    };
  }
  throw new Error("unexpected require: " + name);
};

// The components are module-private. Instead of widening the production export
// surface just for a test, the harness appends its own export line to a copy of
// the bundle and compiles that.
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8")
  .replace(
    "    exports.apply = apply;",
    [
      "    exports.__test = { Trow, SessionRow, WorkspaceRow, TreePane, ListPane, DetailPane, FilterDialog, CommandMenu, DialogHost, frameSizeOf, presenterOf };",
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
  // Children are passed as trailing arguments, exactly as React does: a
  // component that destructures `props` alone still receives its nested
  // elements through createElement's rest parameter.
  if (typeof element.type === "function") return render(element.type(element.props, ...(element.children ?? [])));
  // Host elements keep their props: the presenter assertion below reads
  // data-modal / data-hosted off them, and dropping props would make every
  // assertion vacuously pass.
  return { type: element.type, props: element.props, children: (element.children ?? []).flatMap(render) };
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
const panelTree = render({ type: footer.component, props: { wide: true, t: (k) => k } });
console.log("panel render ok:", Boolean(panelTree));

/**
 * Which presenter owns the panel?
 *
 * The default is the plugin's own floating card — a three-pane explorer is a
 * window, not a dialog. DSH's Modal is opt-in (settings.shell.modal.presentation
 * = "native") and, when chosen, must actually host the panel so the app's mask,
 * focus trap and stacking apply. Without the primitives the request degrades to
 * the floating card instead of rendering nothing.
 */
function findTag(element, tag) {
  if (!element || typeof element !== "object") return null;
  if (Array.isArray(element)) {
    for (const child of element) {
      const hit = findTag(child, tag);
      if (hit) return hit;
    }
    return null;
  }
  // A prop may be false-y (data-hosted="local" is a string, but a boolean
  // attribute would be true), so presence is checked with `in`.
  if (element.props && tag in element.props) return element;
  for (const child of element.children ?? []) {
    const hit = findTag(child, tag);
    if (hit) return hit;
  }
  return null;
}
const hostedNative = findTag(panelTree, "data-modal");
const shellNode = findTag(panelTree, "data-hosted");
const primitivesAvailable = process.env.SE_SMOKE_NO_PRIMITIVES !== "1";
const shellHost = shellNode?.props?.["data-hosted"] ?? null;
console.log(
  "panel presenter:",
  hostedNative ? "native-modal" : "local",
  "| data-hosted =",
  shellHost,
);
// No settings were loaded (the fetch stub returns an empty result), and the
// default presentation is the plugin's own floating card.
if (hostedNative) throw new Error("the default presentation must not claim DSH's Modal");
if (shellHost !== "local") throw new Error("shell must declare data-hosted=local");

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

// ── containers in the list ──────────────────────────────────────────────────
// Two regressions are pinned here, both of which were invisible in the UI:
//   1. a user folder under the current scope must be *listed*, not only drawn
//      in the tree (新建文件夹 created something the user could not see);
//   2. typing a folder's name in the search box must find it, from any depth.
const listPaneWith = (props) => render({ type: ListPane, props: {
  sessions: [session], tree, scope: "f-root", selected: null, onSelect: noop, onCheck: noop,
  checked: new Set(), query: "", onQuery: noop, sortKey: "updated", onSort: noop, now: Date.now(),
  view: "details", onOpenWorkspace: noop, colWidths: { name: 260, tags: 116, note: 150, updated: 104, size: 74, status: 78 },
  onResizeColumn: noop, listRef: null, collapsed: new Set(), onToggleChildren: noop,
  rename: null, onBeginRename: noop, ...props,
} });

/** Collect every host element whose className matches, depth-first. */
function findAll(element, match, out = []) {
  if (!element || typeof element !== "object") return out;
  if (Array.isArray(element)) {
    for (const child of element) findAll(child, match, out);
    return out;
  }
  const cls = typeof element.props?.className === "string" ? element.props.className : "";
  if (cls && match(cls)) out.push(element);
  for (const child of element.children ?? []) findAll(child, match, out);
  return out;
}

/** Flatten the text under an element, for assertions about labels. */
function textOf(element) {
  if (element === null || element === undefined || element === false || element === true) return "";
  if (typeof element === "string" || typeof element === "number") return String(element);
  if (Array.isArray(element)) return element.map(textOf).join(" ");
  return (element.children ?? []).map(textOf).join(" ");
}

const rootList = listPaneWith({});
const folderRows = findAll(rootList, (cls) => cls.split(" ").includes("folderrow"));
if (folderRows.length !== 1) throw new Error("the folder under the root must be listed once, got " + folderRows.length);
if (!textOf(folderRows[0]).includes("文件夹")) throw new Error("a folder row must be labelled 文件夹");
const wsRows = findAll(rootList, (cls) => cls.split(" ").includes("wsrow"));
if (wsRows.length !== 1) throw new Error("the workspace must still be listed, got " + wsRows.length);
if (textOf(wsRows[0]).includes("文件夹")) throw new Error("a workspace row must not be labelled 文件夹");
console.log("list containers ok:", folderRows.length, "folder row(s),", wsRows.length, "workspace row(s)");

// Search: the folder lives at f-root, so a query from the same scope finds it.
const searched = listPaneWith({ query: "文件" });
if (findAll(searched, (cls) => cls.split(" ").includes("folderrow")).length !== 1) {
  throw new Error("searching a folder name must find the folder");
}
// … and so does a query that matches nothing else.
const noHit = listPaneWith({ query: "zzz-no-such-thing" });
if (findAll(noHit, (cls) => cls.split(" ").includes("folderrow")).length !== 0) {
  throw new Error("a non-matching query must not list the folder");
}

const detailProps = {
  now: Date.now(), onClose: noop, onHint: noop, width: 320, parent: null, children: [], forks: [],
  forkSource: null, onOpen: noop, onEnterNode: noop, onOpenSession: noop, tagLibrary: [{ tag: "release", count: 1, preset: true }],
  onAddTag: noop, onRemoveTag: noop, onNewTag: noop, onDropTag: noop, onSetNote: noop, onToggleFlag: noop,
  onArchive: noop, onFork: noop, onRename: noop, onRestore: noop, onDelete: noop,
};
console.log("DetailPane (session) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session, node: null } })));
console.log("DetailPane (trashed) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session: { ...session, trashed: true }, node: null } })));
const wsDetail = render({ type: DetailPane, props: { ...detailProps, session: null, node: { ...tree.nodes["w-ws-1"], kind: "workspace" } } });
console.log("DetailPane (workspace) ok:", Boolean(wsDetail));
// A workspace must describe itself as a workspace. Reading the wrong flag made
// it say 文件夹 in the detail pane.
const wsText = textOf(wsDetail);
if (!wsText.includes("工作区")) throw new Error("a workspace detail must say 工作区");
if (wsText.includes("文件夹")) throw new Error("a workspace detail must not say 文件夹");
const folderDetail = render({ type: DetailPane, props: { ...detailProps, session: null, node: tree.nodes["d-1"] } });
const folderText = textOf(folderDetail);
if (!folderText.includes("文件夹")) throw new Error("a folder detail must say 文件夹");
if (folderText.includes("工作区")) throw new Error("a folder detail must not say 工作区");
console.log("DetailPane (folder) ok:", Boolean(folderDetail));
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

// ── dialogs ─────────────────────────────────────────────────────────────────
// The dialog components are private; expose them the same way as the rows so
// each presenter can be rendered directly. This is where the "native dialog"
// requirement is actually pinned down: a confirm rendered with primitives must
// go through Modal/RiskConfirmation, not through our own markup.
const { DialogHost, frameSizeOf, presenterOf } = mod.__test;

// ── presenter selection ─────────────────────────────────────────────────────
// The interesting case is the *fallback*: asking for the native modal on a host
// without primitives must still render the floating card, not nothing at all.
const presenterCases = [
  [null, true, "float"],
  [{ shell: { modal: { presentation: "float" } } }, true, "float"],
  [{ shell: { modal: { presentation: "native" } } }, true, "native"],
  [{ shell: { modal: { presentation: "native" } } }, false, "float"],
  [{ shell: { modal: {} } }, true, "float"],
  // 窗口模式 is a floating surface by definition, even if the native presenter
  // was chosen earlier: the two settings must not fight.
  [{ shell: { openMode: "window", modal: { presentation: "native" } } }, true, "float"],
];
for (const [input, primitives, expected] of presenterCases) {
  const actual = presenterOf(input, primitives);
  if (actual !== expected) {
    throw new Error("presenterOf(" + JSON.stringify(input) + ", " + primitives + ") = " + actual + ", expected " + expected);
  }
}
console.log("panel presenter cases ok:", presenterCases.length);
const dialogsHosted = (dialog) =>
  render({ type: DialogHost, props: { dialog, promptRef: { current: null }, onSettle: noop } });

const plainConfirm = dialogsHosted({
  kind: "confirm",
  title: "删除文件夹",
  message: "内容会移动到上一级。",
  confirmLabel: "删除",
  cancelLabel: "取消",
  danger: true,
  resolve: noop,
});
const riskConfirm = dialogsHosted({
  kind: "confirm",
  title: "永久删除",
  message: "不可撤销。",
  confirmLabel: "永久删除",
  cancelLabel: "取消",
  danger: true,
  acknowledge: "我明白此操作不可撤销",
  resolve: noop,
});
const promptDialog = dialogsHosted({
  kind: "prompt",
  title: "新建文件夹",
  message: "",
  placeholder: "新建文件夹",
  value: "新建文件夹",
  confirmLabel: "创建",
  cancelLabel: "取消",
  maxLength: 64,
  validate: null,
  resolve: noop,
});
console.log("DialogHost confirm ok:", Boolean(plainConfirm));
console.log("DialogHost risk ok:", Boolean(riskConfirm));
console.log("DialogHost prompt ok:", Boolean(promptDialog));
if (primitivesAvailable) {
  if (!findTag(plainConfirm, "data-modal")) throw new Error("a confirm must be hosted by DSH's Modal");
  if (!findTag(riskConfirm, "data-risk")) throw new Error("a destructive confirm must use RiskConfirmation");
  if (!findTag(promptDialog, "data-modal")) throw new Error("a prompt must be hosted by DSH's Modal");
  console.log("dialogs presenter: native");
} else {
  if (findTag(plainConfirm, "data-modal")) throw new Error("without primitives there is no native modal");
  console.log("dialogs presenter: local");
}

// ── sizing ──────────────────────────────────────────────────────────────────
// The host has modalSizeOf; the bundle cannot import it, so the two are pinned
// to the same answers here. A drift would make the native Modal frame and the
// local shell disagree about what "中" means.
const cases = [
  [{ sizing: "fixed", size: "sm" }, { width: "min(860px, 94vw)", height: "min(560px, 90vh)" }],
  [{ sizing: "fixed", size: "md" }, { width: "min(1100px, 94vw)", height: "min(720px, 90vh)" }],
  [{ sizing: "fixed", size: "lg" }, { width: "min(1320px, 94vw)", height: "min(820px, 90vh)" }],
  [{ sizing: "fixed", size: "xl" }, { width: "min(1600px, 94vw)", height: "min(960px, 90vh)" }],
  [{ sizing: "percent", percent: "p50" }, { width: "50vw", height: "50vh" }],
  [{ sizing: "percent", percent: "p100" }, { width: "100vw", height: "100vh" }],
];
for (const [input, expected] of cases) {
  const actual = frameSizeOf(input);
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error("frameSizeOf(" + JSON.stringify(input) + ") = " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected));
  }
}
console.log("sizing presets ok:", cases.length);
