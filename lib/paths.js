/**
 * dsh-session-explorer — data-directory resolution.
 *
 * The plugin keeps every piece of its own state (virtual tree, annotations,
 * settings, trash index, trash payloads) under a directory that is a **sibling**
 * of `~/.dsh`, not a child of it:
 *
 *   C:\Users\<user>\.dsh                 <- owned by DSH
 *   C:\Users\<user>\.dsh-session-explorer <- owned by this plugin
 *
 * Two reasons. First, the trash holds whole session directories (hundreds of MB),
 * and stuffing those into `~/.dsh` would pollute DSH's own data tree and make
 * backup/migration/cleanup ambiguous. Second, an env override lets the self-test
 * suite point at a throwaway directory, so tests never touch real user data.
 *
 * `DSH_SE_DATA_DIR` overrides the location. It is validated: a value that
 * resolves to a filesystem root (`/` or `C:\\`) is rejected, because a purge
 * of "the trash" under such a root would be catastrophic. Rejected values fall
 * back to the default and log a warning; the plugin never silently honours them.
 *
 * `os.homedir()` is used directly rather than DSH's `dshHomePath()` helper: that
 * helper only exists inside `cordis.yml` `!!js` expressions and is not
 * guaranteed to be reachable from plugin runtime.
 */

import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";

/** Env var that overrides the data directory (mainly for tests). */
export const DATA_DIR_ENV = "DSH_SE_DATA_DIR";

/** Default directory name under the user's home. */
export const DATA_DIR_NAME = ".dsh-session-explorer";

/** Sub-directories that must exist before the plugin serves anything. */
export const DATA_SUBDIRS = ["trash", ".tmp"];

/** Sidecar files that live directly in the data directory. */
export const SIDECARS = ["tree.v1.json", "annotations.v1.json", "settings.v1.json", "trash/index.v1.json"];

/**
 * Resolve the plugin data directory.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} Absolute path to the data directory (never a filesystem root).
 */
export function pluginDataDir(env = process.env) {
  const fallback = join(homedir(), DATA_DIR_NAME);
  const raw = env?.[DATA_DIR_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const abs = resolve(raw.trim());
  const root = parse(abs).root;
  if (abs === root || parse(abs).base === "") {
    console.warn(`[session-explorer] ${DATA_DIR_ENV} points at a filesystem root, ignoring:`, abs);
    return fallback;
  }
  return abs;
}

/** @param {string} dir @param {string[]} subdirs */
function ensureDirs(dir, subdirs) {
  for (const sub of subdirs) {
    mkdirSync(join(dir, ...sub.split("/")), { recursive: true });
  }
}

/**
 * Create the data directory (and its sub-directories) if missing, and clear
 * leftover atomic-write temp files. Safe to call on every start.
 *
 * @param {string} [dir] Defaults to {@link pluginDataDir}.
 * @returns {{ dir: string, created: boolean, subdirs: string[] }}
 */
export function ensureDataDir(dir = pluginDataDir()) {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true });
  ensureDirs(dir, DATA_SUBDIRS);
  ensureDirs(dir, ["trash"]);
  cleanTmp(dir);
  return { dir, created: !existed, subdirs: ["trash", ".tmp"] };
}

/**
 * Remove every `*.tmp`-`*` file under `<dir>/.tmp`. Atomic writes create their
 * temporary file there and rename it into place; anything still present at
 * startup is a leftover from a crash and can never be referenced.
 *
 * @param {string} dir
 * @returns {number} number of removed entries
 */
export function cleanTmp(dir) {
  const tmp = join(dir, ".tmp");
  if (!existsSync(tmp)) return 0;
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(tmp, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    try {
      rmSync(join(tmp, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      /* a live process may still hold it; retried on the next start */
    }
  }
  return removed;
}

/**
 * Path helpers for everything under the data directory.
 *
 * @param {string} [dir]
 */
export function dataPaths(dir = pluginDataDir()) {
  return {
    root: dir,
    tree: join(dir, "tree.v1.json"),
    annotations: join(dir, "annotations.v1.json"),
    settings: join(dir, "settings.v1.json"),
    trashIndex: join(dir, "trash", "index.v1.json"),
    trashDir: join(dir, "trash"),
    tmpDir: join(dir, ".tmp"),
  };
}
