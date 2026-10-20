/**
 * dsh-session-explorer — host half.
 *
 * A Cordis plugin loaded as an out-of-tree bundle row (see cordis.patch.yml).
 * It owns the server side of the session explorer: a single `/session-explorer/api`
 * prefix route registered on the DSH webserver, plus the sidecar store that
 * lives in a directory next to `~/.dsh` (see lib/paths.js).
 *
 * Scope of this file: service wiring, route dispatch, capability probing and
 * error mapping. Business logic lives in `domain/`, data access in `sources/`
 * and `store/`; nothing else is invented here.
 *
 * The plugin declares `webServer` as its only hard dependency: a profile
 * without an HTTP server has no browser half either, so there is nothing to do
 * there and the loader should skip the row entirely.
 */

import { PLUGIN_ID } from "./constants.js";
import { capabilities as probeCapabilities, getService } from "./capabilities.js";
import { resolveDataDir, ensureDataDir, dataPaths } from "./paths.js";
import { fail, ok, readJsonBody, routeOf, send } from "./http.js";
import { dshHome } from "./dsh/home.js";
import { createReader } from "./sources/reader.js";
import { canMove } from "./domain/tree.js";
import { mergeSettings, normalizeSettings } from "./domain/settings.js";
import {
  archiveSession,
  forkSession,
  pinSession,
  renameSession,
  renameWorkspace,
  unarchiveSession,
  unpinSession,
} from "./host/actions.js";
import {
  addLibraryTag,
  idsWithFlag,
  patchAnnotation,
  removeLibraryTag,
  tagIndex,
  tagVocabulary,
} from "./domain/annotations.js";
import { createFolder, deleteFolder, moveNode, renameFolder, reorderNode } from "./domain/folders.js";
import { describeDataDir, inspectDataDir, migrateDataDir } from "./host/datadir.js";
import { moveSessions } from "./host/move.js";
import { emptyTrash, purgeSessions, reconcileTrash, restoreSessions, trashSessions } from "./host/trash.js";
import { sortedEntries, trashedSessionOf } from "./domain/trash.js";
import { openDocuments } from "./store/documents.js";
import { codedError } from "./store/sidecar.js";
import { componentManagerFor } from "./component/manager.js";
import { createDetachedController } from "./detached/launcher.js";
import { join } from "node:path";

export const name = "dsh-session-explorer";
export const inject = ["webServer"];

/**
 * @typedef {(api: PluginApi, req: any, res: any, url: URLSearchParams, params: Record<string, string>) => Promise<any> | any} RouteHandler
 */

/**
 * @param {any} ctx
 */
