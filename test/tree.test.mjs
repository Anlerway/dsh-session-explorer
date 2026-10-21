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
  canAcceptSessions,
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

test("the default workspace is an ordinary, movable workspace node", () => {
  const withDefault = {
    ...registry,
    defaultWorkspaceId: "wb",
  };
  const tree = buildAutoTree({ registry: withDefault, sessions });
  const node = tree.nodes[workspaceNodeId("wb")];
  assert.equal(node.parent, FIXED_NODES.root);
  // 默认工作区 is now a normal workspace: no special kind means no special
  // rename lock, no pinned position, and moving it is legal.
  assert.equal(node.kind, "workspace");
  assert.equal(node.name, "Beta");
  assert.equal(node.workspaceId, "wb");
  // The marker survives so the UI can still point new sessions at it.
  assert.equal(node.default, true);
  assert.equal(tree.counts[workspaceNodeId("wb")], 1);
  // …and it sorts with the other workspaces instead of jumping to the top.
  const siblings = tree.children[FIXED_NODES.root];
  assert.ok(siblings.indexOf(workspaceNodeId("wa")) < siblings.indexOf(workspaceNodeId("wb")));
});

test("R2+R3: every session is counted exactly once on its own container", () => {
  const tree = buildAutoTree({ registry, sessions });
  // 收藏 / 待办 are shortcut containers and 所有会话 mirrors the whole set, so
  // neither takes part in the container sum. 未分组 owns the sessions that have
  // no workspace; every workspace owns its own.
  const excluded = new Set([FIXED_NODES.favorites, FIXED_NODES.todos, FIXED_NODES.all]);
  const containers = tree.children[FIXED_NODES.root].filter(
    (id) => !excluded.has(id) && (tree.nodes[id]?.type === "workspace" || id === FIXED_NODES.ungrouped),
  );
  const sum = containers.reduce((total, id) => total + (tree.counts[id] ?? 0), 0);
  assert.equal(sum, sessions.length);
  // 所有会话 mirrors the live set exactly.
  assert.equal(tree.counts[FIXED_NODES.all], sessions.length);
  // 根目录 aggregates the directory tree below it: with every workspace hanging
  // off the root *and* 未分组 being a real container, that is every live
  // session — but reached through the tree, not by counting sessions itself.
  assert.equal(tree.counts[FIXED_NODES.root], sessions.length);
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

test("scope: 所有会话 is the flat list, the root is the directory tree", () => {
  const tree = buildAutoTree({ registry, sessions });
  const view = { sessions };
  assert.deepEqual(
    sessionsOfNode(FIXED_NODES.all, view, tree).map((session) => session.id).sort(),
    sessions.map((session) => session.id).sort(),
  );
  // 根目录 is a directory, not a list: it shows folders, workspaces and the
  // 所有会话 view, and holds no session rows of its own.
  assert.deepEqual(sessionsOfNode(FIXED_NODES.root, view, tree), []);
  assert.deepEqual(
    sessionsOfNode(FIXED_NODES.ungrouped, view, tree).map((session) => session.id),
    ["s4"],
  );
});

test("scope follows the selection", () => {
  const tree = buildAutoTree({ registry, sessions });
  const view = { sessions };
  const ids = (nodeId) => sessionsOfNode(nodeId, view, tree).map((s) => s.id);
  // 根目录 lists no sessions at all; the flat list is 所有会话.
  assert.deepEqual(ids(FIXED_NODES.root), []);
  assert.deepEqual(ids(FIXED_NODES.all), ["s1", "s2", "s3", "s4"]);
  assert.deepEqual(ids(workspaceNodeId("wa")), ["s1", "s2"]);
  assert.deepEqual(ids(FIXED_NODES.ungrouped), ["s4"]);
  assert.deepEqual(ids(FIXED_NODES.trash), []);
});

// ── virtual session placement ────────────────────────────────────────────────
//
// DSH derives a session's workspace from the header `cwd`, so re-homing a
// session physically would mean moving its directory — which hard constraint 1
// forbids. The sidecar therefore carries a grouping override: the row moves,
// the bytes do not.

test("a virtual placement moves the row without touching the session's workspace", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: { sessionPlacement: { s1: FIXED_NODES.ungrouped } },
  });
  // The counts follow the *placement*, not the registry.
  assert.equal(tree.counts[FIXED_NODES.ungrouped], 2, "s4 plus the re-homed s1");
  assert.equal(tree.counts[workspaceNodeId("wa")], 1, "only s2 is still shown under wa");
  assert.equal(tree.counts[FIXED_NODES.all], sessions.length, "the flat list is unchanged");

  const view = { sessions };
  assert.deepEqual(sessionsOfNode(FIXED_NODES.ungrouped, view, tree).map((s) => s.id).sort(), ["s1", "s4"]);
  assert.deepEqual(sessionsOfNode(workspaceNodeId("wa"), view, tree).map((s) => s.id), ["s2"]);
  // The session itself still reports the workspace DSH registered.
  assert.equal(view.sessions.find((session) => session.id === "s1").workspaceId, "wa");
});

