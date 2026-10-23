/**
 * dsh-session-explorer — 清除数据: the one button that destroys the user's own
 * records.
 *
 * Everything else in this plugin is reversible in some way. 清理缓存 frees
 * derived bytes and the next request rebuilds them; emptying the bin asks again
 * per session; a migration copies before it moves. This does not. It deletes:
 *
 *   - the four sidecar documents (tree, annotations, settings, trash/index) —
 *     every folder, tag, note, layout choice and bin entry;
 *   - the bin's payloads. The bin is a *move*, not a copy (lib/host/trash.js):
 *     those directories are sessions that used to live in DSH's session tree,
 *     so deleting them deletes those sessions for good;
 *   - quarantine/ — documents this plugin could not parse, parked as the user's
 *     own bytes;
 *   - .tmp/ — atomic-write leftovers.
 *
 * It deliberately leaves alone:
 *
 *   - the data directory itself, and its three sub-directories (they are
 *     emptied, not removed: the plugin must still have somewhere to write);
 *   - every session DSH still owns — this plugin only ever moved them, never
 *     invented them;
 *   - the optional browser component, which is an install, not user data (清理
 *     缓存 is the button for that).
 *
 * Because the blast radius is the user's own work, the operation is gated on
 * the literal string DELETE typed into the panel. The gate is checked here, on
 * the host, not only in the client: a route that trusts its caller for the one
 * irreversible action in the plugin is one fetch away from an accident.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { dataPaths, isUsableDataDir } from "../paths.js";
import { codedError } from "../store/sidecar.js";
import { emptyDir, invalidateMemory, sizeOf } from "./maintenance.js";

/** The word a user has to type. Case-sensitive, whitespace-tolerant. */
export const RESET_CONFIRMATION = "DELETE";

/** Sidecar documents, by the name \`api.documents\` uses. */
const DOCUMENT_NAMES = ["tree", "annotations", "settings", "trash"];

/**
 * The absolute paths of the four sidecar files.
 *
 * Read from \`api.documents\` when the runtime exposes it, because a test can
 * point those anywhere; otherwise derived from the data directory.
 *
 * @param {any} api
 * @param {ReturnType<typeof dataPaths>} paths
 * @returns {{ name: string, path: string }[]}
 */
function documentFiles(api, paths) {
  const documents = api?.documents ?? {};
  const fallback = {
    tree: paths.tree,
    annotations: paths.annotations,
    settings: paths.settings,
    trash: paths.trashIndex,
  };
  return DOCUMENT_NAMES.map((name) => {
    const declared = documents?.[name]?.path;
    return { name, path: typeof declared === "string" && declared !== "" ? declared : fallback[name] };
  });
}

/**
 * Delete one file, reporting what it was worth.
 *
 * A missing file is not an error: the button has to work on a directory that
 * has already been cleared, and "nothing there" is the desired end state.
 *
 * @param {string} path
 * @returns {{ removed: boolean, bytes: number }}
 */
function removeFile(path) {
  if (!existsSync(path)) return { removed: false, bytes: 0 };
  const bytes = sizeOf(path);
  try {
    rmSync(path, { force: true });
    return { removed: true, bytes };
  } catch {
    // A scanner holding the file open is the usual reason on Windows. Report it
    // as not removed rather than as an error: the caller's summary has to
    // describe what actually happened.
    return { removed: false, bytes: 0 };
  }
}

/**
 * Wipe this plugin's own records.
 *
 * @param {any} api
 * @param {{ confirm?: unknown }} [options]
 * @returns {Promise<{
 *   freedBytes: number,
 *   documents: Record<string, { removed: boolean, bytes: number }>,
 *   trash: { removed: number, bytes: number },
 *   quarantine: { removed: number, bytes: number },
 *   tmp: { removed: number, bytes: number },
 *   keptLocation: string | null,
 *   dataDir: string,
 *   tookMs: number,
 * }>}
 */
export async function resetData(api, options = {}) {
  const started = Date.now();

  // The gate. Checked before anything is read, let alone deleted, so a wrong or
  // missing word costs nothing and leaves no half-applied state behind.
  const typed = typeof options?.confirm === "string" ? options.confirm.trim() : "";
  if (typed !== RESET_CONFIRMATION) {
    throw codedError("confirm-required", "type DELETE to confirm; nothing was deleted");
  }

  const dataDir = typeof api?.dataDir === "string" ? api.dataDir : "";
  // The same refusal the env override and the migration target go through: a
  // data directory that is a filesystem root or sits on DSH's own tree must
  // never be emptied, however the request found out about it.
  if (!dataDir || !isUsableDataDir(dataDir)) {
    throw codedError("reset-refused", "refusing to clear an unusable data directory: " + (dataDir || "(none)"));
  }

  const paths = api?.paths ?? dataPaths(dataDir);

  // Remember where the plugin lives before the settings document that records
  // it is deleted. Without this a migrated install would silently fall back to
  // the default directory on the next start, and the user would find the panel
  // pointing at a directory that no longer holds anything.
  let keptLocation = null;
  try {
    const settings = await api?.documents?.settings?.read?.();
    const recorded = settings?.dataDir?.current;
    if (typeof recorded === "string" && recorded.trim() !== "" && isUsableDataDir(recorded.trim())) {
      keptLocation = recorded.trim();
    }
  } catch {
    // An unreadable settings document is exactly the kind of thing this button
    // exists to clear; there is simply no location to preserve.
    keptLocation = null;
  }

  /** @type {Record<string, { removed: boolean, bytes: number }>} */
  const documents = {};
  for (const file of documentFiles(api, paths)) {
    documents[file.name] = removeFile(file.path);
  }

  // Payloads first: the bin's index lives inside trash/, so emptying the
  // directory covers both in one pass.
  const trash = emptyDir(paths.trashDir ?? join(dataDir, "trash"));
  const quarantine = emptyDir(paths.quarantine ?? join(dataDir, "quarantine"));
  const tmp = emptyDir(paths.tmpDir ?? join(dataDir, ".tmp"));

  // Every list the panel painted is memoised; without this the folders and tags
  // just deleted would still answer from memory until the process restarted.
  invalidateMemory(api);

  // Put the location back. A fresh document is revision 1 — the same shape a
  // first run would write once the user changes anything — and it holds nothing
  // but the recorded directory, so the page still shows defaults everywhere.
  if (keptLocation) {
    try {
      await api?.documents?.settings?.mutate?.((draft) => {
        draft.dataDir = { ...(draft.dataDir ?? {}), current: keptLocation };
      });
    } catch {
      // Losing the record is survivable: the next start falls back to the
      // default directory, which is where a non-migrated install lives anyway.
      keptLocation = null;
    }
  }

  const freedBytes =
    Object.values(documents).reduce((sum, entry) => sum + entry.bytes, 0) +
    trash.bytes +
    quarantine.bytes +
    tmp.bytes;

  return {
    freedBytes,
    documents,
    trash,
    quarantine,
    tmp,
    keptLocation,
    dataDir,
    tookMs: Date.now() - started,
  };
}