export function apply(ctx) {
  const webServer = getService(ctx, "webServer");
  if (!webServer || typeof webServer.register !== "function") return;

  // The data directory is mutable: a completed migration moves it, and every
  // later request must read and write the new location without a restart.
  let dataDir = resolveDataDir();
  let paths = dataPaths(dataDir);
  let documents = openDocuments(paths);

  const openAt = (dir) => {
    const created = ensureDataDir(dir);
    if (created.created) log(ctx, "info", `data directory created at ${dir}`);
    dataDir = dir;
    paths = dataPaths(dir);
    documents = openDocuments(paths);
  };
  openAt(dataDir);

  // ── browser component + detached window ─────────────────────────────────
  // Both are optional: the plugin is fully usable without the component, and
  // `POST /detached/open` is refused (with a reason) until it is ready.
  const componentFor = (dir) => componentManagerFor(dir, { ctx });
  let component = componentFor(dataDir);
  let detached = null;

  const detachedFor = () => {
    if (detached) return detached;
    detached = createDetachedController({
      dataDir,
      helperMain: join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "detached", "main.js"),
      runtime: async () => {
        const status = await component.status();
        return { binary: component.paths.binary, ready: status.phase === "ready" };
      },
      webPort: () => (typeof webServer.port === "number" ? webServer.port : Number(process.env.DSH_WEB_PORT ?? 0)),
      log: (level, message) => log(ctx, level === "warn" ? "warn" : "info", message),
      profileKey: dataDir,
    });
    return detached;
  };

  /** @type {PluginApi} */
  const api = {
    ctx,
    get dataDir() {
      return dataDir;
    },
    get paths() {
      return paths;
    },
    get documents() {
      return documents;
    },
    /** A migration in flight, or null. Writes are refused while it is set. */
    migration: null,
    /** Point the plugin at another directory (used by the migration). */
    reopen: (dir) => {
      openAt(dir);
      // The component lives inside the data directory, so a migration moves it
      // too: the manager has to be rebuilt for the new root.
      component = componentFor(dir);
      detached = null;
    },
    /** Browser component state machine (install / remove / status). */
    get component() {
      return component;
    },
    /** Detached window controller (spawn / focus / close). */
    get detached() {
      return detachedFor();
    },
    capabilities: () =>
      probeCapabilities(ctx, {
        dataDir,
        component: component.snapshot.phase,
      }),
    reader: createReader({
      dshHome: () => dshHome(),
      // Live services are optional: `getService` is re-asked on every read, so
      // a row that appears after this plugin was applied is still picked up.
      workspaceService: () => getService(ctx, "workspaceRegistry") ?? getService(ctx, "workspaces"),
      runningIds: () => runningSessionIds(ctx),
      // The sidecar decorates the derived tree: user folders, placements and the
      // trash index. A broken document degrades to "no folders, empty trash" in
      // the reader rather than failing the whole listing.
      overlay: () => readOverlay(documents),
    }),
  };

  // A crash between "index entry written" and "payload moved" is reconciled
  // here: the entry is promoted when its payload arrived, dropped when it did
  // not. Best effort — a failure must never stop the plugin from serving.
  reconcileTrash(api).catch(() => {});

  // A component uninstall that could not delete its runtime (DSH had
  // `default_app.asar` open) left the paths on a pending list. This is the
  // first moment they can be removed: the process that held the handles is the
  // one that just exited. Best effort, and deliberately not awaited — the
  // plugin must serve requests immediately.
  component
    .sweep()
    .then((result) => {
      if (result?.removed?.length > 0) {
        log(ctx, "info", `browser component: removed ${result.removed.length} leftover director(ies) from a previous uninstall`);
      }
    })
    .catch(() => {});

  const dispose = webServer.register({
    kind: "prefix",
    path: "/session-explorer/api",
    handler: (req, res) => handle(api, req, res),
  });

  if (typeof dispose === "function") {
    ctx.effect?.(() => dispose, "session-explorer: api routes");
  }
}

/**
 * @param {any} ctx
 * @param {"info" | "warn" | "error"} level
 * @param {string} message
 */
function log(ctx, level, message) {
  try {
    const logger = typeof ctx.logger === "function" ? ctx.logger(name) : ctx.logger;
    const write = logger?.[level];
    if (typeof write === "function") write.call(logger, message);
  } catch {
    /* logging must never break a request */
  }
}

/**
 * The sidecar state the reader needs, in one round trip.
 *
 * @param {ReturnType<typeof openDocuments>} documents
 * @returns {Promise<{ userTree: object, trashedIds: Set<string>, annotations: Record<string, any> }>}
 */
async function readOverlay(documents) {
  const [tree, annotations, trash] = await Promise.all([
    documents.tree.read(),
    documents.annotations.read(),
    documents.trash.read(),
  ]);
  return {
    userTree: {
      revision: tree.revision,
      folders: tree.folders ?? {},
      placement: tree.placement ?? {},
      workspaceOrder: tree.workspaceOrder ?? {},
    },
    trashedIds: new Set(Object.keys(trash.entries ?? {})),
    annotations: annotations.sessions ?? {},
  };
}

/**
 * Ids of sessions that are live in this process right now.
 *
 * The session registry exposes them either as a map-like `list()` or as `ids`;
 * both shapes are probed so a kernel change cannot break the listing.
 *
 * @param {any} ctx
 * @returns {Set<string>}
 */
