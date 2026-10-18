/**
 * dsh-session-explorer — tree projection.
 *
 * The explorer's left pane is a tree of folders and workspace nodes. P1 has no
 * user edits yet (those land in P2 with `tree.v1.json`), so the shape is derived
 * from what DSH knows, using the layout the UI prototype finalised:
 *
 *   f-root (根目录)            ← a real folder: every live session hangs here
 *   ├── w-<defaultWsId>       ← 默认工作区 = DSH's default-workspace workspace
 *   ├── f-ungrouped           ← sessions with no workspace at all
 *   ├── f-todos               ← 待办 (shortcut container, P2 fills it)
 *   ├── f-favorites           ← 收藏 (shortcut container, mirrors DSH pins)
 *   └── w-<workspaceId>…      ← every other real DSH workspace
 *   f-trash (回收站)           ← sibling of the root: trashed sessions leave the root
 *
 * Two rules are load-bearing and encoded here:
 *
 *   1. 收藏 / 待办 are *shortcuts*, not containers. A session shown there still
 *      lives in its real workspace, so it is counted on that workspace (and in
 *      the root total) exactly once — never twice.
 *   2. A workspace never nests inside another workspace. DSH's own registry is
 *      flat, so every workspace but the default one is a direct child of the
 *      root; user folders (P2) may only be added *between* the root and a
 *      workspace, never between two workspaces.
 *
 * Only trashed sessions live outside the root, which is why `f-trash` is a root
 * sibling rather than a child.
 *
 * Everything here is a pure function of its inputs, so the rules can be
 * unit-tested without a kernel or a filesystem.
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
 * Order of the fixed entries inside the root, exactly as the prototype shows
 * them. Workspaces fill in after these.
 */
const ROOT_ENTRY_ORDER = Object.freeze({
  [FIXED_NODES.ungrouped]: 1,
  [FIXED_NODES.todos]: 2,
  [FIXED_NODES.favorites]: 3,
});

/**
 * Build the derived tree.
 *
 * @param {object} input
 * @param {{ workspaceIds: string[], workspaces: Map<string, any>, defaultWorkspaceId?: string | null } | null} input.registry
 * @param {object[]} input.sessions merged session view
 * @param {Set<string> | string[]} [input.trashedIds] ids already moved to the trash
 * @returns {{ revision: number, roots: string[], nodes: Record<string, any>, children: Record<string, string[]>, counts: Record<string, number> }}
 */
export function buildAutoTree({ registry, sessions, trashedIds }) {
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
  const ordered = defaultWorkspaceId
    ? [defaultWorkspaceId, ...workspaceIds.filter((id) => id !== defaultWorkspaceId)]
    : workspaceIds;

  const addWorkspace = (workspaceId, order) => {
    const workspace = registry.workspaces.get(workspaceId);
    const isDefault = workspaceId === defaultWorkspaceId;
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
      FIXED_NODES.root,
      order,
    );
  };

  // 默认工作区 first, then 未分组 / 待办 / 收藏, then the remaining workspaces —
  // the order the prototype's root folder renders.
  let order = 0;
  if (defaultWorkspaceId) {
    addWorkspace(defaultWorkspaceId, order);
    order += 1;
  }
  add({ id: FIXED_NODES.ungrouped, type: "folder", name: "未分组", fixed: true, kind: NODE_KINDS.ungrouped }, FIXED_NODES.root, ROOT_ENTRY_ORDER[FIXED_NODES.ungrouped]);
  add({ id: FIXED_NODES.todos, type: "folder", name: "待办", fixed: true, kind: NODE_KINDS.todos }, FIXED_NODES.root, ROOT_ENTRY_ORDER[FIXED_NODES.todos]);
  add({ id: FIXED_NODES.favorites, type: "folder", name: "收藏", fixed: true, kind: NODE_KINDS.favorites }, FIXED_NODES.root, ROOT_ENTRY_ORDER[FIXED_NODES.favorites]);

  for (const workspaceId of ordered) {
    if (workspaceId === defaultWorkspaceId) continue;
    addWorkspace(workspaceId, ROOT_ENTRY_ORDER[FIXED_NODES.favorites] + 1 + order);
    order += 1;
  }

  // Trash is the one branch that sits outside the root.
  add({ id: FIXED_NODES.trash, type: "folder", name: "回收站", fixed: true, kind: NODE_KINDS.trash }, null, 1);

  // Session counts. A session is counted once, on its real container, so
  // 收藏 / 待办 (shortcut views) are counted separately and never break the sum.
  for (const session of live) {
    const nodeId = session.workspaceId ? workspaceNodeId(session.workspaceId) : FIXED_NODES.ungrouped;
    if (!nodes[nodeId]) continue;
    counts[nodeId] = (counts[nodeId] ?? 0) + 1;
  }
  counts[FIXED_NODES.favorites] = live.filter((session) => session.pinned).length;
  counts[FIXED_NODES.todos] = 0;
  counts[FIXED_NODES.trash] = trashed.size;
  counts[FIXED_NODES.root] = live.length;

  // Parents always precede their children in `children[parent]` order, so sort
  // each child list by the `order` field the prototype uses.
  for (const parent of Object.keys(children)) {
    children[parent].sort((a, b) => (nodes[a]?.order ?? 0) - (nodes[b]?.order ?? 0));
  }

  return { revision: 0, roots: [FIXED_NODES.root, FIXED_NODES.trash], nodes, children, counts };
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

  if (nodeId === FIXED_NODES.favorites) return live.filter((session) => session.pinned);
  if (nodeId === FIXED_NODES.todos) return [];
  if (nodeId === FIXED_NODES.trash) return view.sessions.filter((session) => trashed.has(session.id));

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

  if (nodeId === FIXED_NODES.ungrouped) return live.filter((session) => !session.workspaceId);
  if (nodeId === FIXED_NODES.root) return live;
  return live.filter((session) => session.workspaceId && workspaceIds.has(session.workspaceId));
}
