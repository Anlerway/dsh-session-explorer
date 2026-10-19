/**
 * dsh-session-explorer — the browser-component state machine.
 *
 * One instance per plugin instance. It owns the component directory, the
 * single-flight lock and the persisted state; the HTTP routes and the settings
 * page are thin shells over this class.
 *
 * The lock matters: `install`, `cancel` and `remove` all mutate the same
 * directory, and two concurrent clicks would otherwise interleave a delete with
 * an extract. Every mutation goes through `run()`, which rejects with
 * `component-busy` instead of queueing — a user who clicked twice wants the
 * second click ignored, not executed later.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { codedError } from "../store/sidecar.js";
import {
  ELECTRON_VERSION,
  MIRRORS,
  PINNED_SHA256,
  RUNTIME_SIZE_APPROX,
  assetName,
  binaryPath,
  componentPaths,
  runtimePaths,
} from "./layout.js";
import { downloadAsset, partSize } from "./downloader.js";
import { extractZip, exists, freeBytes, manifestOf, publishRuntime, removeTree, verifyZip, directorySize } from "./install.js";
import { createProgressWriter, emptyState, normalizeState, readState, writeState } from "./state.js";

/** One hour is far longer than a 110 MB download over any usable link. */
const INSTALL_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * A short, collision-resistant stamp for a runtime directory name.
 *
 * Lowercase hex so it survives the `^runtime-[a-z0-9-]+$` check in state.js.
 *
 * @returns {string}
 */
function newRuntimeStamp() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * @param {string} dataDir
 * @param {{ ctx?: any }} [options]
 */
