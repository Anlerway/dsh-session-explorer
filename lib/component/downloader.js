/**
 * dsh-session-explorer — streaming download with resume, mirrors and progress.
 *
 * The transport is **curl**, not `fetch`, and that is deliberate: inside the DSH
 * host process `fetch` fails on these release URLs (the bundled undici rejects
 * the request while the same URL works from a plain Node script). curl also
 * gives resume (`-C -`),
 * redirects, per-mirror timeouts and a hard speed floor for free.
 *
 * Progress comes from polling the partial file's size rather than parsing curl's
 * progress bar: the file is the source of truth, it works identically for a
 * resume, and it needs no terminal escape-sequence parsing.
 *
 * Behaviour worth pinning:
 *
 *   - A resume is only attempted for the same URL as the recorded `.part.json`;
 *     a different mirror starts from zero, because appending two different byte
 *     streams produces an archive that fails its checksum instead of a clean
 *     retry.
 *   - A server that ignores `Range` makes curl fail the resume; that failure
 *     truncates and re-runs once without `-C -` rather than leaving a mixed file.
 *   - A missing `content-length` leaves `totalBytes = 0`, which the UI renders as
 *     an indeterminate bar. It never becomes `NaN` or a fake 100%.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * @typedef {object} DownloadResult
 * @property {number} receivedBytes
 * @property {number} totalBytes
 * @property {string} url the mirror that finished
 * @property {boolean} switched whether a previous mirror failed first
 */

/** How often the partial file's size is sampled for progress, in milliseconds. */
const PROGRESS_INTERVAL_MS = 400;

/**
 * Security/robustness flags shared by every curl invocation.
 *
 * `--proto "=https"` pins every real mirror to TLS. A loopback URL is exempt so
 * the test suite can serve a fixture from a local HTTP server; nothing in the
 * plugin's own configuration can produce one.
 *
 * @param {string} [url]
 * @returns {string[]}
 */
function curlFlags(url = "") {
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
  return [
    "-f",
    "-L",
    "-sS",
    ...(loopback ? [] : ["--proto", "=https", "--proto-redir", "=https"]),
    // Windows' schannel aborts when a revocation check cannot complete, which is
    // common behind a corporate proxy. The archive is checksum-verified anyway.
    ...(process.platform === "win32" ? ["--ssl-no-revoke"] : []),
  ];
}

/**
 * Read the resume metadata for a partial download.
 *
 * @param {string} file
 * @returns {Promise<{ url?: string, etag?: string, received?: number, totalBytes?: number } | null>}
 */
export async function readPartMeta(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @param {object} meta
 */
export async function writePartMeta(file, meta) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

/**
 * How many bytes a `.part` file already holds.
 *
 * @param {string} file
 * @returns {Promise<number>}
 */
export async function partSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * Run one command to completion, capturing its tail for the error message.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
    });
    const out = [];
    const err = [];
    child.stdout?.on("data", (chunk) => out.push(chunk));
    child.stderr?.on("data", (chunk) => {
      err.push(chunk);
      // Keep the tail bounded: a failing mirror can be chatty.
      if (err.length > 40) err.shift();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8").trim(),
      });
    });
  });
}

/**
 * Ask a mirror how large the asset is, so the bar can show a percentage.
 *
 * A failure here is not fatal: the download still runs, it just reports an
 * indeterminate bar. That is strictly better than refusing to download because
 * a HEAD request was refused.
 *
 * @param {string} url
 * @returns {Promise<number>} 0 when unknown
 */
