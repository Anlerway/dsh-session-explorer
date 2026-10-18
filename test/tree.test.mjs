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

import { buildAutoTree, sessionsOfNode, workspaceNodeId, workspaceIdOfNode } from "../lib/domain/tree.js";
import { FIXED_NODES } from "../lib/constants.js";

const registry = {
  workspaceIds: ["wa", "wb"],
  workspaces: new Map([
    ["wa", { id: "wa", title: "Alpha", path: "C:\\alpha" }],
    ["wb", { id: "wb", title: "Beta", path: "C:\\beta" }],
  ]),
};

const sessions = [
  { id: "s1", workspaceId: "wa", pinned: false },
  { id: "s2", workspaceId: "wa", pinned: true },
  { id: "s3", workspaceId: "wb", pinned: false },
  { id: "s4", workspaceId: null, pinned: false },
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
  const containers = tree.children[FIXED_NODES.root].filter((id) => id !== FIXED_NODES.favorites);
  const sum = containers.reduce((total, id) => total + (tree.counts[id] ?? 0), 0);
  assert.equal(sum, sessions.length);
  assert.equal(tree.counts[workspaceNodeId("wa")], 2);
  assert.equal(tree.counts[workspaceNodeId("wb")], 1);
  assert.equal(tree.counts[FIXED_NODES.ungrouped], 1);
});

test("R4: favorites mirrors the pinned set and is not part of the container sum", () => {
  const tree = buildAutoTree({ registry, sessions });
  assert.equal(tree.counts[FIXED_NODES.favorites], 1);
  assert.deepEqual(sessionsOfNode(FIXED_NODES.favorites, { sessions }, tree).map((s) => s.id), ["s2"]);
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
