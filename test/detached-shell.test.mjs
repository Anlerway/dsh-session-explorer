/**
 * Tests for assets/detached/shell.js — the standalone explorer window.
 *
 * That file has no build step and no type checker, and it builds every pane with
 * template strings, so a typo shows up as a blank window rather than an error
 * anyone can see. These tests evaluate the real bundle against a small DOM
 * (test/support/dom.mjs) and a realistic bootstrap payload, then drive it the way
 * a user would: clicks, keystrokes, context menus, checkboxes and drag events.
 *
 * The window is a port of the floating panel, so the assertions below follow the
 * panel's own contract: a double click opens a session (rename is a command),
 * the detail pane describes the scope when no row is selected, and every command
 * goes through the same API the panel uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createDom, click, type, press, contextMenu, Event } from "./support/dom.mjs";

const SRC = readFileSync(new URL("../assets/detached/shell.js", import.meta.url), "utf8");

/** Bootstrap payload shaped like the Host's real answer. */
export function fixture(overrides = {}) {
  const now = Date.now();
  return {
    tree: {
      nodes: {
        "f-root": { id: "f-root", type: "folder", kind: "root", name: "根目录", fixed: true, parent: null },
        "f-all": { id: "f-all", type: "folder", kind: "all", name: "所有会话", fixed: true, parent: "f-root" },
        "f-favorites": { id: "f-favorites", type: "folder", kind: "favorites", name: "收藏", fixed: true, parent: "f-root" },
        "f-todos": { id: "f-todos", type: "folder", kind: "todos", name: "待办", fixed: true, parent: "f-root" },
        "f-ungrouped": { id: "f-ungrouped", type: "folder", kind: "ungrouped", name: "未分组", fixed: true, parent: "f-root" },
        "f-trash": { id: "f-trash", type: "folder", kind: "trash", name: "回收站", fixed: true, parent: null },
        "d-1": { id: "d-1", type: "folder", kind: "folder", name: "工作笔记", fixed: false, parent: "f-root", order: 0 },
        "d-2": { id: "d-2", type: "folder", kind: "folder", name: "子目录", fixed: false, parent: "d-1", order: 0 },
        "w-ws-1": {
          id: "w-ws-1", type: "workspace", kind: "default-workspace", name: "默认工作区",
          fixed: false, parent: "f-root", workspaceId: "ws-1", order: 1,
        },
      },
      children: {
        "f-root": ["d-1", "w-ws-1"],
        "f-all": [],
        "d-1": ["d-2"],
        "d-2": [],
        "w-ws-1": [],
      },
      counts: { "f-root": 3, "f-all": 3, "f-ungrouped": 0, "f-favorites": 1, "f-todos": 1, "f-trash": 0, "d-1": 0, "d-2": 0, "w-ws-1": 3 },
    },
    sessions: [
      {
        id: "session-a", workspaceId: "ws-1", workspaceTitle: "默认工作区",
        title: "重构插件", displayTitle: "重构插件", cwd: "C:/work",
        createdAt: now - 90000, activityAt: now - 1000, sizeBytes: 4096,
        pinned: true, archived: false, favorite: true, todo: false, running: false,
        isSeeded: false, tags: ["重构", "插件"], note: "先看排序", stats: { turns: 12, steps: 40 },
      },
      {
        id: "session-b", workspaceId: "ws-1", workspaceTitle: "默认工作区",
        title: null, displayTitle: "C:/work/other", cwd: "C:/work/other",
        createdAt: now - 80000, activityAt: now - 5000, sizeBytes: 1024,
        pinned: false, archived: false, favorite: false, todo: true, running: true,
        isSeeded: true, tags: [], note: "", stats: { turns: 3, steps: 9 },
      },
      {
        id: "session-c", workspaceId: "ws-1", workspaceTitle: "默认工作区",
        title: "旧会话", displayTitle: "旧会话", cwd: "C:/work",
        createdAt: now - 70000, activityAt: now - 9000, sizeBytes: 512,
        pinned: false, archived: true, favorite: false, todo: false, running: false,
        isSeeded: false, tags: [], note: "", stats: { turns: 1, steps: 1 },
      },
    ],
    trashed: [],
    tags: [],
    tagLibrary: [{ tag: "重构", count: 1, preset: true }, { tag: "插件", count: 1, preset: false }, { tag: "归档候选", count: 0, preset: true }],
    capabilities: { component: "ready" },
    settings: {},
    ...overrides,
  };
}