test("a placement naming a vanished node degrades to the session's own workspace", () => {
  const tree = buildAutoTree({ registry, sessions, userTree: { sessionPlacement: { s1: "d-gone" } } });
  assert.deepEqual(
    sessionsOfNode(workspaceNodeId("wa"), { sessions }, tree).map((s) => s.id),
    ["s1", "s2"],
  );
  assert.equal(tree.counts[workspaceNodeId("wa")], 2);
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

test("未分组 accepts sessions and offers a placement target; 根目录 and the views do not", () => {
  const tree = buildAutoTree({ registry, sessions });
  assert.equal(canAcceptSessions(workspaceNodeId("wa"), tree), true);
  assert.equal(canAcceptSessions(FIXED_NODES.ungrouped, tree), true);
  assert.equal(canAcceptSessions(FIXED_NODES.root, tree), false);
  assert.equal(canAcceptSessions(FIXED_NODES.favorites, tree), false);
  assert.equal(canAcceptSessions(FIXED_NODES.trash, tree), false);
  assert.equal(canAcceptSessions("d-nope", tree), false);
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
  // 根目录 no longer counts sessions directly; it aggregates its subtree, which
  // still reaches every session through the workspaces below it.
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
  // 文件夹可以随意组合：folder in folder, folder in workspace, folder at root.
  assert.equal(canMove("d-b", FIXED_NODES.root, tree).ok, true);
  assert.equal(canMove("d-a", "d-b", tree).ok, false, "a folder may not enter its own descendant");
  assert.equal(canMove("d-a", workspaceNodeId("wa"), tree).ok, true, "a plain folder may live in a workspace");
  // 工作区可以进文件夹或根，永远不能进另一个工作区。
  assert.equal(canMove(workspaceNodeId("wa"), "d-a", tree).ok, true);
  assert.equal(canMove(workspaceNodeId("wa"), workspaceNodeId("wb"), tree).ok, false);
  // Fixed nodes are immovable, and unknown ids are rejected.
  assert.equal(canMove(FIXED_NODES.trash, FIXED_NODES.root, tree).ok, false);
  assert.equal(canMove("d-nope", FIXED_NODES.root, tree).ok, false);
});

test("the only structural rule is that a workspace never nests inside a workspace", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: {
      folders: {
        "d-hold": { id: "d-hold", name: "持有工作区", parent: FIXED_NODES.root, order: 0 },
        "d-plain": { id: "d-plain", name: "空文件夹", parent: FIXED_NODES.root, order: 1 },
        "d-under": { id: "d-under", name: "下级", parent: "d-hold", order: 0 },
      },
      // wa lives inside d-hold, so that whole subtree carries a workspace.
      placement: { wa: "d-hold" },
    },
  });

  // 一个文件夹里可以放第二个工作区——只要它不是套在工作区里面。
  assert.equal(canMove(workspaceNodeId("wb"), "d-hold", tree).ok, true);
  // 含工作区的文件夹不能进工作区（那会让里面的工作区嵌套）。
  assert.equal(canMove("d-hold", workspaceNodeId("wb"), tree).ok, false);
  // 空文件夹可以进工作区。
  assert.equal(canMove("d-plain", workspaceNodeId("wb"), tree).ok, true);
  // 含工作区的文件夹可以进另一个文件夹。
  assert.equal(canMove("d-hold", "d-plain", tree).ok, true);
  // 工作区可以进任意文件夹，也可以回到根。
  assert.equal(canMove(workspaceNodeId("wa"), "d-under", tree).ok, true);
  assert.equal(canMove(workspaceNodeId("wa"), FIXED_NODES.root, tree).ok, true);
  // 会话只能落在工作区（这条不约束树结构，只决定拖放目标）。
  assert.equal(canAcceptSessions(workspaceNodeId("wa"), tree), true);
  assert.equal(canAcceptSessions(FIXED_NODES.root, tree), false);
  assert.equal(canAcceptSessions("d-hold", tree), false);
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

// ── the counts the badges show ──────────────────────────────────────────────
//
// A badge has to match the number of rows the list actually renders, or the
// number is a lie the user can see. The three cases below were all wrong.

test("收藏 / 待办 count their shortcut rows as well as the flagged sessions", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: {
      // Two references into 收藏 (one session, one folder) next to s2's flag.
      shortcuts: {
        "s-one": { kind: "session", targetId: "s1", parent: FIXED_NODES.favorites, order: 0 },
        "s-two": { kind: "folder", targetId: "d-work", parent: FIXED_NODES.favorites, order: 1 },
      },
      folders: { "d-work": { id: "d-work", name: "工作", parent: FIXED_NODES.root, order: 0 } },
    },
  });
  // 1 flagged session + 2 rows pointing into the container = 3 rows on screen.
  assert.equal(tree.counts[FIXED_NODES.favorites], 3);
  assert.equal(tree.children[FIXED_NODES.favorites].length, 2, "two shortcut rows");
  assert.equal(tree.counts[FIXED_NODES.todos], 1, "待办 has no shortcuts here");
});

