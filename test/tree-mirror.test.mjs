/**
 * The client may hold one *traversal*, and no *rules*.
 *
 * Three copies of "where may a node go" used to exist (lib/domain/tree.js, the
 * static shell, and lib/client.js). The shell is gone and the rules moved to
 * lib/domain/tree-rules.js, but the client still has to grey out a bad drop
 * *before* the host answers, so it keeps a predicate of its own. This file is
 * what stops that predicate from drifting: it loads the real client bundle,
 * builds a tree with the real builder, and demands the same verdict for every
 * ordered pair of nodes.
 *
 *   node --test test/tree-mirror.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildAutoTree, canMove, sessionsOfNode } from "../lib/domain/tree.js";
import { shortcutTargetNodeId, subtreeOf } from "../lib/domain/tree-rules.js";
import { FIXED_NODES } from "../lib/constants.js";
import { loadClientBundle } from "./support/client-bundle.mjs";

// ── load the client bundle the same way the plugin host does ────────────────
// No bundler, no jsdom: a stub React is enough because the helpers under test
// are module-level functions, not components.
const { test: client } = loadClientBundle({ expose: ["canDropInTree", "subtreeIds", "shortcutTarget"] });
const { canDropInTree, subtreeIds, shortcutTarget } = client;

// ── a tree with one of everything ───────────────────────────────────────────
const registry = {
  workspaceIds: ["wa", "wb"],
  workspaces: new Map([
    ["wa", { id: "wa", title: "Alpha", path: "C:\\alpha" }],
    ["wb", { id: "wb", title: "Beta", path: "C:\\beta" }],
  ]),
};

const sessions = [
  { id: "s1", workspaceId: "wa", pinned: false, favorite: true, todo: false },
  { id: "s2", workspaceId: "wb", pinned: false, favorite: false, todo: false },
  { id: "s3", workspaceId: null, pinned: false, favorite: false, todo: false },
];

/**
 * 根目录 holds: 所有会话, 未分组, 待办, 收藏, d-a { d-b, w-wa }, w-wb, d-c { s-w → w-wb }.
 *
 * That covers a folder holding a workspace, a nested folder, a shortcut to a
 * workspace sitting in a folder, and a shortcut to a workspace sitting in the
 * root — the four shapes where "where may this go" is not obvious.
 */
const tree = buildAutoTree({
  registry,
  sessions,
  userTree: {
    folders: {
      "d-a": { id: "d-a", name: "A", parent: FIXED_NODES.root, order: 0 },
      "d-b": { id: "d-b", name: "B", parent: "d-a", order: 0 },
      "d-c": { id: "d-c", name: "C", parent: FIXED_NODES.root, order: 1 },
    },
    placement: { wa: "d-a" },
    shortcuts: {
      "s-w": { kind: "workspace", targetId: "wb", parent: "d-c", order: 0 },
    },
  },
});

test("the fixture really does contain one of each shape", () => {
  assert.equal(tree.nodes["w-wa"].parent, "d-a", "a workspace inside a folder");
  assert.equal(tree.nodes["d-b"].parent, "d-a", "a nested folder");
  assert.equal(tree.nodes["s-w"].parent, "d-c", "a shortcut inside a folder");
  assert.equal(tree.nodes["w-wb"].parent, FIXED_NODES.root);
  assert.equal(tree.nodes["w-wb"].hasWorkspace, true);
  assert.equal(tree.nodes["d-a"].hasWorkspace, true, "d-a carries wa");
  assert.equal(tree.nodes["d-c"].accepts.workspace, true, "d-c carries no workspace");
});

test("client canDropInTree agrees with host canMove for every ordered pair", () => {
  const ids = Object.keys(tree.nodes);
  const disagreements = [];
  for (const from of ids) {
    for (const to of ids) {
      const clientSays = canDropInTree(from, to, tree.nodes, tree.children);
      const hostSays = canMove(from, to, tree).ok === true;
      if (clientSays !== hostSays) disagreements.push(`${from} → ${to}: client ${clientSays}, host ${hostSays}`);
    }
  }
  assert.deepEqual(disagreements, [], "the client's drop predicate drifted from the host's move rule");
  // A matrix that is all-false would pass the loop above for the wrong reason.
  const allowed = ids.flatMap((from) => ids.filter((to) => canDropInTree(from, to, tree.nodes, tree.children)));
  assert.ok(allowed.length >= 20, `expected a permissive matrix, got ${allowed.length} allowed pairs`);
  assert.ok(ids.filter((id) => !ids.some((to) => canDropInTree(id, to, tree.nodes, tree.children))).length > 0);
});

test("client subtreeIds agrees with host subtreeOf", () => {
  for (const id of Object.keys(tree.nodes)) {
    assert.deepEqual(
      [...subtreeIds(id, tree.nodes, tree.children)].sort(),
      [...subtreeOf(id, tree)].sort(),
      `subtree of ${id}`,
    );
  }
});

test("client shortcutTarget resolves the same target the host ships as ref", () => {
  for (const node of Object.values(tree.nodes)) {
    if (node.kind !== "shortcut") continue;
    assert.equal(node.ref, shortcutTargetNodeId(node, tree), `ref on ${node.id}`);
    assert.equal(shortcutTarget(node, tree)?.id ?? null, node.ref, `client lookup for ${node.id}`);
  }
});

/**
 * Badge == rows, for every directory in the tree.
 *
 * This is the invariant the P17 fix established and that the unified subtree
 * rule makes structural: a directory's count is the length of the very list the
 * client renders for it.
 */
test("every directory's badge is the number of rows it renders", () => {
  const live = sessions;
  for (const node of Object.values(tree.nodes)) {
    if (node.kind === "shortcut" || !node.accepts.folder) continue;
    const rows = sessionsOfNode(node.id, { sessions: live }, tree, { trashedIds: new Set() }).length;
    if (node.id === FIXED_NODES.root) {
      // 根目录 lists directories, not sessions — the one documented exception.
      assert.equal(tree.counts[node.id], live.length, "根目录 counts every live session");
      assert.equal(rows, 0, "but it lists none");
      continue;
    }
    assert.equal(tree.counts[node.id], rows, `${node.id} (${node.name}) badge vs rows`);
  }
});

test("the client's per-node scope matches what the host lists", () => {
  // The client switches on `node.scope` and never re-derives a view.
  assert.equal(tree.nodes[FIXED_NODES.all].scope, "all");
  assert.equal(tree.nodes[FIXED_NODES.favorites].scope, "favorites");
  assert.equal(tree.nodes[FIXED_NODES.todos].scope, "todos");
  assert.equal(tree.nodes[FIXED_NODES.trash].scope, "trash");
  assert.equal(tree.nodes[FIXED_NODES.root].scope, "none");
  assert.equal(tree.nodes["d-a"].scope, "tree");
  assert.equal(tree.nodes["w-wa"].scope, "tree");
  assert.equal(tree.nodes["s-w"].scope, "tree", "a container shortcut shows its target's subtree");
});
