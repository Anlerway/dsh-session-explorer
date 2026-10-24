/**
 * dsh-session-navigator — tree projection (auto structure + user folders).
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
 *   f-root (根目录)              ← the directory tree; holds no sessions itself
 *   ├── f-all                   ← 所有会话: *every* live session, read-only view
 *   ├── f-ungrouped             ← 未分组: sessions with no workspace (real rows)
 *   ├── f-todos                 ← 待办   (shortcut container)
 *   ├── f-favorites             ← 收藏   (shortcut container)
 *   ├── d-<id>…                 ← user folders
 *   └── w-<workspaceId>…        ← DSH workspaces, the default one included
 *   f-trash (回收站)             ← sibling of the root: trashed sessions leave the root
 *
 * Load-bearing rules, each covered by a test in test/tree.test.mjs:
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

import { FIXED_NODES } from "../constants.js";
import { normalizeShortcut } from "./shortcuts.js";
import {
  NODE_KINDS,
  decorateTree,
  placementOfNode,
  sessionsOfNode,
  workspaceIdOfNode,
  workspaceNodeId,
} from "./tree-rules.js";

/**
 * The rules themselves live in `./tree-rules.js`; this module builds the tree and
 * keeps the public names its callers (and the tests) have always used.
 */
export {
  NODE_KINDS,
  ancestorsOf,
  canAcceptSessions,
  canMove,
  nearestWorkspace,
  placementOfNode,
  sessionsOfNode,
  workspaceIdOfNode,
  workspaceNodeId,
} from "./tree-rules.js";

/** Prefix for user folders, so a folder id can never collide with a fixed node. */
export const FOLDER_NODE_PREFIX = "d-";

/**
 * The label a workspace shows in the tree.
 *
 * The default workspace's registry title is the literal string
 * `default-workspace` — DSH's own id-ish default, not something a user typed.
 * Translating exactly that value keeps the row readable without overriding a
 * title the user chose.
 *
 * @param {string} [title]
 * @param {string} [path]
 * @param {string} [workspaceId]
 * @param {boolean} [isDefault]
 * @returns {string}
 */
