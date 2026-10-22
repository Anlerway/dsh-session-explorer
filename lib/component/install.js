/**
 * dsh-session-explorer — verify and install the extracted runtime.
 *
 * Two properties matter more than speed:
 *
 *   1. **Never publish an unverified runtime.** The SHA-256 check runs on the
 *      completed zip before anything is extracted, so a truncated, mirrored or
 *      tampered download can never become an executable.
 *   2. **Never destroy a working install with a failed one.** Extraction goes
 *      into `runtime.staging`; only after the marker is written is the staging
 *      directory renamed over `runtime`. A crash leaves staging behind and the
 *      previous runtime intact.
 */

import { createHash } from "node:crypto";
import { access, chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { COMPONENT_VERSION, ELECTRON_VERSION } from "./layout.js";
import { abortError } from "./downloader.js";

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * SHA-256 of a file, streamed so a 110 MB zip does not have to fit in memory.
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

/**
 * Compare two hex digests without leaking their position through timing.
 *
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
export function sameDigest(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < actual.length; index += 1) {
    diff |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * Verify the downloaded zip against the pinned digest.
 *
 * @param {string} zip
 * @param {string} expected
 * @returns {Promise<string>} the actual digest, for the manifest
 */
export async function verifyZip(zip, expected) {
  const actual = await sha256File(zip);
  if (!sameDigest(actual, expected)) {
    const error = new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
    error.code = "component-checksum";
    throw error;
  }
  return actual;
}

/**
 * Extract a zip into `dest`.
 *
 * Windows ships bsdtar as \`%SystemRoot%\\System32\\tar.exe\`, which reads zip
 * natively and is far faster than PowerShell's \`Expand-Archive\`. It must be
 * addressed by **absolute path**: \`tar\` on PATH is frequently Git's bsdtar,
 * which does not support zip and fails with "This does not look like a tar
 * archive". PowerShell remains as a fallback for a stripped Windows install.
 *
 * POSIX uses \`unzip\`; a pure-JS unzip would mean shipping a zip parser, and the
 * plugin's zero-dependency rule is worth more than that.
 *
 * @param {string} zip
 * @param {string} dest
 * @param {(count: { files: number }) => void} [onProgress] fires once when done
 * @param {{ signal?: AbortSignal }} [options] `signal` kills the extractor, so a
 *   cancel during the (long) unpack step is not ignored
 */
export async function extractZip(zip, dest, onProgress, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw abortError();
  await mkdir(dest, { recursive: true });
  /** @type {Array<{ command: string, args: string[] }>} */
  const attempts = [];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    attempts.push({
      command: join(systemRoot, "System32", "tar.exe"),
      args: ["-xf", zip, "-C", dest],
    });
    attempts.push({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${zip.replaceAll("'", "''")}' -DestinationPath '${dest.replaceAll("'", "''")}' -Force`,
      ],
    });
  } else {
    attempts.push({
      command: process.platform === "darwin" ? "/usr/bin/unzip" : "unzip",
      args: ["-q", "-o", zip, "-d", dest],
    });
  }

  /** @type {Error | null} */
  let lastError = null;
  for (const attempt of attempts) {
    try {
      await spawnChecked(attempt.command, attempt.args, { signal });
      onProgress?.({ files: 1 });
      return;
    } catch (error) {
      lastError = error;
      // A partial extraction from a failed attempt must not be published.
      await removeTree(dest).catch(() => {});
      await mkdir(dest, { recursive: true });
    }
  }
  const wrapped = new Error(`extraction failed: ${lastError?.message ?? "no extractor worked"}`);
  wrapped.code = "component-extract-failed";
  wrapped.cause = lastError;
  throw wrapped;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
