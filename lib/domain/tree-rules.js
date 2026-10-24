/**
 * dsh-session-navigator — the tree rules, in one place.
 *
 * Every question the UI asks about a tree node — which sessions it shows, where
 * a dragged node may land, what a dropped session may join — used to be answered
 * three times: here in the host, again inside `lib/client.js`, and a third time
 * in the deleted static shell. Three copies of one rule set is a bug generator,
 * so this module owns the answers and everybody else reads them:
 *
 *   - `lib/domain/tree.js` builds the tree and decorates every node with the
 *     answers (`accepts`, `scope`, `ref`, `hasWorkspace`);
 *   - `lib/index.js` validates writes with `canMove` / `canAcceptSessions`;
 *   - `lib/client.js` holds no decision table at all — it reads those fields and
 *     only walks `children` for the two shapes it needs (a subtree, and the
 *     parent chain a move has to stay out of).
 *
 * Load-bearing rules (each covered in test/tree.test.mjs):
 *
 *   R1  a workspace never nests inside another workspace (folders may sit
 *       between the root and a workspace, never between two workspaces);
 *   R2  a session's container is its workspace node, or 未分组 when it has none;
 *   R3  a session is counted exactly once, on that container;
 *   R4  收藏 / 待办 hold shortcuts (references), not sessions — a shortcut never
 *       changes the total, and 根目录 itself holds no sessions (它只装目录);
 *   R5  a node whose parent vanished degrades to the root instead of orphaning
 *       its children, and a cycle can never be constructed.
 *
 * Everything here is a pure function of its inputs, so all of it is testable
 * without a kernel or a filesystem.
 */

import { FIXED_NODES, WORKSPACE_NODE_PREFIX } from "../constants.js";
import { canHoldShortcuts } from "./shortcuts.js";

/** Node `kind` values the client uses to pick an icon and a scope behaviour. */
export const NODE_KINDS = Object.freeze({
  root: "root",
  defaultWorkspace: "default-workspace",
  workspace: "workspace",
  ungrouped: "ungrouped",
  favorites: "favorites",
  todos: "todos",
  trash: "trash",
  folder: "folder",
  shortcut: "shortcut",
  all: "all",
});

/**
 * How a node fills the list pane when it is selected.
 *
 * Shipped to the client as `node.scope`, so the browser never has to know which
 * node id means "everything" or "the bin".
 */
export const SCOPE_MODES = Object.freeze({
  all: "all",
  favorites: "favorites",
  todos: "todos",
  trash: "trash",
  tree: "tree",
  none: "none",
});

/**
 * @param {string} workspaceId
 * @returns {string}
 */
export function workspaceNodeId(workspaceId) {
  return WORKSPACE_NODE_PREFIX + workspaceId;
}

/**
 * @param {string} nodeId
 * @returns {string | null}
 */
export function workspaceIdOfNode(nodeId) {
  return typeof nodeId === "string" && nodeId.startsWith(WORKSPACE_NODE_PREFIX)
    ? nodeId.slice(WORKSPACE_NODE_PREFIX.length)
    : null;
}

/**
 * Ancestor chain of a node, root first. Used by the breadcrumbs.
 *
 * @param {string} nodeId
 * @param {{ nodes: Record<string, any> }} tree
 * @returns {string[]}
 */
export function ancestorsOf(nodeId, tree) {
  /** @type {string[]} */
  const chain = [];
  const seen = new Set();
  let cursor = nodeId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.unshift(cursor);
    cursor = tree.nodes[cursor]?.parent ?? null;
  }
  return chain;
}

/**
 * The workspace a node belongs to, following the parent chain. A folder that
 * only holds folders has no workspace, which is why this is derived rather than
 * stored.
 *
 * @param {string} nodeId
 * @param {{ nodes: Record<string, any> }} tree
 * @returns {string | null}
 */
export function nearestWorkspace(nodeId, tree) {
  const chain = ancestorsOf(nodeId, tree);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const workspaceId = workspaceIdOfNode(chain[index]);
    if (workspaceId) return workspaceId;
  }
  return null;
}

/**
 * The node a shortcut points at, as a node id, or null when the target is gone.
 *
 * A workspace shortcut stores DSH's own workspace id (no prefix), a folder
 * shortcut stores a folder node id, and a session shortcut stores a session id —
 * one id space per kind, so resolving one never needs a guess.
 *
 * @param {any} node
 * @param {{ nodes: Record<string, any> }} tree
 * @returns {string | null}
 */