/**
 * Run the bundle against a fresh DOM.
 *
 * `calls` records every request the page makes, so a test can assert on the
 * API call rather than on a side effect it cannot observe.
 */
export async function boot(options = {}) {
  const { document, window, root, storage } = createDom(options.storage);
  const calls = [];
  const bootstrap = options.bootstrap ?? fixture();
  const respond = options.respond ?? (() => ({ ok: true, result: {} }));

  // The panel steers this window through the preload; the harness records the
  // handler so a test can deliver a command the way main.cjs would.
  const commands = [];
  window.se = {
    detached: true,
    onCommand(handler) {
      commands.push(handler);
      return () => {};
    },
    async api(path, init) {
      const call = { path, method: init?.method ?? "GET", body: init?.body ?? null };
      calls.push(call);
      if (path.endsWith("/bootstrap")) return { ok: true, result: bootstrap };
      return respond(call) ?? { ok: true, result: {} };
    },
    async window(action) {
      calls.push({ path: "/window", method: action, body: null });
      return { maximized: false };
    },
  };

  const run = new Function("window", "document", "setTimeout", "clearTimeout", "navigator", SRC);
  run(window, document, setTimeout, clearTimeout, window.navigator);
  document.readyState = "complete";
  document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: false }));
  await settle();

  const $ = (selector) => root.querySelector(selector);
  const $$ = (selector) => root.querySelectorAll(selector);
  const text = () => root.textContent;
  const html = () => root.innerHTML;

  // 根目录 is a directory: its list holds 所有会话 and the containers, not the
  // session rows. Most tests are about rows, so the harness steps into the flat
  // list unless a test asks to stay where the window opens.
  if (options.keepScope !== true) {
    const flat = root.querySelector('[data-node="f-all"]');
    if (flat) click(flat);
    await settle(5);
  }

  const deliver = (command) => {
    for (const handler of commands) handler(command);
  };

  return { document, window, root, calls, storage, commands, deliver, $, $$, text, html };
}

/** Let the queued bootstrap promise and the 200 ms preference timer run. */
export async function settle(ms = 40) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const selectRow = async (ctx, id) => {
  const row = ctx.$$('[data-session="' + id + '"]')[0];
  assert.ok(row, "row " + id + " rendered");
  click(row);
  await settle(5);
  return row;
};

// ── the shell itself ──────────────────────────────────────────────────────

test("the detached shell renders the panel's three panes", async () => {
  const ctx = await boot();
  const markup = ctx.html();

  assert.ok(markup.includes('class="se-shell"'), "shell root rendered");
  assert.ok(markup.includes("pane-tree"), "tree pane present");
  assert.ok(markup.includes("pane-list"), "list pane present");
  assert.ok(markup.includes("pane-detail"), "detail pane present");
  assert.ok(markup.includes("cmdbar"), "command bar present");
  assert.ok(markup.includes("navbar"), "breadcrumb bar present");

  // It must be the explorer, not the DSH app wrapped in a window.
  assert.ok(!markup.includes("__DSH_BOOT__"), "no DSH boot payload");
  assert.ok(!markup.includes("sidebar"), "no DSH sidebar");
});

test("the tree mirrors the panel: fixed rail, then the directory walk", async () => {
  const ctx = await boot();
  const text = ctx.text();

  for (const label of ["默认工作区", "未分组", "回收站", "待办", "收藏", "目录", "根目录", "工作笔记"]) {
    assert.ok(text.includes(label), "tree shows " + label);
  }
  assert.ok(ctx.$$(".trow").length >= 8, "tree rows rendered");
});

test("the list groups pinned, folders, workspaces, sessions and archived", async () => {
  // The directory groups belong to 根目录 (which lists containers), the session
  // groups to 所有会话 (which lists rows). One scope cannot show both, because
  // 根目录 no longer holds sessions of its own.
  const atRoot = await boot({ keepScope: true });
  const rootGroups = atRoot.$$(".grp").map((node) => node.textContent);
  assert.ok(rootGroups.some((text) => text.includes("特殊文件夹")), "special-folders group");
  assert.ok(rootGroups.some((text) => text.includes("文件夹")), "folder group");
  assert.ok(rootGroups.some((text) => text.includes("工作区")), "workspace group");

  const ctx = await boot();
  const groups = ctx.$$(".grp").map((node) => node.textContent);
  assert.ok(groups.some((text) => text.includes("置顶")), "pinned group");
  assert.ok(groups.some((text) => text.includes("已归档")), "archived group sinks last");
  assert.ok(ctx.text().includes("先看排序"), "note column");
  // The mini DOM matches simple selectors only, so count through the row.
  assert.equal(ctx.$('[data-session="session-a"]').querySelectorAll(".tag").length, 2, "tags column");
});

