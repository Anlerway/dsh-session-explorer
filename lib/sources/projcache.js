/**
 * dsh-session-explorer — L1 data source: DSH's own projection cache.
 *
 * For every stored session DSH keeps one small JSON file at
 *
 *   <dshHome>/storages/session_projcache/sessions/<sessionId>.json
 *
 * written by `@deepseek-ai/dsh-session-projection-cache`. The file holds
 * `{ version, record: { identity, rows } }` where `rows[key] = { seq, val }`
 * are the projected values of the session's event log. Reading it costs one
 * small JSON parse; reading the session log instead costs decompressing 5 MB.
 *
 * This module is the listing workhorse: title, last-prompt time, turn/step
 * counts, token usage, context pressure, cwd and agent preset all come from
 * here, so `/bootstrap` never touches a zstd file for a session the cache
 * knows about.
 *
 * Everything is read defensively. A cache file is *not* authoritative — DSH may
 * rewrite it at any time, and a stale or future-schema record must degrade to
 * "no cached facts" rather than fail the listing. The one thing never trusted
 * is `identity`: the caller cross-checks it against the session header (L2).
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Projection cache format version this reader understands. */
export const PROJCACHE_VERSION = 7;

/**
 * Absolute directory of the projection cache for a given DSH home.
 *
 * @param {string} dshHome
 * @returns {string}
 */
export function projcacheDir(dshHome) {
  return join(dshHome, "storages", "session_projcache", "sessions");
}

/**
 * Read one `{ seq, val }` row, tolerating both the wrapped and bare shapes.
 *
 * @param {any} rows
 * @param {string} key
 * @returns {any} the row's value, or `undefined`
 */
function valueOf(rows, key) {
  const row = rows?.[key];
  if (row === undefined || row === null) return undefined;
  return typeof row === "object" && "val" in row ? row.val : row;
}

/**
 * Extract the listing facts this plugin needs from one cache record.
 *
 * @param {any} record `record` from the cache file
 * @returns {object}
 */
export function factsOf(record) {
  const rows = record?.rows ?? {};
  const identity = record?.identity ?? {};
  const listMeta = valueOf(rows, "sessionListMetadata") ?? {};
  const stats = valueOf(rows, "sessionStats") ?? {};
  const usage = valueOf(rows, "tokenUsage") ?? {};
  const pressure = valueOf(rows, "contextPressure") ?? {};

  const createdAt = Number.isFinite(identity.createdAt) ? identity.createdAt : undefined;
  const lastPromptAt = Number.isFinite(listMeta.lastPromptAt) ? listMeta.lastPromptAt : undefined;

  return {
    title: typeof valueOf(rows, "title") === "string" ? valueOf(rows, "title") : null,
    lastPromptAt: lastPromptAt ?? null,
    createdAt: createdAt ?? null,
    // Sort key: a session with no prompts yet still sorts by creation.
    activityAt: Math.max(createdAt ?? 0, lastPromptAt ?? 0) || null,
    blank: listMeta.blank === true,
    cwd: typeof identity.cwd === "string" ? identity.cwd : null,
    identity,
    stats: {
      turns: numberOr(stats.turns),
      steps: numberOr(stats.steps),
      llmMs: numberOr(stats.llmMs),
      ttftMs: numberOr(stats.ttftMs),
      toolMs: numberOr(stats.toolMs),
    },
    tokenUsage: {
      uncachedInputTokens: numberOr(usage?.totals?.uncachedInputTokens),
      outputTokens: numberOr(usage?.totals?.outputTokens),
      cacheReadTokens: numberOr(usage?.totals?.cacheReadTokens),
      cacheWriteTokens: numberOr(usage?.totals?.cacheWriteTokens),
    },
    contextPressure: {
      surfaceTokens: numberOr(pressure.surfaceTokens),
      contextWindow: numberOr(pressure.contextWindow),
      pressureTokens: numberOr(pressure.pressureTokens),
    },
    workingDirectory: stringOrNull(valueOf(rows, "workingDirectory")),
    agentPreset: stringOrNull(valueOf(rows, "agentPreset")),
    modelSelection: valueOf(rows, "modelSelection") ?? null,
  };
}

/**
 * @param {any} value
 * @returns {number}
 */
function numberOr(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * @param {any} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

/**
 * Read and project one cache file.
 *
 * @param {string} filePath
 * @returns {Promise<{ sessionId: string, version: number, facts: object } | null>}
 *   `null` when the file is absent, unreadable, not JSON, or a version this
 *   reader does not understand.
 */
export async function readProjcacheFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed?.version !== PROJCACHE_VERSION) return null;
  const record = parsed.record;
  if (!record || typeof record !== "object") return null;
  return {
    sessionId: filePath.replace(/^.*[\\/]/, "").replace(/\.json$/, ""),
    version: parsed.version,
    facts: factsOf(record),
  };
}

/**
 * Read every projection cache record in one directory.
 *
 * Missing directories are not an error: a fresh DSH home has no cache yet and
 * the caller falls back to the session headers.
 *
 * @param {string} dir
 * @returns {Promise<Map<string, object>>} sessionId → { version, facts }
 */
export async function readProjcache(dir) {
  /** @type {Map<string, object>} */
  const out = new Map();
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const entry = await readProjcacheFile(join(dir, name));
        if (entry) out.set(entry.sessionId, { version: entry.version, facts: entry.facts });
      }),
  );
  return out;
}
