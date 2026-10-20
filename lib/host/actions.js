/**
 * dsh-session-explorer — operations that must go through DSH itself.
 *
 * Rename, fork, archive and pin are all *native* concepts: DSH already owns the
 * session title event, the fork seed, the archived set and the pinned set. The
 * plugin therefore never stores them (hard constraint 2 / S8 in 实现粗规划.md);
 * it calls the same host services the official UI calls, then makes our own
 * derived view catch up.
 *
 * The service names below are the runtime ones registered by the desktop
 * profile (see `dsh-api-session-controller`, `dsh-api-workspace-controller`):
 *
 *   sessionController        rename / fork
 *   workspaceController      rename / archiveSession / unarchiveSession /
 *                            pinSession / unpinSession
 *   sessionProjectionCache   write(session) — flush the L1 projection cache
 *
 * The last one matters: the list title normally comes from the projection cache
 * on disk, which is written on session creation, on `turn/end` and on disposal,
 * and otherwise throttled (200 events / 5 s). A rename appends exactly one
 * `session/title` event, so without an explicit flush the new title could take
 * five seconds to appear. Flushing right after the rename closes that gap at the
 * source instead of papering over it with an in-memory overlay.
 */

import { getService } from "../capabilities.js";
import { codedError } from "../store/sidecar.js";

/**
 * The session controller, or a `capability-missing` error.
 *
 * @param {any} ctx
 * @returns {any}
 */
function sessionControllerOf(ctx) {
  const controller = getService(ctx, "sessionController");
  if (!controller) {
    throw codedError(
      "capability-missing",
      "this DSH build mounts no session controller, so session operations are unavailable",
    );
  }
  return controller;
}

/**
 * The workspace controller, or a `capability-missing` error.
 *
 * @param {any} ctx
 * @returns {any}
 */
function workspaceControllerOf(ctx) {
  const controller = getService(ctx, "workspaceController");
  if (!controller) {
    throw codedError(
      "capability-missing",
      "this DSH build mounts no workspace controller, so workspace operations are unavailable",
    );
  }
  return controller;
}

/**
 * Bring the derived view back in line after a native mutation.
 *
 * The header scan is TTL-cached, so without this a caller that immediately
 * re-reads `/bootstrap` could still see the pre-mutation listing.
 *
 * @param {any} api
 */
function refresh(api) {
  try {
    api.reader.invalidate();
  } catch {
    /* an unavailable reader just means there is nothing cached to drop */
  }
}

/**
 * Flush the L1 projection cache for one session, if this build has one.
 *
 * Best effort on purpose: the rename already succeeded, and failing the whole
 * request because a *cache* could not be refreshed would be worse than showing
 * the new title a few seconds late.
 *
 * @param {any} ctx
 * @param {string} sessionId
 */
async function flushProjection(ctx, sessionId) {
  try {
    const cache = getService(ctx, "sessionProjectionCache");
    const sessions = getService(ctx, "sessions");
    const session = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : null;
    if (!cache || typeof cache.write !== "function" || !session) return;
    await cache.write(session);
  } catch {
    /* see above: a stale cache is a cosmetic delay, not a failure */
  }
}

/**
 * Rename a session by appending a user-authored `session/title` event.
 *
 * DSH treats a user rename as authoritative: it supersedes automatic title
 * generation, so the new name sticks across later turns. The session is resumed
 * first if it is cold — exactly what the official rename does.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {string} title
 * @returns {Promise<{ sessionId: string, title: string, seq: number }>}
 */
export async function renameSession(api, sessionId, title) {
  const controller = sessionControllerOf(api.ctx);
  if (typeof controller.rename !== "function") {
    throw codedError("capability-missing", "this DSH build cannot rename sessions");
  }
  const result = await controller.rename({ sessionId, title });
  await flushProjection(api.ctx, sessionId);
  refresh(api);
  return { sessionId, title: result?.title ?? title, seq: result?.seq ?? -1 };
}

/**
 * Rename a workspace.
 *
 * Duplicate names are rejected by DSH itself (`workspace/name-conflict`); the
 * plugin deliberately does not pre-validate, so its rule can never drift from
 * the host's.
 *
 * @param {any} api
 * @param {string} workspaceId
 * @param {string} title
 * @returns {Promise<{ workspaceId: string, title: string }>}
 */
export async function renameWorkspace(api, workspaceId, title) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.rename !== "function") {
    throw codedError("capability-missing", "this DSH build cannot rename workspaces");
  }
  const result = await controller.rename({ workspaceId, title });
  refresh(api);
  return { workspaceId, title: result?.workspace?.title ?? title };
}