test("a folder keeps the sessions placed directly in it when it aggregates", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: {
      folders: {
        "d-own": { id: "d-own", name: "自己的", parent: FIXED_NODES.root, order: 0 },
        "d-sub": { id: "d-sub", name: "下级", parent: "d-own", order: 0 },
      },
      // A stale placement can name a folder; the folder must not lose it.
      sessionPlacement: { s4: "d-own" },
      placement: { wa: "d-sub" },
    },
  });
  assert.equal(tree.counts["d-sub"], 2, "wa's two sessions");
  // s4 sits directly in d-own, and d-sub adds two more: assigning instead of
  // adding used to report 2 here and lose s4 entirely.
  assert.equal(tree.counts["d-own"], 3);
});

test("a shortcut row never contributes to the container it sits in", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: {
      folders: { "d-box": { id: "d-box", name: "盒子", parent: FIXED_NODES.root, order: 0 } },
      placement: { wa: "d-box" },
      shortcuts: { "s-ref": { kind: "session", targetId: "s2", parent: "d-box", order: 0 } },
    },
  });
  // wa holds s1+s2; the reference row is a row, not two more sessions.
  assert.equal(tree.counts["d-box"], 2);
});

test("a reference to a session survives a trashing and dies with the payload", () => {
  // A shortcut is a second sighting of a session, and it may not be unlinked by
  // hand — so the only row it may ever leave behind is one that still points at
  // something. Trashing keeps it (the session can come back); a payload that is
  // gone from disk takes the row with it, or the panel would show a reference
  // to nothing that no command can clean up.
  const userTree = { shortcuts: { "s-ref": { kind: "session", targetId: "s2", parent: FIXED_NODES.favorites, order: 0 } } };
  const alive = buildAutoTree({ registry, sessions, userTree });
  assert.ok(alive.nodes["s-ref"], "a live target keeps its reference row");

  const binned = buildAutoTree({ registry, sessions, trashedIds: new Set(["s2"]), userTree });
  assert.ok(binned.nodes["s-ref"], "a binned session is recoverable, so its reference stays");

  // s2 is not in `sessions` at all: the payload was purged or deleted by hand.
  const gone = buildAutoTree({
    registry,
    sessions: sessions.filter((session) => session.id !== "s2"),
    userTree,
  });
  assert.equal(gone.nodes["s-ref"], undefined, "a reference to a vanished session is not built");
  assert.equal(gone.children[FIXED_NODES.favorites].length, 0, "and it leaves no empty row behind");
});

test("a folder created inside 未分组 stays there", () => {
  const tree = buildAutoTree({
    registry,
    sessions,
    userTree: { folders: { "d-in": { id: "d-in", name: "在未分组里", parent: FIXED_NODES.ungrouped, order: 0 } } },
  });
  // The three rules used to disagree: the host accepted the folder, the tree
  // re-parented it to the root, and canMove refused to put it back.
  assert.equal(tree.nodes["d-in"].parent, FIXED_NODES.ungrouped);
  assert.ok(tree.children[FIXED_NODES.ungrouped].includes("d-in"));
  assert.equal(canMove("d-in", FIXED_NODES.ungrouped, tree).ok, true, "and it may move back");
  assert.equal(canMove("d-in", FIXED_NODES.favorites, tree).ok, false, "but not into a reference bin");
});

test("trashed sessions leave the live views and appear only in the trash", () => {
  const tree = buildAutoTree({ registry, sessions, trashedIds: ["s1"] });
  const view = { sessions };
  const trashed = new Set(["s1"]);
  // 所有会话 is the live set; the bin is the only place a trashed session shows.
  assert.equal(tree.counts[FIXED_NODES.all], sessions.length - 1);
  assert.equal(tree.counts[FIXED_NODES.trash], 1);
  assert.deepEqual(
    sessionsOfNode(FIXED_NODES.all, view, tree, { trashedIds: trashed }).map((s) => s.id),
    ["s2", "s3", "s4"],
  );
  assert.deepEqual(
    sessionsOfNode(FIXED_NODES.trash, view, tree, { trashedIds: trashed }).map((s) => s.id),
    ["s1"],
  );
});
