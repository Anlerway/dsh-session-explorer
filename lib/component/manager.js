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

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
} from "./layout.js";
import { downloadAsset, partSize } from "./downloader.js";
import { extractZip, exists, freeBytes, manifestOf, publishRuntime, verifyZip, directorySize } from "./install.js";
import { createProgressWriter, emptyState, normalizeState, readState, writeState } from "./state.js";

/** One hour is far longer than a 110 MB download over any usable link. */
const INSTALL_TIMEOUT_MS = 60 * 60 * 1000;

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
   * Reconcile the stored state with the disk.
   *
   * A `ready` record whose files are gone is `absent` again (someone deleted the
   * directory by hand); an `absent` record whose files exist — e.g. a runtime
   * copied in from another machine — becomes `ready`. This is the only place
   * readiness is decided.
   */
  async function reconcile() {
    const raw = await readState(paths.state);
    const markerOk = await exists(paths.marker);
    const binaryOk = await exists(paths.binary);
    if (markerOk && binaryOk) {
      if (raw.phase !== "ready") {
        state = { ...raw, phase: "ready", electronVersion: ELECTRON_VERSION, receivedBytes: 0, totalBytes: 0, error: null };
      } else state = raw;
      return state;
    }
    if (raw.phase === "ready") {
      // The record says ready but the bytes are gone.
      state = { ...raw, phase: "absent", electronVersion: null, error: null };
      await writeState(paths.state, dataDir, state).catch(() => {});
      return state;
    }
    state = raw;
    return state;
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
      const sizeBytes = current.phase === "ready" ? await directorySize(paths.runtime).catch(() => 0) : 0;
      const partial = current.phase === "downloading" || current.phase === "error" ? await partSize(paths.part) : 0;
      return {
        ...current,
        // A download interrupted by a restart reports what it already has, so
        // the retry button can say 续传 instead of 重新下载.
        receivedBytes: current.phase === "downloading" || current.phase === "error" ? partial : current.receivedBytes,
        sizeBytes,
        approxDownloadBytes: RUNTIME_SIZE_APPROX.downloadBytes,
        approxDiskBytes: RUNTIME_SIZE_APPROX.diskBytes,
        canRemove: current.phase === "ready",
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

        // Pre-flight the disk: a 110 MB zip plus a 370 MB extraction needs
        // roughly twice the archive plus headroom. Failing here is far kinder
        // than failing at 90%.
        await mkdir(paths.downloadDir, { recursive: true });
        const free = await freeBytes(dataDir);
        const needed = RUNTIME_SIZE_APPROX.downloadBytes * 2.2 + 500 * 1024 * 1024;
        if (free !== null && free < needed) {
          throw codedError("component-disk-full", `not enough free space: need about ${Math.round(needed / 1024 / 1024)} MB`);
        }

        // MIRRORS are directory prefixes; the asset name has to be appended.
        const mirrors = mirrorOverride ?? MIRRORS;
        const ordered = source === "github" ? [...mirrors].reverse() : [...mirrors];
        const urls = ordered.map((mirror) => (mirror.endsWith("/") ? mirror : `${mirror}/`) + asset);
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
          await rm(paths.staging, { recursive: true, force: true });
          await extractZip(paths.part, paths.staging);
          if (!(await exists(binaryPathOf(paths.staging)))) {
            throw codedError("component-extract-failed", "the archive did not contain the Electron binary");
          }
          // Publish writes the marker into the staging directory before the
          // rename, so the live runtime is never visible without one.
          await publishRuntime(paths.staging, paths.runtime, paths.marker);
          await writeFile(
            paths.manifest,
            `${JSON.stringify(manifestOf({ source: result.url, digest, sizeBytes: result.receivedBytes }), null, 2)}\n`,
            "utf8",
          );
          await rm(paths.part, { force: true });
          await rm(paths.partMeta, { force: true });

          await progress.flush({
            ...state,
            phase: "ready",
            electronVersion: ELECTRON_VERSION,
            receivedBytes: 0,
            totalBytes: 0,
            source,
            error: null,
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
        await rm(paths.root, { recursive: true, force: true });
        state = emptyState();
        await writeState(paths.state, dataDir, state).catch(() => {});
        emit();
        return this.status();
      });
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