export function workspaceLabel(title, path, workspaceId, isDefault) {
  const name = typeof title === "string" ? title.trim() : "";
  if (name && !(isDefault && /^default[-_ ]?workspace$/i.test(name))) return name;
  if (isDefault) return "默认工作区";
  return name || path || workspaceId || "";
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
  [FIXED_NODES.all]: 1,
  [FIXED_NODES.ungrouped]: 2,
  [FIXED_NODES.todos]: 3,
  [FIXED_NODES.favorites]: 4,
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
 * @param {{ hideBlank?: boolean } | null} [input.listSettings]
 *        the view settings that decide which sessions are hidden. Only the ones
 *        that remove rows matter here: a hidden session leaves the counts.
 * @returns {{ revision: number, roots: string[], nodes: Record<string, any>, children: Record<string, string[]>, counts: Record<string, number> }}
 */
export function buildTree({ registry, sessions, trashedIds, userTree, listSettings }) {
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
  // ── the set the list actually renders ──────────────────────────────────────
  // 过滤空会话 is a view setting, but its effect starts here rather than in the
  // client: a badge that counts a row the list will not draw is the same
  // disagreement R2/R3 forbid, one step out. A session that never started a turn
  // holds nothing to read, so it leaves the counts exactly as it leaves the list —
  // and it comes back when the user turns the filter off, because this is a
  // setting, not a deletion.
  const shown = listSettings?.hideBlank === false ? live : live.filter((session) => session.blank !== true);

  add({ id: FIXED_NODES.root, type: "folder", name: "根目录", fixed: true, kind: NODE_KINDS.root }, null, 0);

  // The default workspace is a *real* workspace. It keeps a `default` marker so
  // the UI can still say "this is where DSH starts new sessions", but it is
  // otherwise an ordinary movable container: no synthetic label, no pinned
  // position, no rename lock.
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
    // A folder may live inside another folder, inside a workspace, or directly
    // in 未分组: folders combine freely, and all three of those are directories.
    // 所有会话 and 最近关闭 are views, and 收藏/待办 hold references rather than a
    // tree, so a folder recorded inside one of those degrades to the root (R5).
    const inFolder = isFolderNodeId(raw) && Boolean(folders[raw]);
    const workspaceId = workspaceIdOfNode(raw);
    const inWorkspace = Boolean(workspaceId && registry?.workspaces?.has(workspaceId));
    const inUngrouped = raw === FIXED_NODES.ungrouped;
    if (!inFolder && !inWorkspace && !inUngrouped) return FIXED_NODES.root;

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

  let fallbackOrder = 0;
  for (const workspaceId of workspaceIds) {
    const workspace = registry.workspaces.get(workspaceId);
    if (!workspace) continue;
    const isDefault = workspaceId === defaultWorkspaceId;

    // R1: a workspace may only hang off the root or off a user folder — never
    // off another workspace. A placement pointing anywhere else is ignored.
    const recorded = placement[workspaceId];
    const parent = typeof recorded === "string" && isFolderNodeId(recorded) && folders[recorded] ? recorded : FIXED_NODES.root;

    const order =
      typeof workspaceOrder[workspaceId] === "number" ? workspaceOrder[workspaceId] : WORKSPACE_BASE_ORDER + fallbackOrder;
    fallbackOrder += 1;

    add(
      {
        id: workspaceNodeId(workspaceId),
        type: "workspace",
        // DSH stores the default workspace under the literal English name
        // "default-workspace"; that is an identifier, not a label. Only that
        // exact value is translated, so a workspace the user renamed to anything
        // else keeps their name (and a rename is never a silent no-op).
        name: workspaceLabel(workspace.title, workspace.path, workspaceId, isDefault),
        fixed: false,
        kind: NODE_KINDS.workspace,
        workspaceId,
        path: workspace.path ?? "",
        default: isDefault,
      },
      parent,
      order,
    );
  }

  // ── fixed entries inside the root ───────────────────────────────────────────
  // 所有会话 is a view over every live session. 根目录 holds directories only, so
  // the flat list lives here instead of being a special case of the root.
  add({ id: FIXED_NODES.all, type: "folder", name: "所有会话", fixed: true, kind: NODE_KINDS.all }, FIXED_NODES.root, ROOT_ENTRY_ORDER[FIXED_NODES.all]);
  // 未分组 is a real container: a session with no workspace has no other home.
  add({ id: FIXED_NODES.ungrouped, type: "folder", name: "未分组", fixed: true, kind: NODE_KINDS.ungrouped }, FIXED_NODES.root, ROOT_ENTRY_ORDER[FIXED_NODES.ungrouped]);
  // 待办 / 收藏 hold *shortcuts* — references that never move their target.
  add({ id: FIXED_NODES.todos, type: "folder", name: "待办", fixed: true, kind: NODE_KINDS.todos }, FIXED_NODES.root, ROOT_ENTRY_ORDER[FIXED_NODES.todos]);
  add({ id: FIXED_NODES.favorites, type: "folder", name: "收藏", fixed: true, kind: NODE_KINDS.favorites }, FIXED_NODES.root, ROOT_ENTRY_ORDER[FIXED_NODES.favorites]);

  // Trash is the one branch that sits outside the root.
  add({ id: FIXED_NODES.trash, type: "folder", name: "回收站", fixed: true, kind: NODE_KINDS.trash }, null, 1);

  // ── shortcuts ──────────────────────────────────────────────────────────────
  // A shortcut is a node of its own whose target lives elsewhere. It is added
  // *after* the real containers so a shortcut can never shadow a real id, and it
  // contributes no sessions to its parent's count (R4): the same session appears
  // once where it lives and once per reference to it.
  const shortcuts = userTree?.shortcuts && typeof userTree.shortcuts === "object" ? userTree.shortcuts : {};
  // A reference to a session survives while the session exists — including
  // while it sits in the bin, because a trashed session can come back. Once the
  // payload is gone (purged here, or deleted from disk by hand), the reference
  // would be a row that opens nothing and that the user is not allowed to
  // remove either: the shortcut *is* the target's sighting, so it leaves with
  // it. This is the outside-the-app half of that promise; the host prunes the
  // sidecar on purge so the row does not come back on the next build.
  const sessionIds = new Set(sessions.map((session) => session.id));
  for (const [id, raw] of Object.entries(shortcuts)) {
    const shortcut = normalizeShortcut(raw, id);
    if (!shortcut) continue;
    if (shortcut.kind === "session" && !sessionIds.has(shortcut.targetId) && !trashed.has(shortcut.targetId)) continue;
    // The container has to still exist, and the root is not a fallback for a
    // reference: 根目录 holds directories (`canHoldShortcuts(f-root)` is false
    // for exactly that reason), so re-parenting here produced a row that no
    // branch rendered and no gesture could remove. A reference whose container
    // is gone is dropped instead; the host lifts them when a folder or a
    // workspace disappears, so this branch is the hand-edited-sidecar case.
    const parent = nodes[shortcut.parent] ? shortcut.parent : null;
    if (!parent) continue;
    // The target has to be resolvable too, for the same reason: a folder or
    // workspace shortcut whose target is gone is a row that opens nothing and
    // that the user cannot delete by hand (a reference is deleted by deleting
    // its target). Session shortcuts are filtered above; these two were not.
    if (shortcut.kind === "folder" && !nodes[shortcut.targetId]) continue;
    if (shortcut.kind === "workspace" && !nodes[workspaceNodeId(shortcut.targetId)]) continue;
    add(
      {
        id: shortcut.id,
        type: "shortcut",
        // The client resolves the label from the target, so a renamed target is
        // reflected without rewriting the sidecar.
        name: shortcut.label ?? "",
        fixed: false,
        kind: NODE_KINDS.shortcut,
        shortcutKind: shortcut.kind,
        targetId: shortcut.targetId,
      },
      parent,
      shortcut.order,
    );
  }

  // ── derived facts ──────────────────────────────────────────────────────────
  // Every node leaves this function carrying the answers the UI asks about it:
  // which drops it accepts, how it fills the list pane, what a shortcut points
  // at, and whether its subtree holds a workspace. The client reads those
  // fields instead of keeping a second copy of the rules.
  decorateTree({ nodes, children });

  // ── counts ─────────────────────────────────────────────────────────────────
  // R2/R3, and the reason a badge can no longer disagree with the rows under
  // it: a directory's number *is* the length of the list it shows. Both come
  // from `sessionsOfNode`, so there is one definition of "what this node holds"
  // instead of a counting pass that imitates a filtering pass.
  //
  // A *virtual* placement can pull a session out of its workspace without
  // moving a byte: DSH derives a session's workspace from the `cwd` in its
  // header, so a physical move is the only way to change that — and this
  // plugin's first hard constraint forbids restructuring `sessions/`. The
  // override therefore lives in the sidecar and affects grouping only; the
  // resolved home travels with each session (`sessionHome`) so neither pass
  // re-derives it.
  const sessionPlacement =
    userTree?.sessionPlacement && typeof userTree.sessionPlacement === "object" ? userTree.sessionPlacement : {};

  // The counting view: the list's own set. `placementOfNode` still runs over
  // every live session below, because a hidden session can be revealed by
  // standing on it and it must know where it belongs when it is.
  const countView = { sessions: shown };
  const treeLike = { nodes, children, sessionPlacement };
  /** @type {Record<string, string>} */
  const sessionHome = {};
  for (const session of live) {
    const home = placementOfNode(session, treeLike);
    if (home) sessionHome[session.id] = home;
  }

  // A container's number counts the *rows* under it: its shown sessions plus the
  // shortcut rows anywhere in its subtree. Counting only sessions made a folder
  // that holds a single session shortcut show 0 while expanding it showed one
  // row — the same disagreement R2/R3 exist to prevent, one level up.
  const shortcutRowsWithin = (id) => {
    let total = 0;
    const stack = [...(children[id] ?? [])];
    while (stack.length > 0) {
      const child = stack.pop();
      const node = nodes[child];
      if (!node) continue;
      if (node.kind === NODE_KINDS.shortcut) {
        total += 1;
        continue; // a reference has no children of its own
      }
      stack.push(...(children[child] ?? []));
    }
    return total;
  };

  for (const [id, node] of Object.entries(nodes)) {
    if (node.kind === NODE_KINDS.shortcut) continue; // a reference is one row, counted below
    if (!node.accepts.folder) continue; // 所有会话/收藏/待办/回收站 mean something else, below
    counts[id] = sessionsOfNode(id, countView, treeLike, { trashedIds: trashed }).length + shortcutRowsWithin(id);
  }

  // 根目录 lists directories, so its own list is empty — but the number beside it
  // is the shown total, which is exactly what it claims to be.
  counts[FIXED_NODES.root] = shown.length;

  // R4: 收藏 and 待办 are shortcut containers, so their count is the number of
  // *rows* they show — shortcuts pointing at a session plus the sessions that
  // carry the flag directly. Neither changes the session total.
  //
  // 所有会话 is the one view that mirrors the whole set; 回收站 is the bin.
  counts[FIXED_NODES.favorites] =
    shown.filter((session) => session.favorite).length + shortcutRowsWithin(FIXED_NODES.favorites);
  counts[FIXED_NODES.todos] = shown.filter((session) => session.todo).length + shortcutRowsWithin(FIXED_NODES.todos);
  counts[FIXED_NODES.trash] = trashed.size;
  counts[FIXED_NODES.all] = shown.length;

  // Parents always precede their children, so sort each child list by `order`.
  for (const parent of Object.keys(children)) {
    children[parent].sort((a, b) => (nodes[a]?.order ?? 0) - (nodes[b]?.order ?? 0));
  }

  // Shortcut rows are counted last: a shortcut to a session is one visible row
  // in its container, and a shortcut to a folder or workspace shows the size of
  // what it points at so the number is not zero-looking.
  for (const [id, node] of Object.entries(nodes)) {
    if (node.kind !== NODE_KINDS.shortcut) continue;
    if (node.shortcutKind === "session") {
      counts[id] = 1;
    } else if (node.shortcutKind === "workspace") {
      counts[id] = counts[workspaceNodeId(node.targetId)] ?? 0;
    } else {
      counts[id] = counts[node.targetId] ?? 0;
    }
  }

  // 置顶 for containers: folders and workspaces pinned by the user, newest
  // first. DSH pins *sessions*; this is the other half of the same visual band,
  // kept in the tree sidecar because DSH has no notion of a container pin.
  const pins = userTree?.pins && typeof userTree.pins === "object" ? userTree.pins : {};
  const pinnedNodes = Object.entries(pins)
    .filter(([id]) => nodes[id] && !nodes[id].fixed)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([id]) => id);

  return {
    revision: typeof userTree?.revision === "number" ? userTree.revision : 0,
    roots: [FIXED_NODES.root, FIXED_NODES.trash],
    nodes,
    children,
    counts,
    pinnedNodes,
    pins,
    sessionPlacement,
    // session id → the node it is shown in, resolved once here so the client
    // never has to replay the workspace-vs-override question (R2).
    sessionHome,
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
