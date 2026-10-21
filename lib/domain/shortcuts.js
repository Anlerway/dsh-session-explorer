/**
 * dsh-session-explorer — shortcuts (快捷方式).
 *
 * A shortcut is a reference to something the tree already holds: a folder, a
 * workspace or a session. It is the plugin's own node, stored in the tree
 * sidecar, and it **never moves the target** (hard constraint 5). That is the
 * whole point: 收藏 and 待办 are shortcut containers, so putting a session there
 * must not relocate its files, and putting a workspace there must not move it
 * out of the directory tree.
 *
 * Shape, in `tree.v1.json`:
 *
 *   shortcuts: {
 *     "s-<id>": { id, kind: "folder" | "workspace" | "session",
 *                 targetId, parent, order, label? }
 *   }
 *
 * `targetId` is always the id the *target's own store* uses: a folder node id
 * (`d-…`), a native workspace id (no `w-` prefix), or a session id. Keeping one
 * id space per kind is what lets a shortcut be resolved without guessing.
 *
 * Pure functions over a draft, like lib/domain/folders.js.
 */

import { FIXED_NODES } from "../constants.js";
import { codedError } from "../store/sidecar.js";

export const SHORTCUT_NODE_PREFIX = "s-";

/** Kinds a shortcut may point at. */
export const SHORTCUT_KINDS = Object.freeze(["folder", "workspace", "session"]);

/**
 * @param {any} nodeId
 * @returns {boolean}
 */
export function isShortcutNodeId(nodeId) {
  return typeof nodeId === "string" && nodeId.startsWith(SHORTCUT_NODE_PREFIX);
}

/**
 * Containers that hold shortcuts rather than a subtree.
 *
 * 收藏 and 待办 are the two the UI has always described as shortcut containers;
 * 未分组 is *not* one — it holds real sessions (a session with no workspace has
 * no other home, so a shortcut there would be a reference to itself).
 *
 * @param {string} nodeId
 * @returns {boolean}
 */
export function isShortcutContainer(nodeId) {
  return nodeId === FIXED_NODES.favorites || nodeId === FIXED_NODES.todos;
}

/**
 * Normalize one stored shortcut, or return null when it is unusable.
 *
 * @param {any} raw
 * @param {string} id
 * @returns {any | null}
 */
export function normalizeShortcut(raw, id) {
  const key = typeof id === "string" && id ? id : raw?.id;
  if (!isShortcutNodeId(key)) return null;
  const kind = SHORTCUT_KINDS.includes(raw?.kind) ? raw.kind : null;
  if (!kind) return null;
  const targetId = typeof raw?.targetId === "string" && raw.targetId ? raw.targetId : "";
  if (!targetId) return null;
  return {
    id: key,
    kind,
    targetId,
    parent: typeof raw?.parent === "string" && raw.parent ? raw.parent : FIXED_NODES.root,
    order: typeof raw?.order === "number" && Number.isFinite(raw.order) ? raw.order : 0,
    label: typeof raw?.label === "string" && raw.label.trim() ? raw.label.trim() : null,
    createdAt: typeof raw?.createdAt === "number" ? raw.createdAt : null,
  };
}

/**
 * Add a shortcut to a container.
 *
 * Refuses a duplicate of the same (kind, target) in the same parent: two
 * identical references in one folder would be two rows with one meaning, and
 * deleting one of them would look like a no-op.
 *
 * @param {{ shortcuts?: Record<string, any> }} draft
 * @param {{ kind: string, targetId: string, parent?: string, label?: string }} input
 * @param {() => string} newId
 * @returns {string} the new shortcut node id
 */
export function createShortcut(draft, input, newId) {
  const kind = SHORTCUT_KINDS.includes(input?.kind) ? input.kind : null;
  if (!kind) throw codedError("bad-request", "shortcut kind must be folder, workspace or session");
  const targetId = typeof input?.targetId === "string" ? input.targetId.trim() : "";
  if (!targetId) throw codedError("bad-request", "shortcut targetId is required");
  // The parent must be a container that can hold a reference. 根目录 and 所有会话
  // are views, and 回收站 is a bin — a shortcut there would outlive the thing it
  // points at. A folder, a workspace, 收藏, 待办 and 未分组 are all real homes.
  // 收藏 is the default home for a reference: it is the container built for them,
  // and it is always a legal parent (see the guard below).
  const parent = typeof input?.parent === "string" && input.parent ? input.parent : FIXED_NODES.favorites;
  if (parent === FIXED_NODES.root || parent === FIXED_NODES.all || parent === FIXED_NODES.trash) {
    throw codedError("bad-request", "这个位置不能放快捷方式");
  }

  draft.shortcuts ??= {};
  // The same target may be referenced twice, but not twice in one container.
  const duplicate = Object.values(draft.shortcuts).some(
    (entry) => entry && entry.kind === kind && entry.targetId === targetId && (entry.parent ?? FIXED_NODES.root) === parent,
  );
  if (duplicate) throw codedError("target-exists", "这个位置已经有指向它的快捷方式");

  const id = SHORTCUT_NODE_PREFIX + newId();
  const siblings = Object.values(draft.shortcuts).filter((entry) => (entry?.parent ?? FIXED_NODES.root) === parent);
  draft.shortcuts[id] = {
    id,
    kind,
    targetId,
    parent,
    order: siblings.length,
    label: typeof input?.label === "string" && input.label.trim() ? input.label.trim() : null,
    createdAt: Date.now(),
  };
  return id;
}

/**
 * Delete one shortcut. The target is untouched by definition.
 *
 * @param {{ shortcuts?: Record<string, any> }} draft
 * @param {string} shortcutId
 * @returns {{ removed: string }}
 */
export function deleteShortcut(draft, shortcutId) {
  if (!isShortcutNodeId(shortcutId)) throw codedError("bad-request", `${shortcutId} is not a shortcut`);
  const shortcut = draft.shortcuts?.[shortcutId];
  if (!shortcut) throw codedError("bad-request", `unknown shortcut ${shortcutId}`);
  delete draft.shortcuts[shortcutId];
  return { removed: shortcutId };
}

/**
 * Drop every shortcut that points at a target, wherever it lives.
 *
 * Called when the target itself goes away (a folder deleted, a session purged).
 * A dangling shortcut would render as a row that opens nothing, which is worse
 * than the row being gone.
 *
 * @param {{ shortcuts?: Record<string, any> }} draft
 * @param {string} kind
 * @param {string} targetId
 * @returns {string[]} removed shortcut ids
 */
export function dropShortcutsTo(draft, kind, targetId) {
  if (!draft.shortcuts) return [];
  const removed = [];
  for (const [id, entry] of Object.entries(draft.shortcuts)) {
    if (entry && entry.kind === kind && entry.targetId === targetId) {
      delete draft.shortcuts[id];
      removed.push(id);
    }
  }
  return removed;
}
