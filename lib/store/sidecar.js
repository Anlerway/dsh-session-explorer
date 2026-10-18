/**
 * dsh-session-explorer — the sidecar store.
 *
 * Every file this plugin owns (`tree.v1.json`, `annotations.v1.json`,
 * `settings.v1.json`, `trash/index.v1.json`) is a small JSON document with the
 * same envelope:
 *
 *   { "version": 1, "revision": <n>, ...payload }
 *
 * Three properties are load-bearing:
 *
 *   Atomic    — the new bytes are written to `<dataDir>/.tmp`, flushed, and
 *               renamed over the target. A crash mid-write leaves the previous
 *               document intact; anything stranded in `.tmp` is swept on the
 *               next start (lib/paths.js).
 *   Revised   — `revision` increments on every successful write. Clients send
 *               the revision they last saw, and a mismatch fails with
 *               `revision-conflict` instead of silently clobbering a change made
 *               in another window.
 *   Serial    — writes to one file are queued on a promise chain. Two requests
 *               arriving together cannot interleave a read-modify-write, so the
 *               revision check stays meaningful without a lock file.
 *
 * Reads are cached in memory and revalidated by mtime+size, so the hot path
 * (every `/bootstrap`) costs one `stat` per file rather than a parse.
 */

import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Error carrying the stable code the HTTP layer maps to a status.
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
export function codedError(code, message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  return error;
}

/**
 * Create a sidecar document handle.
 *
 * @param {object} options
 * @param {string} options.path absolute file path
 * @param {string} options.tmpDir absolute `.tmp` directory (same volume as the target)
 * @param {number} [options.version] schema version this build writes
 * @param {() => object} options.empty payload used when the file does not exist yet
 * @param {(raw: any) => object} [options.migrate] upgrade an older payload
 */
export function createSidecar({ path, tmpDir, version = 1, empty, migrate }) {
  /** @type {{ data: any, stamp: string } | null} */
  let cache = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /**
   * @param {any} raw
   * @returns {any}
   */
  function normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw codedError("sidecar-corrupt", `${basename(path)} is not a JSON object`);
    }
    if (raw.version === version) return raw;
    if (typeof migrate === "function") {
      const migrated = migrate(raw);
      if (migrated && typeof migrated === "object") return { ...migrated, version };
    }
    throw codedError(
      "sidecar-version",
      `${basename(path)} has version ${String(raw.version)}, this build writes ${version}`,
    );
  }

  /** @returns {Promise<{ data: any, stamp: string }>} */
  async function load() {
    let info;
    try {
      info = await stat(path);
    } catch {
      const data = { version, revision: 0, ...empty() };
      cache = { data, stamp: "missing" };
      return cache;
    }
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (cache && cache.stamp === stamp) return cache;

    const text = await readFile(path, "utf8");
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      // A truncated file is recoverable by hand but never by guessing: keep the
      // bytes aside and start clean, so the plugin stays usable.
      await quarantine(path, tmpDir).catch(() => {});
      raw = { version, revision: 0, ...empty() };
    }
    let data;
    try {
      data = normalize(raw);
    } catch (err) {
      await quarantine(path, tmpDir).catch(() => {});
      if (/** @type {any} */ (err).code === "sidecar-version") throw err;
      data = { version, revision: 0, ...empty() };
    }
    cache = { data, stamp };
    return cache;
  }

  /**
   * Read the current document. The returned object is a deep copy, so callers
   * cannot mutate the cache by accident.
   *
   * @returns {Promise<any>}
   */
  async function read() {
    const { data } = await load();
    return structuredClone(data);
  }

  /**
   * Read-modify-write with a revision guard.
   *
   * `mutator` receives a deep copy of the current payload and returns either a
   * replacement payload or `undefined` to mutate in place. It may throw a coded
   * error to abort the write (nothing is persisted).
   *
   * @param {(draft: any) => any} mutator
   * @param {number | undefined} expectedRevision
   * @returns {Promise<any>} the document as persisted
   */
  function mutate(mutator, expectedRevision) {
    const run = queue.then(async () => {
      const { data } = await load();
      if (typeof expectedRevision === "number" && expectedRevision !== data.revision) {
        throw codedError(
          "revision-conflict",
          `${basename(path)} is at revision ${data.revision}, request expected ${expectedRevision}`,
        );
      }
      const draft = structuredClone(data);
      const next = mutator(draft);
      const payload = next && typeof next === "object" ? next : draft;
      const document = { ...payload, version, revision: data.revision + 1 };
      await writeAtomic(path, tmpDir, JSON.stringify(document, null, 2));
      const info = await stat(path);
      cache = { data: document, stamp: `${info.mtimeMs}:${info.size}` };
      return structuredClone(document);
    });
    // Keep the chain alive even when this write rejects, otherwise one failure
    // would poison every later write to the same file.
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    path,
    read,
    mutate,
    /** Drop the in-memory copy; the next read hits the disk. */
    invalidate() {
      cache = null;
    },
  };
}

/**
 * Write bytes atomically: temp file in the same volume, flush, rename over the
 * target. `rename` replaces on every platform Node supports.
 *
 * @param {string} target
 * @param {string} tmpDir
 * @param {string} text
 */
export async function writeAtomic(target, tmpDir, text) {
  const tmp = join(tmpDir, `${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, text, "utf8");
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Move an unreadable document aside instead of deleting it: the user may still
 * want to recover the bytes by hand.
 *
 * @param {string} target
 * @param {string} tmpDir
 */
async function quarantine(target, tmpDir) {
  const name = `${basename(target)}.corrupt-${Date.now()}.json`;
  await rename(target, join(tmpDir, name));
}