test("a row shows its status dot and the container rows show a type tag", async () => {
  const ctx = await boot();
  const running = ctx.$('[data-session="session-b"]');
  assert.ok(running.textContent.includes("运行中"), "running status");
  assert.ok(running.querySelector(".dot.run"), "running dot");
  // The container rows live in 根目录, the session rows in 所有会话.
  const atRoot = await boot({ keepScope: true });
  assert.ok(atRoot.$('[data-id="w-ws-1"]').textContent.includes("工作区"), "workspace type tag");
  assert.ok(atRoot.$('[data-id="d-1"]').textContent.includes("文件夹"), "folder type tag");
});

test("the detail pane describes the scope when nothing is selected", async () => {
  const atRoot = await boot({ keepScope: true });
  const detail = atRoot.$(".pane-detail").textContent;
  assert.ok(detail.includes("根目录"), "scope name in detail");
  assert.ok(detail.includes("全部会话"), "root is described as the whole set");

  // Inside 所有会话 the pane names that view instead.
  const flat = await boot();
  assert.ok(flat.$(".pane-detail").textContent.includes("所有会话"), "flat list names itself");
});

test("a connection failure renders a retry affordance, not a blank window", async () => {
  const { document, window, root } = createDom();
  window.se = {
    async api() {
      return { ok: false, error: "连不上 Host" };
    },
  };
  const run = new Function("window", "document", "setTimeout", "clearTimeout", "navigator", SRC);
  run(window, document, setTimeout, clearTimeout, window.navigator);
  document.readyState = "complete";
  document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: false }));
  await settle();

  assert.ok(root.textContent.includes("加载失败"), "error state shown");
  assert.ok(root.textContent.includes("连不上 Host"), "host message surfaced");
  assert.ok(root.innerHTML.includes('data-act="retry"'), "retry button offered");
});

// ── menus, rename, breadcrumb, column widths ─────────────────────────────

test("right-clicking a row inside a workspace opens the panel's context menu", async () => {
  const ctx = await boot();
  // 所有会话 draws its rows as references and gets the smaller menu, so the
  // full session menu is checked where the session really lives.
  click(ctx.$$('[data-node="w-ws-1"]')[0]);
  await settle(5);
  contextMenu(ctx.$$('[data-session="session-a"]')[0], 60, 80);
  await settle(5);

  const menu = ctx.$(".ctxmenu");
  assert.ok(menu, "menu rendered");
  for (const label of ["重命名", "收藏", "剪切", "复制", "粘贴", "删除"]) {
    assert.ok(menu.textContent.includes(label), "menu offers " + label);
  }
});

test("所有会话 draws each row as a reference with the smaller menu", async () => {
  const ctx = await boot();
  assert.ok(ctx.$$(".ref-row").length > 0, "reference rows wear their own class");

  contextMenu(ctx.$$('[data-session="session-a"]')[0], 60, 80);
  await settle(5);

  const menu = ctx.$(".ctxmenu");
  assert.ok(menu, "menu rendered");
  assert.ok(menu.textContent.includes("跳转到原位置"), "menu offers the jump");
  assert.ok(!menu.textContent.includes("重命名"), "a view cannot rename the original");
});

