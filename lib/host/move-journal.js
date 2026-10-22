/**
 * dsh-session-explorer — the intent journal for a cross-workspace move.
 *
 * A move is two writes that cannot be made one: the payload is relocated on
 * disk, and the workspace registry is told about it afterwards. A crash in
 * between leaves the bytes at the destination and the registry still describing
 * the old home — the session is then in neither workspace, which is exactly the
 * failure the trash flow already guards against with `pending` entries.
 *
 * The journal is that guard for moves: an entry is written before the payload
 * leaves its directory and removed once the registry has caught up. Startup
 * reads whatever is left and finishes or forgets it (`reconcileMoves`), so the
 * window is closed rather than merely narrowed.
 *
 * It lives beside the other sidecars in the plugin data directory and is a
 * single small JSON file, written atomically (temp + rename) so a crash during
 * the write leaves either the old journal or the new one, never half of each.
 */

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** File name inside the plugin data directory. */
export const MOVE_JOURNAL_FILE = "move-journal.v1.json";

/**
 * @param {{ dataDir: string }} paths
 * @returns {string}
 */
export function journalPath(paths) {
  return join(paths.dataDir, MOVE_JOURNAL_FILE);
}

/**
 * @param {{ dataDir: string }} paths
 * @returns {Promise<any[]>}
 */
async function readJournal(paths) {
  try {
    const text = await readFile(journalPath(paths), "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.moves) ? parsed.moves.filter((move) => move && typeof move === "object") : [];
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") return [];
    // An unreadable journal is not fatal: the move it described is either
    // finished (the destination exists) or never started, and both are visible
    // on the filesystem. Losing the entry costs the automatic repair, not data.
    return [];
  }
}

/**
 * @param {{ dataDir: string }} paths
 * @param {any[]} moves
 */
async function writeJournal(paths, moves) {
  const target = journalPath(paths);
  if (moves.length === 0) {
    await rm(target, { force: true }).catch(() => {});
    return;
  }
  const temp = target + ".tmp";
  await writeFile(temp, JSON.stringify({ version: 1, moves }, null, 2), "utf8");
  await rename(temp, target);
}

/**
 * Remember that a move is about to start.
 *
 * Written before the payload leaves its directory, so every crash point after
 * this call is repairable.
 *
 * @param {{ dataDir: string }} paths
 * @param {any} entry
 */
export async function recordMove(paths, entry) {
  const moves = (await readJournal(paths)).filter((move) => move.sessionId !== entry.sessionId);
  moves.push(entry);
  await writeJournal(paths, moves);
}

/**
 * Forget a move that has finished (or whose rollback put everything back).
 *
 * @param {{ dataDir: string }} paths
 * @param {string} sessionId
 */
export async function forgetMove(paths, sessionId) {
  const moves = (await readJournal(paths)).filter((move) => move.sessionId !== sessionId);
  await writeJournal(paths, moves);
}

/**
 * Every move that was started and not finished.
 *
 * @param {{ dataDir: string }} paths
 * @returns {Promise<any[]>}
 */
export async function pendingMoves(paths) {
  return readJournal(paths);
}