/**
 * Delete a workspace registration, keeping its files and its sessions.
 *
 * This is DSH's own delete: the registry entry goes away, the directory and
 * every session log stay on disk. A session that was grouped under it therefore
 * has no workspace any more, which is exactly what 未分组 is for — it shows up
 * there instead of vanishing. Re-registering the same directory brings the
 * workspace back, sessions and all.
 *
 * @param {any} api
 * @param {string} workspaceId
 * @returns {Promise<{ workspaceId: string, deleted: boolean }>}
 */
export async function deleteWorkspace(api, workspaceId) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.delete !== "function") {
    throw codedError("capability-missing", "this DSH build cannot delete workspaces");
  }
  const result = await controller.delete({ workspaceId });
  refresh(api);
  return { workspaceId, deleted: result?.deleted !== false };
}

/**
 * Reveal a path in the OS file manager.
 *
 * DSH owns this: the path has to be verified through the composed filesystem,
 * and only the desktop host can hand it to Explorer/Finder. A plugin that
 * spawned `explorer.exe` itself would bypass both checks.
 *
 * @param {any} api
 * @param {string} path
 * @returns {Promise<{ path: string, opened: boolean }>}
 */
export async function revealPath(api, path) {
  const controller = sessionControllerOf(api.ctx);
  if (typeof controller.openWorkspacePath !== "function") {
    throw codedError("capability-missing", "this DSH build cannot open a path in the file manager");
  }
  await controller.openWorkspacePath({ path, action: "reveal" });
  return { path, opened: true };
}

/**
 * Archive a session (视觉降权, not deletion — hard constraint 3).
 *
 * A session with running work refuses to be archived unless `stopActivity` is
 * set; the client shows a confirmation and retries with it.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {{ stopActivity?: boolean }} [options]
 * @returns {Promise<{ archivedSessionIds: string[] }>}
 */
export async function archiveSession(api, sessionId, options = {}) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.archiveSession !== "function") {
    throw codedError("capability-missing", "this DSH build cannot archive sessions");
  }
  const request = options.stopActivity === true ? { sessionId, stopActivity: true } : { sessionId };
  const result = await controller.archiveSession(request);
  refresh(api);
  return { archivedSessionIds: listOf(result?.archivedSessionIds) };
}

/**
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<{ archivedSessionIds: string[] }>}
 */
export async function unarchiveSession(api, sessionId) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.unarchiveSession !== "function") {
    throw codedError("capability-missing", "this DSH build cannot unarchive sessions");
  }
  const result = await controller.unarchiveSession({ sessionId });
  refresh(api);
  return { archivedSessionIds: listOf(result?.archivedSessionIds) };
}

/**
 * Pin a session to the top of its list.
 *
 * DSH refuses to pin an archived session (`gateway/bad-request`), which is the
 * behaviour we surface rather than work around.
 *
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<{ pinnedSessionIds: string[] }>}
 */
export async function pinSession(api, sessionId) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.pinSession !== "function") {
    throw codedError("capability-missing", "this DSH build cannot pin sessions");
  }
  const result = await controller.pinSession({ sessionId });
  refresh(api);
  return { pinnedSessionIds: listOf(result?.pinnedSessionIds) };
}

/**
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<{ pinnedSessionIds: string[] }>}
 */
export async function unpinSession(api, sessionId) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.unpinSession !== "function") {
    throw codedError("capability-missing", "this DSH build cannot unpin sessions");
  }
  const result = await controller.unpinSession({ sessionId });
  refresh(api);
  return { pinnedSessionIds: listOf(result?.pinnedSessionIds) };
}

/**
 * Fork a session into a child that continues from a chosen event.
 *
 * Without `atSeq` DSH picks the latest completed turn — the same default the
 * official fork uses.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {number} [atSeq]
 * @returns {Promise<{ sessionId: string, parentSessionId: string }>}
 */
export async function forkSession(api, sessionId, atSeq) {
  const controller = sessionControllerOf(api.ctx);
  if (typeof controller.fork !== "function") {
    throw codedError("capability-missing", "this DSH build cannot fork sessions");
  }
  const request = Number.isSafeInteger(atSeq) ? { sessionId, atSeq } : { sessionId };
  const result = await controller.fork(request);
  const childId = String(result?.sessionId ?? "");
  if (!childId) throw codedError("fork-failed", "the host did not return a forked session id");
  refresh(api);
  return { sessionId: childId, parentSessionId: sessionId };
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function listOf(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