async function probeTotal(url) {
  try {
    const { code, stdout } = await run("curl", [...curlFlags(url), "-I", "-m", "15", url]);
    if (code !== 0) return 0;
    // Follow redirects can produce several header blocks; the last one wins.
    const matches = [...stdout.matchAll(/^content-length:\s*(\d+)\s*$/gim)];
    const last = matches.at(-1);
    return last ? Number(last[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Download one asset with curl, reporting progress from the file size.
 *
 * @param {object} options
 * @param {string} url
 * @param {string} part destination for the body
 * @param {number} totalBytes 0 when unknown
 * @param {boolean} resumable
 * @param {(progress: { receivedBytes: number, totalBytes: number }) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<number>} bytes written
 */
async function curlDownload({ url, part, totalBytes, resumable, onProgress, signal }) {
  await mkdir(dirname(part), { recursive: true });
  const args = [
    ...curlFlags(url),
    "--retry",
    "2",
    "--retry-delay",
    "1",
    "--connect-timeout",
    "10",
    // Abandon a mirror that stops moving instead of hanging the install.
    "--speed-limit",
    "20000",
    "--speed-time",
    "30",
    "-o",
    part,
    ...(resumable ? ["-C", "-"] : []),
    url,
  ];

  const child = spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, signal });
  const stderrChunks = [];
  child.stderr?.on("data", (chunk) => {
    stderrChunks.push(chunk);
    if (stderrChunks.length > 20) stderrChunks.shift();
  });
  const stderr = () => Buffer.concat(stderrChunks).toString("utf8").trim();
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const size = await partSize(part);
    onProgress?.({ receivedBytes: size, totalBytes });
  };
  const timer = setInterval(() => {
    void tick();
  }, PROGRESS_INTERVAL_MS);
  timer.unref?.();

  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? -1));
  }).finally(() => {
    stopped = true;
    clearInterval(timer);
  });

  const written = await partSize(part);
  onProgress?.({ receivedBytes: written, totalBytes });

  if (code !== 0) {
    const error = new Error(`curl exited with ${code}: ${stderr().slice(-300) || "no output"}`);
    error.code = "component-download-failed";
    error.exitCode = code;
    throw error;
  }
  return written;
}

/**
 * Download one asset, resuming when the partial file belongs to the same URL.
 *
 * @param {object} options
 * @param {string[]} options.urls mirrors in preference order
 * @param {string} options.part destination for the body
 * @param {string} options.partMeta metadata sidecar
 * @param {(progress: { receivedBytes: number, totalBytes: number, url: string }) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<DownloadResult>}
 */
export async function downloadAsset({ urls, part, partMeta, onProgress, signal }) {
  await mkdir(dirname(part), { recursive: true });
  const previous = await readPartMeta(partMeta);
  let switched = false;
  let lastError = null;

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    if (signal?.aborted) throw abortError();
    // Only a partial file from this same mirror may be resumed, and only when
    // the sidecar still describes it. Another mirror's bytes are a different
    // stream; appending them is how a resume produces a corrupt archive.
    const sameMirror = previous?.url === url;
    const existing = sameMirror ? await partSize(part) : 0;
    const resumable = sameMirror && existing > 0;
    if (!sameMirror && existing > 0) await rm(part, { force: true });
    const totalBytes = await probeTotal(url);

    try {
      let written;
      try {
        written = await curlDownload({
          url,
          part,
          totalBytes,
          resumable,
          signal,
          onProgress: (progress) => onProgress?.({ ...progress, url }),
        });
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (!resumable) throw error;
        // "Cannot resume" means the mirror served the whole file for a ranged
        // request, or the partial file is gone. Start this mirror clean.
        await rm(part, { force: true });
        written = await curlDownload({
          url,
          part,
          totalBytes,
          resumable: false,
          signal,
          onProgress: (progress) => onProgress?.({ ...progress, url }),
        });
      }

      await writePartMeta(partMeta, { url, received: written, totalBytes });
      return { receivedBytes: written, totalBytes, url, switched };
    } catch (error) {
      lastError = error;
      switched = index < urls.length - 1;
      if (!switched) break;
    }
  }

  const error = new Error(`download failed: ${lastError?.message ?? "no mirror answered"}`);
  error.code = "component-download-failed";
  error.cause = lastError;
  throw error;
}

/**
 * @returns {Error & { code: string }}
 */
function abortError() {
  const error = new Error("download cancelled");
  error.code = "component-cancelled";
  return error;
}
