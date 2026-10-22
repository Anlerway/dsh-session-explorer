/**
 * dsh-session-explorer — trash execution.
 *
 * The rules live in `lib/domain/trash.js`; this module only moves bytes and
 * keeps the index in step. The operation is the same one a file manager does:
 *
 *   delete  → rename <sessions>/<project>/<session>/  →  <dataDir>/trash/<trashId>/
 *   restore → rename back
 *   purge   → rm -rf the payload directory
 *
 * A cross-volume move cannot be a rename, so it degrades to copy-then-delete.
 * Nothing else about the flow changes.
 *
 * Crash safety: the index entry is written *before* the payload moves, marked
 * `pending`. A crash in between therefore leaves a pending entry with no
 * payload — reconcilable, not a lost session. `reconcileTrash` finishes the
 * bookkeeping on the next start: a pending entry whose payload exists is
 * promoted to ready, and one whose payload never left is dropped.
 */

import { access, cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dshHome } from "../dsh/home.js";
import { readAllHeaders, sessionsDir } from "../sources/heads.js";
import {
  newTrashId,
  originalDirOf,
  originalProjectDirOf,
  restoreTargetOf,
  sortedEntries,
  trashEntryOf,
  trashTargetDir,
} from "../domain/trash.js";
import { codedError } from "../store/sidecar.js";
import { dropShortcutsTo } from "../domain/shortcuts.js";

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a directory. Same volume is one rename; across volumes it is a copy
 * followed by a delete, which is the only thing the filesystem allows.
 *
 * @param {string} from
 * @param {string} to
 */
export async function moveDir(from, to) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
    return;
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    // Only a cross-volume move needs the copy fallback. Retrying an EPERM/EACCES
    // as a copy would either fail the same way or merge into an existing
    // directory — and `force: true` would silently overwrite a payload that is
    // already there, which is data loss disguised as a move.
    if (code !== "EXDEV") throw err;
  }
  await cp(from, to, { recursive: true, force: false, errorOnExist: true });
  try {
    const [source, target] = await Promise.all([fileList(from), fileList(to)]);
    const missing = source.filter((name) => !target.includes(name));
    if (missing.length > 0) throw codedError("move-incomplete", `${to} is missing ${missing.length} file(s)`);
  } catch (error) {
    // The copy is short, so the source is still the only good copy: keep it and
    // drop the partial destination rather than deleting the session.
    await rm(to, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await rm(from, { recursive: true, force: true });
}

/**
 * The payload directory for a trash entry, or `null` when the recorded id is not
 * a payload name at all.
 *
 * The index is plain JSON on disk, so a hand-edited `trashId` can be anything.
 * Listing and startup reconciliation must survive that: a malformed id means the
 * payload is not there (which is true — it can never have been created), not a
 * reason to fail the whole call.
 *
 * @param {{ trashDir: string }} paths
 * @param {unknown} trashId
 * @returns {string | null}
 */
function payloadOf(paths, trashId) {
  try {
    return trashTargetDir(paths, String(trashId ?? ""));
  } catch {
    return null;
  }
}

/**
 * Relative names of every regular file under `dir`, sorted.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function fileList(dir) {
  /** @type {string[]} */
  const found = [];
  /** @type {{ rel: string, abs: string }[]} */
  const pending = [{ rel: "", abs: dir }];
  while (pending.length > 0) {
    const current = /** @type {{ rel: string, abs: string }} */ (pending.pop());
    const entries = await readdir(current.abs, { withFileTypes: true });
    for (const entry of entries) {
      const rel = current.rel === "" ? entry.name : `${current.rel}/${entry.name}`;
      const abs = join(current.abs, entry.name);
      if (entry.isDirectory()) pending.push({ rel, abs });
      else found.push(rel);
    }
  }
  return found.sort();
}

/**
 * The DSH home this api reads from. The plugin passes nothing and the real home
 * is used; the tests inject one so they never touch a user's sessions.
 *
 * @param {any} api
 * @returns {string}
 */
function homeOf(api) {
  return typeof api.dshHome === "function" ? api.dshHome() : dshHome();
}

/**
 * Everything the trash routes need to know about the current sessions: the
 * merged view for titles and workspace membership, and the headers for the
 * physical location of each log.
 *
 * @param {any} api
 */
async function currentState(api) {
  const [snapshot, headers] = await Promise.all([
    api.reader.snapshot({ refresh: true }),
    readAllHeaders(homeOf(api)),
  ]);
  /** @type {Map<string, any>} */
  const sessions = new Map();
  for (const session of snapshot.view.sessions) sessions.set(session.id, session);
  return { snapshot, headers, sessions };
}

/**
 * @param {any} api
 * @param {string[]} ids
 * @returns {Promise<string[]>}
 */
function requireIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw codedError("bad-request", "ids must be a non-empty array");
  }
  return ids.map((id) => String(id ?? "")).filter((id) => id !== "");
}

