/**
 * dsh-session-explorer — the read pipeline behind `/bootstrap` and `/sessions`.
 *
 * Three sources, one merged answer (see lib/domain/sessions.js for the merge
 * rules). This module owns the I/O and the caching policy:
 *
 *   L2 headers  — the expensive-but-truthful path: directory walk + one zstd
 *                 frame per session. Cached in-process and invalidated by a
 *                 short TTL, because a listing that re-decodes every header on
 *                 every keystroke would be a visible stall.
 *   L1 cache    — one small JSON per session, re-read on every request. It is
 *                 the cheapest source and the most volatile (DSH rewrites it as
 *                 the user types), so it is never cached here.
 *   registry    — live service when available, durable file otherwise.
 *
 * The TTL is deliberately short: correctness of "did a new session appear" must
 * not lag more than a second or two behind the sidebar, while still collapsing
 * a burst of requests into one walk.
 */

import { buildSessionView } from "../domain/sessions.js";
import { buildAutoTree } from "../domain/tree.js";
import { readAllHeaders } from "../sources/heads.js";
import { projcacheDir, readProjcache } from "../sources/projcache.js";
import { readWorkspaceFile, readWorkspaceService } from "../sources/workspaces.js";

/** How long a header scan stays fresh, in milliseconds. */
export const HEADER_TTL_MS = 1500;

/**
 * @typedef {object} Snapshot
 * @property {object[]} sessions merged, sorted session list
 * @property {object} view the merged view (for scoped queries)
 * @property {any} tree derived tree
 * @property {any} registry normalized registry
 * @property {object} stats counters (source mix, timings)
 * @property {number} scannedAt epoch ms of the header scan behind this snapshot
 */

/**
 * Create the reader. One instance per plugin instance.
 *
 * @param {object} options
 * @param {() => string} options.dshHome resolves the DSH home each call, so a
 *   relocation is picked up without a restart
 * @param {() => any} [options.workspaceService] live `ctx.workspaceRegistry`
 * @param {() => Set<string>} [options.runningIds] live session ids
 * @param {() => Promise<{ userTree: object | null, trashedIds: Set<string> }>} [options.overlay]
 *   the sidecar state that decorates the derived tree: user folders, placements
 *   and the trash index. Async because the documents live on disk.
 * @param {number} [options.ttlMs]
 */
export function createReader(options) {
  const ttlMs = options.ttlMs ?? HEADER_TTL_MS;

  /** @type {{ headers: Map<string, object>, at: number } | null} */
  let headerCache = null;
  /** @type {Promise<Map<string, object>> | null} */
  let inflight = null;
  /**
   * Bumped by `invalidate()`. A walk that started before the bump must not
   * publish its result: it read the tree before the change that invalidated it,
   * and writing it back would resurrect the state the caller just dropped.
   */
  let epoch = 0;

  /**
   * Header map, reusing the last scan when it is still fresh.
   *
   * Concurrent callers share one walk: a burst of requests must not multiply
   * the filesystem cost.
   *
   * @param {boolean} refresh force a rescan
   * @returns {Promise<Map<string, object>>}
   */
  async function headers(refresh) {
    const now = Date.now();
    if (!refresh && headerCache && now - headerCache.at < ttlMs) return headerCache.headers;
    if (inflight) {
      // A refresh must not join a walk that began before the write it is
      // refreshing for; let the older walk finish, then read the tree again.
      if (!refresh) return inflight;
      await inflight.catch(() => {});
    }
    const startedEpoch = epoch;
    /** @type {Promise<Map<string, object>>} */
    const walk = readAllHeaders(options.dshHome())
      .then((headers) => {
        if (startedEpoch === epoch) headerCache = { headers, at: Date.now() };
        return headers;
      })
      .finally(() => {
        if (inflight === walk) inflight = null;
      });
    inflight = walk;
    return walk;
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.refresh] bypass the header TTL
   * @returns {Promise<Snapshot>}
   */
  async function snapshot(opts = {}) {
    const startedAt = performance.now();
    const home = options.dshHome();
    const [headerMap, cacheMap, registry, overlay] = await Promise.all([
      headers(opts.refresh === true),
      readProjcache(projcacheDir(home)),
      readRegistry(),
      safeOverlay(),
    ]);

    const running = safeRunning();
    const trashedIds = overlay.trashedIds;
    const view = buildSessionView({
      headers: headerMap,
      projcache: cacheMap,
      registry,
      running,
      annotations: overlay.annotations,
    });
    // Trashed sessions are removed from the live view: they belong to the trash
    // node and must not be counted (or searched) as if they were still there.
    const live = view.sessions.filter((session) => !trashedIds.has(session.id));
    const trashed = view.sessions.filter((session) => trashedIds.has(session.id));
    const tree = buildAutoTree({
      registry,
      sessions: view.sessions,
      trashedIds,
      userTree: overlay.userTree,
    });

    return {
      sessions: live,
      trashed,
      view: { sessions: view.sessions, live, trashed },
      tree,
      registry,
      annotations: overlay.annotations,
      stats: {
        ...view.stats,
        trashed: trashed.length,
        projcacheEntries: cacheMap.size,
        workspaces: registry?.workspaceIds.length ?? 0,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      },
      scannedAt: headerCache?.at ?? Date.now(),
    };
  }

  /**
   * Registry: live service first, durable file second.
   *
   * @returns {Promise<any | null>}
   */
  async function readRegistry() {
    const file = await readWorkspaceFile(options.dshHome()).catch(() => null);
    try {
      const service = options.workspaceService?.();
      const live = readWorkspaceService(service);
      if (live && live.workspaceIds.length > 0) {
        // The live service does not expose `defaultWorkspaceId`, but the tree
        // needs it to label one workspace 默认工作区. The durable file still
        // carries it, so prefer the file's value when the ids agree.
        const defaultWorkspaceId =
          file?.defaultWorkspaceId && live.workspaces.has(file.defaultWorkspaceId)
            ? file.defaultWorkspaceId
            : live.defaultWorkspaceId;
        return { ...live, defaultWorkspaceId };
      }
    } catch {
      /* fall through to the file */
    }
    return file;
  }

  /** @returns {Set<string>} */
  function safeRunning() {
    try {
      const ids = options.runningIds?.();
      return ids instanceof Set ? ids : new Set();
    } catch {
      return new Set();
    }
  }

  /**
   * The sidecar overlay. A broken or missing document degrades to "no user
   * folders, empty trash" rather than failing the listing: the derived tree is
   * always renderable on its own.
   *
   * @returns {Promise<{ userTree: object | null, trashedIds: Set<string>, annotations: Record<string, any> }>}
   */
  async function safeOverlay() {
    const empty = { userTree: null, trashedIds: new Set(), annotations: {} };
    if (typeof options.overlay !== "function") return empty;
    try {
      const overlay = await options.overlay();
      return {
        userTree: overlay?.userTree ?? null,
        trashedIds: overlay?.trashedIds instanceof Set ? overlay.trashedIds : new Set(),
        annotations: overlay?.annotations ?? {},
      };
    } catch {
      return empty;
    }
  }

  return {
    snapshot,
    invalidate() {
      epoch += 1;
      headerCache = null;
    },
    get headerCacheAge() {
      return headerCache ? Date.now() - headerCache.at : null;
    },
  };
}