// 发送到: the three "hand this row to a container" commands are one hover
// flyout now. The parent is a label (no data-mi, so its click cannot run), the
// children are ordinary [data-mi] rows inside .submenu, and the click path is
// the one that already existed — no new event branch.
test("the session menu folds 收藏 / 待办 / 创建快捷方式 into one 发送到 flyout", async () => {
  const ctx = await boot();
  click(ctx.$$('[data-node="w-ws-1"]')[0]);
  await settle(5);
  contextMenu(ctx.$$('[data-session="session-a"]')[0], 60, 80);
  await settle(5);

  const menu = ctx.$(".ctxmenu");
  assert.ok(menu, "menu rendered");
  assert.ok(menu.textContent.includes("发送到"), "the parent row is labelled 发送到");
  assert.ok(!menu.textContent.includes("添加到收藏"), "the flat rows are gone");

  const parent = ctx.$(".mi.has-sub");
  assert.ok(parent, "the parent wears has-sub");
  assert.equal(parent.getAttribute("data-mi"), null, "a parent is not a command");
  assert.equal(parent.getAttribute("aria-haspopup"), "true", "the parent advertises its flyout");
  const chevron = parent.querySelector(".k");
  assert.ok(chevron && chevron.innerHTML.includes("svg"), "the chevron sits in the .k slot");

  const flyout = parent.querySelector(".submenu");
  assert.ok(flyout, "the flyout is inside the parent");
  for (const id of ["add-favorite", "add-todo", "create-shortcut"]) {
    assert.ok(flyout.querySelector('[data-mi="' + id + '"]'), "flyout offers " + id);
  }
  assert.ok(flyout.querySelector(".misep"), "the separator survives inside the flyout");

  // The click path is unchanged: a child id runs through runMenuAction.
  click(flyout.querySelector('[data-mi="add-favorite"]'));
  await settle(5);
  assert.ok(ctx.calls.some((call) => call.path.endsWith("/shortcuts") && call.method === "POST"), "the child posts a shortcut");

  // A menu pinned to the right edge flips its flyout left, or the flyout would
  // land outside the window where nobody can reach it.
  contextMenu(ctx.$$('[data-session="session-a"]')[0], 1270, 80);
  await settle(5);
  const edgeMenu = ctx.$(".ctxmenu");
  assert.ok(edgeMenu, "menu rendered at the edge");
  assert.equal(edgeMenu.getAttribute("data-flip"), "1", "a right-edge menu flips its flyouts");
  assert.equal(ctx.$(".mi.has-sub").getAttribute("data-mi"), null, "the parent is still not a command");

  // The same menu away from the edge keeps the default (right-opening) flyout.
  contextMenu(ctx.$$('[data-session="session-a"]')[0], 60, 80);
  await settle(5);
  assert.equal(ctx.$(".ctxmenu").getAttribute("data-flip"), null, "a left-side menu does not flip");
});

test("the pencil starts an inline rename and Enter posts the new title", async () => {
  const ctx = await boot();
  await selectRow(ctx, "session-a");

  click(ctx.$('[data-beginrename-session="session-a"]'));
  await settle(5);
  const input = ctx.$("#rename-input");
  assert.ok(input, "inline editor replaced the label");
  assert.equal(input.value, "重构插件", "editor starts with the current title");

  input.value = "新标题";
  press(ctx.window, "Enter", { target: input });
  await settle();

  const rename = ctx.calls.find((call) => call.path.endsWith("/rename"));
  assert.ok(rename, "rename request sent");
  assert.equal(rename.body.title, "新标题");
});

test("F2 renames the selected row and Escape cancels without a request", async () => {
  const ctx = await boot();
  await selectRow(ctx, "session-a");

  press(ctx.window, "F2");
  await settle(5);
  const input = ctx.$("#rename-input");
  assert.ok(input, "F2 opened the editor");

  input.value = "不要提交";
  press(ctx.window, "Escape", { target: input });
  await settle();
  assert.ok(!ctx.$("#rename-input"), "editor closed");
  assert.ok(!ctx.calls.some((call) => call.path.endsWith("/rename")), "no rename request");
});

test("the breadcrumb shows the path and navigates back to an ancestor", async () => {
  const ctx = await boot();
  click(ctx.$$('[data-node="d-1"]')[0]);
  await settle(5);
  const nested = ctx.$$('[data-node="d-2"]')[0];
  assert.ok(nested, "a folder opens on entering it");
  click(nested);
  await settle(5);

  const crumbs = ctx.$$("[data-crumb]");
  assert.ok(crumbs.length >= 3, "root / 工作笔记 / 子目录 are all crumbed");

  click(crumbs[0]);
  await settle(5);
  assert.equal(ctx.$$("[data-crumb]").length, 1, "back at the root");
});

test("dragging a column handle widens the column and remembers it", async () => {
  const ctx = await boot();
  // The strip has its own attribute: the list pane owns `data-cw` (the column
  // width *mode*), and matching that from inside the pane started a resize on
  // every press.
  const handle = ctx.$('[data-colrz="tags"]');
  assert.ok(handle, "resize handle rendered");
  handle.dispatchEvent(new Event("mousedown", { bubbles: true, target: handle, clientX: 300, clientY: 40 }));
  ctx.document.dispatchEvent(new Event("mousemove", { bubbles: false, clientX: 360, clientY: 40 }));
  ctx.document.dispatchEvent(new Event("mouseup", { bubbles: false }));
  await settle(260);

  assert.ok(ctx.html().includes("--w-tags:176px"), "column widened by 60px");
  const saved = ctx.storage.get("se-detached.prefs.v2");
  assert.ok(saved && saved.includes('"tags":176'), "width persisted");
});

