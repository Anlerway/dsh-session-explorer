/**
 * dsh-session-navigator — the last-frame facts a listing needs from one log.
 *
 * Two questions the list asks about every session cannot be answered from the
 * header or from DSH's own cache:
 *
 *   空白会话  — has this log ever contained a `turn/start`? DSH's projcache
 *               knows, but only for sessions it has listed itself; a log the
 *               plugin found by walking the data dir has no such record.
 *   已中断    — does the log end mid-turn? DSH decides liveness in memory, so a
 *               log that was cut off by a crash looks exactly like an idle one
 *               from the outside: the last thing it holds is a `turn/start` that
 *               never got its `turn/end`.
 *
 * Both answers live at the two ends of the file, and a log is a concatenation of
 * zstd frames (one per appended batch) — see `dsh/zstd.js`. So this module reads
 * the tail window for the last event and, for small logs, the whole file for the
 * first turn. Everything is cached by `path|size|mtime`, because a listing
 * re-runs on every keystroke while a log only changes while its turn is running.
 */

import { open, readFile, stat } from "node:fs/promises";

import { decompressFrame, scanZstdFrames, ZSTD_MAGIC } from "../dsh/zstd.js";

/** How much of the end of a log is read to find its last frame. */
const TAIL_BYTES = 128 * 1024;

/** How much of the start of a large log is read to find its first turn. */
const HEAD_BYTES = 64 * 1024;

/** Logs at or below this size are read whole: one read beats two. */
const SMALL_BYTES = 256 * 1024;

/** Frames decompressed from the head of a large log to look for a first turn. */
const HEAD_FRAMES = 3;

/** How many logs' facts stay cached. */
const CACHE_LIMIT = 512;

/** `turn/start` in a JSONL event line, without parsing it. */
const TURN_START = /"type"\s*:\s*"turn\/start"/;

/** The `type` of one event line, without parsing it. */
const EVENT_TYPE = /"type"\s*:\s*"([^"]+)"/;

/** @type {Map<string, { turnStart: boolean | null, lastType: string | null, torn: boolean }>} */
const cache = new Map();

/**
 * Drop every cached answer.
 *
 * Tests use it; production never needs to, because the key carries size and
 * mtime and a changed log therefore misses on its own.
 */
export function clearLogFacts() {
  cache.clear();
}

/**
 * The listing facts for one log, or `null` when it cannot be read.
 *
 * @param {string | null | undefined} logPath
 * @param {number | null} [sizeBytes] size from the header scan
 * @param {number | null} [mtimeMs] mtime from the header scan
 * @returns {Promise<{ turnStart: boolean | null, lastType: string | null, torn: boolean } | null>}
 */
