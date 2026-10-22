/**
 * 子智能体的绑定规则 (P32).
 *
 * A subagent is not a session of the user's: it is one delegation inside its
 * parent's run. DSH still writes it as a full session directory, so the explorer
 * has to decide, in one place, which operations a child accepts. The answer is
 * "none that change the store": deleting, moving, copying, cutting, favouriting,
 * todo-ing, renaming, forking or archiving a child would either orphan the
 * parent's delegation history or promote a piece of another conversation into a
 * session of its own.
 *
 * What a child *does* accept is the parent's own operations, and those arrive
 * two ways:
 *   - by cascade: the bin takes a parent and every subagent below it together
 *     (see `withDescendants`, used by the trash routes);
 *   - by derivation: a child is archived exactly when an ancestor is (see the
 *     archive pass in domain/sessions.js), so archiving the parent greys the
 *     whole subtree without writing anything per child.
 *
 * `isSubagent` is decided once in domain/sessions.js from the header (`origin`
 * or `delegationDepth`). A fork is not a subagent: it is a copy the user asked
 * for, and it lives on its own.
 */

/**
 * @param {object|null|undefined} session
 * @returns {boolean} true when the session is a delegation of another one.
 */
export function isBound(session) {
  return session?.isSubagent === true;
}

/**
 * Ids of every subagent below `id`, at any depth, parents before children.
 *
 * Depth matters: a subagent may delegate again, and the bin has to take the
 * whole chain. The walk is cycle-guarded because a corrupt sidecar or a
 * hand-edited header must not hang the route.
 *
 * @param {Array<object>} sessions
 * @param {string} id
 * @returns {string[]}
 */
export function descendantsOf(sessions, id) {
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const session of sessions) {
    if (!isBound(session) || !session.parentSession) continue;
    const list = children.get(session.parentSession) ?? [];
    list.push(session.id);
    children.set(session.parentSession, list);
  }
  const out = [];
  const seen = new Set([id]);
  const queue = [...(children.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out;
}

/**
 * `ids` plus every subagent below them, deduped and in input order.
 *
 * Used where a parent operation has to reach its children (trash, purge,
 * restore). Ids that name no session are dropped: the bin routes skip unknown
 * ids anyway, and a child that is not listed cannot be cascaded to.
 *
 * @param {Array<object>} sessions
 * @param {string[]} ids
 * @returns {string[]}
 */
export function withDescendants(sessions, ids) {
  const known = new Set(sessions.map((session) => session.id));
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of descendantsOf(sessions, id)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
    }
  }
  return out;
}

/**
 * The ids in `ids` that are subagents.
 *
 * A standalone operation refuses when this is non-empty; the caller turns the
 * first id into a message the user can act on (open the parent instead).
 *
 * @param {Array<object>} sessions
 * @param {string[]} ids
 * @returns {string[]}
 */
export function boundIds(sessions, ids) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return ids.filter((id) => isBound(byId.get(id)));
}