function runningSessionIds(ctx) {
  const sessions = getService(ctx, "sessions");
  /** @type {Set<string>} */
  const ids = new Set();
  if (!sessions) return ids;
  try {
    if (Array.isArray(sessions.ids)) for (const id of sessions.ids) ids.add(String(id));
    else if (typeof sessions.list === "function") {
      const listed = sessions.list();
      if (Array.isArray(listed)) {
        for (const entry of listed) {
          const id = typeof entry === "string" ? entry : entry?.id;
          if (id) ids.add(String(id));
        }
      }
    }
  } catch {
    /* an unreadable registry just means "nothing is marked running" */
  }
  return ids;
}

/**
 * @typedef {object} PluginApi
 * @property {any} ctx
 * @property {string} dataDir
 * @property {ReturnType<typeof dataPaths>} paths
 * @property {ReturnType<typeof openDocuments>} documents
 * @property {() => ReturnType<typeof probeCapabilities>} capabilities
 * @property {ReturnType<typeof createReader>} reader
 */

/** @type {Record<string, RouteHandler>} */
const ROUTES = {
  /**
   * Everything the panel needs, in one round trip.
   *
   * The header scan is TTL-cached, so opening the panel repeatedly is cheap;
   * `?refresh=1` (the refresh button, and the client after a mutation) forces a
   * full rescan instead of waiting out the TTL.
   */
  "GET /bootstrap": async (api, _req, _res, query) => {
    const snapshot = await api.reader.snapshot({ refresh: query?.get("refresh") === "1" });
    const [annotations, settings, tree, trash] = await Promise.all([
      api.documents.annotations.read(),
      api.documents.settings.read(),
      api.documents.tree.read(),
      api.documents.trash.read(),
    ]);
    return {
      hello: { plugin: PLUGIN_ID, schema: 1 },
      capabilities: api.capabilities(),
      workspaces: serializeWorkspaces(snapshot.registry),
      sessions: snapshot.sessions,
      // A trashed session's log has physically left DSH's sessions tree, so the
      // merged view cannot describe it any more. The index entry is the only
      // remaining description, which is exactly why it snapshots the title.
      trashed: sortedEntries(trash.entries).map(trashedSessionOf),
      tree: snapshot.tree,
      // tagLibrary is the picker's vocabulary (presets first, then tags that
      // only exist on sessions); tags stays the plain usage index the filter
      // list was built on.
      tags: tagIndex(annotations),
      tagLibrary: tagVocabulary(annotations),
      favorites: idsWithFlag(annotations, "favorite"),
      todos: idsWithFlag(annotations, "todo"),
      settings: normalizeSettings(settings),
      revisions: {
        tree: tree.revision,
        annotations: annotations.revision,
        settings: settings.revision,
      },
      stats: snapshot.stats,
      scannedAt: snapshot.scannedAt,
    };
  },

  /**
   * The tag vocabulary: the shared library first (in creation order), then the
   * tags that are only in use on sessions. `tags` keeps the plain usage index
   * for callers that only want counts.
   */
  "GET /tags": async (api) => {
    const annotations = await api.documents.annotations.read();
    return { tags: tagIndex(annotations), library: tagVocabulary(annotations) };
  },

  /** Add a tag to the shared library (the user's own vocabulary). */
  "POST /tags": async (api, req) => {
    const tag = requireText(req.body?.tag, "tag");
    const document = await api.documents.annotations.mutate(
      (draft) => {
        draft.tags = addLibraryTag(draft.tags, tag);
      },
      expectedRevision(req, api),
    );
    return { tag, library: tagVocabulary(document), revision: document.revision };
  },

  /** Remove a tag from the library. Sessions that carry it keep it. */
  "DELETE /tags/:tag": async (api, req) => {
    const tag = String(req.params.tag ?? "");
    if (!tag) throw badRequest("tag is required");
    const document = await api.documents.annotations.mutate(
      (draft) => {
        draft.tags = removeLibraryTag(draft.tags, tag);
      },
      expectedRevision(req, api),
    );
    return { tag, library: tagVocabulary(document), revision: document.revision };
  },

  /** Patch one session's annotation (tags / note / 收藏 / 待办). */
  "PATCH /annotations/:id": async (api, req) => {
    const id = String(req.params.id ?? "");
    if (!id) throw badRequest("session id is required");
    const patch = req.body && typeof req.body === "object" ? req.body : {};
    const document = await api.documents.annotations.mutate(
      (draft) => {
        patchAnnotation(draft, id, patch, Date.now());
      },
      expectedRevision(req, api),
    );
    return {
      id,
      annotation: document.sessions[id] ?? null,
      revision: document.revision,
      tags: tagIndex(document),
      favorites: idsWithFlag(document, "favorite"),
      todos: idsWithFlag(document, "todo"),
    };
  },

  /** Create a folder (新建文件夹). */
  "POST /folders": async (api, req) => {
    const snapshot = await api.reader.snapshot({});
    const body = req.body ?? {};
    /** @type {string} */
    let created = "";
    const document = await api.documents.tree.mutate(
      (draft) => {
        created = createFolder(draft, { name: body.name, parent: body.parent }, snapshot.tree, newId);
      },
      expectedRevision(req, api),
    );
    return { id: created, folder: document.folders[created], revision: document.revision };
  },

  /** Rename a folder. */
  "PATCH /folders/:id": async (api, req) => {
    const id = String(req.params.id ?? "");
    const body = req.body ?? {};
    const document = await api.documents.tree.mutate(
      (draft) => {
        if (typeof body.name === "string") renameFolder(draft, id, body.name);
      },
      expectedRevision(req, api),
    );
    return { id, folder: document.folders[id] ?? null, revision: document.revision };
  },

  /** Delete a folder, lifting its contents to the parent first. */
  "DELETE /folders/:id": async (api, req, _res, query) => {
    const id = String(req.params.id ?? "");
    const snapshot = await api.reader.snapshot({});
    const liftContents = query?.get("lift") !== "0";
    /** @type {any} */
    let result = null;
    const document = await api.documents.tree.mutate(
      (draft) => {
        result = deleteFolder(draft, id, snapshot.tree, { liftContents });
      },
      expectedRevision(req, api),
    );
    return { ...result, revision: document.revision };
  },

  /** Move a folder or workspace to a new parent. */
  "POST /nodes/:id/move": async (api, req) => {
    const nodeId = String(req.params.id ?? "");
    const parentId = String(req.body?.parent ?? "");
    if (!parentId) throw badRequest("parent is required");
    const snapshot = await api.reader.snapshot({});
    const verdict = canMove(nodeId, parentId, snapshot.tree);
    if (!verdict.ok) throw codedError(verdict.code, verdict.message);
    const document = await api.documents.tree.mutate(
      (draft) => {
        moveNode(draft, nodeId, parentId);
      },
      expectedRevision(req, api),
    );
    return { nodeId, parent: parentId, revision: document.revision };
  },

  /** Reorder a node among its siblings. */
  "POST /nodes/:id/order": async (api, req) => {
    const nodeId = String(req.params.id ?? "");
    const order = Number(req.body?.order);
    const document = await api.documents.tree.mutate(
      (draft) => {
        reorderNode(draft, nodeId, order);
      },
      expectedRevision(req, api),
    );
    return { nodeId, order, revision: document.revision };
  },

  /**
   * The settings document on its own, for the settings page.
   *
   * `/bootstrap` carries the same object, but the settings page mounts outside
   * the panel and must not pay for a full session scan just to render.
   */
  "GET /settings": async (api) => {
    const document = await api.documents.settings.read();
    return {
      settings: normalizeSettings(document),
      revision: document.revision,
      capabilities: api.capabilities(),
      dataDir: api.dataDir,
    };
  },

  /**
   * Panel settings that must follow the user across browsers.
   *
   * The body is a partial document — nested groups may be sent alone, e.g.
   * `{ shell: { modal: { dim: 0.2 } } }` — and unknown keys are dropped by
   * `mergeSettings` instead of being persisted.
   */
  "PUT /settings": async (api, req) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const document = await api.documents.settings.mutate(
      (draft) => {
        Object.assign(draft, mergeSettings(draft, body));
      },
      expectedRevision(req, api),
    );
    return { settings: normalizeSettings(document), revision: document.revision };
  },

  /**
   * Cross-workspace move / copy.
   *
   * `{ ids, target: { workspaceId }, copy? }` — the artifact is re-homed (its
   * header cwd rewritten, the directory relocated) and the registry accounting
   * swapped in one transaction; see lib/host/move.js. `copy: true` writes a
   * second, independent session under a fresh id instead of moving.
   */
  "POST /move": async (api, req) => moveSessions(api, req.body ?? {}),

  /**
   * Move sessions to the trash.
   *
   * This is a real move: the session directory leaves DSH's sessions tree, so
   * the session disappears from DSH's own sidebar too. That is the point — the
   * bin is a bin, not a filter — and it is also why restore has to put the
   * payload back where it came from (see lib/host/trash.js).
   */
  "POST /trash": async (api, req) => trashSessions(api, req.body?.ids),

  /** Put sessions back. Ids that are not in the bin are skipped, not refused. */
  "POST /restore": async (api, req) => restoreSessions(api, req.body?.ids),

  /** Delete payloads for good. */
  "POST /purge": async (api, req) => purgeSessions(api, req.body?.ids),

  /** Empty the bin in one call. */
  "POST /trash/empty": async (api) => emptyTrash(api),

  /**
   * Rename a session.
   *
   * This is DSH's own rename: it appends a user-authored `session/title` event
   * and supersedes automatic title generation, so the name survives later
   * turns. Nothing is written to a sidecar.
   */
  "POST /sessions/:id/rename": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    const title = requireText(req.body?.title, "title");
    return renameSession(api, sessionId, title);
  },

  /** Rename a workspace. Duplicate names are rejected by DSH itself. */
  "POST /workspaces/:id/rename": async (api, req) => {
    const workspaceId = String(req.params.id ?? "");
    const title = requireText(req.body?.title, "title");
    return renameWorkspace(api, workspaceId, title);
  },

  /**
   * Archive a session: it stays where it is and keeps its log, it is only
   * de-emphasised in the list (hard constraint 3). A session with running work
   * is refused unless `stopActivity` is passed.
   */
  "POST /sessions/:id/archive": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    return archiveSession(api, sessionId, { stopActivity: req.body?.stopActivity === true });
  },

  /** Un-archive; idempotent, as in DSH. */
  "POST /sessions/:id/unarchive": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    return unarchiveSession(api, sessionId);
  },

  /** Pin to the top; DSH refuses to pin an archived session. */
  "POST /sessions/:id/pin": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    return pinSession(api, sessionId);
  },

  /** Un-pin; idempotent, as in DSH. */
  "POST /sessions/:id/unpin": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    return unpinSession(api, sessionId);
  },

  /**
   * Fork a session into a child that continues from `atSeq`, or from the latest
   * completed turn when it is omitted — the same default as the official fork.
   */
  "POST /sessions/:id/fork": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    const atSeq = Number(req.body?.atSeq);
    return forkSession(api, sessionId, Number.isSafeInteger(atSeq) ? atSeq : undefined);
  },

  /**
   * Where the data lives right now, and what is in it.
   *
   * The settings page shows this before offering a migration, so a user can see
   * how large a move would be and whether the environment overrides the
   * location (a `DSH_SE_DATA_DIR` override makes a migration pointless).
   */
  "GET /datadir": async (api) => describeDataDir(api),

  /**
   * Pre-flight for a migration: validate the target and report the plan
   * without touching anything.
   */
  "POST /datadir/inspect": async (api, req) => inspectDataDir(api, req.body?.target),

  /**
   * Move the data directory. Blocks other writes for the duration (step 3 of
   * the seven-step flow in 实现粗规划.md §5.5).
   */
  "POST /datadir/migrate": async (api, req) => migrateDataDir(api, req.body ?? {}),

  /** Component status: the one payload the settings page and SSE share. */
  "GET /component/status": async (api) => api.component.status(),

  /**
   * Server-sent progress.
   *
   * Progress is the one place polling alone feels broken: a 110 MB download
   * that only moves every 500 ms reads as a frozen bar. SSE pushes each state
   * change as it happens; the client still polls as a fallback, because a
   * background tab throttles EventSource and a reconnect must not lose the
   * final phase.
   */
  "GET /component/events": async (api, req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (state) => {
      try {
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      } catch {
        /* the client went away; the unsubscribe below cleans up */
      }
    };

    send(await api.component.status());
    const unsubscribe = api.component.subscribe((state) => send(state));
    const keepAlive = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch {
        /* handled by close */
      }
    }, 15_000);
    keepAlive.unref?.();

    const close = () => {
      clearInterval(keepAlive);
      unsubscribe();
      try {
        res.end();
      } catch {
        /* already ended */
      }
    };
    req.on("close", close);
    req.on("aborted", close);
    // The handler owns the response now; `handle()` must not write an envelope.
    return undefined;
  },

  /** Start (or resume) the component install. */
  "POST /component/install": async (api, req) => api.component.install(req.body ?? {}),

  /** Cancel an in-flight install, keeping the partial download for a resume. */
  "POST /component/cancel": async (api) => api.component.cancel(),

  /** Delete the component. Refuses while the detached window is running. */
  "POST /component/remove": async (api) =>
    api.component.remove({
      closeHelper: async () => {
        if (!api.detached.running) return true;
        return api.detached.close();
      },
    }),

  /** Retry after an error; an existing .part resumes instead of restarting. */
  "POST /component/retry": async (api, req) => api.component.install(req.body ?? {}),

  /** Open (or focus) the detached window. */
  "POST /detached/open": async (api) => {
    const status = await api.component.status();
    if (status.phase !== "ready") {
      throw codedError("component-not-installed", "download the browser component before opening a detached window");
    }
    const result = await api.detached.open();
    return { open: true, ...result };
  },

  /** Bring the detached window forward without spawning another one. */
  "POST /detached/focus": async (api) => api.detached.focus(),

  /** Close the detached window. */
  "POST /detached/close": async (api) => ({ closed: await api.detached.close() }),

};

