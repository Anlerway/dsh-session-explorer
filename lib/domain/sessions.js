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

import { workspaceLabel } from "./tree.js";

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
  /** @type {Map<string, string>} lower-cased workspace path → workspaceId */
  const workspaceByPath = new Map();
  for (const [workspaceId, workspace] of registry?.workspaces ?? new Map()) {
    for (const sessionId of workspace.sessionIds ?? []) {
      if (!workspaceOf.has(sessionId)) workspaceOf.set(sessionId, workspaceId);
    }
    const path = typeof workspace?.path === "string" ? workspace.path.replace(/[\\/]+$/, "") : "";
    if (path && !workspaceByPath.has(path.toLowerCase())) workspaceByPath.set(path.toLowerCase(), workspaceId);
  }

  /**
   * The label a workspace id is shown under.
   *
   * `workspaceLabel` translates DSH's literal "default-workspace" id into the
   * user-facing name; every other title is passed through unchanged.
   *
   * @param {string | null} workspaceId
   * @returns {string | null}
   */
  const titleOfWorkspace = (workspaceId) =>
    workspaceId
      ? workspaceLabel(
          registry?.workspaces.get(workspaceId)?.title,
          registry?.workspaces.get(workspaceId)?.path,
          workspaceId,
          workspaceId === registry?.defaultWorkspaceId,
        )
      : null;

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
      // The label the user sees, not the raw registry title: DSH files the
      // default workspace under the literal "default-workspace", which is an
      // identifier. `workspaceLabel` translates exactly that one value and leaves
      // every other title alone.
      workspaceTitle: titleOfWorkspace(workspaceId),
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
      // The artifact path, so the export route can read the log without a
      // second directory walk. It is a host path: the client never opens it.
      logPath: header.logPath ?? null,
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

  // 子会话的归属 (P31). DSH's workspace registry only lists the sessions a user
  // opened from a workspace; every child of a delegated run is created by its
  // parent and is absent from `workspace.sessionIds`, so it arrived here with
  // `workspaceId: null` and was filed under 未分组 even though its parent sits
  // in a workspace. A child belongs where its parent belongs, so the workspace
  // is inherited down the parent chain — a chain, not one hop, because a
  // subagent may delegate again.
  //
  // Two fallbacks keep this from inventing a home: an unresolvable parent
  // leaves the child unplaced, and only when the whole chain is unplaced is the
  // cwd compared with a workspace path (an exact match, the same witness DSH
  // uses). A fork is not a subagent and is never moved by this rule.
  const byId = new Map(sessions.map((session) => [session.id, session]));
  /** @type {Map<string, { workspaceId: string, workspaceTitle: string | null } | null>} */
  const inherited = new Map();

  /**
   * @param {object} session
   * @param {Set<string>} seen ids already on this chain (cycle guard)
   * @returns {{ workspaceId: string, workspaceTitle: string | null } | null}
   */
  const homeOfChain = (session, seen) => {
    if (session.workspaceId) {
      return { workspaceId: session.workspaceId, workspaceTitle: session.workspaceTitle ?? titleOfWorkspace(session.workspaceId) };
    }
    if (inherited.has(session.id)) return inherited.get(session.id);
    const parent = session.parentSession ? byId.get(session.parentSession) : null;
    if (!parent || seen.has(parent.id)) {
      inherited.set(session.id, null);
      return null;
    }
    seen.add(session.id);
    const found = homeOfChain(parent, seen);
    inherited.set(session.id, found);
    return found;
  };

  for (const session of sessions) {
    if (!session.isSubagent || session.workspaceId) continue;
    let home = homeOfChain(session, new Set([session.id]));
    if (!home && typeof session.cwd === "string") {
      const path = session.cwd.replace(/[\\/]+$/, "").toLowerCase();
      const workspaceId = workspaceByPath.get(path);
      if (workspaceId) home = { workspaceId, workspaceTitle: titleOfWorkspace(workspaceId) };
    }
    if (!home) continue;
    session.workspaceId = home.workspaceId;
    session.workspaceTitle = home.workspaceTitle;
  }

  // 子会话的归档 (P32). Archiving a parent has to grey its whole subtree, and
  // DSH's `archivedSessionIds` only ever names the parent — a child is never in
  // it. Deriving the child's state from the ancestor chain (instead of writing
  // one archivedSessionId per child) keeps "this run is archived" a single fact
  // and survives a child that is created later. A child archived on its own
  // stays archived: the walk stops at the first true.
  /** @type {Map<string, boolean>} */
  const archivedUp = new Map();
  /**
   * @param {object} session
   * @returns {boolean}
   */
  const isArchivedUp = (session) => {
    if (session.archived) return true;
    const memo = archivedUp.get(session.id);
    if (memo !== undefined) return memo;
    // Cycle guard: a chain that loops must not recurse forever.
    archivedUp.set(session.id, false);
    const parent = session.parentSession ? byId.get(session.parentSession) : null;
    const value = parent ? isArchivedUp(parent) : false;
    archivedUp.set(session.id, value);
    return value;
  };
  for (const session of sessions) {
    if (!session.isSubagent) continue;
    session.archived = isArchivedUp(session);
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


