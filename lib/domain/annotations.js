/**
 * dsh-session-explorer — annotation rules.
 *
 * An annotation is the plugin's own opinion about a session: tags, a note, a
 * priority, and the two shortcut flags (收藏 / 待办). It never holds a title, a
 * path or a timestamp — those come from DSH (S8).
 *
 * An entry is deleted the moment it carries no information, so the sidecar does
 * not slowly fill with `{ tags: [], note: "" }` shells for every session the
 * user ever clicked.
 *
 * All functions are pure and take/return plain objects, which is what makes them
 * testable without a filesystem.
 */

/** Longest accepted tag, in characters. */
export const TAG_MAX_LENGTH = 32;

/** Longest accepted note, in characters. */
export const NOTE_MAX_LENGTH = 4000;

/** Most tags one session may carry. */
export const TAG_LIMIT = 24;

/** Priority is a small ordered scale, not a free number. */
export const PRIORITIES = Object.freeze(["none", "low", "normal", "high"]);

/**
 * @param {any} value
 * @returns {string}
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalize a tag list: trimmed, de-duplicated case-insensitively, length- and
 * count-bounded. Order is preserved so the user's first tag stays first.
 *
 * @param {any} input
 * @returns {string[]}
 */
export function normalizeTags(input) {
  const list = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const tag = text(raw).slice(0, TAG_MAX_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= TAG_LIMIT) break;
  }
  return out;
}

/**
 * @param {any} input
 * @returns {string}
 */
export function normalizeNote(input) {
  return text(input).slice(0, NOTE_MAX_LENGTH);
}

/**
 * @param {any} input
 * @returns {"none" | "low" | "normal" | "high"}
 */
export function normalizePriority(input) {
  const value = text(input).toLowerCase();
  return PRIORITIES.includes(value) ? /** @type {any} */ (value) : "none";
}

/**
 * The annotation for one session, normalized. Unknown keys are dropped so a
 * stale client cannot smuggle state into the sidecar.
 *
 * @param {any} entry
 * @returns {{ tags: string[], note: string, priority: string, favorite: boolean, todo: boolean, updatedAt: number | null }}
 */
export function normalizeAnnotation(entry) {
  return {
    tags: normalizeTags(entry?.tags),
    note: normalizeNote(entry?.note),
    priority: normalizePriority(entry?.priority),
    favorite: entry?.favorite === true,
    todo: entry?.todo === true,
    updatedAt: typeof entry?.updatedAt === "number" ? entry.updatedAt : null,
  };
}

/**
 * Does this annotation carry any information at all?
 *
 * @param {{ tags: string[], note: string, priority: string, favorite: boolean, todo: boolean }} entry
 * @returns {boolean}
 */
export function hasContent(entry) {
  return (
    entry.tags.length > 0 ||
    entry.note !== "" ||
    entry.priority !== "none" ||
    entry.favorite ||
    entry.todo
  );
}

/**
 * Apply a partial patch to one session's annotation, in the sidecar document.
 *
 * Mutates `document.sessions` in place (the sidecar hands the mutator a draft)
 * and returns the resulting entry, or `null` when the entry was deleted.
 *
 * @param {{ sessions: Record<string, any> }} document
 * @param {string} sessionId
 * @param {object} patch
 * @param {number} now
 * @returns {any | null}
 */
export function patchAnnotation(document, sessionId, patch, now = Date.now()) {
  document.sessions ??= {};
  const current = normalizeAnnotation(document.sessions[sessionId]);

  /** @type {any} */
  const next = { ...current };
  if ("tags" in patch) next.tags = normalizeTags(patch.tags);
  if ("note" in patch) next.note = normalizeNote(patch.note);
  if ("priority" in patch) next.priority = normalizePriority(patch.priority);
  if ("favorite" in patch) next.favorite = patch.favorite === true;
  if ("todo" in patch) next.todo = patch.todo === true;

  if (!hasContent(next)) {
    delete document.sessions[sessionId];
    return null;
  }
  next.updatedAt = now;
  document.sessions[sessionId] = next;
  return next;
}

/**
 * Every tag in use, with the number of sessions carrying it. The client shows
 * this as the tag filter list, so it must be derived, never stored.
 *
 * @param {{ sessions: Record<string, any> }} document
 * @returns {{ tag: string, count: number }[]}
 */
export function tagIndex(document) {
  /** @type {Map<string, { tag: string, count: number }>} */
  const seen = new Map();
  for (const entry of Object.values(document.sessions ?? {})) {
    for (const tag of normalizeTags(entry?.tags)) {
      const key = tag.toLowerCase();
      const row = seen.get(key);
      if (row) row.count += 1;
      else seen.set(key, { tag, count: 1 });
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh"));
}

/**
 * Ids that carry a given flag, so the list can be filtered without walking the
 * annotations on the client.
 *
 * @param {{ sessions: Record<string, any> }} document
 * @param {"favorite" | "todo"} flag
 * @returns {string[]}
 */
export function idsWithFlag(document, flag) {
  return Object.entries(document.sessions ?? {})
    .filter(([, entry]) => entry?.[flag] === true)
    .map(([id]) => id);
}