function spawnChecked(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const onAbort = () => {
      // `kill()` is best effort: the extractor may already be gone.
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("exit", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? "unknown"}`));
    });
  });
}

/**
 * Publish an extracted staging directory as the live runtime.
 *
 * The old runtime is moved aside first, then deleted after the new one is in
 * place: a rename over a non-empty directory is not portable, and deleting
 * first would leave the user with nothing if the rename failed.
 *
 * @param {string} staging
 * @param {string} runtime
 * @param {string} marker
 */
export async function publishRuntime(staging, runtime, marker) {
  const backup = `${runtime}.old-${Date.now().toString(36)}`;
  await chmod(staging, 0o755).catch(() => {});
  await mkdir(join(marker, ".."), { recursive: true }).catch(() => {});
  if (!(await exists(marker))) {
    // The marker belongs inside the published directory: write it there before
    // the rename so a reader can never see a runtime without one.
    await writeFile(marker.replace(runtime, staging), `${ELECTRON_VERSION}\n`, "utf8").catch(() => {});
  }
  const hadRuntime = await exists(runtime);
  if (hadRuntime) await rename(runtime, backup);
  try {
    await rename(staging, runtime);
  } catch (error) {
    if (hadRuntime) await rename(backup, runtime).catch(() => {});
    throw error;
  }
  // A leftover backup is harmless and may be locked for a moment; a failure
  // here must not fail an otherwise successful install.
  if (hadRuntime) await removeTree(backup).catch(() => {});
}

/**
 * Remove a directory, tolerating files Windows will not release.
 *
 * Two different things can block a delete, and they deserve different answers:
 *
 *   1. **Transient** (`EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY`): Defender's scanner,
 *      the search indexer, a helper that has not fully exited. Retrying a few
 *      times clears it, so the call does that first.
 *   2. **Permanent**: `resources/default_app.asar`. Electron ships that 111 KB
 *      app bundle in every release zip; it is never used by this plugin (the
 *      helper is started with an explicit `main.cjs`), but once anything has
 *      loaded it, Windows keeps the handle for the life of the process. No
 *      amount of retrying helps, and it is not worth failing an uninstall over.
 *
 * So the delete is best effort: everything else in the tree goes, the known
 * unusable bundle is left behind, and the caller is told which paths survived.
 * A leftover 111 KB file is not a reason to make a user re-download 150 MB.
 *
 * @param {string} dir
 * @param {{ attempts?: number, delayMs?: number }} [options]
 * @returns {Promise<{ removed: boolean, leftover: string[] }>}
 */
export async function removeTree(dir, options = {}) {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 120;
  /** @type {any} */
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 0 });
      return { removed: true, leftover: [] };
    } catch (error) {
      lastError = error;
      const code = /** @type {any} */ (error)?.code;
      const transient = code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY";
      if (!transient) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1) + Math.floor(Math.random() * 60)));
    }
  }

  // Still blocked: delete what can be deleted, then report what remains. This
  // turns "uninstall fails with EBUSY" into "uninstall leaves one 111 KB file".
  const leftover = await removeChildren(dir);
  if (leftover.length === 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { removed: !(await pathExists(dir)), leftover: [] };
  }
  return { removed: false, leftover };
}

/**
 * Delete every entry inside `dir` that can be deleted.
 *
 * @param {string} dir
 * @returns {Promise<string[]>} absolute paths that survived
 */
async function removeChildren(dir) {
  /** @type {string[]} */
  const survivors = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return survivors;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await removeTree(child, { attempts: 2, delayMs: 100 });
      if (!nested.removed) survivors.push(...nested.leftover);
      continue;
    }
    try {
      await rm(child, { force: true });
    } catch {
      survivors.push(child);
    }
  }
  return survivors;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the manifest written after a successful install.
 *
 * @param {{ source: string, digest: string, sizeBytes: number }} input
 */
export function manifestOf(input) {
  return {
    version: COMPONENT_VERSION,
    electronVersion: ELECTRON_VERSION,
    sha256: input.digest,
    sizeBytes: input.sizeBytes,
    source: input.source,
    installedAt: Date.now(),
  };
}

/**
 * Size of a directory tree, for the settings page's "370 MB" line.
 *
 * Best effort: an unreadable entry is skipped rather than failing the summary.
 *
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function directorySize(dir) {
  /** @type {string[]} */
  const pending = [dir];
  let total = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await import("node:fs/promises").then((fs) => fs.readdir(current, { withFileTypes: true }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else {
        try {
          total += (await stat(child)).size;
        } catch {
          /* a file that vanished mid-walk contributes nothing */
        }
      }
    }
  }
  return total;
}

/**
 * Free bytes on the volume holding `dir`.
 *
 * `statfs` exists from Node 18.15; on a runtime without it (or a filesystem that
 * does not report it) this returns `null` and the caller skips the pre-flight
 * rather than refusing a download it cannot reason about.
 *
 * @param {string} dir
 * @returns {Promise<number | null>}
 */
export async function freeBytes(dir) {
  try {
    const fs = await import("node:fs/promises");
    if (typeof fs.statfs !== "function") return null;
    const info = await fs.statfs(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}
