/**
 * Unit tests for the tree projection — the only part of P1 that encodes rules
 * rather than IO, so it is the only part worth pinning down with assertions.
 *
 *   node --test test/
 *
 * The rules under test (实现粗规划.md §5.3):
 *   R1 a workspace is never nested inside another workspace
 *   R2 every session lands in exactly one container
 *   R3 counts add up to the session total
 *   R4 favorites is a view over pins, not a container
 *   R5 unknown / dangling node ids degrade instead of throwing
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ancestorsOf,
  buildAutoTree,
  canMove,
  nearestWorkspace,
  sessionsOfNode,
  workspaceNodeId,
  workspaceIdOfNode,
} from "../lib/domain/tree.js";
import { FIXED_NODES } from "../lib/constants.js";

const registry = {
  workspaceIds: ["wa", "wb"],
  workspaces: new Map([
    ["wa", { id: "wa", title: "Alpha", path: "C:\\alpha" }],
    ["wb", { id: "wb", title: "Beta", path: "C:\\beta" }],
  ]),
};

const sessions = [
  { id: "s1", workspaceId: "wa", pinned: false, favorite: false, todo: false },
  { id: "s2", workspaceId: "wa", pinned: true, favorite: true, todo: false },
  { id: "s3", workspaceId: "wb", pinned: false, favorite: false, todo: true },
  { id: "s4", workspaceId: null, pinned: false, favorite: false, todo: false },
];

test("node ids round-trip", () => {
  assert.equal(workspaceNodeId("wa"), "w-wa");
  assert.equal(workspaceIdOfNode("w-wa"), "wa");
  assert.equal(workspaceIdOfNode("f-root"), null);
  assert.equal(workspaceIdOfNode(null), null);
});

test("R1: workspaces hang directly off the root, never off each other", () => {
  const tree = buildAutoTree({ registry, sessions });
  for (const workspaceId of registry.workspaceIds) {
    assert.equal(tree.nodes[workspaceNodeId(workspaceId)].parent, FIXED_NODES.root);
  }
  // Only the trash sits outside the root: every live session is reachable from
  // 根目录, trashed ones leave it.
  assert.deepEqual(tree.roots, [FIXED_NODES.root, FIXED_NODES.trash]);
  assert.equal(tree.nodes[FIXED_NODES.trash].parent, null);
});

test("the default workspace is a real node inside the root", () => {
  const withDefault = {
    ...registry,
    defaultWorkspaceId: "wb",
  };
  const tree = buildAutoTree({ registry: withDefault, sessions });
  const node = tree.nodes[workspaceNodeId("wb")];
  assert.equal(node.parent, FIXED_NODES.root);
  assert.equal(node.kind, "default-workspace");
  assert.equal(node.name, "默认工作区");
  assert.equal(node.workspaceId, "wb");
  // …and it is still an ordinary workspace container for counting purposes.
  assert.equal(tree.counts[workspaceNodeId("wb")], 1);
});

test("R2+R3: every session is counted exactly once and counts sum to the total", () => {
  const tree = buildAutoTree({ registry, sessions });
  // 收藏 / 待办 are shortcut views, so they are not part of the container sum.
  const shortcuts = new Set([FIXED_NODES.favorites, FIXED_NODES.todos]);
  const containers = tree.children[FIXED_NODES.root].filter((id) => !shortcuts.has(id));
  const sum = containers.reduce((total, id) => total + (tree.counts[id] ?? 0), 0);
  assert.equal(sum, sessions.length);
  assert.equal(tree.counts[workspaceNodeId("wa")], 2);
  assert.equal(tree.counts[workspaceNodeId("wb")], 1);
  assert.equal(tree.counts[FIXED_NODES.ungrouped], 1);
});

test("R4: favorites and todos mirror the plugin flags and are not part of the container sum", () => {
  const tree = buildAutoTree({ registry, sessions });
  assert.equal(tree.counts[FIXED_NODES.favorites], 1);
  assert.equal(tree.counts[FIXED_NODES.todos], 1);
  assert.deepEqual(sessionsOfNode(FIXED_NODES.favorites, { sessions }, tree).map((s) => s.id), ["s2"]);
  assert.deepEqual(sessionsOfNode(FIXED_NODES.todos, { sessions }, tree).map((s) => s.id), ["s3"]);
  // A pin alone is 置顶, not 收藏: s2 is both here, so assert the independence.
  const pinOnly = [{ id: "p1", workspaceId: "wa", pinned: true, favorite: false, todo: false }];
  const tree2 = buildAutoTree({ registry, sessions: pinOnly });
  assert.equal(tree2.counts[FIXED_NODES.favorites], 0);
});

test("scope follows the selection", () => {
  const tree = buildAutoTree({ registry, sessions });
  const view = { sessions };
  const ids = (nodeId) => sessionsOfNode(nodeId, view, tree).map((s) => s.id);
  assert.deepEqual(ids(FIXED_NODES.root), ["s1", "s2", "s3", "s4"]);
  assert.deepEqual(ids(workspaceNodeId("wa")), ["s1", "s2"]);
  assert.deepEqual(ids(FIXED_NODES.ungrouped), ["s4"]);
  assert.deepEqual(ids(FIXED_NODES.trash), []);
});

test("R5: a session pointing at a vanished workspace is not counted anywhere it cannot be shown", () => {
  const tree = buildAutoTree({
    registry,
    sessions: [...sessions, { id: "s5", workspaceId: "gone", pinned: false }],
  });
  // No node exists for "gone", so it silently drops out of the container counts
  // instead of creating a phantom branch.
  assert.equal(tree.nodes[workspaceNodeId("gone")], undefined);
  assert.equal(tree.counts[workspaceNodeId("wa")], 2);
  assert.equal(sessionsOfNode(workspaceNodeId("gone"), { sessions }, tree).length, 0);
});

test("an empty registry still yields a navigable tree", () => {
  const tree = buildAutoTree({ registry: null, sessions: [] });
  assert.deepEqual(tree.roots, [FIXED_NODES.root, FIXED_NODES.trash]);
  assert.equal(tree.counts[FIXED_NODES.root], 0);
  assert.ok(tree.children[FIXED_NODES.root].includes(FIXED_NODES.ungrouped));
});

// ── user folders (P2) ────────────────────────────────────────────────────────

test("a user folder holds a workspace and aggregates its sessions", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: {
      folders: { "d-work": { id: "d-work", name: "工作", parent: FIXED_NODES.root, order: 0 } },
      placement: { wa: "d-work" },
    },
  });
  assert.equal(tree.nodes["d-work"].parent, FIXED_NODES.root);
  assert.equal(tree.nodes[workspaceNodeId("wa")].parent, "d-work");
  // The workspace keeps its own count; the folder aggregates it.
  assert.equal(tree.counts[workspaceNodeId("wa")], 2);
  assert.equal(tree.counts["d-work"], 2);
  // …and the total is unchanged: a folder is a container, not a new session.
  assert.equal(tree.counts[FIXED_NODES.root], sessions.length);
});

test("nested folders aggregate from the deepest child upward", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: {
      folders: {
        "d-a": { id: "d-a", name: "A", parent: FIXED_NODES.root, order: 0 },
        "d-b": { id: "d-b", name: "B", parent: "d-a", order: 0 },
      },
      placement: { wa: "d-b", wb: "d-a" },
    },
  });
  assert.equal(tree.counts["d-b"], 2);
  assert.equal(tree.counts["d-a"], 3);
  assert.equal(tree.nodes[workspaceNodeId("wa")].parent, "d-b");
});

test("R1: a placement that would nest a workspace in a workspace is ignored", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: { folders: {}, placement: { wa: workspaceNodeId("wb") } },
  });
  assert.equal(tree.nodes[workspaceNodeId("wa")].parent, FIXED_NODES.root);
});

test("R5: a folder whose parent vanished degrades to the root", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: { folders: { "d-lost": { id: "d-lost", name: "孤儿", parent: "d-gone" } } },
  });
  assert.equal(tree.nodes["d-lost"].parent, FIXED_NODES.root);
});

test("R5: a parent cycle is cut at the root instead of looping forever", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: {
      folders: {
        "d-x": { id: "d-x", name: "X", parent: "d-y" },
        "d-y": { id: "d-y", name: "Y", parent: "d-x" },
      },
    },
  });
  // Neither folder can keep the other as parent without a cycle, so both land
  // on the root and the tree stays finite and walkable.
  assert.equal(tree.nodes["d-x"].parent, FIXED_NODES.root);
  assert.equal(tree.nodes["d-y"].parent, FIXED_NODES.root);
  assert.deepEqual(ancestorsOf("d-x", tree), [FIXED_NODES.root, "d-x"]);
});

test("canMove enforces the tree rules", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: {
      folders: {
        "d-a": { id: "d-a", name: "A", parent: FIXED_NODES.root, order: 0 },
        "d-b": { id: "d-b", name: "B", parent: "d-a", order: 0 },
      },
    },
  });
  // A folder may move inside another folder…
  assert.equal(canMove("d-b", FIXED_NODES.root, tree).ok, true);
  // …but not into its own descendant, and not into a workspace.
  assert.equal(canMove("d-a", "d-b", tree).ok, false);
  assert.equal(canMove("d-a", workspaceNodeId("wa"), tree).ok, false);
  // A workspace may live in a folder, never in another workspace.
  assert.equal(canMove(workspaceNodeId("wa"), "d-a", tree).ok, true);
  assert.equal(canMove(workspaceNodeId("wa"), workspaceNodeId("wb"), tree).ok, false);
  // Fixed nodes are immovable, and unknown ids are rejected.
  assert.equal(canMove(FIXED_NODES.trash, FIXED_NODES.root, tree).ok, false);
  assert.equal(canMove("d-nope", FIXED_NODES.root, tree).ok, false);
});

test("ancestorsOf and nearestWorkspace follow the chain", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: {
      folders: { "d-a": { id: "d-a", name: "A", parent: FIXED_NODES.root, order: 0 } },
      placement: { wa: "d-a" },
    },
  });
  assert.deepEqual(ancestorsOf(workspaceNodeId("wa"), tree), [FIXED_NODES.root, "d-a", workspaceNodeId("wa")]);
  assert.equal(nearestWorkspace(workspaceNodeId("wa"), tree), "wa");
  assert.equal(nearestWorkspace("d-a", tree), null);
});

test("trashed sessions leave the root and appear only in the trash", () => {
  const tree = buildAutoTree({ registry, sessions, trashedIds: ["s1"] });
  const view = { sessions };
  const trashed = new Set(["s1"]);
  assert.equal(tree.counts[FIXED_NODES.root], sessions.length - 1);
  assert.equal(tree.counts[FIXED_NODES.trash], 1);
  assert.deepEqual(
    sessionsOfNode(FIXED_NODES.root, view, tree, { trashedIds: trashed }).map((s) => s.id),
    ["s2", "s3", "s4"],
  );
  assert.deepEqual(
    sessionsOfNode(FIXED_NODES.trash, view, tree, { trashedIds: trashed }).map((s) => s.id),
    ["s1"],
  );
});
