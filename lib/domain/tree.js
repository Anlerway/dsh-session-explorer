/**
 * dsh-session-explorer — tree projection (auto structure + user folders).
 *
 * The left pane is a tree of folders and workspace nodes. Two things feed it:
 *
 *   the derived structure — one node per DSH workspace, plus the fixed entries,
 *                           recomputed on every request from the live registry.
 *   `tree.v1.json`       — the user's own folders and their placement, which
 *                           DSH knows nothing about.
 *
 * The layout the UI prototype settled on:
 *
 *   f-root (根目录)              ← a real folder: every live session hangs here
 *   ├── w-<defaultWsId>         ← 默认工作区 = DSH's default workspace
 *   ├── f-ungrouped             ← sessions with no workspace at all
 *   ├── f-todos                 ← 待办   (shortcut view)
 *   ├── f-favorites             ← 收藏   (shortcut view, mirrors DSH pins)
 *   └── w-<workspaceId>…        ← every other real DSH workspace
 *   f-trash (回收站)             ← sibling of the root: trashed sessions leave the root
 *
 * Load-bearing rules, each covered by a test in test/tree.test.mjs:
 *
 *   R1  a workspace never nests inside another workspace (folders may sit
 *       between the root and a workspace, never between two workspaces);
 *   R2  a session's container is its workspace node, or 未分组 when it has none;
 *   R3  a session is counted exactly once, on that container;
 *   R4  收藏 / 待办 are shortcuts, not containers — they mirror a set and never
 *       change the total;
 *   R5  a node whose parent vanished degrades to the root instead of orphaning
 *       its children, and a cycle can never be constructed.
 *
 * Everything here is a pure function of its inputs, so all of it is testable
 * without a kernel or a filesystem.
 */

import { FIXED_NODES, WORKSPACE_NODE_PREFIX } from "../constants.js";

/** Node types the tree may contain. */
export const NODE_TYPES = Object.freeze({ folder: "folder", workspace: "workspace" });

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
});

/** Fixed ids that may never be created, renamed, moved or deleted. */
export const FIXED_NODE_IDS = Object.freeze([
  FIXED_NODES.root,
  FIXED_NODES.favorites,
  FIXED_NODES.todos,
  FIXED_NODES.trash,
  FIXED_NODES.ungrouped,
]);

/** Prefix for user folders, so a folder id can never collide with a fixed node. */
export const FOLDER_NODE_PREFIX = "d-";

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
 * @param {string} folderId
 * @returns {boolean}
 */
export function isFolderNodeId(folderId) {
  return typeof folderId === "string" && folderId.startsWith(FOLDER_NODE_PREFIX);
}

/**
 * Order of the fixed entries inside the root, exactly as the prototype shows
 * them. Workspaces fill in after these.
 */
const ROOT_ENTRY_ORDER = Object.freeze({
  [FIXED_NODES.ungrouped]: 1,
  [FIXED_NODES.todos]: 2,
  [FIXED_NODES.favorites]: 3,
});

/** Where workspaces start when no user folder claims them. */
const WORKSPACE_BASE_ORDER = ROOT_ENTRY_ORDER[FIXED_NODES.favorites] + 1;

/**
 * Build the tree.
 *
 * @param {object} input
 * @param {{ workspaceIds: string[], workspaces: Map<string, any>, defaultWorkspaceId?: string | null } | null} input.registry
 * @param {object[]} input.sessions merged session view
 * @param {Set<string> | string[]} [input.trashedIds] ids already moved to the trash
 * @param {{ folders?: Record<string, any>, placement?: Record<string, string>, workspaceOrder?: Record<string, number> } | null} [input.userTree]
 *        the user sidecar: `folders` maps folder id → { id, name, parent, order },
 *        `placement` maps a workspace id → the folder id that now holds it.
 * @returns {{ revision: number, roots: string[], nodes: Record<string, any>, children: Record<string, string[]>, counts: Record<string, number> }}
 */
