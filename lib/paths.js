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
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";

/** Env var that overrides the data directory (mainly for tests). */
export const DATA_DIR_ENV = "DSH_SE_DATA_DIR";

/** Default directory name under the user's home. */
export const DATA_DIR_NAME = ".dsh-session-explorer";

/** Sub-directories that must exist before the plugin serves anything. */
export const DATA_SUBDIRS = ["trash", ".tmp", "quarantine"];

/** Directory name (under the data directory) holding documents set aside as unreadable. */
export const QUARANTINE_DIR_NAME = "quarantine";

/**
 * The user's home directory as the rest of this file understands it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function homeOf(env = process.env) {
  return env?.HOME || env?.USERPROFILE || homedir();
}

/**
 * DSH's own data root (`~/.dsh`), the one directory this plugin must never own.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function dshRoot(env = process.env) {
  const configured = env?.DSH_HOME;
  if (typeof configured === "string" && configured.trim() !== "") return resolve(configured.trim());
  return join(homeOf(env), ".dsh");
}

/**
 * Is `child` strictly inside `parent`? Both are resolved first, so `..` in the
 * input cannot pretend otherwise.
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Compare two absolute paths the way the platform does.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function samePath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/**
 * Whether a path may be the plugin's data directory.
 *
 * Three refusals, all of them about blast radius rather than tidiness: a
 * filesystem root, DSH's own `~/.dsh` tree, and any *ancestor* of `~/.dsh` (the
 * home directory is the usual accident). Emptying the trash deletes the
 * payloads under the data directory recursively, so a data directory that
 * contains DSH's data turns "empty the trash" into "delete DSH".
 *
 * Every entry point that can *set* the location goes through this: the env
 * override, the recorded `dataDir.current`, a request body, and the migration
 * target.
 *
 * @param {string} dir
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isUsableDataDir(dir, env = process.env) {
  if (typeof dir !== "string" || dir.trim() === "") return false;
  const abs = resolve(dir.trim());
  const parsed = parse(abs);
  if (abs === parsed.root || parsed.base === "") return false;
  const dsh = dshRoot(env);
  if (samePath(abs, dsh)) return false;
  return !isInside(abs, dsh) && !isInside(dsh, abs);
}

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
  if (!isUsableDataDir(abs, env)) {
    console.warn(`[session-explorer] ${DATA_DIR_ENV} is not a usable data directory, ignoring:`, abs);
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
  cleanTmp(dir);
  return { dir, created: !existed, subdirs: [...DATA_SUBDIRS] };
}

/**
 * Clear leftover atomic-write temp files, and rescue anything a previous build
 * parked next to them.
 *
 * Only `*.tmp` files are atomic-write leftovers: their names carry the target
 * basename, the pid and random hex (`tree.v1.json.1234.abcd.tmp`), so a plain
 * `rm` of everything in `.tmp` is what deleted the quarantined documents this
 * plugin had deliberately set aside. Those (`*.corrupt-*`) are moved into
 * `quarantine/` instead, where nothing sweeps them.
 *
 * @param {string} dir
 * @returns {number} number of removed entries
 */
export function cleanTmp(dir) {
  const tmp = join(dir, ".tmp");
  if (!existsSync(tmp)) return 0;
  const quarantine = join(dir, QUARANTINE_DIR_NAME);
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(tmp, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const from = join(tmp, entry.name);
    if (entry.name.includes(".corrupt-")) {
      try {
        mkdirSync(quarantine, { recursive: true });
        renameSync(from, join(quarantine, entry.name));
      } catch {
        /* left in place; retried on the next start */
      }
      continue;
    }
    if (!entry.name.endsWith(".tmp")) continue;
    try {
      rmSync(from, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* a live process may still hold it; retried on the next start */
    }
  }
  return removed;
}

/** Name of the pointer file a moved-away directory carries. */
export const LOCATION_FILE = ".location";

/**
 * The location this plugin uses when nothing overrides it.
 *
 * `os.homedir()` is only the last resort: tests pass a fake environment, and on
 * Windows `USERPROFILE` is what actually decides where the home directory is.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultDataDir(env = process.env) {
  const home = env?.HOME || env?.USERPROFILE || homedir();
  return join(home, DATA_DIR_NAME);
}

/**
 * Follow `<dir>/.location` to the directory this one was migrated to.
 *
 * A directory that has been moved away is kept (mode `copy`) or deleted (mode
 * `move`). In the copy case the old tree is still on disk and a later start
 * would happily read the stale copy, so the migration leaves a pointer behind
 * and this function follows it. A chain is followed up to a small bound so a
 * hand-edited loop cannot hang the start-up.
 *
 * @param {string} dir
 * @returns {string} the directory to actually use
 */
export function followLocation(dir) {
  let current = dir;
  for (let hop = 0; hop < 8; hop += 1) {
    const next = readMovedTo(current);
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

/**
 * @param {string} dir
 * @returns {string | null}
 */
function readMovedTo(dir) {
  try {
    const text = readFileSync(join(dir, LOCATION_FILE), "utf8");
    const parsed = JSON.parse(text);
    const movedTo = parsed?.movedTo;
    if (typeof movedTo !== "string" || movedTo.trim() === "") return null;
    return resolve(movedTo.trim());
  } catch {
    return null;
  }
}

/**
 * The `dataDir.current` recorded in a directory's own settings document.
 *
 * This is the third level of the resolution order: the settings file is what a
 * migration rewrites, so reading it is how a later start finds the new home
 * even when the old directory has been deleted.
 *
 * @param {string} dir
 * @returns {string | null}
 */
function readStoredLocation(dir) {
  try {
    const text = readFileSync(join(dir, "settings.v1.json"), "utf8");
    const current = JSON.parse(text)?.dataDir?.current;
    if (typeof current !== "string" || current.trim() === "") return null;
    return resolve(current.trim());
  } catch {
    return null;
  }
}

/**
 * Resolve the data directory, honouring the three-level fallback:
 *
 *   1. `DSH_SE_DATA_DIR`            (tests, and an explicit override)
 *   2. `<default>/settings.v1.json` `dataDir.current`  (a completed migration)
 *   3. `<default>`                  (first run)
 *
 * The default directory's `.location` pointer is followed as well, so a
 * `copy` migration that left the old tree behind is not read twice.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDataDir(env = process.env) {
  const fallback = defaultDataDir(env);
  const fromEnv = env?.[DATA_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return pluginDataDir(env);

  const stored = readStoredLocation(fallback);
  if (stored) {
    // A recorded location is honoured only if it is still a place this plugin
    // may own: the settings file is plain JSON on disk, and a hand edit (or a
    // stale pointer from another machine) must not relocate the trash onto a
    // root or into DSH's own tree.
    if (isUsableDataDir(stored, env)) return stored;
    console.warn(`[session-explorer] recorded data directory is not usable, falling back:`, stored);
  }

  return followLocation(fallback);
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
    quarantine: join(dir, QUARANTINE_DIR_NAME),
  };
}
