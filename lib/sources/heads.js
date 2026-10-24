/**
 * dsh-session-navigator — L2 data source: session headers on disk.
 *
 * `<dshHome>/sessions/<encodedProjectDir>/<encodedSessionId>/session.v4.jsonl.zstd`
 *
 * The log is a concatenation of zstd frames; frame #1 holds the session header
 * line:
 *
 *   { type:"session", version:4, id, createdAt, cwd, isSeeded,
 *     delegationDepth, agentPreset, parentSession?, origin? }
 *
 * We decode *only* that frame. This costs a few hundred microseconds per
 * session and gives three things the projection cache cannot guarantee:
 *
 *   1. the session physically exists,
 *   2. its id and cwd (the cache's `identity` is a claim; the header is truth),
 *   3. headers for sessions the cache has not seen yet.
 *
 * Discovery walks the directory tree instead of re-deriving DSH's path encoding
 * (`C:\Users\mi\x` → `--C-Users-mi-x--`), which is an implementation detail that
 * has already changed once. Directory names are therefore treated as opaque;
 * identity comes from the decoded header, never from the path.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readFirstRecord } from "../dsh/zstd.js";
// The log name and format version are owned by sources/artifact.js (the writer);
// importing them keeps a version bump from having to touch two files.
import { SESSION_FORMAT_VERSION, SESSION_LOG_FILE } from "./artifact.js";

export { SESSION_FORMAT_VERSION, SESSION_LOG_FILE };

/**
 * @param {string} dshHome
 * @returns {string} the sessions root
 */
export function sessionsDir(dshHome) {
  return join(dshHome, "sessions");
}

/**
 * Normalize one decoded header line into the shape the domain layer expects.
 *
 * @param {any} raw
 * @param {{ logPath?: string, sizeBytes?: number, mtimeMs?: number }} [meta]
 * @returns {object | null} `null` for a non-header or unknown version
 */
export function normalizeHeader(raw, meta = {}) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type !== "session") return null;
  if (!Number.isInteger(raw.version) || raw.version < 1) return null;
  return {
    id: String(raw.id ?? ""),
    formatVersion: raw.version,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    isSeeded: raw.isSeeded === true,
    delegationDepth: Number.isFinite(raw.delegationDepth) ? raw.delegationDepth : 0,
    agentPreset: typeof raw.agentPreset === "string" ? raw.agentPreset : null,
    parentSession: typeof raw.parentSession === "string" ? raw.parentSession : null,
    origin: typeof raw.origin === "string" ? raw.origin : null,
    logPath: meta.logPath ?? null,
    sizeBytes: Number.isFinite(meta.sizeBytes) ? meta.sizeBytes : null,
    // Together with the size this is the cache key for the tail facts
    // (`sources/logfacts.js`): a log only needs re-reading when it changed.
    mtimeMs: Number.isFinite(meta.mtimeMs) ? meta.mtimeMs : null,
  };
}

/**
 * Read one session header.
 *
 * @param {string} logPath absolute path to `session.v4.jsonl.zstd`
 * @returns {Promise<object | null>}
 */
export async function readSessionHeader(logPath) {
  try {
    // The log size is what the list shows in its 大小 column. `stat` runs
    // alongside the decode rather than after it so the header scan costs one
    // round trip per session, not two.
    const [raw, info] = await Promise.all([
      readFirstRecord(logPath),
      stat(logPath).catch(() => null),
    ]);
    return normalizeHeader(raw, { logPath, sizeBytes: info?.size, mtimeMs: info?.mtimeMs });
  } catch {
    return null;
  }
}

/** `session.v<N>.jsonl.zstd`: the format version is part of the file name. */
const LOG_NAME = /^session\.v(\d+)\.jsonl\.zstd$/;

/**
 * How many header decodes run at once.
 *
 * Every header costs one open file and a small buffer. A few hundred sessions
 * read at once is a few hundred fds and tens of megabytes of buffers, and the
 * plugin shares the process with DSH itself.
 */
const HEAD_CONCURRENCY = 8;

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The newest log in one session directory, or `null` when there is none.
 *
 * The name carries the format version, so building the path from the current
 * constant would make every session written by another DSH version invisible —
 * it would simply not appear in the list, with no error anywhere. Reading the
 * directory keeps old logs visible, and picking the highest version means a
 * session that was upgraded in place is read once.
 *
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function newestLog(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  let bestVersion = -1;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = LOG_NAME.exec(entry.name);
    if (!match) continue;
    const version = Number(match[1]);
    if (version > bestVersion) {
      bestVersion = version;
      best = entry.name;
    }
  }
  return best === null ? null : join(dir, best);
}

/**
 * Discover every session log under `<dshHome>/sessions`.
 *
 * Layout is two levels deep (`<project>/<session>/<file>`), but both levels are
 * walked defensively: a stray file or a nested directory is skipped rather than
 * throwing, because a plugin must never take the app down over a data-dir quirk.
 *
 * The result is sorted by path, so "the same session id was found twice" always
 * resolves the same way (see `readAllHeaders`).
 *
 * @param {string} dshHome
 * @returns {Promise<Array<{ logPath: string, projectDir: string }>>}
 */
export async function discoverLogs(dshHome) {
  const root = sessionsDir(dshHome);
  /** @type {Array<{ logPath: string, projectDir: string }>} */
  const found = [];
  /** @type {Array<{ dir: string, projectDir: string }>} */
  const sessionDirs = [];

  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    let sessions;
    try {
      sessions = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      sessionDirs.push({ dir: join(projectDir, session.name), projectDir: project.name });
    }
  }

  await mapLimit(sessionDirs, HEAD_CONCURRENCY, async (entry) => {
    const logPath = await newestLog(entry.dir);
    if (logPath !== null) found.push({ logPath, projectDir: entry.projectDir });
  });

  found.sort((a, b) => (a.logPath < b.logPath ? -1 : a.logPath > b.logPath ? 1 : 0));
  return found;
}

/**
 * Read every session header under the sessions root.
 *
 * @param {string} dshHome
 * @returns {Promise<Map<string, object>>} sessionId → header
 */
export async function readAllHeaders(dshHome) {
  const logs = await discoverLogs(dshHome);
  /** @type {Map<string, object>} */
  const out = new Map();
  // `discoverLogs` sorted the paths, and a `Map` keeps the first write, so two
  // copies of one session id resolve to the same header on every scan instead of
  // depending on which parallel read finished first.
  const headers = await mapLimit(logs, HEAD_CONCURRENCY, (entry) => readSessionHeader(entry.logPath));
  for (const header of headers) {
    if (!header?.id) continue;
    if (!out.has(header.id)) out.set(header.id, header);
  }
  return out;
}
