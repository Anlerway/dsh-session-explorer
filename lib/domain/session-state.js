/**
 * One session's explorer state, as the buttons DSH renders outside the panel
 * need to see it.
 *
 * Those surfaces (the conversation header strip, the sidebar row's "…" menu)
 * have no bootstrap snapshot: they know one session id. Answering them is
 * therefore a question about three documents, not about the tree, which is why
 * this lives here as a pure function of them — no filesystem, no HTTP, and no
 * second definition of "archived" or "in the bin" to drift from the panel's.
 */

/**
 * @param {{
 *   annotations?: { sessions?: Record<string, { favorite?: boolean, todo?: boolean }> } | null,
 *   trash?: { entries?: Record<string, unknown> } | null,
 *   sessions?: Array<{ id: string, archived?: boolean, trashed?: boolean }> | null,
 * }} documents
 * @param {string} id
 * @returns {{ id: string, favorite: boolean, todo: boolean, archived: boolean, trashed: boolean }}
 */
export function sessionStateOf(documents, id) {
  const entry = documents?.annotations?.sessions?.[id] ?? null;
  const session = (documents?.sessions ?? []).find((candidate) => candidate.id === id) ?? null;
  return {
    id,
    favorite: entry?.favorite === true,
    todo: entry?.todo === true,
    archived: session?.archived === true,
    // Two sources, both authoritative in their own layer: the bin is this
    // plugin's own record (it holds the payload), `trashed` is what DSH reports
    // while a restore is still settling. Either one means "not live".
    trashed: Object.prototype.hasOwnProperty.call(documents?.trash?.entries ?? {}, id) || session?.trashed === true,
  };
}