export function buildTree({ registry, sessions, trashedIds, userTree }) {
  /** @type {Record<string, any>} */
  const nodes = {};
  /** @type {Record<string, string[]>} */
  const children = {};
  /** @type {Record<string, number>} */
  const counts = {};

  const add = (node, parent, order) => {
    nodes[node.id] = { ...node, parent, order };
    (children[parent] ??= []).push(node.id);
    children[node.id] ??= [];
    return node.id;
  };

  const trashed = trashedIds instanceof Set ? trashedIds : new Set(trashedIds ?? []);
  const live = sessions.filter((session) => !trashed.has(session.id));

  add({ id: FIXED_NODES.root, type: "folder", name: "根目录", fixed: true, kind: NODE_KINDS.root }, null, 0);

  // The default workspace is a *real* workspace, just pinned to the top of the
  // root and labelled the way the prototype labels it.
  const defaultWorkspaceId =
    registry?.defaultWorkspaceId && registry.workspaces?.has(registry.defaultWorkspaceId)
      ? registry.defaultWorkspaceId
      : null;

  const workspaceIds = (registry?.workspaceIds ?? []).filter((id) => registry?.workspaces?.get(id));

  // ── user folders ────────────────────────────────────────────────────────────
  // A folder is placed under another folder or directly under the root. Broken
  // parents (R5) and cycles degrade to the root rather than losing the subtree.
  const folders = userTree?.folders && typeof userTree.folders === "object" ? userTree.folders : {};
  const folderIds = Object.keys(folders).filter((id) => isFolderNodeId(id));

  /**
   * Effective parent of a folder. The recorded parent is honoured only when the
   * whole chain above it terminates at the root; a missing parent, a parent
   * that is not a folder, or a cycle all degrade to the root (R5). Resolution
   * is a pure function of `folders`, so it does not depend on iteration order.
   *
   * @param {string} id
   * @returns {string}
   */
  const folderParent = (id) => {
    const raw = folders[id]?.parent;
    if (typeof raw !== "string" || raw === FIXED_NODES.root) return FIXED_NODES.root;
    // A folder may live inside another folder or inside a workspace: folders
    // combine freely, and a workspace is just another container to them. A
    // folder may never live inside a *session* view (收藏/待办/回收站/未分组),
    // because those are views, not directories.
    const inFolder = isFolderNodeId(raw) && Boolean(folders[raw]);
    const workspaceId = raw.startsWith("w-") ? raw.slice(2) : null;
    const inWorkspace = Boolean(workspaceId && registry?.workspaces?.has(workspaceId));
    if (!inFolder && !inWorkspace) return FIXED_NODES.root;

    const seen = new Set([id]);
    let cursor = raw;
    while (cursor) {
      if (seen.has(cursor)) return FIXED_NODES.root;
      seen.add(cursor);
      const next = folders[cursor]?.parent;
      if (typeof next !== "string" || !isFolderNodeId(next) || !folders[next]) break;
      cursor = next;
    }
    return raw;
  };

  for (const id of folderIds) {
    const folder = folders[id];
    const parent = folderParent(id);
    const order = typeof folder.order === "number" && Number.isFinite(folder.order) ? folder.order : 0;
    add(
      {
        id,
        type: "folder",
        name: typeof folder.name === "string" && folder.name.trim() ? folder.name : "新建文件夹",
        fixed: false,
        kind: NODE_KINDS.folder,
        createdAt: folder.createdAt ?? null,
      },
      parent,
      order,
    );
  }

  // ── workspaces ──────────────────────────────────────────────────────────────
  const placement = userTree?.placement && typeof userTree.placement === "object" ? userTree.placement : {};
  const workspaceOrder =
    userTree?.workspaceOrder && typeof userTree.workspaceOrder === "object" ? userTree.workspaceOrder : {};

  const ordered = defaultWorkspaceId
    ? [defaultWorkspaceId, ...workspaceIds.filter((id) => id !== defaultWorkspaceId)]
    : workspaceIds;

  let fallbackOrder = 0;
  for (const workspaceId of ordered) {
    const workspace = registry.workspaces.get(workspaceId);
    if (!workspace) continue;
    const isDefault = workspaceId === defaultWorkspaceId;

    // R1: a workspace may only hang off the root or off a user folder — never
    // off another workspace. A placement pointing anywhere else is ignored.
    const recorded = placement[workspaceId];
    const parent = typeof recorded === "string" && isFolderNodeId(recorded) && folders[recorded] ? recorded : FIXED_NODES.root;

    const order =
      typeof workspaceOrder[workspaceId] === "number"
        ? workspaceOrder[workspaceId]
        : isDefault && parent === FIXED_NODES.root
          ? 0
          : WORKSPACE_BASE_ORDER + fallbackOrder;
    fallbackOrder += 1;

    add(
      {
        id: workspaceNodeId(workspaceId),
        type: "workspace",
        name: isDefault ? "默认工作区" : workspace.title || workspace.path || workspaceId,
        fixed: false,
        kind: isDefault ? NODE_KINDS.defaultWorkspace : NODE_KINDS.workspace,
        workspaceId,
        path: workspace.path ?? "",
        default: isDefault,
      },
      parent,
      order,
    );
  }

  // ── fixed entries inside the root ───────────────────────────────────────────
  add({ id: FIXED_NODES.ungrouped, type: "folder", name: "未分组", fixed: true, kind: NODE_KINDS.ungrouped }, FIXED_NODES.root, ROOT_ENTRY_ORDER[FIXED_NODES.ungrouped]);
  add({ id: FIXED_NODES.todos, type: "folder", name: "待办", fixed: true, kind: NODE_KINDS.todos }, FIXED_NODES.root, ROOT_ENTRY_ORDER[FIXED_NODES.todos]);
  add({ id: FIXED_NODES.favorites, type: "folder", name: "收藏", fixed: true, kind: NODE_KINDS.favorites }, FIXED_NODES.root, ROOT_ENTRY_ORDER[FIXED_NODES.favorites]);

  // Trash is the one branch that sits outside the root.
  add({ id: FIXED_NODES.trash, type: "folder", name: "回收站", fixed: true, kind: NODE_KINDS.trash }, null, 1);

  // ── counts ─────────────────────────────────────────────────────────────────
  // R2/R3: a session is counted once, on its own container node.
  for (const session of live) {
    const nodeId = session.workspaceId ? workspaceNodeId(session.workspaceId) : FIXED_NODES.ungrouped;
    if (!nodes[nodeId]) continue;
    counts[nodeId] = (counts[nodeId] ?? 0) + 1;
  }

  // Folders aggregate their descendants. Walking in reverse depth order means a
  // child is always final before its parent reads it.
  const depthOf = (id) => {
    let depth = 0;
    let cursor = nodes[id]?.parent;
    const seen = new Set([id]);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = nodes[cursor]?.parent;
    }
    return depth;
  };
  const foldersByDepth = folderIds.filter((id) => nodes[id]).sort((a, b) => depthOf(b) - depthOf(a));
  for (const id of foldersByDepth) {
    counts[id] = (children[id] ?? []).reduce((sum, child) => sum + (counts[child] ?? 0), 0);
  }

  // R4: shortcut views mirror a set and are counted separately. 收藏 and 待办 are
  // the plugin's own flags (sidecar), while 置顶 stays DSH's pin — three
  // different ideas that the UI must not conflate.
  counts[FIXED_NODES.favorites] = live.filter((session) => session.favorite).length;
  counts[FIXED_NODES.todos] = live.filter((session) => session.todo).length;
  counts[FIXED_NODES.trash] = trashed.size;
  counts[FIXED_NODES.root] = live.length;

  // Parents always precede their children, so sort each child list by `order`.
  for (const parent of Object.keys(children)) {
    children[parent].sort((a, b) => (nodes[a]?.order ?? 0) - (nodes[b]?.order ?? 0));
  }

  return {
    revision: typeof userTree?.revision === "number" ? userTree.revision : 0,
    roots: [FIXED_NODES.root, FIXED_NODES.trash],
    nodes,
    children,
    counts,
  };
}