export function createComponentManager(dataDir, options = {}) {
  const paths = componentPaths(dataDir);
  const ctx = options.ctx ?? null;
  // Injection points for tests: a local mirror that serves a tiny fixture zip.
  // Production always uses the pinned release; nothing in the settings path can
  // reach these.
  const mirrorOverride = Array.isArray(options.mirrors) && options.mirrors.length > 0 ? options.mirrors : null;
  const pinnedOverride = options.pinned && typeof options.pinned === "object" ? options.pinned : null;
  /** @type {Promise<any> | null} */
  let busy = null;
  let controller = null;
  /** @type {any} */
  let state = emptyState();
  /** @type {Set<(state: object) => void>} */
  const listeners = new Set();

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener({ ...state });
      } catch {
        /* a broken subscriber must not stop the state machine */
      }
    }
  };

  const persist = (next) => {
    state = { ...next };
    emit();
    return writeState(paths.state, dataDir, state).catch(() => state);
  };

  const progress = createProgressWriter({
    intervalMs: 1000,
    write: (next) => persist(next),
  });

  /**
   * Run one mutation under the lock.
   *
   * @param {() => Promise<any>} task
   */
  async function run(task) {
    if (busy) throw codedError("component-busy", "the browser component is already being changed");
    busy = (async () => task())();
    try {
      return await busy;
    } finally {
      busy = null;
    }
  }

  /**
   * The runtime directory the current state points at.
   *
   * A record without `runtimeName` predates versioned runtimes; it is treated as
   * the legacy `runtime/` so an existing install keeps working across the
   * upgrade instead of being reported missing.
   *
   * @param {any} snapshot
   * @returns {ReturnType<typeof componentPaths>}
   */
  function pathsFor(snapshot) {
    if (typeof snapshot?.runtimeName === "string" && snapshot.runtimeName) {
      return runtimePaths(dataDir, snapshot.runtimeName);
    }
    return paths;
  }

  /**
   * Reconcile the stored state with the disk.
   *
   * A `ready` record whose marker or binary is gone is `absent` again (someone
   * deleted the directory, or a half-finished remove dropped the marker); a
   * record whose runtime is intact is `ready`. This is the only place readiness
   * is decided.
   *
   * A leftover runtime directory with no state pointing at it is *not* adopted:
   * it is debris from a failed or superseded install, and adopting it would let
   * an unverified tree become the live runtime.
   */
  async function reconcile() {
    const raw = await readState(paths.state);
    const active = pathsFor(raw);
    const markerOk = await exists(active.marker);
    const binaryOk = await exists(active.binary);
    if (markerOk && binaryOk) {
      if (raw.phase !== "ready") {
        state = {
          ...raw,
          phase: "ready",
          electronVersion: ELECTRON_VERSION,
          receivedBytes: 0,
          totalBytes: 0,
          error: null,
          runtimeName: raw.runtimeName ?? null,
        };
      } else state = raw;
      return state;
    }
    if (raw.phase === "ready") {
      // The record says ready but the bytes are gone.
      state = { ...raw, phase: "absent", electronVersion: null, error: null, runtimeName: null };
      await writeState(paths.state, dataDir, state).catch(() => {});
      return state;
    }
    state = raw;
    return state;
  }

  /**
   * Delete runtime directories no state points at.
   *
   * Best effort by design: a directory Windows still has a handle on is skipped
   * and retried on the next call. This is how a versioned runtime keeps the
   * install path working even when the previous one cannot be removed.
   *
   * @param {string | null} keep
   */
  async function sweepRuntimes(keep) {
    let entries;
    try {
      entries = await readdir(paths.root, { withFileTypes: true });
    } catch {
      return;
    }
    /** @type {string[]} */
    const blocked = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^runtime(-[a-z0-9-]+)?$/.test(entry.name)) continue;
      if (entry.name === keep) continue;
      try {
        await removeTree(join(paths.root, entry.name), { attempts: 2, delayMs: 120 });
      } catch {
        blocked.push(join(paths.root, entry.name));
      }
    }
    return blocked;
  }

  /**
   * Every runtime directory currently on disk.
   *
   * @returns {Promise<string[]>}
   */
  async function findRuntimes() {
    try {
      const entries = await readdir(paths.root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && /^runtime(-[a-z0-9-]+)?$/.test(entry.name))
        .map((entry) => join(paths.root, entry.name));
    } catch {
      return [];
    }
  }

  /**
   * The pending-cleanup list.
   *
   * Uninstalling cannot always delete the runtime: DSH keeps
   * `resources/default_app.asar` open from whatever runtime directory it was
   * pointed at, and Windows refuses to delete an open file. Rather than ask the
   * user to run a script, the leftover paths are recorded here and swept on the
   * next start — by then the handles are gone, because the process that held
   * them is the one starting up.
   *
   * @returns {Promise<string[]>}
   */
  async function readPending() {
    try {
      const parsed = JSON.parse(await readFile(paths.pending, "utf8"));
      return Array.isArray(parsed?.paths) ? parsed.paths.filter((value) => typeof value === "string") : [];
    } catch {
      return [];
    }
  }

  /**
   * @param {string[]} list
   */
  async function writePending(list) {
    await mkdir(paths.root, { recursive: true });
    if (list.length === 0) {
      await rm(paths.pending, { force: true }).catch(() => {});
      return;
    }
    const temp = `${paths.pending}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ paths: list }, null, 2)}\n`, "utf8");
    await rm(paths.pending, { force: true }).catch(() => {});
    await rename(temp, paths.pending);
  }

  /**
   * Delete what a previous uninstall could not, then forget it.
   *
   * Runs on every start, before anything else looks at the component. A path
   * that still cannot be deleted stays on the list for the next start; nothing
   * here throws, because a leftover directory must never stop the plugin from
   * serving.
   *
   * @returns {Promise<{ removed: string[], remaining: string[] }>}
   */
  async function sweepPending() {
    const pending = await readPending();
    if (pending.length === 0) return { removed: [], remaining: [] };
    /** @type {string[]} */
    const remaining = [];
    /** @type {string[]} */
    const removed = [];
    for (const target of pending) {
      try {
        await removeTree(target, { attempts: 3, delayMs: 200 });
        removed.push(target);
      } catch {
        remaining.push(target);
      }
    }
    await writePending(remaining).catch(() => {});
    return { removed, remaining };
  }

  /**
   * A runtime directory that is complete and can be adopted without downloading.
   *
   * Uninstalling the component and installing it again must not cost 150 MB:
   * the bytes are still on disk whenever the delete was blocked, and they are
   * exactly the runtime this build pins. The marker is the proof that the tree
   * was fully published, and the binary's presence is the proof it is usable.
   *
   * @returns {Promise<string | null>} the runtime directory name
   */
  async function adoptableRuntime() {
    for (const dir of await findRuntimes()) {
      const name = dir.slice(paths.root.length + 1);
      const candidate = runtimePaths(dataDir, name);
      if ((await exists(candidate.marker)) && (await exists(candidate.binary))) return name;
    }
    return null;
  }

  return {
    paths,
    get dataDir() {
      return dataDir;
    },
    /** The last known state, without touching the disk. */
    get snapshot() {
      return { ...state };
    },
    /** Subscribe to state changes (the SSE route and the settings poller). */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * The payload every component route returns.
     *
     * @returns {Promise<object>}
     */
    async status() {
      const current = await reconcile();
      const active = pathsFor(current);
      const sizeBytes = current.phase === "ready" ? await directorySize(active.runtime).catch(() => 0) : 0;
      const partial = current.phase === "downloading" || current.phase === "error" ? await partSize(paths.part) : 0;
      const pending = await readPending();
      return {
        ...current,
        // A download interrupted by a restart reports what it already has, so
        // the retry button can say 续传 instead of 重新下载.
        receivedBytes: current.phase === "downloading" || current.phase === "error" ? partial : current.receivedBytes,
        sizeBytes,
        approxDownloadBytes: RUNTIME_SIZE_APPROX.downloadBytes,
        approxDiskBytes: RUNTIME_SIZE_APPROX.diskBytes,
        canRemove: current.phase === "ready",
        // Leftovers a previous uninstall could not delete. They are swept on
        // the next start; the UI only mentions them so the disk usage makes
        // sense.
        pendingCleanup: pending.length,
      };
    },

    /**
     * Install the runtime.
     *
     * @param {{ source?: "mirror" | "github" }} [input]
     * @returns {Promise<object>} the final status
     */
    async install(input = {}) {
      return run(async () => {
        await reconcile();
        if (state.phase === "ready") return this.status();

        const source = input.source === "github" ? "github" : "mirror";
        const asset = assetName();
        const digest = pinnedOverride?.[asset] ?? PINNED_SHA256[asset];
        if (!digest) {
          throw codedError("component-download-failed", `no pinned checksum for ${asset}`);
        }

        // Before downloading anything, try to adopt a runtime that is already
        // on disk: an uninstall whose delete was blocked leaves a complete,
        // verified tree behind, and asking the user to download 150 MB again
        // for bytes that are still there would be indefensible.
        const adoptable = await adoptableRuntime();
        if (adoptable) {
          await progress.flush({
            ...state,
            phase: "ready",
            electronVersion: ELECTRON_VERSION,
            receivedBytes: 0,
            totalBytes: 0,
            source: "reuse",
            error: null,
            runtimeName: adoptable,
          });
          await sweepRuntimes(adoptable).catch(() => {});
          return this.status();
        }

        await mkdir(paths.downloadDir, { recursive: true });
        const free = await freeBytes(dataDir);
        const needed = RUNTIME_SIZE_APPROX.downloadBytes * 2.2 + 500 * 1024 * 1024;
        if (free !== null && free < needed) {
          throw codedError("component-disk-full", `not enough free space: need about ${Math.round(needed / 1024 / 1024)} MB`);
        }

        // MIRRORS are {id,label,prefix}; the asset name has to be appended.
        // A test may pass plain strings, so both shapes are accepted.
        const mirrors = mirrorOverride ?? MIRRORS;
        const ordered = source === "github" ? [...mirrors].reverse() : [...mirrors];
        const urls = ordered.map((mirror) => {
          const prefix = typeof mirror === "string" ? mirror : mirror.prefix;
          return (prefix.endsWith("/") ? prefix : `${prefix}/`) + asset;
        });
        controller = new AbortController();
        const timeout = setTimeout(() => controller?.abort(), INSTALL_TIMEOUT_MS);

        try {
          await progress.flush({
            ...state,
            phase: "downloading",
            electronVersion: ELECTRON_VERSION,
            source,
            error: null,
          });

          const result = await downloadAsset({
            urls,
            part: paths.part,
            partMeta: paths.partMeta,
            signal: controller.signal,
            onProgress: ({ receivedBytes, totalBytes }) => {
              progress.push({
                ...state,
                phase: "downloading",
                receivedBytes,
                totalBytes,
                source,
              });
            },
          });

          await progress.flush({
            ...state,
            phase: "verifying",
            receivedBytes: result.receivedBytes,
            totalBytes: result.totalBytes,
            source,
          });

          await verifyZip(paths.part, digest);

          await progress.flush({ ...state, phase: "extracting" });
          await removeTree(paths.staging);
          await extractZip(paths.part, paths.staging);
          if (!(await exists(binaryPathOf(paths.staging)))) {
            throw codedError("component-extract-failed", "the archive did not contain the Electron binary");
          }

          // Publish into a *fresh* runtime directory and point the state at it.
          // Overwriting a fixed path would need a rename over a directory that
          // Windows may have open (EPERM), and a failed rename would leave the
          // install half-applied. A new name always succeeds.
          const stamp = newRuntimeStamp();
          const published = runtimePaths(dataDir, `runtime-${stamp}`);
          await publishRuntime(paths.staging, published.runtime, published.marker);
          await writeFile(
            paths.manifest,
            `${JSON.stringify(manifestOf({ source: result.url, digest, sizeBytes: result.receivedBytes }), null, 2)}\n`,
            "utf8",
          );
          await rm(paths.part, { force: true });
          await rm(paths.partMeta, { force: true });

          // Old runtimes are swept now that the new one is live. Whatever cannot
          // be deleted (DSH holds `default_app.asar` open) goes on the pending
          // list and is retried on the next start instead of failing the install.
          const blocked = await sweepRuntimes(published.runtimeName);
          if (blocked && blocked.length > 0) {
            await writePending([...(await readPending()), ...blocked]).catch(() => {});
          }

          await progress.flush({
            ...state,
            phase: "ready",
            electronVersion: ELECTRON_VERSION,
            receivedBytes: 0,
            totalBytes: 0,
            source,
            error: null,
            runtimeName: published.runtimeName,
          });
          return this.status();
        } catch (error) {
          const code = /** @type {any} */ (error)?.code;
          if (code === "component-cancelled") {
            await progress.flush({ ...state, phase: "absent", error: null });
            return this.status();
          }
          await progress.flush({
            ...state,
            phase: "error",
            error: String(error?.message ?? error),
          });
          throw error;
        } finally {
          clearTimeout(timeout);
          controller = null;
        }
      });
    },

    /**
     * Cancel an in-flight install. The `.part` file is kept for a resume.
     *
     * @returns {Promise<object>}
     */
    async cancel() {
      controller?.abort();
      // The installer observes the abort and writes `absent` itself; this wait
      // only makes the HTTP response reflect the settled state.
      if (busy) await busy.catch(() => {});
      return this.status();
    },

    /**
     * Remove the component. Refuses while the detached helper is running.
     *
     * @param {{ closeHelper?: () => Promise<boolean> }} [input]
     * @returns {Promise<object>}
     */
    async remove(input = {}) {
      return run(async () => {
        await reconcile();
        if (typeof input.closeHelper === "function") {
          const closed = await input.closeHelper();
          if (!closed) throw codedError("component-in-use", "close the detached window before removing the component");
        }
        // Give the OS a moment to release the executable's file handles on
        // Windows; deleting a running binary fails with EBUSY.
        await new Promise((resolve) => setTimeout(resolve, 150));

        // The marker goes first. Whatever survives a locked file afterwards is
        // then provably not a usable runtime: the next status() reports
        // `absent`, the detached button greys out, and a fresh install is
        // allowed. Without this, one locked file could pin the component in
        // "ready" while its directory is half gone.
        const active = pathsFor(state);
        await rm(active.marker, { force: true }).catch(() => {});

        // A directory DSH itself has open cannot be deleted from inside DSH:
        // the desktop app keeps `resources/default_app.asar` of whatever runtime
        // it was pointed at. Uninstalling is still complete — the marker is gone
        // and the state is absent — but the bytes stay until the next start.
        //
        // Whatever survives is recorded as pending rather than handed to the
        // user as a script: the plugin sweeps it on the next start, when the
        // process that held the handles is the one starting up. No prompt, no
        // manual step, and no second 150 MB download — install() adopts a
        // complete runtime that is still on disk.
        /** @type {string[]} */
        const blocked = [];
        try {
          await removeTree(paths.root, { attempts: 2, delayMs: 150 });
        } catch {
          blocked.push(...(await findRuntimes()));
        }
        if (blocked.length > 0) {
          await writePending([...(await readPending()), ...blocked]).catch(() => {});
        }

        state = emptyState();
        await writeState(paths.state, dataDir, state).catch(() => {});
        emit();
        return { ...(await this.status()), leftover: blocked.length > 0 };
      });
    },

    /**
     * Start-up maintenance: delete what a previous uninstall could not.
     *
     * Called once when the plugin loads, before the first status read. A
     * leftover runtime is retried here because the process that held it open
     * (DSH itself, via `default_app.asar`) is no longer the same one that
     * created the handle — on Windows a restart is exactly what releases it.
     *
     * Never throws: a component directory that cannot be cleaned must not stop
     * the plugin from serving sessions.
     *
     * @returns {Promise<{ removed: string[], remaining: string[] }>}
     */
    async sweep() {
      try {
        return await sweepPending();
      } catch {
        return { removed: [], remaining: [] };
      }
    },

    /** Reload from disk (after a migration moved the data directory). */
    async refresh() {
      await reconcile();
      emit();
      return this.status();
    },

    /** Whether a detached window may be opened right now. */
    async isReady() {
      const current = await reconcile();
      return current.phase === "ready";
    },
  };

  /**
   * The binary path inside an arbitrary runtime directory.
   *
   * @param {string} dir
   * @returns {string}
   */
  function binaryPathOf(dir) {
    return binaryPath(dir);
  }
}

/** @type {Map<string, ReturnType<typeof createComponentManager>>} */
const managers = new Map();

/**
 * One manager per data directory, so the host routes and the detached launcher
 * observe the same state instead of racing two instances over one directory.
 *
 * @param {string} dataDir
 * @param {{ ctx?: any }} [options]
 */
export function componentManagerFor(dataDir, options = {}) {
  let manager = managers.get(dataDir);
  if (!manager) {
    manager = createComponentManager(dataDir, options);
    managers.set(dataDir, manager);
  }
  return manager;
}
