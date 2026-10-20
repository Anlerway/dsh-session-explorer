/**
 * dsh-session-explorer — shared constants.
 *
 * Kept in one module because both halves reason about the same strings: the
 * client fetches `API_PREFIX`, the host registers a route table under it, and
 * the ids of the fixed tree nodes appear in both.
 */

/** HTTP prefix the host registers on `ctx.webServer`. */
export const API_PREFIX = "/session-explorer/api";

/** Plugin id, as used by DSH's loader and the client module loader. */
export const PLUGIN_ID = "dsh-session-explorer";

/**
 * Ids of the fixed tree nodes. They never move and never get deleted; the rest
 * of the tree is user content.
 */
export const FIXED_NODES = Object.freeze({
  root: "f-root",
  /** 所有会话 — every live session, read-only. 根目录 itself holds no sessions. */
  all: "f-all",
  favorites: "f-favorites",
  todos: "f-todos",
  trash: "f-trash",
  ungrouped: "f-ungrouped",
});

/** Prefix used for the node ids DSH's own workspaces are projected onto. */
export const WORKSPACE_NODE_PREFIX = "w-";
