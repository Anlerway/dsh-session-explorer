/**
 * dsh-session-explorer — L2 data source: session headers on disk.
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

/** File name of a session log inside its session directory. */
export const SESSION_LOG_FILE = "session.v4.jsonl.zstd";

/** Session format version this build understands. */
export const SESSION_FORMAT_VERSION = 4;

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
 * @param {{ logPath?: string, sizeBytes?: number }} [meta]
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
    return normalizeHeader(raw, { logPath, sizeBytes: info?.size });
  } catch {
    return null;
  }
}

/**
 * Discover every session log under `<dshHome>/sessions`.
 *
 * Layout is two levels deep (`<project>/<session>/<file>`), but both levels are
 * walked defensively: a stray file or a nested directory is skipped rather than
 * throwing, because a plugin must never take the app down over a data-dir quirk.
 *
 * @param {string} dshHome
 * @returns {Promise<Array<{ logPath: string, projectDir: string }>>}
 */
export async function discoverLogs(dshHome) {
  const root = sessionsDir(dshHome);
  /** @type {Array<{ logPath: string, projectDir: string }>} */
  const found = [];

  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }

  await Promise.all(
    projects
      .filter((entry) => entry.isDirectory())
      .map(async (project) => {
        const projectDir = join(root, project.name);
        let sessions;
        try {
          sessions = await readdir(projectDir, { withFileTypes: true });
        } catch {
          return;
        }
        await Promise.all(
          sessions
            .filter((entry) => entry.isDirectory())
            .map(async (session) => {
              const logPath = join(projectDir, session.name, SESSION_LOG_FILE);
              // `readSessionHeader` returns null for a missing/unreadable file,
              // which subsumes an existence check without a second stat.
              found.push({ logPath, projectDir: project.name });
            }),
        );
      }),
  );

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
  const headers = await Promise.all(logs.map((entry) => readSessionHeader(entry.logPath)));
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (!header?.id) continue;
    if (!out.has(header.id)) out.set(header.id, header);
  }
  return out;
}