// ── views, filters, batch selection ──────────────────────────────────────

test("the view switch toggles the panel's icon view", async () => {
  const ctx = await boot();
  assert.equal(ctx.$("#se-listpane").getAttribute("data-view"), "details");

  click(ctx.$('[data-setview="icons"]'));
  await settle(5);
  assert.equal(ctx.$("#se-listpane").getAttribute("data-view"), "icons", "icons view applied");

  click(ctx.$('[data-setview="details"]'));
  await settle(5);
  assert.equal(ctx.$("#se-listpane").getAttribute("data-view"), "details", "back to details");
});

test("the filter dialog narrows the list and can be cleared", async () => {
  const ctx = await boot();
  const before = ctx.$$("[data-session]").length;

  click(ctx.$('[data-act="filter"]'));
  await settle(5);
  assert.ok(ctx.$(".fmodal"), "filter dialog opened");

  click(ctx.$('[data-fseg="favorite"][data-fval="yes"]'));
  await settle(5);
  click(ctx.$('[data-dlg="apply"]'));
  await settle(5);

  assert.ok(ctx.$$("[data-session]").length < before, "filtered list is shorter");
  assert.ok(ctx.text().includes("筛选中"), "status says a filter is on");

  click(ctx.$('[data-act="clear-filter"]'));
  await settle(5);
  assert.equal(ctx.$$("[data-session]").length, before, "filter cleared");
});

test("checking a row shows the count and drives the batch action", async () => {
  const ctx = await boot();
  click(ctx.$('[data-check="session-b"]'));
  await settle(5);

  assert.ok(ctx.text().includes("已选 1 项"), "status shows the checked count");

  click(ctx.$('[data-act="delete"]'));
  await settle();

  const trash = ctx.calls.find((call) => call.path.endsWith("/trash"));
  assert.ok(trash, "trash request sent");
  assert.deepEqual(trash.body.ids, ["session-b"], "the checked row, not the selected one");
});

// ── clipboard and undo ───────────────────────────────────────────────────

test("Ctrl+X marks the row as cut and Ctrl+V moves it to the scope workspace", async () => {
  const ctx = await boot();
  click(ctx.$$('[data-node="w-ws-1"]')[0]);
  await settle(5);
  await selectRow(ctx, "session-b");

  press(ctx.window, "x", { ctrlKey: true });
  await settle(5);
  assert.equal(ctx.$$(".row.cut").length, 1, "cut row is dimmed");

  press(ctx.window, "v", { ctrlKey: true });
  await settle();

  const move = ctx.calls.find((call) => call.path.endsWith("/move"));
  assert.ok(move, "move request sent");
  assert.deepEqual(move.body.ids, ["session-b"]);
  assert.equal(move.body.target.workspaceId, "ws-1");
  assert.equal(move.body.copy, false, "a cut is a move, not a copy");
});

test("Ctrl+Z undoes the last destructive action", async () => {
  const ctx = await boot();
  await selectRow(ctx, "session-a");
  click(ctx.$('[data-act="delete"]'));
  await settle();
  assert.ok(ctx.calls.some((call) => call.path.endsWith("/trash")), "trashed first");

  press(ctx.window, "z", { ctrlKey: true });
  await settle();

  const restore = ctx.calls.find((call) => call.path.endsWith("/restore"));
  assert.ok(restore, "undo restored the session");
  assert.deepEqual(restore.body.ids, ["session-a"]);
});

// ── drag and drop, tabs ──────────────────────────────────────────────────

test("dragging a session onto a workspace row moves it there", async () => {
  const ctx = await boot();
  const row = ctx.$$('[data-session="session-b"]')[0];
  row.dispatchEvent(new Event("dragstart", { bubbles: true, target: row, dataTransfer: { setData() {}, effectAllowed: "" } }));
  await settle(5);

  const target = ctx.$$('[data-node="w-ws-1"]')[0];
  const over = new Event("dragover", { bubbles: true, target, dataTransfer: { dropEffect: "" } });
  target.dispatchEvent(over);
  await settle(5);
  assert.ok(target.classList.contains("drop"), "drop target highlighted");
  assert.ok(over.defaultPrevented, "drop allowed");

  target.dispatchEvent(new Event("drop", { bubbles: true, target, dataTransfer: { dropEffect: "move" } }));
  await settle();

  const move = ctx.calls.find((call) => call.path.endsWith("/move"));
  assert.ok(move, "move request sent");
  assert.deepEqual(move.body.ids, ["session-b"]);
  assert.ok(!ctx.html().includes("trow drop"), "highlight cleared");
});