/**
 * A required, non-blank string from a request body.
 *
 * Whitespace-only titles are rejected here so the error is a `bad-request`
 * with a readable message instead of whatever the native layer happens to say.
 *
 * @param {any} value
 * @param {string} field
 * @returns {string}
 */
function requireText(value, field) {
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === "") throw badRequest(`${field} must not be blank`);
  return trimmed;
}

/**
 * The revision a mutating request expects. `If-Match` is the header form;
 * `revision` in the body is the JSON form. Omitting both means "last writer
 * wins", which is what a single-window user expects.
 *
 * @param {any} req
 * @param {PluginApi} api
 * @returns {number | undefined}
 */
function expectedRevision(req, _api) {
  const header = req.headers?.["if-match"];
  if (typeof header === "string" && header.trim() !== "") {
    const value = Number(header.replace(/"/g, ""));
    if (Number.isFinite(value)) return value;
  }
  const body = req.body?.revision;
  if (Number.isFinite(body)) return body;
  return undefined;
}

/**
 * A short, collision-resistant id for a new folder.
 *
 * @returns {string}
 */
function newId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/**
 * @param {any} registry normalized registry (service or file)
 * @returns {{ workspaces: object[] }}
 */
function serializeWorkspaces(registry) {
  if (!registry) return { workspaces: [] };
  return {
    workspaces: registry.workspaceIds
      .map((id) => registry.workspaces.get(id))
      .filter(Boolean)
      .map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessionIds: workspace.sessionIds,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })),
  };
}

