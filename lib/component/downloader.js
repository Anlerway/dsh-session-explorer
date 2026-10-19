/**
 * dsh-session-explorer — streaming download with resume, mirrors and progress.
 *
 * The only reason this is hand-written instead of `fetch(...).arrayBuffer()` is
 * that a 110 MB download has to show progress, survive a dropped connection and
 * resume from where it stopped. `arrayBuffer()` gives none of the three.
 *
 * Behaviour worth pinning:
 *
 *   - `Range` is used only when a `.part.json` records the same URL and an
 *     ETag. A server that answers `200` to a ranged request (i.e. ignores the
 *     range) makes us truncate and start over rather than appending to a file
 *     with an unknown prefix — that is the one way to silently corrupt the zip.
 *   - A missing `content-length` leaves `totalBytes = 0`, which the UI renders
 *     as an indeterminate bar. It never becomes `NaN` or a fake 100%.
 *   - When a mirror fails, the *next* mirror restarts from zero and the caller
 *     is told (`switched: true`) so the copy can say 已切换下载源 rather than
 *     looking like the progress bar went backwards for no reason.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * @typedef {object} DownloadResult
 * @property {number} receivedBytes
 * @property {number} totalBytes
 * @property {string} url the mirror that finished
 * @property {boolean} switched whether a previous mirror failed first
 */

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
 * One HTTP request, following redirects.
 *
 * `fetch` is used directly: it is available in the Node versions DSH ships and
 * it follows redirects, which node:https does not do for free. The body is a
 * web stream, which {@link Readable.fromWeb} turns into a Node stream for
 * `pipeline`.
 *
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {AbortSignal} [signal]
 * @returns {Promise<Response>}
 */
async function request(url, headers, signal) {
  const response = await fetch(url, { headers, signal, redirect: "follow" });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} for ${url}`);
    error.code = "component-download-failed";
    error.status = response.status;
    throw error;
  }
  return response;
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
    let received = await partSize(part);
    // A partial file from another mirror has a different byte stream; appending
    // to it would produce a corrupt archive, so it is dropped.
    const resumable = previous?.url === url && typeof previous.etag === "string" && received > 0;
    const headers = { "user-agent": "dsh-session-explorer" };
    if (resumable) headers.range = `bytes=${received}-`;

    let response;
    try {
      response = await request(url, headers, signal);
    } catch (error) {
      lastError = error;
      switched = index < urls.length - 1;
      if (!switched) break;
      continue;
    }

    // 206 = the range was honoured; 200 = it was ignored, so start clean.
    const resumed = response.status === 206;
    if (!resumed) {
      received = 0;
      await rm(part, { force: true });
    }
    if (resumed && previous?.received !== received) {
      // The sidecar disagrees with the file on disk: trust the file, but drop
      // the stale metadata so a later resume cannot mix the two.
      await rm(partMeta, { force: true });
    }

    const length = Number(response.headers.get("content-length") ?? 0);
    const totalBytes = Number.isFinite(length) && length > 0 ? length + (resumed ? received : 0) : 0;
    const etag = response.headers.get("etag") ?? undefined;
    await writePartMeta(partMeta, { url, etag, received, totalBytes });

    const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
    let written = received;
    onProgress?.({ receivedBytes: written, totalBytes, url });

    try {
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, _encoding, callback) {
            written += chunk.length;
            onProgress?.({ receivedBytes: written, totalBytes, url });
            callback(null, chunk);
          },
        }),
        out,
        { signal },
      );
    } catch (error) {
      lastError = error;
      await writePartMeta(partMeta, { url, etag, received: written, totalBytes }).catch(() => {});
      if (signal?.aborted) throw abortError();
      switched = index < urls.length - 1;
      if (!switched) break;
      continue;
    }

    await writePartMeta(partMeta, { url, etag, received: written, totalBytes });
    return { receivedBytes: written, totalBytes, url, switched };
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