/**
 * Backwards-compatible alias: the derived structure without user folders.
 *
 * @param {object} input
 */
export function buildAutoTree(input) {
  return buildTree(input);
}

/**
 * Sessions shown when a node is selected.
 *
 * Scope follows the tree rules: a folder shows its own sessions plus every
 * descendant workspace's, while `f-favorites` shows the pin set regardless of
 * where those sessions live.
 *
 * @param {string} nodeId
 * @param {{ sessions: object[] }} view merged session view
 * @param {{ children: Record<string, string[]>, nodes: Record<string, any> }} tree
 * @param {{ trashedIds?: Set<string> | string[] }} [options]
 * @returns {object[]}
 */
export function sessionsOfNode(nodeId, view, tree, options = {}) {
  const trashed = options.trashedIds instanceof Set ? options.trashedIds : new Set(options.trashedIds ?? []);
  const live = view.sessions.filter((session) => !trashed.has(session.id));

  if (nodeId === FIXED_NODES.favorites) return live.filter((session) => session.favorite);
  if (nodeId === FIXED_NODES.todos) return live.filter((session) => session.todo);
  if (nodeId === FIXED_NODES.trash) return view.sessions.filter((session) => trashed.has(session.id));
  if (nodeId === FIXED_NODES.ungrouped) return live.filter((session) => !session.workspaceId);
  if (nodeId === FIXED_NODES.root) return live;

  const workspaceIds = new Set();
  const stack = [nodeId];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const workspaceId = workspaceIdOfNode(current);
    if (workspaceId) workspaceIds.add(workspaceId);
    for (const child of tree.children[current] ?? []) stack.push(child);
  }

  return live.filter((session) => session.workspaceId && workspaceIds.has(session.workspaceId));
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
  return tree.nodes[nodeId]?.type === "workspace";
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
 * The client mirrors these rules so an invalid target greys out before the
 * pointer is released; the host re-checks, because a stale client must never be
 * able to write an illegal tree.
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

  // 收藏/待办 mirror a set of sessions and 回收站 is the bin: none of them is a
  // container, so dropping a folder or workspace into one has no meaning. This
  // is a "can it hold anything at all" question, not a tree-shape rule.
  if (parent.fixed && parent.id !== FIXED_NODES.root) {
    return { ok: false, code: "bad-request", message: `${parent.name ?? parentId} 不接收目录` };
  }

  // The only structural rule: a workspace may not end up inside another one.
  //
  // "Inside" is transitive — a workspace placed under a folder that itself sits
  // under a workspace is still nested, so the check walks the target's ancestor
  // chain rather than looking at `parent.type` alone. Symmetrically, a *folder*
  // moving into a workspace is fine unless it carries a workspace with it,
  // because then that workspace would become nested too.
  if (nearestWorkspace(parentId, tree) !== null) {
    if (node.type === "workspace") {
      return { ok: false, code: "bad-request", message: "工作区不能放进工作区" };
    }
    if (reachesWorkspace(nodeId, tree)) {
      return { ok: false, code: "bad-request", message: "这个文件夹里有工作区，放进去会变成工作区套工作区" };
    }
  }

  // Refuse a cycle: moving a node into its own subtree would delete the branch.
  const stack = [nodeId];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === parentId) {
      return { ok: false, code: "bad-request", message: "不能把目录放进它自己的子目录" };
    }
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const child of tree.children[current] ?? []) stack.push(child);
  }

  return { ok: true };
}

/**
 * Whether a subtree contains a workspace.
 *
 * Only used for the one rule above: a folder moving *into a workspace* must not
 * bring a workspace with it. A folder moving anywhere else may contain as many
 * workspaces as the user likes.
 *
 * @param {string} nodeId
 * @param {{ nodes: Record<string, any>, children: Record<string, string[]> }} tree
 * @returns {boolean}
 */
function reachesWorkspace(nodeId, tree) {
  const seen = new Set();
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (tree.nodes[current]?.type === "workspace") return true;
    for (const child of tree.children[current] ?? []) stack.push(child);
  }
  return false;
}