/**
 * Move sessions to the trash.
 *
 * Every id is handled on its own: one session that cannot be moved (a running
 * one, a locked directory) must not cancel the rest of the batch, because the
 * caller asked for all of them in one click and each success is a session the
 * user got rid of. The failures come back as `errors` so the client can say
 * which ones stayed.
 *
 * @param {any} api
 * @param {string[]} ids
 * @returns {Promise<{ trashed: string[], skipped: string[], errors: { sessionId: string, code: string, message: string }[] }>}
 */
export async function trashSessions(api, ids) {
  const wanted = requireIds(ids);
  const { headers, sessions } = await currentState(api);
  const index = await api.documents.trash.read();
  const entries = index.entries ?? {};

  /** @type {string[]} */
  const trashed = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {{ sessionId: string, code: string, message: string }[]} */
  const errors = [];

  for (const id of wanted) {
    try {
      if (entries[id]) {
        skipped.push(id);
        continue;
      }
      const header = headers.get(id);
      if (!header?.logPath) {
        skipped.push(id);
        continue;
      }
      const session = sessions.get(id) ?? {};
      if (session.running === true) {
        // Moving the log of a live session would pull the file out from under the
        // agent that is still writing to it.
        throw codedError("session-active", `${id} is running; stop it before deleting`);
      }
      const entry = trashEntryOf(
        { ...session, id, logPath: header.logPath, sizeBytes: session.sizeBytes ?? header.sizeBytes },
        { trashId: newTrashId() },
      );

      // Claim the id inside the document lock. Two windows trashing the same
      // session at once used to each write a fresh trashId; the loser then moved
      // nothing, and its compensation deleted the winner's entry — leaving a
      // payload on disk that no entry points at, so it could never be restored
      // or emptied. Whoever finds the entry already taken leaves it alone.
      /** @type {any} */
      let claimed = null;
      await api.documents.trash.mutate((draft) => {
        draft.entries ??= {};
        if (draft.entries[id]) return;
        draft.entries[id] = { ...entry, pending: true };
        claimed = entry;
      });
      if (!claimed) {
        skipped.push(id);
        continue;
      }

      const from = originalDirOf(claimed);
      const to = trashTargetDir(api.paths, claimed.trashId);
      try {
        await moveDir(from, to);
      } catch (err) {
        await api.documents.trash
          .mutate((draft) => {
            if (draft.entries?.[id]?.trashId === claimed.trashId) delete draft.entries[id];
          })
          .catch(() => {});
        throw err;
      }

      await api.documents.trash.mutate((draft) => {
        const stored = draft.entries?.[id];
        if (stored && stored.trashId === claimed.trashId) delete stored.pending;
      });
      trashed.push(id);
    } catch (error) {
      errors.push({
        sessionId: id,
        code: String(/** @type {any} */ (error)?.code ?? "io-error"),
        message: String(/** @type {any} */ (error)?.message ?? error),
      });
      skipped.push(id);
    }
  }

  api.reader.invalidate();
  return { trashed, skipped, errors };
}

/**
 * The project directory a payload should be restored into.
 *
 * The recorded origin is preferred and recreated when missing. When the whole
 * project directory is gone, a directory that still holds a session of the same
 * workspace is used, so the restored session lands next to its neighbours. The
 * last resort is any live project directory, which is what makes 未分组 a safe
 * landing place: the session's workspace membership lives in DSH's registry, so
 * an id that no longer belongs to a workspace shows up there automatically.
 *
 * @param {any} api
 * @param {object} entry
 * @param {Map<string, any>} headers
 * @param {Map<string, any>} sessions
 * @returns {Promise<string>}
 */
async function projectDirFor(api, entry, headers, sessions) {
  const original = originalProjectDirOf(entry);
  if (await exists(original)) return original;

  const workspaceId = entry.workspaceId ?? null;
  if (workspaceId) {
    for (const [id, session] of sessions) {
      if (session.workspaceId !== workspaceId) continue;
      const header = headers.get(id);
      if (!header?.logPath) continue;
      const candidate = dirname(dirname(header.logPath));
      if (await exists(candidate)) return candidate;
    }
  }

  for (const [, header] of headers) {
    if (!header?.logPath) continue;
    const candidate = dirname(dirname(header.logPath));
    if (await exists(candidate)) return candidate;
  }

  // Nothing at all is left: the sessions root may not even exist yet. Recreate
  // the recorded project directory rather than inventing an encoding for it.
  await mkdir(original, { recursive: true });
  return original;
}

/**
 * Move sessions back out of the trash.
 *
 * @param {any} api
 * @param {string[]} ids
 * @returns {Promise<{ restored: string[], skipped: string[] }>}
 */
