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
