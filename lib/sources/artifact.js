/**
 * dsh-session-explorer — session artifact paths, read and encode.
 *
 * A session log lives at
 *
 *   <dshHome>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v<gen>.jsonl.zstd
 *
 * and both path segments are encoded by the persistence backend
 * (`@deepseek-ai/dsh-session-persistence-jsonl`), not by anything the plugin
 * may guess. This module reproduces the two encoders exactly — the same rules
 * are already documented in `sources/heads.js` as "path names are opaque" —
 * because a *write* path cannot be discovered by walking: a move has to name
 * the destination before it exists.
 *
 * The encoders are pinned by test/artifact.test.mjs against the real directory
 * names observed on this machine (see 交接文档.md §5.4).
 *
 * Log shape: the file is a concatenation of independent zstd frames, one per
 * appended batch. Frame #1 starts with the JSON header line. Rewriting a move
 * therefore means "decode every frame, replace the header line, re-encode";
 * the event bytes are preserved verbatim, so the conversation cannot drift.
 */

import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { codedError } from "../store/sidecar.js";
import { scanZstdFrames } from "../dsh/zstd.js";

/** Current session format generation this build knows how to write. */
export const SESSION_FORMAT_VERSION = 4;

/** File name a session log uses in its own directory. */
export const SESSION_LOG_FILE = `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`;

/** Artifact names a cold session may still carry, newest generation first. */
export const ARTIFACT_NAMES = Object.freeze([
  "session.v4.jsonl.zstd",
  "session.v3.jsonl.zstd",
  "session.v2.jsonl.zstd",
  "session.jsonl.zstd",
  "session.jsonl",
]);

/**
 * Encode one path segment the way DSH's persistence backend does.
 *
 * Safe code units (\`A-Za-z0-9._-\`, but not \`~\`) stay literal; everything else
 * becomes \`~XXXX\` (four uppercase hex digits of the UTF-16 code unit). \`.\` and
 * \`..\` are escaped so a session id can never traverse.
 *
 * @param {string} raw
 * @returns {string}
 */