test("a session dropped on a folder becomes a shortcut and does not move", async () => {
  const ctx = await boot();
  const row = ctx.$$('[data-session="session-b"]')[0];
  row.dispatchEvent(new Event("dragstart", { bubbles: true, target: row, dataTransfer: { setData() {}, effectAllowed: "" } }));
  await settle(5);

  const target = ctx.$$('[data-node="d-1"]')[0];
  const over = new Event("dragover", { bubbles: true, target, dataTransfer: { dropEffect: "" } });
  target.dispatchEvent(over);
  await settle(5);
  assert.ok(over.defaultPrevented, "folder accepts the drop as a reference");
  assert.ok(target.classList.contains("drop"), "drop target highlighted");

  target.dispatchEvent(new Event("drop", { bubbles: true, target, dataTransfer: { dropEffect: "move" } }));
  await settle();

  const shortcut = ctx.calls.find((call) => call.path.endsWith("/shortcuts"));
  assert.ok(shortcut, "a shortcut request was sent");
  assert.equal(shortcut.body.parent, "d-1");
  assert.equal(shortcut.body.kind, "session");
  assert.equal(shortcut.body.targetId, "session-b");
  assert.ok(!ctx.calls.some((call) => call.path.endsWith("/move")), "the session did not move");
});

test("Ctrl+T opens a tab, Ctrl+W closes it and Ctrl+1 returns to the first", async () => {
  const ctx = await boot();
  const tabCount = () => ctx.$$("[data-tab]").length;
  assert.equal(tabCount(), 1, "starts with one tab");

  press(ctx.window, "t", { ctrlKey: true });
  await settle(5);
  assert.equal(tabCount(), 2, "second tab opened");
  assert.ok(ctx.$$("[data-tab]")[1].classList.contains("active"), "new tab is active");

  press(ctx.window, "w", { ctrlKey: true });
  await settle(5);
  assert.equal(tabCount(), 1, "tab closed");

  press(ctx.window, "t", { ctrlKey: true });
  await settle(5);
  press(ctx.window, "1", { ctrlKey: true });
  await settle(5);
  assert.ok(ctx.$$("[data-tab]")[0].classList.contains("active"), "Ctrl+1 activates the first tab");
});

// ── tags and notes ───────────────────────────────────────────────────────

test("clicking a tag's × removes it from the session", async () => {
  const ctx = await boot();
  await selectRow(ctx, "session-a");

  const chip = ctx.$('[data-untag="插件"]');
  assert.ok(chip, "tag chip rendered");
  click(chip);
  await settle();

  const patch = ctx.calls.find((call) => call.path.includes("/annotations/session-a"));
  assert.ok(patch, "annotation patched");
  assert.deepEqual(patch.body.tags, ["重构"]);
});

test("editing the note and leaving the field saves it", async () => {
  const ctx = await boot();
  await selectRow(ctx, "session-a");

  const note = ctx.$("#note-input");
  assert.ok(note, "note editor rendered");
  type(note, "新的备注");
  note.dispatchEvent(new Event("focusout", { bubbles: true, target: note }));
  await settle();

  const patch = ctx.calls.find((call) => call.path.includes("/annotations/session-a"));
  assert.ok(patch, "note patched");
  assert.equal(patch.body.note, "新的备注");
});

test("the tag picker adds a library tag and a new tag joins the library", async () => {
  const ctx = await boot();
  await selectRow(ctx, "session-a");

  click(ctx.$('[data-act="toggle-tags"]'));
  await settle(5);
  const option = ctx.$('[data-tag="归档候选"]');
  assert.ok(option, "library suggestion rendered");
  click(option);
  await settle();

  const patch = ctx.calls.find((call) => call.path.includes("/annotations/session-a"));
  assert.ok(patch, "annotation patched");
  assert.deepEqual(patch.body.tags, ["重构", "插件", "归档候选"]);

  // The picker stays open across the reload the first add triggered, so the
  // "new tag" field is already on screen.
  const input = ctx.$("#tag-input");
  assert.ok(input, "the picker is still open after adding a tag");
  input.value = "全新标签";
  click(ctx.$('[data-act="new-tag"]'));
  await settle();

  const add = ctx.calls.find((call) => call.path === "/session-explorer/api/tags" && call.method === "POST");
  assert.ok(add, "new tag added to the library");
  assert.equal(add.body.tag, "全新标签");
});

// ── destructive flows ────────────────────────────────────────────────────

