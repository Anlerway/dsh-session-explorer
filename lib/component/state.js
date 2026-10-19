/**
 * dsh-session-explorer — component lifecycle state.
 *
 * `state.v1.json` is the one durable answer to "what is the component doing?".
 * It survives a restart, so a download interrupted by a crash resumes with the
 * bytes it already has instead of starting over, and the settings page can say
 * "上次下载中断" instead of pretending nothing happened.
 *
 * Phases:
 *
 *   absent ──install──▶ downloading ──▶ verifying ──▶ extracting ──▶ ready
 *      ▲                    │               │              │            │
 *      │                    ▼               ▼              ▼            │
 *      └──── remove ───── error ◀───────────┴──────────────┘            │
 *      └──────────────────────── remove ◀──────────────────────────────┘
 *
 * Only `ready` authorises `openMode: "detached"`. `error` keeps its message so
 * the retry button can explain what failed.
 */

import { readFile, rename, writeFile } from "node:fs/promises";

import { COMPONENT_VERSION } from "./layout.js";

/** Every phase the state machine may be in. */
export const PHASES = Object.freeze([
  "absent",
  "downloading",
  "verifying",
  "extracting",
  "ready",
  "error",
]);

/**
 * A fresh record. `absent` is the normal state: the plugin is fully usable
 * without the component.
 *
 * @returns {object}
 */
export function emptyState() {
  return {
    version: COMPONENT_VERSION,
    phase: "absent",
    electronVersion: null,
    receivedBytes: 0,
    totalBytes: 0,
    source: null,
    error: null,
    updatedAt: 0,
  };
}

/**
 * Coerce whatever is on disk into a complete, type-correct record.
 *
 * An unknown phase degrades to `absent` rather than rendering a state the UI
 * has no branch for; the file is ours, but a hand-edited or half-written
 * document must never break the settings page.
 *
 * @param {any} raw
 * @returns {object}
 */
export function normalizeState(raw) {
  const out = emptyState();
  if (!raw || typeof raw !== "object") return out;
  if (PHASES.includes(raw.phase)) out.phase = raw.phase;
  if (typeof raw.electronVersion === "string") out.electronVersion = raw.electronVersion;
  if (Number.isFinite(raw.receivedBytes) && raw.receivedBytes >= 0) out.receivedBytes = raw.receivedBytes;
  if (Number.isFinite(raw.totalBytes) && raw.totalBytes >= 0) out.totalBytes = raw.totalBytes;
  if (typeof raw.source === "string") out.source = raw.source;
  if (typeof raw.error === "string") out.error = raw.error;
  if (Number.isFinite(raw.updatedAt)) out.updatedAt = raw.updatedAt;
  return out;
}

/**
 * Read the stored state. A missing or unreadable file is `absent`, not an error:
 * an install has not started yet, which is exactly what `absent` means.
 *
 * @param {string} file
 * @returns {Promise<object>}
 */
export async function readState(file) {
  try {
    return normalizeState(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return emptyState();
  }
}

/**
 * Write the state atomically (temp file + rename).
 *
 * @param {string} file
 * @param {string} tmpDir
 * @param {object} state
 * @returns {Promise<object>} the record as written
 */
export async function writeState(file, tmpDir, state) {
  const next = { ...normalizeState(state), updatedAt: Date.now() };
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try {
    await rename(temp, file);
  } catch (error) {
    await writeFile(temp, "").catch(() => {});
    throw error;
  }
  return next;
}

/**
 * Throttle disk writes during a download.
 *
 * A 110 MB download at 3 MB/s produces hundreds of progress callbacks a second;
 * writing the state file for each one would be thousands of tiny writes. The
 * throttle keeps at most one write per `intervalMs` and always persists the
 * final value through {@link flush}.
 *
 * @param {{ write: (state: object) => Promise<object>, intervalMs?: number }} options
 */
export function createProgressWriter(options) {
  const intervalMs = options.intervalMs ?? 1000;
  let lastWrite = 0;
  /** @type {object | null} */
  let pending = null;
  let queue = Promise.resolve();

  const run = (state) => {
    queue = queue.then(() => options.write(state)).catch(() => {});
    return queue;
  };

  return {
    /** Persist if enough time passed; otherwise remember the newest value. */
    push(state) {
      const now = Date.now();
      if (now - lastWrite < intervalMs) {
        pending = state;
        return queue;
      }
      lastWrite = now;
      pending = null;
      return run(state);
    },
    /** Persist whatever is pending right now (phase changes must not be lost). */
    flush(state) {
      pending = null;
      lastWrite = Date.now();
      return run(state ?? pending);
    },
  };
}