export async function restoreSessions(api, ids) {
  const wanted = requireIds(ids);
  const { headers, sessions } = await currentState(api);
  const index = await api.documents.trash.read();
  const entries = index.entries ?? {};

  /** @type {string[]} */
  const restored = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {{ sessionId: string, code: string, message: string }[]} */
  const errors = [];

  for (const id of wanted) {
    // One entry that cannot be restored (a payload that vanished mid-flight, a
    // path that is occupied) must not cancel the rest of the batch: the others
    // were asked for in the same click and each one that succeeds is a session
    // the user got back.
    try {
      const entry = entries[id];
      if (!entry) {
        skipped.push(id);
        continue;
      }
      const from = trashTargetDir(api.paths, entry.trashId);
      if (!(await exists(from))) {
        // The payload is gone but the entry survived: drop the stale record so the
        // bin stops offering a restore that cannot work.
        await api.documents.trash.mutate((draft) => {
          if (draft.entries?.[id]?.trashId === entry.trashId) delete draft.entries[id];
        });
        skipped.push(id);
        continue;
      }

      const projectDir = await projectDirFor(api, entry, headers, sessions);
      const target = restoreTargetOf(entry, projectDir);
      if (await exists(target)) {
        throw codedError("target-exists", `${target} already exists`);
      }
      await moveDir(from, target);

      await api.documents.trash.mutate((draft) => {
        if (draft.entries?.[id]?.trashId === entry.trashId) delete draft.entries[id];
      });
      restored.push(id);
    } catch (error) {
      errors.push({
        sessionId: id,
        code: String(/** @type {any} */ (error)?.code ?? "io-error"),
        message: String(/** @type {any} */ (error)?.message ?? error),
      });
      skipped.push(id);
    }
  }

  api.reader.invalidate();
  return { restored, skipped, errors };
}

/**
 * Delete payloads for good.
 *
 * Like the other batch operations, one payload that cannot be deleted (a file
 * still open in another process) does not stop the rest: the entry that failed
 * keeps its record so the bin still shows it, and `errors` says why.
 *
 * @param {any} api
 * @param {string[]} ids
 * @returns {Promise<{ purged: string[], skipped: string[], errors: { sessionId: string, code: string, message: string }[] }>}
 */
export async function purgeSessions(api, ids) {
  const wanted = requireIds(ids);
  const index = await api.documents.trash.read();
  const entries = index.entries ?? {};

  /** @type {string[]} */
  const purged = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {{ sessionId: string, code: string, message: string }[]} */
  const errors = [];

  for (const id of wanted) {
    try {
      const entry = entries[id];
      if (!entry) {
        skipped.push(id);
        continue;
      }
      // A malformed id has no payload on disk, so there is nothing to remove —
      // the record itself is still dropped below.
      const payload = payloadOf(api.paths, entry.trashId);
      if (payload) await rm(payload, { recursive: true, force: true });
      await api.documents.trash.mutate((draft) => {
        if (draft.entries?.[id]?.trashId === entry.trashId) delete draft.entries[id];
      });
      purged.push(id);
    } catch (error) {
      errors.push({
        sessionId: id,
        code: String(/** @type {any} */ (error)?.code ?? "io-error"),
        message: String(/** @type {any} */ (error)?.message ?? error),
      });
      skipped.push(id);
    }
  }

  api.reader.invalidate();
  // A reference outlives nothing: once the payload is gone, every shortcut that
  // pointed at it is gone too. That is the *only* way a shortcut disappears —
  // the row itself is not deletable — so this is where the promise is kept.
  if (purged.length > 0) {
    await api.documents.tree.mutate((draft) => {
      for (const id of purged) dropShortcutsTo(draft, "session", id);
    });
  }
  return { purged, skipped, errors };
}

/**
 * Empty the whole bin.
 *
 * @param {any} api
 * @returns {Promise<{ purged: string[] }>}
 */
export async function emptyTrash(api) {
  const index = await api.documents.trash.read();
  const ids = sortedEntries(index.entries ?? {}).map((entry) => entry.sessionId);
  if (ids.length === 0) return { purged: [] };
  const result = await purgeSessions(api, ids);
  return { purged: result.purged };
}

/**
 * Finish the bookkeeping a crash interrupted.
 *
 * A pending entry whose payload arrived is promoted to ready; a pending entry
 * whose payload never left is dropped. Ready entries are left alone — their
 * payload is the whole point of the bin.
 *
 * @param {any} api
 * @returns {Promise<{ promoted: string[], dropped: string[] }>}
 */
export async function reconcileTrash(api) {
  const index = await api.documents.trash.read();
  const entries = index.entries ?? {};
  /** @type {string[]} */
  const promoted = [];
  /** @type {string[]} */
  const dropped = [];

  for (const entry of Object.values(entries)) {
    if (!entry || entry.pending !== true) continue;
    const payload = payloadOf(api.paths, entry.trashId);
    if (payload && (await exists(payload))) promoted.push(entry.sessionId);
    else dropped.push(entry.sessionId);
  }
  if (promoted.length === 0 && dropped.length === 0) return { promoted, dropped };

  await api.documents.trash.mutate((draft) => {
    for (const id of promoted) {
      const stored = draft.entries?.[id];
      if (stored) delete stored.pending;
    }
    for (const id of dropped) delete draft.entries?.[id];
  });
  return { promoted, dropped };
}

/**
 * The sessions root, for the client's benefit (it shows the trash location).
 *
 * @returns {string}
 */
export function sessionsRoot(api) {
  return sessionsDir(homeOf(api));
}

