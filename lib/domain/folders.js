/**
 * dsh-session-navigator — folder and placement rules.
 *
 * These are the operations behind 新建文件夹 / 重命名 / 移动 / 删除 in the UI. They
 * mutate a *draft* of `tree.v1.json` and are pure, so every rule in
 * lib/domain/tree.js (R1, R5) is enforced here at the point of mutation rather
 * than only being repaired at render time.
 *
 * Deletion is deliberately recursive-but-explicit: deleting a folder that still
 * holds workspaces or sessions is refused unless the caller asks for the
 * contents to be lifted to the parent first, because silently reparenting a
 * user's whole workspace tree is not a recoverable mistake.
 */

import { FIXED_NODES } from "../constants.js";
import { FOLDER_NODE_PREFIX, isFolderNodeId } from "./tree.js";
import { SHORTCUT_NODE_PREFIX, isShortcutNodeId } from "./shortcuts.js";
import { codedError } from "../store/sidecar.js";

/** Longest accepted folder name. */
export const FOLDER_NAME_MAX = 64;

/**
 * @param {any} input
 * @returns {string}
 */
function folderName(input) {
  const name = typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "";
  if (!name) throw codedError("bad-request", "folder name is required");
  if (name.length > FOLDER_NAME_MAX) {
    throw codedError("bad-request", `folder name is longer than ${FOLDER_NAME_MAX} characters`);
  }
  return name;
}

/**
 * May this container hold *folders* (and workspaces)?
 *
 * 未分组 and 根目录 are real directories; 收藏/待办/回收站 hold references and
 * 最近关闭 is a view, so none of those may grow a subtree.
 *
 * @param {any} node
 * @returns {boolean}
 */
export function canHoldFolders(node) {
  if (!node) return false;
  // A shortcut is a reference, not a container — the same answer
  // `tree-rules.holdsDirectories` has always given. Without this line a folder
  // could be created "inside" a shortcut (which is not `fixed`, so the branch
  // below accepted it) and then re-parented to the root at render time, so the
  // new folder appeared somewhere the user never dropped it.
  if (node.kind === "shortcut") return false;
  if (!node.fixed) return true;
  return node.id === FIXED_NODES.root || node.kind === "ungrouped";
}

/**
 * The next free `order` among `siblings`.
 *
 * `siblings.length` was the old answer, and it collides after a deletion: with
 * three siblings numbered 0, 1, 2, deleting the middle one makes the next
 * folder number 2 — the same value the last sibling already holds. Ordering is
 * the only thing that keeps a user's arrangement stable, so it is computed from
 * the values in use instead of from the count.
 *
 * @param {any[]} siblings
 * @returns {number}
 */
function nextOrder(siblings) {
  let highest = -1;
  for (const sibling of siblings) {
    const order = typeof sibling?.order === "number" && Number.isFinite(sibling.order) ? sibling.order : -1;
    if (order > highest) highest = order;
  }
  return highest + 1;
}

/**
 * Refuse a second folder with the same name under the same parent.
 *
 * Two rows called 工作 in the same container are indistinguishable to the user
 * and to any drag-and-drop they perform; the tree would show two identical
 * names with no way to tell which one a session went into.
 *
 * @param {{ folders: Record<string, any> }} draft
 * @param {string} parent
 * @param {string} name
 * @param {string} [exceptId]
 */
function assertUniqueName(draft, parent, name, exceptId) {
  const wanted = name.toLocaleLowerCase();
  for (const folder of Object.values(draft.folders ?? {})) {
    if (!folder || folder.id === exceptId) continue;
    if ((folder.parent ?? FIXED_NODES.root) !== parent) continue;
    if (String(folder.name ?? "").toLocaleLowerCase() === wanted) {
      throw codedError("bad-request", `a folder named ${name} already exists here`);
    }
  }
}

/**
 * Would `parentId` end up inside `nodeId`?
 *
 * The route checks this against the tree it read, but two moves that arrive
 * together each see the same "before" tree: A into B and B into A both pass the
 * check and the stored result is a cycle (which renders as both folders jumping
 * to the root). Re-checking inside the mutation sees the draft the second move
 * is about to extend, so the second one is refused.
 *
 * @param {{ folders: Record<string, any>, placement: Record<string, string> }} draft
 * @param {string} nodeId
 * @param {string} parentId
 * @returns {boolean}
 */