export function shortcutTargetNodeId(node, tree) {
  if (!node || node.kind !== NODE_KINDS.shortcut) return null;
  if (node.shortcutKind === "workspace") {
    const target = workspaceNodeId(node.targetId);
    return tree.nodes?.[target] ? target : null;
  }
  if (node.shortcutKind === "folder") return tree.nodes?.[node.targetId] ? node.targetId : null;
  return null;
}

/**
 * Every node id at or below one node, the node itself included.
 *
 * A shortcut to a folder or a workspace contributes what it points at, without
 * the target moving here — that is what makes a reference row show real rows.
 * Cycle-safe: a shortcut pointing back into its own ancestor is simply skipped.
 *
 * `followReferences: false` answers the *structural* question instead: what
 * actually moves with this node. A reference is not part of the branch that
 * travels with a drag, so the two tree-shape rules (no workspace inside a
 * workspace, no node into its own subtree) must not follow one — a folder
 * holding a shortcut to workspace W is not "carrying W", and a shortcut to W is
 * not W's child.
 *
 * @param {string} nodeId
 * @param {{ nodes: Record<string, any>, children: Record<string, string[]> }} tree
 * @param {{ followReferences?: boolean }} [options]
 * @returns {Set<string>}
 */
export function subtreeOf(nodeId, tree, options = {}) {
  const followReferences = options.followReferences !== false;
  /** @type {Set<string>} */
  const ids = new Set();
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || ids.has(current)) continue;
    ids.add(current);
    const node = tree.nodes?.[current];
    if (node?.kind === NODE_KINDS.shortcut) {
      if (!followReferences) continue;
      const target = shortcutTargetNodeId(node, tree);
      if (target && target !== current) stack.push(target);
      // A shortcut has no children of its own: its whole meaning is the target.
      continue;
    }
    for (const child of tree.children?.[current] ?? []) stack.push(child);
  }
  return ids;
}

/**
 * The container node a session is *shown* in.
 *
 * Normally that is its DSH workspace node. A virtual placement in the sidecar
 * can override it — see the counts block in {@link buildTree} for why that
 * exists instead of a physical move. Null means "nowhere": the workspace it
 * names is gone, so the session shows up in 所有会话 but in no container.
 *
 * @param {{ id: string, workspaceId?: string | null }} session
 * @param {{ nodes: Record<string, any>, sessionPlacement?: Record<string, string> }} tree
 * @returns {string | null}
 */
export function placementOfNode(session, tree) {
  const override = tree.sessionPlacement?.[session.id];
  if (typeof override === "string" && tree.nodes?.[override]) return override;
  if (!session.workspaceId) return FIXED_NODES.ungrouped;
  const nodeId = workspaceNodeId(session.workspaceId);
  return tree.nodes?.[nodeId] ? nodeId : null;
}

/**
 * Sessions shown when a node is selected — and, by construction, what its badge
 * counts. Keep those two answers in one function and a badge can never disagree
 * with the rows under it.
 *
 * A directory node shows every live session whose home is somewhere in its
 * subtree (itself included). The fixed views are the exceptions they always
 * were: 所有会话 is everything, 收藏 / 待办 filter on the flags, 回收站 is the bin,
 * and 根目录 lists directories only (its badge is still the live total, because
 * that is what the number next to it means).
 *
 * @param {string} nodeId
 * @param {{ sessions: object[] }} view merged session view
 * @param {{ children: Record<string, string[]>, nodes: Record<string, any>, sessionPlacement?: Record<string, string> }} tree
 * @param {{ trashedIds?: Set<string> | string[] }} [options]
 * @returns {object[]}
 */
export function sessionsOfNode(nodeId, view, tree, options = {}) {
  const trashed = options.trashedIds instanceof Set ? options.trashedIds : new Set(options.trashedIds ?? []);
  const node = tree.nodes?.[nodeId];
  if (!node) return [];
  const live = view.sessions.filter((session) => !trashed.has(session.id));

  switch (node.kind) {
    case NODE_KINDS.all:
      return live;
    case NODE_KINDS.favorites:
      return live.filter((session) => session.favorite);
    case NODE_KINDS.todos:
      return live.filter((session) => session.todo);
    case NODE_KINDS.trash:
      return view.sessions.filter((session) => trashed.has(session.id));
    // 根目录 holds directories, not sessions: its rows are the folders,
    // workspaces and views below it. The flat list is one click away in 所有会话.
    case NODE_KINDS.root:
      return [];
    default:
      break;
  }

  // A shortcut to a session is exactly one row, so it shows exactly that one.
  if (node.kind === NODE_KINDS.shortcut && node.shortcutKind === "session") {
    return live.filter((session) => session.id === node.targetId);
  }

  const ids = subtreeOf(nodeId, tree);
  return live.filter((session) => {
    const home = placementOfNode(session, tree);
    return Boolean(home && ids.has(home));
  });
}