export async function readLogFacts(logPath, sizeBytes, mtimeMs) {
  if (typeof logPath !== "string" || logPath === "") return null;
  const key = `${logPath}\u0000${sizeBytes ?? ""}\u0000${mtimeMs ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let facts = null;
  try {
    facts = await scanLog(logPath, sizeBytes);
  } catch {
    // A log being rewritten, a permission problem, an exotic frame: a listing
    // must not fail because one row could not be classified.
    facts = null;
  }
  if (facts) remember(key, facts);
  return facts;
}

/**
 * @param {string} key
 * @param {{ turnStart: boolean | null, lastType: string | null, torn: boolean }} value
 */
function remember(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Classify one log.
 *
 * @param {string} logPath
 * @param {number | null} sizeBytes
 * @returns {Promise<{ turnStart: boolean | null, lastType: string | null, torn: boolean } | null>}
 */
async function scanLog(logPath, sizeBytes) {
  const size = Number.isFinite(sizeBytes) ? Number(sizeBytes) : (await stat(logPath)).size;
  if (size === 0) return { turnStart: false, lastType: null, torn: false };

  if (size <= SMALL_BYTES) {
    const buf = await readFile(logPath);
    const scan = scanZstdFrames(buf);
    if (scan.frames.length === 0) return null;
    const text = framesText(buf, scan.frames);
    return { turnStart: TURN_START.test(text), lastType: lastTypeOf(text), torn: scan.tornStart !== null };
  }

  const buf = await readTail(logPath, size);
  const found = lastFrames(buf);
  if (found === null) return null;
  // Frame offsets are relative to the window they were scanned in, which starts
  // at the first parseable magic rather than at the top of the read.
  const frames = found.scan.frames;
  const tail = framesText(found.window, [frames[frames.length - 1]]);
  // The first turn lives at the *other* end of the file, so the head is read
  // separately — the tail window cannot answer it. Only a handful of frames are
  // decompressed: a `turn/start` that is not near the top of a large log is
  // reported as unknown rather than as blank, because hiding a real
  // conversation is worse than showing a short one.
  const head = await readHead(logPath, size);
  return {
    turnStart: head === null ? null : TURN_START.test(head) ? true : null,
    lastType: lastTypeOf(tail),
    torn: found.scan.tornStart !== null,
  };
}

/**
 * Decompressed text of the first few frames of a log.
 *
 * @param {string} logPath
 * @param {number} size
 * @returns {Promise<string | null>}
 */
async function readHead(logPath, size) {
  const want = Math.min(size, HEAD_BYTES);
  const handle = await open(logPath, "r");
  try {
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buf, 0, want, 0);
    const scan = scanZstdFrames(buf.subarray(0, bytesRead));
    if (scan.frames.length === 0) return null;
    return framesText(buf.subarray(0, bytesRead), scan.frames.slice(0, HEAD_FRAMES));
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * @param {Buffer} buf
 * @param {Array<{ start: number, end: number }>} frames
 * @returns {string}
 */
function framesText(buf, frames) {
  const parts = [];
  for (const frame of frames) parts.push(decompressFrame(buf, frame));
  return Buffer.concat(parts).toString("utf8");
}

/**
 * The `type` of the last event line in a decoded chunk.
 *
 * @param {string} text
 * @returns {string | null}
 */
function lastTypeOf(text) {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    const match = EVENT_TYPE.exec(line);
    return match === null ? null : match[1];
  }
  return null;
}

/**
 * Read the last window of a log.
 *
 * @param {string} logPath
 * @param {number} size
 * @returns {Promise<Buffer>}
 */
async function readTail(logPath, size) {
  const want = Math.min(size, TAIL_BYTES);
  const start = size - want;
  const handle = await open(logPath, "r");
  try {
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buf, 0, want, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Frame boundaries of the newest complete frame inside a tail window.
 *
 * The window almost always starts inside a frame, so the scan cannot begin at
 * offset 0: it walks forward to the first magic number that parses, which is
 * the boundary of the first frame the window holds whole — and therefore every
 * frame after it, including the newest one. A candidate that only *looks* like
 * a magic (compressed payloads are arbitrary bytes) is skipped rather than
 * allowed to abort the whole classification.
 *
 * @param {Buffer} buf
 * @returns {{ window: Buffer, scan: { frames: Array<{ start: number, end: number }>, tornStart: number | null, tornReason: string | null } } | null}
 */
function lastFrames(buf) {
  // Backwards first: the newest frame's magic sits within a few KB of the end,
  // so this usually settles after a handful of checks. A false magic inside
  // compressed payload is skipped rather than allowed to abort the whole
  // classification, and if nothing parses the other direction is tried.
  const backwards = scanForFrames(buf, true);
  if (backwards !== null) return backwards;
  return scanForFrames(buf, false);
}

/**
 * @param {Buffer} buf
 * @param {boolean} fromEnd
 * @returns {{ window: Buffer, scan: any } | null}
 */
function scanForFrames(buf, fromEnd) {
  const limit = buf.length - 4;
  for (let step = 0; step <= limit; step += 1) {
    const index = fromEnd ? limit - step : step;
    if (buf.readUInt32LE(index) !== ZSTD_MAGIC) continue;
    const window = buf.subarray(index);
    let scan;
    try {
      scan = scanZstdFrames(window);
    } catch {
      continue;
    }
    if (scan.frames.length > 0) return { window, scan };
  }
  return null;
}
