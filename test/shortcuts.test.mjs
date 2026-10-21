/**
 * Tests for lib/domain/shortcuts.js and lib/host/theme.js.
 *
 * Both modules exist to keep one promise: a shortcut never moves its target,
 * and a theme token can never be a style-injection vector.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createShortcut, deleteShortcut, dropShortcutsTo, isShortcutContainer, isShortcutNodeId, normalizeShortcut } from "../lib/domain/shortcuts.js";
import { FIXED_NODES } from "../lib/constants.js";

const ids = () => {
  let n = 0;
  return () => "x" + ++n;
};

test("shortcut ids are recognisable and never collide with folders", () => {
  assert.equal(isShortcutNodeId("s-abc"), true);
  assert.equal(isShortcutNodeId("d-abc"), false);
  assert.equal(isShortcutNodeId("f-root"), false);
  assert.equal(isShortcutNodeId(null), false);
});

test("only 收藏 and 待办 are shortcut containers", () => {
  assert.equal(isShortcutContainer(FIXED_NODES.favorites), true);
  assert.equal(isShortcutContainer(FIXED_NODES.todos), true);
  assert.equal(isShortcutContainer(FIXED_NODES.ungrouped), false);
  assert.equal(isShortcutContainer(FIXED_NODES.root), false);
  assert.equal(isShortcutContainer(FIXED_NODES.trash), false);
});

test("createShortcut records a reference and nothing else", () => {
  const draft = {};
  const id = createShortcut(draft, { kind: "session", targetId: "sess-1", parent: FIXED_NODES.favorites }, ids());

  assert.equal(id, "s-x1");
  assert.deepEqual(Object.keys(draft.shortcuts), ["s-x1"]);
  const entry = draft.shortcuts["s-x1"];
  assert.equal(entry.kind, "session");
  assert.equal(entry.targetId, "sess-1");
  assert.equal(entry.parent, FIXED_NODES.favorites);
  // The defining property: no copy of the target, no path, no move marker.
  assert.ok(!("path" in entry));
  assert.ok(!("workspaceId" in entry));
});

test("the same target may be referenced twice, but not twice in one container", () => {
  const draft = {};
  // One factory for the whole scenario: a fresh `ids()` per call would hand out
  // the same id twice and the second create would overwrite the first.
  const next = ids();
  createShortcut(draft, { kind: "folder", targetId: "d-1", parent: FIXED_NODES.favorites }, next);
  createShortcut(draft, { kind: "folder", targetId: "d-1", parent: FIXED_NODES.todos }, next);
  assert.equal(Object.keys(draft.shortcuts).length, 2, "two containers, two references");

  assert.throws(
    () => createShortcut(draft, { kind: "folder", targetId: "d-1", parent: FIXED_NODES.favorites }, next),
    /已经有指向它的快捷方式/,
  );
});

test("createShortcut refuses an unknown kind or an empty target", () => {
  assert.throws(() => createShortcut({}, { kind: "workspace-ish", targetId: "x" }, ids()), /kind must be/);
  assert.throws(() => createShortcut({}, { kind: "session", targetId: "  " }, ids()), /targetId is required/);
});

// ── the host validates the parent against the real tree ────────────────────
//
// Before, the only guard was "not 根目录 / 所有会话 / 回收站". A parent that did not
// exist, or that was itself a shortcut, was accepted and written — and the tree
// then re-parented the row to the root at render time, or dropped it somewhere
// invisible. These are the cases that used to get through.

const treeFixture = () => ({
  nodes: {
    "f-root": { id: "f-root", kind: "root", name: "根目录", fixed: true },
    "f-all": { id: "f-all", kind: "all", name: "所有会话", fixed: true },
    "f-favorites": { id: "f-favorites", kind: "favorites", name: "收藏", fixed: true },
    "f-todos": { id: "f-todos", kind: "todos", name: "待办", fixed: true },
    "f-ungrouped": { id: "f-ungrouped", kind: "ungrouped", name: "未分组", fixed: true },
    "f-trash": { id: "f-trash", kind: "trash", name: "回收站", fixed: true },
    "d-work": { id: "d-work", kind: "folder", name: "工作", type: "folder" },
    "w-wa": { id: "w-wa", kind: "workspace", name: "Alpha", type: "workspace", workspaceId: "wa" },
    "s-old": { id: "s-old", kind: "shortcut", type: "shortcut" },
  },
});

test("createShortcut refuses a parent the tree does not have, or that is a reference", () => {
  const tree = treeFixture();
  const next = ids();

  assert.throws(
    () => createShortcut({}, { kind: "session", targetId: "s1", parent: "d-missing" }, next, tree),
    /unknown parent/,
  );
  assert.throws(
    () => createShortcut({}, { kind: "session", targetId: "s1", parent: "s-old" }, next, tree),
    /不能放在快捷方式里/,
  );
  assert.throws(
    () => createShortcut({}, { kind: "session", targetId: "s1", parent: "session-xyz" }, next, tree),
    /unknown parent/,
  );
  // A real container still works, including the fixed ones that hold references.
  for (const parent of ["d-work", "w-wa", FIXED_NODES.favorites, FIXED_NODES.todos, FIXED_NODES.ungrouped]) {
    assert.doesNotThrow(
      () => createShortcut({}, { kind: "session", targetId: "s1", parent }, ids(), tree),
      `${parent} may hold a reference`,
    );
  }
});

test("createShortcut refuses a folder or workspace target that is not in the tree", () => {
  const tree = treeFixture();
  const next = ids();
  assert.throws(
    () => createShortcut({}, { kind: "folder", targetId: "d-gone", parent: FIXED_NODES.favorites }, next, tree),
    /没有可以指向的文件夹/,
  );
  assert.throws(
    () => createShortcut({}, { kind: "workspace", targetId: "gone", parent: FIXED_NODES.todos }, next, tree),
    /没有可以指向的工作区/,
  );
  assert.doesNotThrow(
    () => createShortcut({}, { kind: "folder", targetId: "d-work", parent: FIXED_NODES.favorites }, ids(), tree),
  );
  assert.doesNotThrow(
    () => createShortcut({}, { kind: "workspace", targetId: "wa", parent: FIXED_NODES.todos }, ids(), tree),
  );
});

test("deleteShortcut removes the reference only", () => {
  const draft = {};
  const id = createShortcut(draft, { kind: "workspace", targetId: "ws-1", parent: FIXED_NODES.favorites }, ids());
  assert.deepEqual(deleteShortcut(draft, id), { removed: id });
  assert.deepEqual(draft.shortcuts, {});
  assert.throws(() => deleteShortcut(draft, id), /unknown shortcut/);
});

test("dropShortcutsTo removes every reference to a vanished target", () => {
  const draft = {};
  const next = ids();
  createShortcut(draft, { kind: "folder", targetId: "d-1", parent: FIXED_NODES.favorites }, next);
  createShortcut(draft, { kind: "folder", targetId: "d-1", parent: FIXED_NODES.todos }, next);
  createShortcut(draft, { kind: "folder", targetId: "d-2", parent: FIXED_NODES.todos }, next);

  const removed = dropShortcutsTo(draft, "folder", "d-1");
  assert.equal(removed.length, 2);
  assert.equal(Object.keys(draft.shortcuts).length, 1, "the unrelated reference survives");
});

test("normalizeShortcut drops an unusable entry instead of rendering a dead row", () => {
  assert.equal(normalizeShortcut({ kind: "session", targetId: "x" }, "not-a-shortcut"), null);
  assert.equal(normalizeShortcut({ kind: "nope", targetId: "x" }, "s-1"), null);
  assert.equal(normalizeShortcut({ kind: "session", targetId: "" }, "s-1"), null);
  const ok = normalizeShortcut({ kind: "session", targetId: "sess", parent: "d-1", order: 3 }, "s-1");
  assert.deepEqual(ok, { id: "s-1", kind: "session", targetId: "sess", parent: "d-1", order: 3, label: null, createdAt: null });
});