/**
 * Whether a node can hold a *directory* (folder or workspace) at all.
 *
 * Structural containers are the root, 未分组, user folders and workspaces.
 * 收藏 / 待办 are shortcut containers, 所有会话 is a view, 回收站 is a bin and a
 * shortcut is a reference, so none of them takes a directory.
 *
 * @param {any} node
 * @returns {boolean}
 */
function holdsDirectories(node) {
  if (!node) return false;
  if (node.kind === NODE_KINDS.root || node.kind === NODE_KINDS.ungrouped) return true;
  if (node.fixed) return false;
  return node.kind === NODE_KINDS.folder || node.kind === NODE_KINDS.workspace;
}

/**
 * The answers a container gives a drag, as one object.
 *
 * `accepts.folder` — may a directory land here at all.
 * `accepts.workspace` — may a directory that carries a workspace land here
 *   (R1, asked from the target's side: no workspace may end up inside one).
 * `accepts.session` — may a session be placed here.
 * `accepts.shortcut` — may a reference be dropped here.
 *
 * The client paints a drop target straight from these four booleans, so it never
 * needs to know that 未分组 is an id or that 收藏 is a special case.
 *
 * @param {string} nodeId
 * @param {{ nodes: Record<string, any> }} tree
 * @returns {{ session: boolean, folder: boolean, workspace: boolean, shortcut: boolean }}
 */
export function acceptsOf(nodeId, tree) {
  const node = tree.nodes?.[nodeId];
  const folder = holdsDirectories(node);
  return {
    session: nodeId === FIXED_NODES.ungrouped || node?.kind === NODE_KINDS.workspace,
    folder,
    // R1 from the target side: a workspace (or a folder carrying one) may only
    // land where no workspace is above it — and a workspace is never its own
    // parent chain's exception.
    workspace: folder && node?.kind !== NODE_KINDS.workspace && nearestWorkspace(nodeId, tree) === null,
    shortcut: canHoldShortcuts(node),
  };
}

/**
 * Whether sessions may be dropped on / pasted into one node.
 *
 * A session belongs to exactly one workspace and nothing else: 根目录, a plain
 * folder and the fixed views all refuse it. Stated from the container's side so
 * the client can grey out an invalid target before a drop happens.
 *
 * @param {string} nodeId
 * @param {{ nodes: Record<string, any> }} tree
 * @returns {boolean}
 */
export function canAcceptSessions(nodeId, tree) {
  return acceptsOf(nodeId, tree).session;
}

/**
 * Whether a subtree contains a workspace (the node itself included).
 *
 * This is the "does moving this drag a workspace along" question, which is all
 * R1 needs once the target said it cannot take a workspace.
 *
 * @param {string} nodeId
 * @param {{ nodes: Record<string, any>, children: Record<string, string[]> }} tree
 * @returns {boolean}
 */
export function hasWorkspace(nodeId, tree) {
  // Structural only: a shortcut to a workspace is a reference, and moving the
  // folder that holds it does not move that workspace anywhere.
  for (const id of subtreeOf(nodeId, tree, { followReferences: false })) {
    if (tree.nodes?.[id]?.kind === NODE_KINDS.workspace) return true;
  }
  return false;
}