/**
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function badRequest(message) {
  return codedError("bad-request", message);
}

/**
 * Compile a route pattern into a matcher. Patterns may carry `:name` segments;
 * everything else is literal.
 *
 * @param {string} pattern e.g. `PATCH /folders/:id`
 * @returns {{ method: string, segments: string[], match: (path: string) => Record<string, string> | null }}
 */
function compileRoute(pattern) {
  const [method, path] = pattern.split(" ");
  const segments = path.split("/").filter(Boolean);
  return {
    method,
    segments,
    match(candidate) {
      const parts = candidate.split("/").filter(Boolean);
      if (parts.length !== segments.length) return null;
      /** @type {Record<string, string>} */
      const params = {};
      for (let index = 0; index < segments.length; index += 1) {
        const expected = segments[index];
        const actual = parts[index];
        if (expected.startsWith(":")) {
          params[expected.slice(1)] = decodeURIComponent(actual);
          continue;
        }
        if (expected !== actual) return null;
      }
      return params;
    },
  };
}

const COMPILED = Object.entries(ROUTES).map(([pattern, handler]) => ({
  ...compileRoute(pattern),
  handler,
}));

/**
 * Dispatch one request against the route table.
 *
 * @param {PluginApi} api
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handle(api, req, res) {
  const route = routeOf(req.url);
  if (!route) return fail(res, 404, "bad-request", "unknown route");

  const method = (req.method ?? "GET").toUpperCase();
  /** @type {any} */
  let matched = null;
  /** @type {Record<string, string>} */
  let params = {};
  for (const entry of COMPILED) {
    if (entry.method !== method) continue;
    const result = entry.match(route.path);
    if (result) {
      matched = entry;
      params = result;
      break;
    }
  }
  if (!matched) return fail(res, 404, "bad-request", `no route for ${method} ${route.path}`);

  try {
    // A migration rewrites every sidecar; letting a write through mid-move
    // would either be lost in the copy or resurrect the old directory.
    if (api.migration && method !== "GET" && method !== "HEAD" && !route.path.startsWith("/datadir")) {
      throw codedError("migration-in-progress", "a data directory migration is running");
    }
    if (method !== "GET" && method !== "HEAD") {
      /** @type {any} */ (req).body = await readJsonBody(req);
    }
    /** @type {any} */ (req).params = params;
    const result = await matched.handler(api, req, res, route.query, params);
    // A streaming route (SSE) has already taken over the response: writing an
    // envelope after its headers would corrupt the event stream.
    if (res.writableEnded || res.headersSent) return;
    ok(res, result);
  } catch (err) {
    const code = errorCodeOf(err);
    const status = statusFor(code);
    log(api.ctx, "warn", `${method} ${route.path} failed: ${err?.message ?? err}`);
    if (!res.writableEnded) fail(res, status, code, String(err?.message ?? err));
  }
}

