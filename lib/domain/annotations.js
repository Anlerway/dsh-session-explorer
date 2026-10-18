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

/** Most tags the shared library may hold. */
export const TAG_LIBRARY_LIMIT = 120;

/**
 * Normalize the tag library.
 *
 * The library is the user's own vocabulary: tags created once and then picked
 * from the detail pane instead of retyped. It lives in the annotations sidecar
 * because it is the same kind of fact — the plugin's opinion, not something DSH
 * knows (S8). Order is the order the user created them in.
 *
 * @param {any} input
 * @returns {string[]}
 */
export function normalizeTagLibrary(input) {
  const list = Array.isArray(input) ? input : [];
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
    if (out.length >= TAG_LIBRARY_LIMIT) break;
  }
  return out;
}

/**
 * Add one tag to the library. Returns the normalized list; a tag that already
 * exists (case-insensitively) is a no-op so the caller cannot grow duplicates.
 *
 * @param {string[]} current
 * @param {any} tag
 * @returns {string[]}
 */
export function addLibraryTag(current, tag) {
  const list = normalizeTagLibrary(current);
  const next = text(tag).slice(0, TAG_MAX_LENGTH);
  if (!next) return list;
  if (list.some((entry) => entry.toLowerCase() === next.toLowerCase())) return list;
  return normalizeTagLibrary([...list, next]);
}

/**
 * Remove one tag from the library. Sessions that already carry it keep it: the
 * library is a vocabulary, not a constraint.
 *
 * @param {string[]} current
 * @param {any} tag
 * @returns {string[]}
 */
export function removeLibraryTag(current, tag) {
  const key = text(tag).toLowerCase();
  return normalizeTagLibrary(current).filter((entry) => entry.toLowerCase() !== key);
}

/**
 * The picker's vocabulary: every library tag first (in creation order), then
 * the tags that are only in use on sessions, so a tag typed before the library
 * existed is still one click away. Each row carries its usage count.
 *
 * @param {{ sessions?: Record<string, any>, tags?: any }} document
 * @returns {{ tag: string, count: number, preset: boolean }[]}
 */
export function tagVocabulary(document) {
  const counts = new Map();
  for (const row of tagIndex(document)) counts.set(row.tag.toLowerCase(), row.count);
  /** @type {{ tag: string, count: number, preset: boolean }[]} */
  const out = [];
  const seen = new Set();
  for (const tag of normalizeTagLibrary(document?.tags)) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tag, count: counts.get(key) ?? 0, preset: true });
  }
  for (const row of tagIndex(document)) {
    const key = row.tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tag: row.tag, count: row.count, preset: false });
  }
  return out;
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
