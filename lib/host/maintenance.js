/**
 * dsh-session-explorer — what "清理缓存" is allowed to delete.
 *
 * The plugin has no cache directory of its own. What it does accumulate is:
 *
 *   - in-memory answers (the session walk, log facts, the four sidecar
 *     documents) — dropped by invalidation, which costs a re-read and nothing
 *     else;
 *   - `.tmp/` leftovers from atomic writes interrupted by a crash;
 *   - partial browser-component downloads (`component/download/`) and staging
 *     trees from a cancelled install, which are the only *large* files this
 *     plugin ever writes.
 *
 * It deliberately does not touch:
 *
 *   - `quarantine/` — those are the user's own bytes, parked because a document
 *     could not be parsed. Deleting them is data loss dressed as maintenance;
 *   - DSH's own projection cache (`<dshHome>/storages/session_projcache`) —
 *     not this plugin's to clear, and DSH would rebuild it anyway;
 *   - the session store itself.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { componentPaths } from "../component/layout.js";
import { cleanTmp } from "../paths.js";
import { clearLogFacts } from "../sources/logfacts.js";

/** Phases in which the component owns its download directory. */
const COMPONENT_BUSY = new Set(["downloading", "verifying", "extracting"]);

/**
 * Bytes under a directory, without following anything clever.
 *
 * A failure to stat one entry is not a failure to clean: the walk is only used
 * to report how much space came back.
 *
 * @param {string} dir
 * @returns {number}
 */
export function sizeOf(dir) {
  if (!dir || !existsSync(dir)) return 0;
  // A single file is a legitimate subject too — 清除数据 measures the four
  // sidecars before deleting them, and a walk over a file finds nothing.
  try {
    const stat = statSync(dir);
    if (stat.isFile()) return stat.size;
  } catch {
    return 0;
  }
  /** @type {string[]} */
  const stack = [dir];
  let total = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(path);
        } else if (entry.isFile()) {
          total += statSync(path).size;
        }
      } catch {
        /* a file that vanished mid-walk contributes nothing */
      }
    }
  }
  return total;
}

/**
 * Empty one directory, keeping the directory itself.
 *
 * @param {string} dir
 * @returns {{ removed: number, bytes: number }}
 */
export function emptyDir(dir) {
  const bytes = sizeOf(dir);
  let removed = 0;
  if (!dir || !existsSync(dir)) return { removed, bytes: 0 };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed, bytes: 0 };
  }
  for (const entry of entries) {
    try {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      /* a scanner or an indexer still holds it; the next clear retries */
    }
  }
  return { removed, bytes };
}

/**
 * Drop the plugin's in-memory caches.
 *
 * The session walk and the sidecars both memoise, so a clear that only deleted
 * files would leave every list answering from memory until the process
 * restarted — the opposite of what the button promises.
 *
 * @param {any} api
 * @returns {string[]} the caches that were dropped
 */
export function invalidateMemory(api) {
  const dropped = [];
  try {
    if (typeof api?.reader?.invalidate === "function") {
      api.reader.invalidate();
      dropped.push("sessions");
    }
  } catch {
    /* a broken reader still has to leave the rest working */
  }
  try {
    clearLogFacts();
    dropped.push("log-facts");
  } catch {
    /* ditto */
  }
  const documents = api?.documents ?? {};
  for (const name of Object.keys(documents)) {
    const document = documents[name];
    if (document && typeof document.invalidate === "function") {
      try {
        document.invalidate();
        dropped.push(name);
      } catch {
        /* ditto */
      }
    }
  }
  return dropped;
}

/**
 * Clear every cache this plugin owns.
 *
 * @param {any} api
 * @returns {Promise<{ freedBytes: number, caches: string[], tmp: { removed: number, bytes: number }, downloads: { removed: number, bytes: number }, staging: { removed: number, bytes: number }, skipped: string[], tookMs: number }>}
 */
export async function clearCaches(api) {
  const started = Date.now();
  const dataDir = typeof api?.dataDir === "string" ? api.dataDir : "";
  const caches = invalidateMemory(api);

  // Atomic-write leftovers. `cleanTmp` knows which names are ours (and rescues
  // `.corrupt-*` into `quarantine/` instead of deleting them), so this is the
  // same sweep every start does.
  const tmpDir = api?.paths?.tmpDir ?? join(dataDir, ".tmp");
  const tmpBefore = sizeOf(tmpDir);
  const tmpRemoved = cleanTmp(dataDir);
  const tmp = { removed: tmpRemoved, bytes: Math.max(0, tmpBefore - sizeOf(tmpDir)) };

  /** @type {string[]} */
  const skipped = [];
  let downloads = { removed: 0, bytes: 0 };
  let staging = { removed: 0, bytes: 0 };

  /** @type {{ downloadDir: string, staging: string } | null} */
  let component = null;
  try {
    component = componentPaths(dataDir);
  } catch {
    component = null;
  }

  if (component) {
    let phase = "";
    try {
      const status = await api?.component?.status?.();
      phase = typeof status?.phase === "string" ? status.phase : "";
    } catch {
      // An unreadable component record says nothing about the files; treating
      // it as busy is the safe direction, because the files may be in use.
      phase = "extracting";
    }
    if (COMPONENT_BUSY.has(phase)) {
      skipped.push("component-busy");
    } else {
      // A `.part` is a resumable download: clearing it means the next install
      // starts over, which is why it only happens when the user asks.
      downloads = emptyDir(component.downloadDir);
      const stagingBytes = sizeOf(component.staging);
      const stagingExisted = existsSync(component.staging);
      try {
        rmSync(component.staging, { recursive: true, force: true });
        if (stagingExisted) staging = { removed: 1, bytes: stagingBytes };
      } catch {
        skipped.push("staging-in-use");
      }
    }
  }

  return {
    freedBytes: tmp.bytes + downloads.bytes + staging.bytes,
    caches,
    tmp,
    downloads,
    staging,
    skipped,
    tookMs: Date.now() - started,
  };
}