function isInsideDraft(draft, nodeId, parentId) {
  /** @type {Set<string>} */
  const seen = new Set();
  let current = parentId;
  while (current && current !== FIXED_NODES.root) {
    if (current === nodeId) return true;
    // A loop that is already stored must not be extended either.
    if (seen.has(current)) return true;
    seen.add(current);
    const folder = draft.folders?.[current];
    if (folder) {
      current = folder.parent ?? FIXED_NODES.root;
      continue;
    }
    const placed = draft.placement?.[current];
    current = typeof placed === "string" && placed ? placed : null;
  }
  return false;
}

/**
 * Create a folder under `parentId`.
 *
 * @param {{ folders: Record<string, any>, placement: Record<string, string>, workspaceOrder: Record<string, number> }} draft
 * @param {{ name: string, parent?: string }} input
 * @param {{ nodes: Record<string, any> }} tree the current tree, for validation
 * @param {() => string} newId id factory (injectable for tests)
 * @returns {string} the new folder id
 */
export function createFolder(draft, input, tree, newId) {
  const name = folderName(input.name);
  const parent = typeof input.parent === "string" && input.parent ? input.parent : FIXED_NODES.root;

  const parentNode = tree.nodes[parent];
  if (!parentNode) throw codedError("bad-request", `unknown parent ${parent}`);
  // A folder may be created inside any container: a folder, a workspace, 未分组
  // or the root. 收藏/待办/回收站 hold references rather than a tree, so a folder
  // cannot be created inside them.
  if (!canHoldFolders(parentNode)) {
    throw codedError("bad-request", `${parentNode.name ?? parent} 不能放文件夹`);
  }

  draft.folders ??= {};
  draft.placement ??= {};

  const id = FOLDER_NODE_PREFIX + newId();
  assertUniqueName(draft, parent, name);
  const siblings = Object.values(draft.folders).filter((folder) => (folder.parent ?? FIXED_NODES.root) === parent);
  draft.folders[id] = {
    id,
    name,
    parent,
    order: nextOrder(siblings),
    createdAt: Date.now(),
  };
  return id;
}

/**
 * Rename a folder. Fixed nodes are refused: 根目录 / 收藏 / 待办 / 回收站 / 未分组 are
 * not the user's to rename.
 *
 * @param {{ folders: Record<string, any> }} draft
 * @param {string} folderId
 * @param {string} name
 * @returns {string} the accepted name
 */
export function renameFolder(draft, folderId, name) {
  if (!isFolderNodeId(folderId)) throw codedError("bad-request", `${folderId} is not a folder`);
  const folder = draft.folders?.[folderId];
  if (!folder) throw codedError("bad-request", `unknown folder ${folderId}`);
  const accepted = folderName(name);
  assertUniqueName(draft, folder.parent ?? FIXED_NODES.root, accepted, folderId);
  folder.name = accepted;
  return folder.name;
}

/**
 * Move a folder or a workspace to a new parent.
 *
 * The caller validates with `canMove` first; this only applies the change, so a
 * refusal and an application never disagree about the rules.
 *
 * @param {{ folders: Record<string, any>, placement: Record<string, string>, workspaceOrder: Record<string, number> }} draft
 * @param {string} nodeId
 * @param {string} parentId
 * @returns {{ nodeId: string, parent: string }}
 */