/**
 * Validate a placement: may `nodeId` become a child of `parentId`?
 *
 * Exactly two rules:
 *
 *   1. a workspace never nests inside another workspace (directly or through a
 *      folder that moves with it);
 *   2. a node never moves into its own subtree — that would detach the branch
 *      from the tree entirely.
 *
 * Everything else combines freely: folders inside folders, folders inside
 * workspaces, workspaces inside folders, workspaces at the root. 会话 placement
 * is a separate question (`canAcceptSessions`) and does not constrain the tree.
 *
 * Fixed nodes (根目录/收藏/待办/未分组/回收站) are not the user's to move.
 *
 * The client asks the same questions through `acceptsOf`-derived node fields, so
 * a target greys out before the pointer is released; the host re-checks here,
 * because a stale client must never be able to write an illegal tree.
 *
 * @param {string} nodeId
 * @param {string} parentId
 * @param {{ nodes: Record<string, any>, children: Record<string, string[]> }} tree
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function canMove(nodeId, parentId, tree) {
  const node = tree.nodes[nodeId];
  const parent = tree.nodes[parentId];
  if (!node) return { ok: false, code: "bad-request", message: `unknown node ${nodeId}` };
  if (!parent) return { ok: false, code: "bad-request", message: `unknown node ${parentId}` };
  if (node.fixed) return { ok: false, code: "bad-request", message: `${nodeId} is a fixed node` };
  if (parentId === nodeId) return { ok: false, code: "bad-request", message: "a node cannot contain itself" };

  const accepts = acceptsOf(parentId, tree);
  // 收藏/待办 mirror a set of sessions and 回收站 is the bin: none of them is a
  // container, so dropping a folder or workspace into one has no meaning. This
  // is a "can it hold anything at all" question, not a tree-shape rule — and
  // 未分组 *is* a container (it owns real sessions and holds folders), so it stays
  // a legal parent here, exactly as `accepts.folder` says.
  if (!accepts.folder) {
    return { ok: false, code: "bad-request", message: `${parent.name ?? parentId} 不接收目录` };
  }

  // The only structural rule: a workspace may not end up inside another one.
  //
  // "Inside" is transitive — a workspace placed under a folder that itself sits
  // under a workspace is still nested, so the check asks the target's ancestor
  // chain rather than looking at `parent.kind` alone. Symmetrically, a *folder*
  // moving into a workspace is fine unless it carries a workspace with it,
  // because then that workspace would become nested too.
  if (!accepts.workspace) {
    if (node.kind === NODE_KINDS.workspace) {
      return { ok: false, code: "bad-request", message: "工作区不能放进工作区" };
    }
    if (hasWorkspace(nodeId, tree)) {
      return { ok: false, code: "bad-request", message: "这个文件夹里有工作区，放进去会变成工作区套工作区" };
    }
  }

  // Refuse a cycle: moving a node into its own subtree would delete the branch.
  // Structural only — a shortcut to the target is a reference, not a parent
  // edge, so dropping one into the node it points at is not a cycle.
  for (const id of subtreeOf(nodeId, tree, { followReferences: false })) {
    if (id === parentId) {
      return { ok: false, code: "bad-request", message: "不能把目录放进它自己的子目录" };
    }
  }

  return { ok: true };
}

/**
 * The scope mode a node's list pane uses.
 *
 * @param {any} node
 * @returns {string}
 */
export function scopeOf(node) {
  switch (node?.kind) {
    case NODE_KINDS.all:
      return SCOPE_MODES.all;
    case NODE_KINDS.favorites:
      return SCOPE_MODES.favorites;
    case NODE_KINDS.todos:
      return SCOPE_MODES.todos;
    case NODE_KINDS.trash:
      return SCOPE_MODES.trash;
    case NODE_KINDS.root:
      return SCOPE_MODES.none;
    case NODE_KINDS.shortcut:
      // A reference to a session is one row and nothing else; a reference to a
      // folder or workspace shows what it points at (see `subtreeOf`).
      return node.shortcutKind === "session" ? SCOPE_MODES.none : SCOPE_MODES.tree;
    default:
      return SCOPE_MODES.tree;
  }
}

/**
 * Attach the derived answers to every node, in place.
 *
 * Called once by `buildTree`, so `/bootstrap` ships the answers instead of the
 * questions: the client reads `node.accepts` / `node.scope` / `node.ref` and
 * holds no rule of its own.
 *
 * @param {{ nodes: Record<string, any>, children: Record<string, string[]> }} tree
 * @returns {{ nodes: Record<string, any>, children: Record<string, string[]> }} the same tree
 */
export function decorateTree(tree) {
  for (const [id, node] of Object.entries(tree.nodes ?? {})) {
    node.accepts = acceptsOf(id, tree);
    node.hasWorkspace = hasWorkspace(id, tree);
    node.ref = shortcutTargetNodeId(node, tree);
    node.scope = scopeOf(node);
  }
  return tree;
}
