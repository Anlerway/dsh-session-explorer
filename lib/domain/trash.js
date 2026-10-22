/**
 * dsh-session-explorer — trash rules.
 *
 * Deleting a session moves its whole session directory out of DSH's sessions
 * tree and into `<dataDir>/trash/<trashId>/`, exactly like dropping a file in
 * the recycle bin. Restoring moves the same directory back. Nothing is copied,
 * nothing is rewritten, and no DSH storage file is touched behind the kernel's
 * back — a trashed session is simply *not there* any more, which is why DSH and
 * this plugin agree about it without any coordination.
 *
 * Because the payload is gone, the session header is gone too, so the listing
 * cannot describe a trashed session from DSH's data any more. The index entry
 * therefore carries a small snapshot: title, cwd, workspace and size at the
 * moment of deletion. That is the one place this plugin duplicates a native
 * attribute, and it is deliberate (实现粗规划.md §5.2 allows it): without the
 * snapshot the recycle bin would be a list of opaque ids.
 *
 * The entry also records where the payload came from, so restore can put it
 * back. The restore ladder, in order:
 *
 *   1. `original`    the recorded project directory (recreated when missing)
 *   2. `workspace`   a project directory that still holds the same workspace
 *   3. `ungrouped`   any existing project directory, so the session reappears
 *                     under 未分组 instead of being lost
 *
 * Pure: paths and shapes only, no I/O. `lib/host/trash.js` does the moving.
 */

import { basename, dirname, join, resolve } from "node:path";
import { codedError } from "../store/sidecar.js";

/** Prefix of a trash payload directory name. */
export const TRASH_ID_PREFIX = "t-";

/**
 * Shape of a payload directory name: `t-<base36 time>-<suffix>`, all lowercase
 * alphanumerics. The id is read back from `trash/index.v1.json`, which is plain
 * JSON on disk — a hand edit must not be able to point a recursive delete at
 * `..\..\..\Documents`, so the id is validated instead of trusted.
 */
const TRASH_ID_PATTERN = /^t-[a-z0-9]+-[a-z0-9]+$/;

/**
 * Where a payload directory lives inside the data directory.
 *
 * @param {{ trashDir: string }} paths
 * @param {string} trashId
 * @returns {string}
 */
export function trashTargetDir(paths, trashId) {
  const id = String(trashId ?? "");
  if (!TRASH_ID_PATTERN.test(id)) {
    throw codedError("trash-not-found", `malformed trash id: ${id}`);
  }
  const base = resolve(paths.trashDir);
  const target = resolve(base, id);
  if (dirname(target) !== base) {
    throw codedError("trash-not-found", `trash payload ${id} resolves outside ${base}`);
  }
  return target;
}

/**
 * @param {() => string} [random] injectable for tests
 * @returns {string} a fresh payload directory name
 */
export function newTrashId(random) {
  const suffix = typeof random === "function" ? random() : Math.random().toString(36).slice(2, 8);
  return `${TRASH_ID_PREFIX}${Date.now().toString(36)}-${suffix}`;
}

/**
 * Compare two absolute paths the way the platform does. Windows is
 * case-insensitive; POSIX is not.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = a.replace(/[\\/]+$/, "");
  const right = b.replace(/[\\/]+$/, "");
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/**
 * Build the index entry for one session.
 *
 * @param {object} session merged session view (or a partial one from a header)
 * @param {{ trashId: string, deletedAt?: number }} options
 * @returns {object}
 */
export function trashEntryOf(session, options) {
  const id = String(session?.id ?? "");
  if (!id) throw codedError("bad-request", "cannot trash a session without an id");
  const logPath = typeof session?.logPath === "string" ? session.logPath : null;
  if (!logPath) throw codedError("session-not-found", `${id} has no session log`);
  return {
    sessionId: id,
    trashId: options.trashId,
    // Snapshot, not a mirror: these four fields describe the session as it was
    // when it went to the bin, because the payload is no longer readable.
    title: session.displayTitle ?? session.title ?? basename(dirname(logPath)) ?? id,
    cwd: typeof session.cwd === "string" ? session.cwd : null,
    workspaceId: session.workspaceId ?? null,
    workspaceTitle: session.workspaceTitle ?? null,
    sizeBytes: Number.isFinite(session.sizeBytes) ? session.sizeBytes : null,
    createdAt: Number.isFinite(session.createdAt) ? session.createdAt : null,
    // Provenance: everything restore needs to put the payload back.
    originalLogPath: logPath,
    deletedAt: Number.isFinite(options.deletedAt) ? options.deletedAt : Date.now(),
  };
}

/**
 * @param {object} entry
 * @returns {string} the session directory the payload was taken from
 */
export function originalDirOf(entry) {
  const logPath = String(entry?.originalLogPath ?? "");
  if (!logPath) throw codedError("trash-not-found", "trash entry has no recorded origin");
  return dirname(logPath);
}

/**
 * The project directory a payload came from (`<sessions>/<project>/`).
 *
 * @param {object} entry
 * @returns {string}
 */
export function originalProjectDirOf(entry) {
  return dirname(originalDirOf(entry));
}

/**
 * Where restore should drop the payload: the project directory plus the
 * session directory name it had before.
 *
 * @param {object} entry
 * @param {string} projectDir
 * @returns {string}
 */
export function restoreTargetOf(entry, projectDir) {
  return join(projectDir, basename(originalDirOf(entry)));
}

/**
 * A session-shaped object for the trash scope.
 *
 * Trashed payloads have no header any more, so the merged view cannot produce
 * one. Everything the list and the detail pane read is filled in from the
 * entry; everything DSH owns (archive, pin, running, stats) is false or null,
 * because it genuinely is unknown while the payload is in the bin.
 *
 * @param {object} entry
 * @returns {object}
 */
export function trashedSessionOf(entry) {
  const id = String(entry?.sessionId ?? "");
  const title = typeof entry?.title === "string" && entry.title ? entry.title : id;
  const deletedAt = Number.isFinite(entry?.deletedAt) ? entry.deletedAt : null;
  return {
    id,
    workspaceId: entry?.workspaceId ?? null,
    workspaceTitle: entry?.workspaceTitle ?? null,
    title: entry?.title ?? null,
    displayTitle: title,
    createdAt: entry?.createdAt ?? null,
    lastPromptAt: null,
    activityAt: deletedAt,
    cwd: entry?.cwd ?? null,
    agentPreset: null,
    isSeeded: false,
    delegationDepth: 0,
    parentSession: null,
    origin: null,
    isSubagent: false,
    blank: null,
    stats: null,
    tokenUsage: null,
    contextPressure: null,
    modelSelection: null,
    archived: false,
    pinned: false,
    running: false,
    hasCache: false,
    formatVersion: null,
    sizeBytes: entry?.sizeBytes ?? null,
    tags: [],
    note: "",
    favorite: false,
    todo: false,
    trashed: true,
    deletedAt,
  };
}

/**
 * Trash entries, newest first.
 *
 * @param {Record<string, object>} entries
 * @returns {object[]}
 */
export function sortedEntries(entries) {
  return Object.values(entries ?? {})
    .filter((entry) => entry && typeof entry === "object")
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
}