export function moveNode(draft, nodeId, parentId) {
  draft.folders ??= {};
  draft.placement ??= {};
  draft.shortcuts ??= {};

  if (isShortcutNodeId(nodeId)) {
    const shortcut = draft.shortcuts[nodeId];
    if (!shortcut) throw codedError("bad-request", `unknown shortcut ${nodeId}`);
    shortcut.parent = parentId;
    const siblings = Object.values(draft.shortcuts)
      .filter((entry) => entry.id !== nodeId && (entry.parent ?? FIXED_NODES.root) === parentId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    shortcut.order = nextOrder(siblings);
    return { nodeId, parent: parentId };
  }

  if (isFolderNodeId(nodeId)) {
    const folder = draft.folders[nodeId];
    if (!folder) throw codedError("bad-request", `unknown folder ${nodeId}`);
    if (isInsideDraft(draft, nodeId, parentId)) {
      throw codedError("bad-request", `cannot move ${nodeId} inside itself`);
    }
    assertUniqueName(draft, parentId, String(folder.name ?? ""), nodeId);
    folder.parent = parentId;
    // Siblings are renumbered so the moved folder lands at the end of its new
    // parent instead of colliding with an existing order value.
    const siblings = Object.values(draft.folders)
      .filter((entry) => entry.id !== nodeId && (entry.parent ?? FIXED_NODES.root) === parentId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    folder.order = nextOrder(siblings);
    return { nodeId, parent: parentId };
  }

  const workspaceId = nodeId.startsWith("w-") ? nodeId.slice(2) : null;
  if (!workspaceId) throw codedError("bad-request", `${nodeId} is not movable`);
  if (parentId === FIXED_NODES.root) delete draft.placement[workspaceId];
  else draft.placement[workspaceId] = parentId;
  return { nodeId, parent: parentId };
}

/**
 * Delete a folder.
 *
 * @param {{ folders: Record<string, any>, placement: Record<string, string>, workspaceOrder: Record<string, number> }} draft
 * @param {string} folderId
 * @param {{ nodes: Record<string, any>, children: Record<string, string[]> }} tree
 * @param {{ liftContents?: boolean }} [options]
 * @returns {{ removed: string[], lifted: string[] }}
 */
export function deleteFolder(draft, folderId, tree, options = {}) {
  if (!isFolderNodeId(folderId)) throw codedError("bad-request", `${folderId} is not a folder`);
  const folder = draft.folders?.[folderId];
  if (!folder) throw codedError("bad-request", `unknown folder ${folderId}`);

  const kids = tree.children[folderId] ?? [];
  if (kids.length > 0 && options.liftContents !== true) {
    throw codedError(
      "bad-request",
      `${folder.name} still holds ${kids.length} item(s); move them out or pass liftContents`,
    );
  }

  const parent = folder.parent ?? FIXED_NODES.root;
  /** @type {string[]} */
  const lifted = [];
  for (const child of kids) {
    const workspaceId = child.startsWith("w-") ? child.slice(2) : null;
    if (workspaceId) {
      if (parent === FIXED_NODES.root) delete draft.placement[workspaceId];
      else draft.placement[workspaceId] = parent;
      lifted.push(child);
      continue;
    }
    const childFolder = draft.folders[child];
    if (childFolder) {
      childFolder.parent = parent;
      lifted.push(child);
      continue;
    }
    // A shortcut inside the folder is lifted too: deleting a folder must not
    // take the user's references with it (they are not the folder's contents).
    // When the folder sat at the root the references go to 收藏 instead, because
    // 根目录 holds directories and would drop them at render time.
    const shortcut = draft.shortcuts?.[child];
    if (shortcut) {
      shortcut.parent = parent === FIXED_NODES.root ? FIXED_NODES.favorites : parent;
      lifted.push(child);
    }
  }

  delete draft.folders[folderId];
  return { removed: [folderId], lifted };
}

/**
 * Reorder a node among its siblings.
 *
 * @param {{ folders: Record<string, any>, workspaceOrder: Record<string, number> }} draft
 * @param {string} nodeId
 * @param {number} order
 * @returns {{ nodeId: string, order: number }}
 */
export function reorderNode(draft, nodeId, order) {
  const value = Number(order);
  if (!Number.isFinite(value)) throw codedError("bad-request", "order must be a number");
  draft.folders ??= {};
  draft.workspaceOrder ??= {};

  if (isShortcutNodeId(nodeId)) {
    const shortcut = draft.shortcuts?.[nodeId];
    if (!shortcut) throw codedError("bad-request", `unknown shortcut ${nodeId}`);
    shortcut.order = value;
    return { nodeId, order: value };
  }

  if (isFolderNodeId(nodeId)) {
    const folder = draft.folders[nodeId];
    if (!folder) throw codedError("bad-request", `unknown folder ${nodeId}`);
    folder.order = value;
    return { nodeId, order: value };
  }

  const workspaceId = nodeId.startsWith("w-") ? nodeId.slice(2) : null;
  if (!workspaceId) throw codedError("bad-request", `${nodeId} is not reorderable`);
  draft.workspaceOrder[workspaceId] = value;
  return { nodeId, order: value };
}

