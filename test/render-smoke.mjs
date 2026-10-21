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
import { decorateTree } from "../lib/domain/tree-rules.js";

// A minimal class base, because PanelBoundary is the one class component in the
// bundle (an error boundary has no hook equivalent).
class StubComponent {
  constructor(props) {
    this.props = props;
    this.state = {};
  }
  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) };
  }
}

const React = {
  Component: StubComponent,
  Fragment: Symbol("Fragment"),
  // React puts children in props.children as well as passing them positionally;
  // PanelBoundary renders `this.props.children`, so the stub must match.
  createElement: (type, props, ...children) => {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged, children };
  },
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
  // The plugin used to probe @deepseek-ai/dsh-client-ui-primitives for Modal /
  // RiskConfirmation. It no longer does: the panel and every dialog are drawn by
  // the plugin itself, so a host without that package behaves identically. The
  // shim still refuses it, which pins exactly that: requiring it would throw and
  // fail the whole run.
  throw new Error("unexpected require: " + name);
};

// The components are module-private. Instead of widening the production export
// surface just for a test, the harness appends its own export line to a copy of
// the bundle and compiles that.
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8")
  .replace(
    "    exports.apply = apply;",
    [
      "    exports.__test = { Trow, SessionRow, ContainerRow, TreePane, ListPane, DetailPane, FilterDialog, CommandMenu, DialogHost, frameSizeOf, PanelBoundary };",
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
  if (typeof element.type === "function") {
    // A class component is constructed and rendered; a function component is
    // called. PanelBoundary is the only class in the bundle.
    if (element.type.prototype && typeof element.type.prototype.render === "function") {
      const instance = new element.type(element.props ?? {});
      instance.props = element.props ?? {};
      return render(instance.render());
    }
    return render(element.type(element.props, ...(element.children ?? [])));
  }
  // Host elements keep their props: the assertions below read data-mode and the
  // class names off them, and dropping props would make them vacuously pass.
  return { type: element.type, props: element.props, children: (element.children ?? []).flatMap(render) };
}

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

/** The first host element carrying one of the given class names. */
function hasClass(name) {
  return (cls) => cls.split(" ").includes(name);
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

// ── surface mode ────────────────────────────────────────────────────────────
// Two modes only: 浮窗 and 独立窗口. The old "let DSH's Modal host the panel"
// axis is gone, and with it the data-hosted attribute that marked it.
const { Trow, SessionRow, ContainerRow, TreePane, ListPane, DetailPane, FilterDialog, CommandMenu, DialogHost, frameSizeOf, PanelBoundary } = mod.__test;

const shellNode = findAll(panelTree, hasClass("se-shell"))[0] ?? null;
if (!shellNode) throw new Error("the panel must render a .se-shell");
if ("data-hosted" in (shellNode.props ?? {})) throw new Error("data-hosted must be gone: the native presenter axis was removed");
if ("data-mode" in (shellNode.props ?? {})) throw new Error("data-mode must be gone: there is one surface, not two");
if (findAll(panelTree, hasClass("se-native-frame")).length > 0) throw new Error("no native frame may be rendered");
console.log("panel surface: single floating card");

const settings = registered.find(([name]) => name === "settings.section")[1];
console.log("settings render ok:", Boolean(render({ type: settings.component, props: {} })));

// ── components with data ────────────────────────────────────────────────────
// A render with boot.data === null only exercises the loading branch, so the
// row components are called directly with realistic props.
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

const workspaceNode = { id: "w-ws-1", workspaceId: "ws-1", name: "project", path: "C:\\work", type: "workspace", kind: "workspace" };
const folderNode = { id: "d-1", type: "folder", name: "文件夹", fixed: false, kind: "folder", parent: "f-root", order: 3 };
const specialNode = { id: "f-favorites", type: "folder", name: "收藏", fixed: true, kind: "favorites", parent: "f-root", order: 3 };

console.log("ContainerRow (workspace) ok:", Boolean(render({
  type: ContainerRow,
  props: { node: workspaceNode, count: 1, selected: false, onOpen: noop, checked: false, onCheck: noop, onSelect: noop, onBeginRename: noop, rename },
})));
console.log("ContainerRow (folder) ok:", Boolean(render({
  type: ContainerRow,
  props: { node: folderNode, count: 0, selected: false, onOpen: noop, checked: false, onCheck: noop, onSelect: noop, onBeginRename: noop, rename },
})));

// A 特殊文件夹 may not be renamed, may not be deleted, and must not even offer a
// checkbox: it is a view over the session set, not the user's object.
const specialRow = render({ type: ContainerRow, props: { node: specialNode, count: 3, selected: false, onOpen: noop, checked: false, onCheck: noop, onSelect: noop, onBeginRename: noop } });
if (findAll(specialRow, hasClass("chk")).length !== 0) throw new Error("a 特殊文件夹 must not render a checkbox");
if (findAll(specialRow, hasClass("nm-editbtn")).length !== 0) throw new Error("a 特殊文件夹 must not render a rename pencil");
if (!textOf(specialRow).includes("特殊文件夹")) throw new Error("a 特殊文件夹 must be labelled as such");
console.log("ContainerRow (special) ok:", Boolean(specialRow));

const tree = {
  nodes: {
    "f-root": { id: "f-root", type: "folder", name: "根目录", fixed: true, kind: "root", parent: null, order: 0 },
    "f-all": { id: "f-all", type: "folder", name: "所有会话", fixed: true, kind: "all", parent: "f-root", order: 1 },
    "f-trash": { id: "f-trash", type: "folder", name: "回收站", fixed: true, kind: "trash", parent: null, order: 1 },
    "f-ungrouped": { id: "f-ungrouped", type: "folder", name: "未分组", fixed: true, kind: "ungrouped", parent: "f-root", order: 1 },
    "f-todos": { id: "f-todos", type: "folder", name: "待办", fixed: true, kind: "todos", parent: "f-root", order: 2 },
    "f-favorites": { id: "f-favorites", type: "folder", name: "收藏", fixed: true, kind: "favorites", parent: "f-root", order: 3 },
    "w-ws-1": { id: "w-ws-1", type: "workspace", name: "project", workspaceId: "ws-1", kind: "workspace", parent: "f-root", order: 2 },
    "d-1": { id: "d-1", type: "folder", name: "文件夹", fixed: false, kind: "folder", parent: "f-root", order: 3 },
  },
  children: {
    "f-root": ["f-all", "w-ws-1", "d-1", "f-ungrouped", "f-todos", "f-favorites"],
    "f-trash": [], "f-all": [], "f-ungrouped": [], "f-todos": [], "f-favorites": [], "w-ws-1": [], "d-1": [],
  },
  counts: { "f-root": 1, "f-all": 1, "f-trash": 0, "f-ungrouped": 0, "f-todos": 0, "f-favorites": 0, "w-ws-1": 1, "d-1": 0 },
  roots: ["f-root", "f-trash"],
};
// The client holds no rule table: it reads the facts the host ships on every
// node (`accepts`, `hasWorkspace`, `scope`, `ref`). Decorating the fixture with
// the real host function is what keeps this harness honest — a fixture written
// by hand would drift from /bootstrap and prove nothing.
decorateTree(tree);
console.log("TreePane ok:", Boolean(render({
  type: TreePane,
  props: { tree, scope: "f-root", onSelect: noop, expanded: new Set(["f-root"]), onToggle: noop, width: 260, onMove: noop, rename, onBeginRename: noop },
})));

const listPaneWith = (props) => render({ type: ListPane, props: {
  sessions: [session], tree, scope: "f-root", selected: null, onSelect: noop, onCheck: noop,
  checked: new Set(), query: "", onQuery: noop, sortKey: "updated", sortDir: "desc", onSort: noop, showArchived: true, now: Date.now(),
  view: "details", onOpenWorkspace: noop, colWidths: { name: 260, tags: 116, note: 150, updated: 104, size: 74, status: 78 },
  onResizeColumn: noop, listRef: null, collapsed: new Set(), onToggleChildren: noop,
  rename: null, onBeginRename: noop, ...props,
} });
console.log("ListPane ok:", Boolean(listPaneWith({ selected: session.id })));

// ── containers in the list ──────────────────────────────────────────────────
// Three things are pinned here, all of which were invisible in the UI:
//   1. a user folder under the current scope must be *listed*, not only drawn
//      in the tree (新建文件夹 created something the user could not see);
//   2. workspaces and folders are *separate groups* — mixing them made a folder
//      look like a workspace with the wrong icon;
//   3. typing a folder's name in the search box must find it, from any depth.
const rootList = listPaneWith({});
const folderRows = findAll(rootList, hasClass("folderrow"));
if (folderRows.length !== 1) throw new Error("the folder under the root must be listed once, got " + folderRows.length);
if (!textOf(folderRows[0]).includes("文件夹")) throw new Error("a folder row must be labelled 文件夹");
const wsRows = findAll(rootList, hasClass("wsrow"));
if (wsRows.length !== 1) throw new Error("the workspace must still be listed, got " + wsRows.length);
if (textOf(wsRows[0]).includes("文件夹")) throw new Error("a workspace row must not be labelled 文件夹");
const specialRows = findAll(rootList, hasClass("specialrow"));
// 所有会话 / 未分组 / 收藏 / 待办 — and deliberately NOT 根目录: you are already in
// it. 所有会话 belongs here because 根目录 itself lists no session rows.
if (specialRows.length !== 4) throw new Error("根目录 must list the four 特殊文件夹, got " + specialRows.length);
if (findAll(rootList, hasClass("specialrow")).some((row) => textOf(row).includes("根目录"))) {
  throw new Error("根目录 must not list itself");
}

// The group captions are the user-visible answer to "分开".
const captions = findAll(rootList, hasClass("grp")).map((group) => textOf(group));
if (!captions.some((text) => text.includes("特殊文件夹"))) throw new Error("the special folders need their own group, got " + JSON.stringify(captions));
// Folders before workspaces: the user's own containers come first.
// A caption carries its count ("文件夹 1"), so match on the word and exclude
// the 特殊文件夹 band, which also contains it.
const folderAt = captions.findIndex((text) => text.includes("文件夹") && !text.includes("特殊"));
const workspaceAt = captions.findIndex((text) => text.includes("工作区"));
if (folderAt < 0) throw new Error("folders need their own group, got " + JSON.stringify(captions));
if (workspaceAt < 0) throw new Error("workspaces need their own group, got " + JSON.stringify(captions));
if (folderAt > workspaceAt) throw new Error("文件夹 must come before 工作区, got " + JSON.stringify(captions));
console.log("list containers ok:", folderRows.length, "folder,", wsRows.length, "workspace,", specialRows.length, "special");
console.log("groups:", captions.join(" | "));

// Search: the folder lives at f-root, so a query from the same scope finds it.
const searched = listPaneWith({ query: "文件" });
if (findAll(searched, hasClass("folderrow")).length !== 1) {
  throw new Error("searching a folder name must find the folder");
}
// … and a query that matches nothing lists nothing.
const noHit = listPaneWith({ query: "zzz-no-such-thing" });
if (findAll(noHit, hasClass("folderrow")).length !== 0) {
  throw new Error("a non-matching query must not list the folder");
}
// The bin shows trashed sessions only: no containers to navigate out of.
const trashList = listPaneWith({ scope: "f-trash" });
if (findAll(trashList, hasClass("frow")).length !== 0) {
  throw new Error("the bin must not list containers");
}

const detailProps = {
  now: Date.now(), onClose: noop, onHint: noop, width: 320, parent: null, children: [], forks: [],
  forkSource: null, onOpen: noop, onEnterNode: noop, onOpenSession: noop, tagLibrary: [{ tag: "release", count: 1, preset: true }],
  onAddTag: noop, onRemoveTag: noop, onNewTag: noop, onDropTag: noop, onSetNote: noop, onToggleFlag: noop,
  onArchive: noop, onFork: noop, onRename: noop, onRestore: noop, onDelete: noop,
};
console.log("DetailPane (session) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session, node: null } })));
console.log("DetailPane (trashed) ok:", Boolean(render({ type: DetailPane, props: { ...detailProps, session: { ...session, trashed: true }, node: null } })));
const wsDetail = render({ type: DetailPane, props: { ...detailProps, session: null, node: workspaceNode } });
console.log("DetailPane (workspace) ok:", Boolean(wsDetail));
// A workspace must describe itself as a workspace. Reading the wrong flag made
// it say 文件夹 in the detail pane.
const wsText = textOf(wsDetail);
if (!wsText.includes("工作区")) throw new Error("a workspace detail must say 工作区");
if (wsText.includes("文件夹")) throw new Error("a workspace detail must not say 文件夹");
const folderDetail = render({ type: DetailPane, props: { ...detailProps, session: null, node: folderNode } });
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
const plainMenu = render({
  type: CommandMenu,
  props: {
    anchor: { left: 400, bottom: 300, element: null },
    items: [{ label: "刷新", icon: "refresh", run: noop }, { sep: true }, { label: "撤销", run: noop }],
    onClose: noop,
  },
});
console.log("CommandMenu ok:", Boolean(plainMenu));
if (findAll(plainMenu, hasClass("has-sub")).length > 0) throw new Error("a flat menu must not grow a flyout");

// 发送到: a parent with `sub` is a label, not a command. It carries has-sub and
// aria-haspopup, its .k slot holds the chevron instead of a shortcut key, and
// the children live inside .submenu as ordinary .mi rows (separators included).
const subMenu = render({
  type: CommandMenu,
  props: {
    anchor: { left: 400, bottom: 300, element: null },
    items: [
      { label: "发送到", icon: "shortcut", sub: [
        { label: "收藏", icon: "star", run: noop },
        { label: "待办", icon: "todo", run: noop },
        { sep: true },
        { label: "创建快捷方式（放到收藏）", icon: "shortcut", run: noop },
      ] },
      { label: "删除", icon: "trash", danger: true, run: noop },
    ],
    onClose: noop,
  },
});
const parents = findAll(subMenu, hasClass("has-sub"));
if (parents.length !== 1) throw new Error("the 发送到 parent must be the only has-sub row");
const parent = parents[0];
if (parent.props["aria-haspopup"] !== "true") throw new Error("a flyout parent advertises aria-haspopup");
if (typeof parent.props.onClick === "function") parent.props.onClick();
const flyout = findAll(parent, hasClass("submenu"))[0] ?? null;
if (!flyout) throw new Error("the parent must contain a .submenu");
const children = findAll(flyout, hasClass("mi"));
if (children.length !== 3) throw new Error("the flyout must hold three items, got " + children.length);
if (findAll(flyout, hasClass("misep")).length !== 1) throw new Error("a sep inside sub becomes a .misep");
if (!textOf(flyout).includes("收藏") || !textOf(flyout).includes("创建快捷方式")) throw new Error("the flyout labels must render");
if (findAll(subMenu, hasClass("danger")).length !== 1) throw new Error("the sibling row keeps its own class");
console.log("CommandMenu 发送到 flyout ok:", children.length === 3);

// A menu that would push its flyout off the right edge flips it to the left:
// data-flip rides on the .ctxmenu and the stylesheet turns left:100% into
// right:100%. Without it 发送到 would open outside the window.
const flipMenu = (left) => findAll(render({
  type: CommandMenu,
  props: {
    anchor: { left, bottom: 300, element: null },
    items: [{ label: "发送到", icon: "shortcut", sub: [{ label: "收藏", icon: "star", run: noop }] }],
    onClose: noop,
  },
}), hasClass("ctxmenu"))[0];
const nearEdge = flipMenu(1270);
if (nearEdge.props["data-flip"] !== "1") throw new Error("a right-edge menu must flip its flyout");
const away = flipMenu(400);
if (away.props["data-flip"] !== undefined) throw new Error("a menu with room must keep the default flyout");
console.log("CommandMenu data-flip ok:", nearEdge.props["data-flip"] === "1");

// ── dialogs ─────────────────────────────────────────────────────────────────
// Every dialog is local now, and it must be local *and* on the plugin's dialog
// layer. The old design rendered destructive confirms through DSH's Modal,
// which sits at the app's dialog tier — below this panel — so a confirmation
// could be painted underneath the window that opened it.
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

for (const [label, dialog] of [["confirm", plainConfirm], ["risk", riskConfirm], ["prompt", promptDialog]]) {
  if (!dialog) throw new Error("the " + label + " dialog must render");
  if (findAll(dialog, hasClass("fmodal")).length !== 1) {
    throw new Error("the " + label + " dialog must be a local .fmodal layer");
  }
  if (findAll(dialog, (cls) => cls.includes("se-native-dialog")).length > 0) {
    throw new Error("the " + label + " dialog must not use the removed native class");
  }
}
// The acknowledgement checkbox is what makes 永久删除 hard to trigger by accident.
if (findAll(riskConfirm, hasClass("se-dlg-ack")).length !== 1) {
  throw new Error("a destructive confirm must carry the acknowledgement checkbox");
}
if (findAll(plainConfirm, hasClass("se-dlg-ack")).length !== 0) {
  throw new Error("an ordinary confirm must not carry an acknowledgement");
}
const dialogLayer = findAll(plainConfirm, hasClass("fmodal"))[0];
if (dialogLayer.props?.onMouseDown === undefined) {
  throw new Error("the dialog backdrop must dismiss on mousedown, not on any click");
}
console.log("dialogs presenter: local (above the panel)");

// ── sizing ──────────────────────────────────────────────────────────────────
// The host has modalSizeOf; the bundle cannot import it, so the two are pinned
// to the same answers here. A drift would make the panel and the settings page
// disagree about what "中" means.
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