test("deleting a folder from its context menu asks first and lifts the contents", async () => {
  const ctx = await boot();
  const row = ctx.$$('[data-node="d-1"]')[0];
  contextMenu(row, 120, 200);
  await settle(5);

  const item = ctx.$('[data-mi="delete-folder"]');
  assert.ok(item, "the folder menu offers 删除文件夹");
  click(item);
  await settle(5);
  assert.ok(ctx.$(".fmodal"), "confirmation dialog opened");
  assert.ok(ctx.$(".fmodal").textContent.includes("内容会移到上一层"), "explains the lift");

  click(ctx.$('[data-dlg="ok"]'));
  await settle();

  const remove = ctx.calls.find((call) => call.path.includes("/folders/d-1") && call.method === "DELETE");
  assert.ok(remove, "folder deleted");
  assert.ok(remove.path.includes("lift=1"), "contents are lifted, not trashed");
});

test("the trash view restores a session and offers to empty the bin", async () => {
  const trashedRow = {
    id: "session-z", workspaceId: "ws-1", workspaceTitle: "默认工作区",
    title: "删掉的会话", displayTitle: "删掉的会话", cwd: "C:/work",
    createdAt: null, activityAt: Date.now() - 1000, sizeBytes: 128,
    pinned: false, archived: false, favorite: false, todo: false, running: false,
    isSeeded: false, tags: [], note: "", stats: null, trashed: true, deletedAt: Date.now(),
  };
  const ctx = await boot({ bootstrap: fixture({ trashed: [trashedRow] }) });
  click(ctx.$$('[data-node="f-trash"]')[0]);
  await settle(5);

  assert.ok(ctx.$(".listbody").textContent.includes("删掉的会话"), "trashed row listed");
  assert.ok(ctx.$('[data-act="empty-trash"]'), "empty-bin action offered");

  click(ctx.$$('[data-session="session-z"]')[0]);
  await settle(5);
  click(ctx.$('[data-act="restore"]'));
  await settle();

  const restore = ctx.calls.find((call) => call.path.endsWith("/restore"));
  assert.ok(restore, "restore requested");
  assert.deepEqual(restore.body.ids, ["session-z"]);
});

test("right-clicking empty space offers creating a folder and rescanning", async () => {
  const ctx = await boot();
  contextMenu(ctx.$(".listbody"), 200, 200);
  await settle(5);

  const menu = ctx.$(".ctxmenu");
  assert.ok(menu, "menu rendered");
  assert.ok(menu.textContent.includes("新建文件夹"), "create folder offered");
  assert.ok(menu.textContent.includes("重新扫描"), "rescan offered");
  assert.equal(ctx.$$(".ctxmenu").length, 1, "one menu at a time");
});

test("the status bar reports the visible count and the total size", async () => {
  const ctx = await boot();
  const status = ctx.$(".status").textContent;
  assert.ok(status.includes("3 个项目"), "three sessions in scope");
  assert.ok(status.includes("共"), "size total shown");
});

test("an archived row is dimmed but still listed (归档 is visual, not hidden)", async () => {
  const ctx = await boot();
  const archived = ctx.$$(".row.arch");
  assert.equal(archived.length, 1, "archived row present");
  assert.ok(archived[0].textContent.includes("旧会话"));
  assert.ok(ctx.text().includes("已归档"), "grouped separately");
});

// ── the bridge ───────────────────────────────────────────────────────────

test("打开 asks the panel to open the session through the bridge", async () => {
  const ctx = await boot();
  await selectRow(ctx, "session-a");

  click(ctx.$('[data-act="open"]'));
  await settle();

  const command = ctx.calls.find((call) => call.path.endsWith("/bridge/commands"));
  assert.ok(command, "a bridge command was published");
  assert.equal(command.method, "POST");
  assert.equal(command.body.kind, "open-session");
  assert.equal(command.body.payload.sessionId, "session-a");
  assert.ok(!ctx.calls.some((call) => call.path.endsWith("/detached/focus")), "no fake focus call");
});

test("a failed bridge call still leaves the id on the clipboard", async () => {
  const ctx = await boot({
    respond: (call) => (call.path.endsWith("/bridge/commands") ? { ok: false, error: "no panel" } : { ok: true, result: {} }),
  });
  await selectRow(ctx, "session-a");
  click(ctx.$('[data-act="open"]'));
  await settle();

  assert.ok(ctx.text().includes("已复制会话 id"), "the fallback explains itself");
});

