/**
 * dsh-session-explorer — session view model.
 *
 * One function merges the three read paths into the flat list the UI renders:
 *
 *   headers (L2, filesystem)  — the authoritative set of sessions that exist
 *   projcache (L1, JSON)      — the cheap per-session facts (title, times…)
 *   workspace registry        — which workspace each session belongs to, and
 *                               DSH's own archived / pinned sets
 *
 * Precedence is deliberate. The **header** decides existence and identity: a
 * session missing from the projection cache is still a session and is listed
 * with what the header knows. The **cache** supplies everything the header does
 * not carry, and may only fill fields, never rename or re-scope a session —
 * a stale cache whose `identity` disagrees with the header is ignored wholesale.
 *
 * Pure and synchronous on purpose: no I/O here, so it is directly unit-testable
 * and the route layer stays a thin adapter.
 */

/**
 * DSH's own display-title rule, reproduced so the explorer shows exactly what
 * the sidebar shows: title → cwd directory name → id.
 *
 * @param {object} session
 * @returns {string}
 */
export function displayTitleOf(session) {
  const title = typeof session?.title === "string" ? session.title.trim() : "";
  if (title) return title;
  const cwd = typeof session?.cwd === "string" ? session.cwd.trim() : "";
  if (cwd) {
    const trimmed = cwd.replace(/[\\/]+$/, "");
    const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
    const base = index === -1 ? trimmed : trimmed.slice(index + 1);
    if (base) return base;
  }
  return session?.id ?? "(unknown)";
}

/**
 * Two facts are about the same session only when the cache's identity matches
 * the header. `createdAt` + `cwd` are the cache's identity witness; a mismatch
 * means the cache belongs to a recycled id (or a rewritten log) and must be
 * dropped, not merged.
 *
 * @param {object} identity cache `record.identity`
 * @param {object} header session header
 * @returns {boolean}
 */
export function identityMatches(identity, header) {
  if (!identity || !header) return false;
  if (Number.isFinite(identity.createdAt) && Number.isFinite(header.createdAt) && identity.createdAt !== header.createdAt) return false;
  if (typeof identity.cwd === "string" && typeof header.cwd === "string" && identity.cwd !== header.cwd) return false;
  if (Number.isFinite(identity.formatVersion) && Number.isFinite(header.formatVersion) && identity.formatVersion !== header.formatVersion) return false;
  return true;
}

/**
 * Build the merged session list.
 *
 * @param {object} input
 * @param {Map<string, object>} input.headers sessionId → header (L2)
 * @param {Map<string, { version: number, facts: object }>} input.projcache sessionId → cache entry (L1)
 * @param {{ workspaces: Map<string, any>, archivedSessionIds: string[], pinnedSessionIds: string[] } | null} input.registry
 * @param {Set<string>} [input.running] ids with a live session in this process
 * @param {Record<string, any>} [input.annotations] sessionId → sidecar annotation
 * @returns {{ sessions: object[], stats: { total: number, withCache: number, headerOnly: number, cacheRejected: number } }}
 */
export function buildSessionView(input) {
  const { headers, projcache, registry, running, annotations } = input;
  const archived = new Set(registry?.archivedSessionIds ?? []);
  const pinned = new Set(registry?.pinnedSessionIds ?? []);

  /** @type {Map<string, string>} sessionId → workspaceId */
  const workspaceOf = new Map();
  for (const [workspaceId, workspace] of registry?.workspaces ?? new Map()) {
    for (const sessionId of workspace.sessionIds ?? []) {
      if (!workspaceOf.has(sessionId)) workspaceOf.set(sessionId, workspaceId);
    }
  }

  let withCache = 0;
  let headerOnly = 0;
  let cacheRejected = 0;
  /** @type {object[]} */
  const sessions = [];

  for (const [id, header] of headers) {
    const cached = projcache?.get(id);
    let facts = null;
    if (cached) {
      if (identityMatches(cached.facts.identity, header)) {
        facts = cached.facts;
        withCache += 1;
      } else {
        cacheRejected += 1;
      }
    }
    if (!facts) headerOnly += 1;

    const workspaceId = workspaceOf.get(id) ?? null;
    const createdAt = header.createdAt ?? facts?.createdAt ?? null;
    const lastPromptAt = facts?.lastPromptAt ?? null;
    // Two different ideas share the word "favorite" in the UI: 置顶 (`pinned`) is
    // DSH's own pin, while 收藏 (`favorite`) is this plugin's sidecar flag. They
    // are kept apart all the way to the client so neither overwrites the other.
    const annotation = annotations?.[id] ?? null;
    const session = {
      id,
      workspaceId,
      workspaceTitle: workspaceId ? (registry?.workspaces.get(workspaceId)?.title ?? null) : null,
      title: facts?.title ?? null,
      displayTitle: displayTitleOf({ title: facts?.title, cwd: header.cwd, id }),
      createdAt,
      lastPromptAt,
      activityAt: Math.max(createdAt ?? 0, lastPromptAt ?? 0) || null,
      cwd: header.cwd ?? facts?.cwd ?? null,
      agentPreset: header.agentPreset ?? facts?.agentPreset ?? null,
      isSeeded: header.isSeeded,
      delegationDepth: header.delegationDepth ?? 0,
      parentSession: header.parentSession ?? null,
      origin: header.origin ?? null,
      // A subagent is a delegation, and DSH has two creation paths for one:
      // `dsh-subagent` stamps origin:"subagent", while in-process team members
      // persist only delegationDepth. Keying on origin alone therefore missed
      // every child that came from the second path and listed it as an
      // unrelated session. Either signal is enough; a fork is neither (it keeps
      // depth 0 and only carries parentSession + isSeeded), so it stays a
      // sibling of its source (user instruction, 2026-10-18).
      isSubagent:
        header.origin === "subagent" ||
        (header.origin === null && (header.delegationDepth ?? 0) > 0),
      blank: facts?.blank ?? null,
      stats: facts?.stats ?? null,
      tokenUsage: facts?.tokenUsage ?? null,
      contextPressure: facts?.contextPressure ?? null,
      modelSelection: facts?.modelSelection ?? null,
      archived: archived.has(id),
      pinned: pinned.has(id),
      running: running?.has(id) ?? false,
      hasCache: Boolean(facts),
      formatVersion: header.formatVersion ?? null,
      sizeBytes: header.sizeBytes ?? null,
      tags: annotation?.tags ?? [],
      note: annotation?.note ?? "",
      favorite: annotation?.favorite === true,
      todo: annotation?.todo === true,
    };
    sessions.push(session);
  }

  // A child whose parent is not in the listing would render as an orphan row
  // with a 子 badge and no parent to nest under. Keep the relation only when it
  // is actually resolvable, so the client never has to guess.
  const ids = new Set(sessions.map((session) => session.id));
  for (const session of sessions) {
    if (session.parentSession && !ids.has(session.parentSession)) session.parentSession = null;
  }

  sessions.sort(compareSessions);

  return {
    sessions,
    stats: { total: sessions.length, withCache, headerOnly, cacheRejected },
  };
}

/**
 * Listing order: pinned first, then most recent activity, then title.
 * Archived sessions keep their position in the array — the UI is what greys
 * them out and sinks them (see 实现粗规划 §2.1: our "archived" never hides).
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareSessions(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const delta = (b.activityAt ?? 0) - (a.activityAt ?? 0);
  if (delta !== 0) return delta;
  return a.displayTitle.localeCompare(b.displayTitle);
}


