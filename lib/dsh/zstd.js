/**
 * dsh-session-explorer — minimal zstd frame scanner.
 *
 * DSH stores a session log as a *concatenation of independent zstd frames* —
 * one frame per appended batch of JSONL events. To read just the session header
 * we must find the boundary of frame #1 without decompressing (or even reading)
 * the rest of a file that can be several megabytes.
 *
 * `node:zlib` can decompress a single frame (`zstdDecompressSync`) but cannot
 * tell us where that frame ends, hence this scanner. It implements only the
 * parsing needed to *skip* a frame: magic, frame header, block loop, checksum.
 * It deliberately does not decode literals/sequences, and it never guesses — a
 * truncated file yields `tornStart` instead of a bogus frame boundary.
 *
 * Frame layout (RFC 8878 §3.1):
 *   magic      4 bytes  LE 0xFD2FB528
 *   descriptor 1 byte   [FCS flag:2][single segment:1][unused:1][reserved:1][checksum:1][dict id flag:2]
 *   window    0|1|2|4    omitted when single-segment
 *   dict id   0|1|2|4    size from the descriptor's low 2 bits
 *   fcs       0|1|2|4|8  size from the descriptor's high 2 bits (bit pattern, not a byte count)
 *   blocks    3-byte header each: [last:1][type:2][size:21], then payload
 *                          raw → size bytes, rle → 1 byte, compressed → size bytes
 *   checksum  0|4 bytes
 */

import { open, readFile } from "node:fs/promises";

/** Little-endian frame magic, as a 32-bit unsigned integer. */
export const ZSTD_MAGIC = 0xfd2fb528;

/** Default number of bytes read to locate/decompress the first frame. */
export const HEAD_BYTES = 256 * 1024;

/**
 * Parse one frame starting at `offset`.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ end: number } | { torn: true, reason: string }}
 *   `end` is the offset just past the frame (exclusive).
 */
function frameAt(buf, offset) {
  const start = offset;
  if (buf.length - offset < 4) return { torn: true, reason: "magic" };
  if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return { torn: true, reason: "magic" };
  offset += 4;
  if (offset >= buf.length) return { torn: true, reason: "descriptor" };

  const descriptor = buf.readUInt8(offset++);
  const fcsFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const hasChecksum = (descriptor & 0x04) !== 0;
  const dictIdFlag = descriptor & 0x03;

  const dictIdBytes = dictIdFlag === 3 ? 4 : dictIdFlag;
  // RFC 8878 Table 2: flag 0 is `0 bytes` for multi-segment but `1 byte` for a
  // single-segment frame (the FCS then doubles as the window size).
  const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag;
  const windowBytes = singleSegment ? 0 : 1;

  const headerRest = windowBytes + dictIdBytes + fcsBytes;
  if (buf.length - offset < headerRest) return { torn: true, reason: "header" };
  offset += headerRest;

  for (;;) {
    if (buf.length - offset < 3) return { torn: true, reason: "block-header" };
    const header = buf.readUIntLE(offset, 3);
    offset += 3;
    const last = (header & 1) !== 0;
    const type = (header >>> 1) & 0x03;
    const size = header >>> 3;
    if (type === 3) return { torn: true, reason: "block-type-reserved" };
    const payload = type === 1 ? 1 : size;
    if (buf.length - offset < payload) return { torn: true, reason: "block-payload" };
    offset += payload;
    if (last) break;
  }

  if (hasChecksum) {
    if (buf.length - offset < 4) return { torn: true, reason: "checksum" };
    offset += 4;
  }

  return { end: offset, size: offset - start };
}

/**
 * Enumerate frame boundaries in a buffer.
 *
 * A trailing partial frame is reported as `tornStart` and is *not* included in
 * `frames`: the producer may still be appending, and a half-written frame is
 * normal, not corruption.
 *
 * @param {Buffer} buf
 * @param {{ limit?: number }} [options] stop after this many complete frames
 * @returns {{ frames: Array<{ start: number, end: number }>, tornStart: number | null, tornReason: string | null }}
 */
export function scanZstdFrames(buf, options = {}) {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  /** @type {Array<{ start: number, end: number }>} */
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    if (frames.length >= limit) return { frames, tornStart: null, tornReason: null };
    const parsed = frameAt(buf, offset);
    if (parsed.torn) return { frames, tornStart: offset, tornReason: parsed.reason };
    frames.push({ start: offset, end: parsed.end });
    offset = parsed.end;
  }
  return { frames, tornStart: null, tornReason: null };
}

/**
 * Decompress exactly one frame.
 *
 * @param {Buffer} buf
 * @param {{ start: number, end: number }} frame
 * @returns {Buffer}
 */
export function decompressFrame(buf, frame) {
  return decompressSlice(buf.subarray(frame.start, frame.end));
}

/**
 * Decompress one zstd frame contained in `slice`.
 *
 * Split out so tests can feed a hand-built frame without a scanner.
 *
 * @param {Buffer} slice
 * @returns {Buffer}
 */
export function decompressSlice(slice) {
  const zstd = typeof globalThis?.process?.getBuiltinModule === "function"
    ? globalThis.process.getBuiltinModule("node:zlib")
    : undefined;
  const decompress = zstd?.zstdDecompressSync;
  if (typeof decompress !== "function") {
    const error = new Error("node:zlib.zstdDecompressSync is unavailable on this runtime");
    error.code = "capability-missing";
    throw error;
  }
  return decompress(slice);
}

/**
 * Read the first frame of a zstd file without loading the whole file when its
 * first frame ends inside `headBytes`.
 *
 * @param {string} filePath
 * @param {number} [headBytes]
 * @returns {Promise<{ text: string, bytes: number, torn: boolean }>}
 */
export async function readFirstFrameText(filePath, headBytes = HEAD_BYTES) {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const want = Math.min(size, headBytes);
    const head = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(head, 0, want, 0);
    let buf = head.subarray(0, bytesRead);
    let scan = scanZstdFrames(buf, { limit: 1 });

    // First frame larger than the probe window: fall back to the whole file.
    // Session headers are tiny, so this only triggers on exotic logs.
    if (scan.frames.length === 0 && scan.tornStart === 0 && bytesRead < size) {
      buf = await readFile(filePath);
      scan = scanZstdFrames(buf, { limit: 1 });
    }

    if (scan.frames.length === 0) {
      const error = new Error(`no complete zstd frame in ${filePath} (${scan.tornReason ?? "empty"})`);
      error.code = "bad-request";
      throw error;
    }
    const frame = scan.frames[0];
    return {
      text: decompressFrame(buf, frame).toString("utf8"),
      bytes: buf.length,
      torn: scan.tornStart !== null,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Read the first frame of a zstd file and parse its first JSONL line.
 *
 * @param {string} filePath
 * @returns {Promise<any>} the parsed first record
 */
export async function readFirstRecord(filePath) {
  const { text } = await readFirstFrameText(filePath);
  const line = text.split("\n", 1)[0];
  if (!line) throw new Error(`empty first frame in ${filePath}`);
  return JSON.parse(line);
}