test("新建会话 asks the panel for a session in the current workspace", async () => {
  const ctx = await boot();
  click(ctx.$$('[data-node="w-ws-1"]')[0]);
  await settle(5);

  // 新建 is a menu, as in the panel: the command bar has one entry, not two.
  click(ctx.$('[data-act="create-menu"]'));
  await settle(5);
  click(ctx.$('[data-mi="new-session"]'));
  await settle();

  const command = ctx.calls.find((call) => call.path.endsWith("/bridge/commands"));
  assert.ok(command, "a bridge command was published");
  assert.equal(command.body.kind, "new-session");
  assert.equal(command.body.payload.workspaceId, "ws-1");
});

test("a reveal command selects the row, opens its container and switches to its workspace", async () => {
  const ctx = await boot({ bootstrap: fixture() });
  // Stand in an unrelated folder first, so the test proves the reveal navigates.
  click(ctx.$$('[data-node="d-1"]')[0]);
  await settle(5);

  ctx.deliver({ kind: "reveal", payload: { sessionId: "session-b" } });
  await settle(5);

  assert.ok(ctx.$("#se-listpane").textContent.includes("C:/work/other"), "the row is in the list");
  assert.equal(ctx.$$(".row.sel").length, 1, "exactly one row is selected");
  assert.ok(ctx.$$(".row.sel")[0].getAttribute("data-session"), "the selected row is a session");
  assert.ok(ctx.text().includes("已定位到"), "the window says what it did");
  assert.ok(ctx.$(".pane-detail"), "the detail pane is on screen for the revealed row");
});

test("an unknown command is ignored instead of throwing", async () => {
  const ctx = await boot();
  const before = ctx.html();

  assert.doesNotThrow(() => ctx.deliver({ kind: "delete-everything" }));
  assert.doesNotThrow(() => ctx.deliver({ kind: "reveal", payload: {} }));
  assert.doesNotThrow(() => ctx.deliver(null));

  assert.equal(ctx.html(), before, "the window did not change");
});

// ── API surface ──────────────────────────────────────────────────────────

test("every route the window calls exists on the Host", async () => {
  // The window has no client bundle to share route knowledge with, so a typo in
  // a path would only surface as a 404 at runtime. The route table is the source
  // of truth; parse it and check the literals the bundle contains.
  const index = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const routes = new Set(
    [...index.matchAll(/^\s{2}"(?:GET|POST|PATCH|PUT|DELETE) ([^"]+)":/gm)].map((match) => match[1]),
  );
  assert.ok(routes.size > 30, "route table parsed");

  const used = new Set();
  for (const match of SRC.matchAll(/["`]\/(bootstrap|annotations|folders|nodes|move|trash|restore|purge|sessions|workspaces|tags)[^"`]*/g)) {
    used.add(match[0].replace(/^`|^"/, ""));
  }
  const normalise = (path) => path.replace(/\?.*$/, "").replace(/\$\{[^}]*\}/g, ":id");
  const known = new Set([...routes].map((route) => normalise(route)));

  const unknown = [];
  for (const path of used) {
    const clean = normalise(path.replace(/\/session-explorer\/api/, ""));
    if (clean === "" || clean === "/") continue;
    // A template is only a prefix ("/sessions/" + id + "/rename"); it is fine as
    // long as some served route continues it.
    const served = clean.endsWith("/")
      ? [...known].some((route) => route.startsWith(clean))
      : known.has(clean) || [...known].some((route) => route.startsWith(clean + "/"));
    if (!served) unknown.push(path);
  }
  assert.deepEqual(unknown, [], "no route the Host does not serve");
});

test("the window never calls a route that was removed in P7", async () => {
  for (const gone of ["/sessions?", "/tree", "by-node"]) {
    assert.ok(!SRC.includes(gone), "removed route " + gone + " is not referenced");
  }
});

// ── preferences ──────────────────────────────────────────────────────────

test("the window remembers its tabs, view and widths across reloads", async () => {
  const ctx = await boot();
  press(ctx.window, "t", { ctrlKey: true });
  await settle(5);
  click(ctx.$('[data-setview="icons"]'));
  await settle(260);

  const saved = JSON.parse(ctx.storage.get("se-detached.prefs.v2"));
  assert.equal(saved.view, "icons", "view persisted");
  assert.equal(saved.tabs.length, 2, "tabs persisted");

  const second = await boot({ bootstrap: fixture(), storage: ctx.storage });
  assert.equal(second.$$("[data-tab]").length, 2, "tabs restored");
  assert.equal(second.$("#se-listpane").getAttribute("data-view"), "icons", "view restored");
});