/**
 * The code a thrown value should be reported under.
 *
 * Native DSH errors carry a namespaced `RemoteError.code` such as
 * `workspace/name-conflict` or `session/title-invalid`. Those are passed
 * through unchanged so the client can branch on the host's own vocabulary
 * instead of a translation layer that would drift.
 *
 * @param {any} err
 * @returns {string}
 */
function errorCodeOf(err) {
  return typeof err?.code === "string" && err.code !== "" ? err.code : "bad-request";
}

/**
 * HTTP status for a plugin error code. Only codes a client can act on get a
 * non-500 status; anything unexpected is a server fault.
 *
 * @param {string} code
 * @returns {number}
 */
function statusFor(code) {
  switch (code) {
    case "bad-request":
    case "gateway/bad-request":
    case "session/title-invalid":
    case "workspace/name-conflict":
      return 400;
    case "session/not-found":
    case "workspace/not-found":
    case "trash-not-found":
      return 404;
    case "target-exists":
    case "session-active":
    case "session-corrupt":
      return 409;
    case "subagent-unsupported":
      return 400;
    case "revision-conflict":
      return 409;
    case "datadir-same":
    case "datadir-not-empty":
    case "migration-in-progress":
      return 409;
    case "component-busy":
    case "component-in-use":
      return 409;
    case "component-not-installed":
      return 404;
    case "component-disk-full":
      return 507;
    case "workspace/session-active":
      return 409;
    case "capability-missing":
      return 501;
    default:
      return 500;
  }
}

// `send` is re-exported for tests that want to inspect the envelope helpers.
export { send };