export function encodeSegment(raw) {
  const text = String(raw ?? "");
  if (text.length === 0) throw codedError("bad-request", "cannot encode an empty path segment");
  if (text === ".") return "~002E";
  if (text === "..") return "~002E~002E";
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * Encode a project cwd into its readable directory key.
 *
 * Separators and the drive colon collapse to a single `-`; unsafe code units
 * use the same escape as {@link encodeSegment}. The key is bounded to 251 code
 * units, which is what keeps a deep cwd inside a filesystem component limit.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function projectKey(cwd) {
  const text = String(cwd ?? "");
  if (text.length === 0) throw codedError("bad-request", "cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Directory name for a session log, given the project key and the session id.
 *
 * @param {string} sessionsRoot
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionDirOf(sessionsRoot, cwd, sessionId) {
  return join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId));
}

/**
 * The artifact path a session with this header would live at.
 *
 * @param {string} sessionsRoot
 * @param {{ id: string, cwd?: string | null, version?: number }} header
 * @param {{ fileName?: string }} [options]
 * @returns {string}
 */
export function artifactPathOf(sessionsRoot, header, options = {}) {
  const cwd = typeof header?.cwd === "string" && header.cwd !== "" ? header.cwd : undefined;
  const dir = cwd === undefined
    ? join(sessionsRoot, "_no-cwd", encodeSegment(header.id))
    : sessionDirOf(sessionsRoot, cwd, header.id);
  const fileName = options.fileName ?? `session.v${header.version ?? SESSION_FORMAT_VERSION}.jsonl.zstd`;
  return join(dir, fileName);
}

/**
 * Whether `target` sits inside `root` (and is not the root itself).
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(`..${sep}`);
}

/**
 * Read one session artifact as logical JSONL text.
 *
 * Every complete frame is decoded and concatenated. A torn trailing frame is
 * refused instead of silently dropped: appending a truncated log to a complete
 * one is how a conversation loses its last turn.
 *
 * @param {string} filePath
 * @returns {Promise<{ header: any, events: any[], text: string, fileName: string, compressed: boolean }>}
 */
export async function readArtifact(filePath) {
  const bytes = await readFile(filePath);
  const compressed = filePath.endsWith(".zstd");
  let text;
  if (!compressed) {
    text = bytes.toString("utf8");
  } else {
    const scan = scanZstdFrames(bytes);
    if (scan.frames.length === 0) {
      throw codedError("session-corrupt", `${filePath} holds no complete zstd frame`);
    }
    if (scan.tornStart !== null) {
      throw codedError(
        "session-corrupt",
        `${filePath} ends with a truncated zstd frame (${scan.tornReason ?? "unknown"}); refusing to rewrite it`,
      );
    }
    const parts = [];
    for (const frame of scan.frames) {
      parts.push(zstdDecompressSync(bytes.subarray(frame.start, frame.end)));
    }
    text = Buffer.concat(parts).toString("utf8");
  }

  if (!text.endsWith("\n")) {
    throw codedError("session-corrupt", `${filePath} does not end with a complete JSONL line`);
  }
  const newline = text.indexOf("\n");
  if (newline <= 0) throw codedError("session-corrupt", `${filePath} has no header line`);
  let header;
  try {
    header = JSON.parse(text.slice(0, newline));
  } catch {
    throw codedError("session-corrupt", `${filePath} header line is not valid JSON`);
  }
  const events = [];
  for (const line of text.slice(newline + 1).split("\n")) {
    if (line === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw codedError("session-corrupt", `${filePath} contains an event line that is not valid JSON`);
    }
  }
  return { header, events, text, fileName: basename(filePath), compressed };
}

/**
 * Serialize a header + event bodies back into the artifact's physical layout.
 *
 * The header gets its own frame so the L2 reader (which decodes exactly one
 * frame) keeps working; the events are one frame of their own. A plain-text
 * artifact stays plain text.
 *
 * @param {any} header
 * @param {string} rest text after the header line, including the final newline
 * @param {boolean} compressed
 * @returns {Buffer}
 */
export function encodeArtifact(header, rest, compressed) {
  const headerLine = `${JSON.stringify(header)}\n`;
  if (!compressed) return Buffer.from(headerLine + rest, "utf8");
  const headerFrame = zstdCompressSync(Buffer.from(headerLine, "utf8"));
  if (rest === "") return headerFrame;
  return Buffer.concat([headerFrame, zstdCompressSync(Buffer.from(rest, "utf8"))]);
}

/**
 * A temp path next to a final target. Same directory, so the publish rename is
 * a single filesystem operation and never crosses a volume.
 *
 * @param {string} finalPath
 * @returns {string}
 */
export function tempPathFor(finalPath) {
  return `${finalPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

/**
 * List the artifact files present in one session directory, newest generation
 * first. Used to pick the file a cold session actually has.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
export async function artifactsIn(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const rank = new Map(ARTIFACT_NAMES.map((name, index) => [name, index]));
  return names
    .filter((name) => rank.has(name))
    .sort((a, b) => rank.get(a) - rank.get(b));
}

/**
 * Resolve the artifact file for a session directory.
 *
 * @param {string} directory
 * @returns {Promise<string | null>}
 */
export async function artifactIn(directory) {
  const [first] = await artifactsIn(directory);
  return first ? join(directory, first) : null;
}

/**
 * The inherited-event cut a seeded session was created with, derived from its
 * own log: the last `session/end-seed` marker with `data.inherited === true`.
 *
 * DSH stores this cut in persistence state, not in the header, so a plugin
 * refolding the projection cache has to recover it from the events. Returning
 * `null` means "cannot prove it", and the caller must skip the refold rather
 * than guess — a wrong cut poisons the cache.
 *
 * @param {any[]} events
 * @returns {number | null}
 */
export function inheritedCutOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "session/end-seed" && event?.data?.inherited === true) {
      return Number.isFinite(event.seq) ? event.seq + 1 : index + 1;
    }
  }
  return null;
}

/**
 * Whether an event list is a contiguous logical log starting at seq 0. A log
 * with packed physical rows or a gap cannot be handed to the projection refold.
 *
 * @param {any[]} events
 * @returns {boolean}
 */
export function isContiguousLog(events) {
  return events.every((event, index) => event && typeof event === "object" && event.seq === index);
}

/**
 * @param {string} path
 * @returns {string} the directory a log file lives in
 */
export function dirOfArtifact(path) {
  return dirname(path);
}
