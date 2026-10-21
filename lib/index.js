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
import { canAcceptSessions, canMove } from "./domain/tree.js";
import { mergeSettings, normalizeSettings } from "./domain/settings.js";
import {
  archiveSession,
  deleteWorkspace,
  forkSession,
  pinSession,
  renameSession,
  renameWorkspace,
  revealPath,
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
import { createFolder, deleteFolder, moveNode, renameFolder } from "./domain/folders.js";
import { createShortcut, deleteShortcut } from "./domain/shortcuts.js";
import { describeDataDir, inspectDataDir, migrateDataDir } from "./host/datadir.js";
import { moveSessions } from "./host/move.js";
import { emptyTrash, purgeSessions, reconcileTrash, restoreSessions, trashSessions } from "./host/trash.js";
import { sortedEntries, trashedSessionOf } from "./domain/trash.js";
import { openDocuments } from "./store/documents.js";
import { codedError } from "./store/sidecar.js";
import { componentManagerFor } from "./component/manager.js";
import { createDetachedController } from "./detached/launcher.js";
import { readArtifact } from "./sources/artifact.js";
import { exportFileName, toJsonl, toMarkdown } from "./domain/export.js";
import { createBridge, normalizeCommand, WINDOW_COMMANDS } from "./host/bridge.js";
import { createThemeStore } from "./host/theme.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * The plugin's own directory.
 *
 * `import.meta.dirname` is Node 21+; the URL fallback keeps the module loadable
 * on an older runtime. Both are only ever used to read files, never compared.
 */
const PLUGIN_ROOT = import.meta.dirname ?? new URL(".", import.meta.url).pathname;

/**
 * The detached window's files.
 *
 * Constants, not request parameters: no part of a request decides which file is
 * read, so there is nothing to traverse. The window loads the panel's own module
 * (`lib/client.js`) rather than a second UI — see assets/detached/shim.js.
 */
const UI_ASSETS = Object.freeze({
  page: join(PLUGIN_ROOT, "..", "assets", "detached", "index.html"),
  stylesheet: join(PLUGIN_ROOT, "..", "assets", "detached", "window.css"),
  shim: join(PLUGIN_ROOT, "..", "assets", "detached", "shim.js"),
  module: join(PLUGIN_ROOT, "client.js"),
  react: join(PLUGIN_ROOT, "..", "assets", "vendor", "react.production.min.js"),
  reactDom: join(PLUGIN_ROOT, "..", "assets", "vendor", "react-dom.production.min.js"),
});

export const name = "dsh-session-explorer";
// The plugin needs the HTTP server and nothing else. The detached window no
// longer loads the DSH app (it has its own local page and talks to the API
// through the helper preload), so the `connection` service is not required —
// asking for it would make the plugin refuse to load on a profile that has none.
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
  // The panel and the detached window are two documents that cannot call each
  // other; this is the one place they can meet (see lib/host/bridge.js).
  const bridge = createBridge();
  // The live palette, pushed by the panel and read by the detached window.
  const theme = createThemeStore();

  const detachedFor = () => {
    if (detached) return detached;
    detached = createDetachedController({
      dataDir,
      // `.cjs` on purpose: this package sets "type": "module", so a `.js`
      // file is loaded as ESM and the helper's `require("electron")` throws
      // "require is not defined in ES module scope" before any window opens.
      helperMain: join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "detached", "main.cjs"),
      runtime: async () => {
        const status = await component.status();
        // `component.binary` resolves against the *installed* runtime name;
        // `component.paths.binary` is the un-stamped default and does not exist
        // once an install has published into a stamped directory.
        return { binary: component.binary, ready: status.phase === "ready" };
      },
      webPort: () => (typeof webServer.port === "number" ? webServer.port : Number(process.env.DSH_WEB_PORT ?? 0)),
      /**
       * Window → Host reports are forwarded to the panel as bridge commands.
       *
       * The helper owns the OS window; whether it was closed by the user, or
       * whether it is still loading, is knowledge only that process has. Passing
       * it through the same bus the window already publishes on means the panel
       * needs no second channel to learn it.
       */
      onEvent: (event) => {
        if (event === "closed") bridge.publish("window-closed", null);
        else if (event === "hello") bridge.publish("window-open", null);
      },
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
    /** The panel ↔ window command bus. */
    bridge,
    /** The panel's last reported palette (see /theme). */
    theme,
    /**
     * The capability snapshot, async because the component phase is.
     *
     * `component.snapshot` is the in-memory record, which starts as `absent`
     * and is only refreshed by `status()` (it reconciles against the disk).
     * Reading the snapshot here answered `absent` for every `/bootstrap` even
     * when the runtime was installed and working, so the panel greyed out
     * 独立窗口 with "没有浏览器组件" on a machine that had one.
     */
    capabilities: async () => {
      const status = await component.status();
      return probeCapabilities(ctx, {
        dataDir,
        component: status.phase,
      });
    },
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

  // The helper is a child process: if the plugin is disabled or reloaded while
  // the detached window is open, nothing else would stop it, and the window
  // would outlive the code that owns it. `stop()` existed but was never called.
  ctx.effect?.(() => () => {
    try {
      api.detached.stop();
    } catch {
      /* the controller may never have been created */
    }
  }, "session-explorer: detached helper");
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
      shortcuts: tree.shortcuts ?? {},
      pins: tree.pins ?? {},
      sessionPlacement: tree.sessionPlacement ?? {},
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
      capabilities: await api.capabilities(),
      workspaces: serializeWorkspaces(snapshot.registry),
      // Each session carries the container node it is shown in (R2) and whether
      // that home is a virtual placement rather than its DSH workspace. Both are
      // derived once, host-side, so the client never replays the rule.
      sessions: withHome(snapshot.sessions, snapshot.tree),
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

  /**
   * Create a shortcut (快捷方式).
   *
   * `{ kind, targetId, parent? }` — a reference, never a move (hard constraint
   * 5). The target keeps living where it lives; 收藏 / 待办 / any folder can hold
   * the row.
   */
  "POST /shortcuts": async (api, req) => {
    const snapshot = await api.reader.snapshot({});
    const body = req.body ?? {};
    /** @type {string} */
    let created = "";
    const document = await api.documents.tree.mutate(
      (draft) => {
        created = createShortcut(
          draft,
          { kind: body.kind, targetId: body.targetId, parent: body.parent, label: body.label },
          newId,
          snapshot.tree,
        );
      },
      expectedRevision(req, api),
    );
    return { id: created, shortcut: document.shortcuts[created], revision: document.revision };
  },

  /** Delete one shortcut. The target is untouched. */
  "DELETE /shortcuts/:id": async (api, req) => {
    const id = String(req.params.id ?? "");
    const document = await api.documents.tree.mutate(
      (draft) => {
        deleteShortcut(draft, id);
      },
      expectedRevision(req, api),
    );
    return { removed: id, revision: document.revision };
  },

  /**
   * Pin / unpin a container (a folder or a workspace).
   *
   * DSH pins sessions; this stores a container pin in the tree sidecar. Both
   * appear in the list's 置顶 group, which is why the two sets live in different
   * stores but one visual band.
   */
  "POST /nodes/:id/pin": async (api, req) => {
    const nodeId = String(req.params.id ?? "");
    if (!nodeId) throw badRequest("node id is required");
    const pinned = req.body?.pinned !== false;
    const document = await api.documents.tree.mutate(
      (draft) => {
        draft.pins ??= {};
        if (pinned) draft.pins[nodeId] = Date.now();
        else delete draft.pins[nodeId];
      },
      expectedRevision(req, api),
    );
    return { nodeId, pinned, revision: document.revision };
  },

  /**
   * Re-home sessions *virtually*: show them under another container without
   * moving their directory.
   *
   * DSH derives a session's workspace from the header `cwd`; changing that means
   * moving the payload, which hard constraint 1 forbids. So a drop onto 未分组
   * (or back into a workspace) writes a grouping override into the sidecar and
   * leaves the file exactly where DSH put it.
   *
   * `{ ids, parent }` — `parent` is a container node id; omitting it (or passing
   * the node the session already lives in) clears the override.
   */
  "POST /sessions/placement": async (api, req) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string" && id) : [];
    if (ids.length === 0) throw badRequest("ids is required");
    const parent = typeof body.parent === "string" && body.parent ? body.parent : "";
    const snapshot = await api.reader.snapshot({});
    const tree = snapshot.tree;
    // Validate against the *live* tree: a placement must name a node that can
    // actually hold sessions, otherwise the row would disappear from every view.
    if (parent) {
      const node = tree.nodes[parent];
      if (!node) throw badRequest("parent node does not exist");
      if (!canAcceptSessions(parent, tree)) throw badRequest("this container cannot hold sessions");
    }
    const document = await api.documents.tree.mutate(
      (draft) => {
        draft.sessionPlacement ??= {};
        for (const id of ids) {
          if (parent) draft.sessionPlacement[id] = parent;
          else delete draft.sessionPlacement[id];
        }
      },
      expectedRevision(req, api),
    );
    return { ids, parent: parent || null, revision: document.revision, sessionPlacement: document.sessionPlacement ?? {} };
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
      capabilities: await api.capabilities(),
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

  /**
   * Delete a workspace registration.
   *
   * DSH keeps the directory and every session log: only the grouping entry goes
   * away, so the sessions fall back to 未分组. That is the behaviour the user
   * asked for ("删除后内部结构解散，其会话归为未分类") and it is also what the
   * native delete means, which is why there is no custom unlink here.
   */
  "POST /workspaces/:id/delete": async (api, req) => {
    const workspaceId = String(req.params.id ?? "");
    if (!workspaceId) throw badRequest("workspace id is required");
    return deleteWorkspace(api, workspaceId);
  },

  /**
   * The theme DSH is using right now, as CSS custom properties.
   *
   * A `file://` window has no access to the app's stylesheet, so every
   * `--dsw-alias-*` token there falls back to a hard-coded dark palette. The
   * panel *does* see the live tokens (it is a child of the app document), so it
   * reports them here on request and the window applies them to its own root.
   *
   * The token list is fixed on purpose: this route exists to theme one window,
   * not to expose an arbitrary CSS scrape of the host UI.
   */
  "GET /theme": async (api, req) => {
    return api.theme.snapshot();
  },

  /**
   * Record the panel's live theme so /theme can answer for the window.
   *
   * Stored in memory: a theme is per-process state (DSH reloads it from its own
   * settings on start), and persisting it would let a stale palette outlive the
   * theme that produced it.
   */
  "POST /theme": async (api, req) => {
    return api.theme.record(req.body ?? {});
  },

  /**
   * The detached window.
   *
   * The window used to be a `file://` page with its own 3.5k-line UI — a second
   * implementation of the panel, kept in step by hand. It now runs the panel's
   * own module: this page, the shim that stands in for DSH while that module
   * mounts, and a stylesheet that turns the floating overlay into a whole
   * window. One UI, two surfaces.
   *
   * Same-origin is the point. A `file://` page cannot import the plugin's
   * module, cannot fetch the API without a token, and gets a CSP of its own; a
   * page served from here is the same origin as `/session-explorer/api`, so the
   * module's existing `fetch("/session-explorer/api/…")` calls work unchanged.
   *
   * These are the only routes that answer with something other than the JSON
   * envelope: each writes its own body, and `handle()` leaves a finished
   * response alone.
   */
  "GET /ui": async (api, req, res) => serveAsset(res, UI_ASSETS.page, "text/html; charset=utf-8"),
  "GET /ui/window.css": async (api, req, res) => serveAsset(res, UI_ASSETS.stylesheet, "text/css; charset=utf-8"),
  "GET /ui/shim.js": async (api, req, res) => serveAsset(res, UI_ASSETS.shim, "text/javascript; charset=utf-8"),
  "GET /ui/client.js": async (api, req, res) => serveAsset(res, UI_ASSETS.module, "text/javascript; charset=utf-8"),
  "GET /ui/react.js": async (api, req, res) => serveAsset(res, UI_ASSETS.react, "text/javascript; charset=utf-8"),
  "GET /ui/react-dom.js": async (api, req, res) => serveAsset(res, UI_ASSETS.reactDom, "text/javascript; charset=utf-8"),

  /** Reveal an arbitrary verified path (a session's cwd) in the file manager. */
  "POST /reveal-path": async (api, req) => {
    const path = typeof req.body?.path === "string" ? req.body.path : "";
    if (!path) throw badRequest("path is required");
    return revealPath(api, path);
  },

  /** Reveal a workspace's directory in the OS file manager. */
  "POST /workspaces/:id/reveal": async (api, req) => {
    const workspaceId = String(req.params.id ?? "");
    const snapshot = await api.reader.snapshot({});
    const workspace = snapshot.registry?.workspaces?.get(workspaceId) ?? null;
    if (!workspace) throw codedError("workspace/not-found", `unknown workspace ${workspaceId}`);
    if (!workspace.path) throw codedError("bad-request", "这个工作区没有记录路径");
    return revealPath(api, workspace.path);
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
   * Export one session's conversation.
   *
   * `?format=md|jsonl` and an optional `&download=1`. The response is the file
   * itself with `Content-Disposition`, not a JSON envelope: the panel hands it
   * to the browser as a download, and a JSON wrapper would force it to rebuild
   * the bytes in the renderer.
   *
   * A trashed session is refused — its payload is no longer in DSH's tree, so
   * there is nothing to read (the bin keeps only a description).
   */
  "GET /export": async (api, req, res, query) => {
    const sessionId = String(query?.get("sessionId") ?? "");
    if (!sessionId) throw badRequest("sessionId is required");
    const format = query?.get("format") === "jsonl" ? "jsonl" : "md";
    const snapshot = await api.reader.snapshot({});
    const session = snapshot.sessions.find((entry) => entry.id === sessionId) ?? null;
    if (!session) throw codedError("session/not-found", `unknown session ${sessionId}`);

    if (!session.logPath) throw codedError("session-not-found", `${sessionId} has no readable log`);
    const artifact = await readArtifact(session.logPath);
    const body = format === "jsonl" ? toJsonl(artifact) : toMarkdown(artifact, { title: session.displayTitle, includeTools: true });
    const fileName = exportFileName(artifact.header, session.displayTitle ?? session.id, format);
    res.statusCode = 200;
    res.setHeader("Content-Type", format === "jsonl" ? "application/jsonl; charset=utf-8" : "text/markdown; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (query?.get("download") === "1") {
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    }
    res.end(body);
    return undefined;
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

  /**
   * Component status: what the settings page polls.
   *
   * Polling, not SSE: the only live number is a download percentage, and the one
   * page that shows it is open for seconds at a time. A push stream nothing ever
   * subscribed to was pure surface.
   */
  "GET /component/status": async (api) => api.component.status(),

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

  /**
   * The bridge's write end: a command from the detached window.
   *
   * Deliberately unauthenticated beyond the helper token the preload attaches:
   * the bus carries no data, only "the user clicked 打开" / "the user asked for a
   * new session", and every consumer still goes through the ordinary routes
   * (and so through the ordinary validation) when it acts on one.
   */
  "POST /bridge/commands": async (api, req) => {
    const command = normalizeCommand(req.body ?? {});
    const published = api.bridge.publish(command.kind, command.payload);
    return { seq: published.seq, kind: published.kind };
  },

  /**
   * The bridge's read end, for the panel.
   *
   * Server-sent events, not polling: the panel is usually closed, and a command
   * is only useful if it lands while the user is looking. `since` lets a
   * reconnecting panel skip what it already ran.
   */
  "GET /bridge/events": async (api, req, res, query) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const write = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* the panel went away; the close handler cleans up */
      }
    };

    // Anything already waiting, so a panel that reconnects does not need a
    // second round trip to catch up.
    const since = Number(query?.get("since") ?? 0);
    write("ready", { cursor: api.bridge.cursor, kinds: WINDOW_COMMANDS });
    for (const command of api.bridge.since(since)) write("command", command);

    const unsubscribe = api.bridge.subscribe((command) => write("command", command));
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
    return undefined;
  },

  /** Open (or focus) the detached window. */
  "POST /detached/open": async (api) => {
    const status = await api.component.status();
    if (status.phase !== "ready") {
      throw codedError("component-not-installed", "download the browser component before opening a detached window");
    }
    const result = await api.detached.open();
    return { open: true, ...result };
  },

  /** Close the detached window. */
  "POST /detached/close": async (api) => ({ closed: await api.detached.close() }),

};

/**
 * Stamp every session with the container node it is shown in.
 *
 * `home` is the resolved answer (a workspace node, a user folder, or 未分组;
 * null when the workspace it names is gone), and `homeOverride` says whether the
 * sidecar pulled it out of that workspace rather than DSH placing it there. The
 * client sorts, groups and drags with those two fields only.
 *
 * @param {object[]} sessions merged session view
 * @param {{ sessionHome?: Record<string, string>, sessionPlacement?: Record<string, string> }} tree
 * @returns {object[]}
 */
function withHome(sessions, tree) {
  const home = tree?.sessionHome ?? {};
  const placement = tree?.sessionPlacement ?? {};
  return sessions.map((session) => ({
    ...session,
    home: home[session.id] ?? null,
    homeOverride: typeof placement[session.id] === "string",
  }));
}

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
  if (typeof header === "string") {
    // An empty entity tag (`""`) states nothing; only an empty *string* means
    // "no expectation", which is different from the legitimate revision 0 of a
    // sidecar that has never been written.
    const tag = header.replace(/"/g, "").trim();
    if (tag !== "") {
      const value = Number(tag);
      if (Number.isFinite(value)) return value;
    }
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
 * Send one of the plugin's own files, unmodified.
 *
 * `no-store` on purpose: the panel and the window must run the same code, and a
 * cached copy of one after a plugin update is exactly the drift this whole
 * arrangement exists to remove.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} file absolute path, from UI_ASSETS only
 * @param {string} type content type
 * @returns {Promise<void>}
 */
async function serveAsset(res, file, type) {
  let body;
  try {
    body = await readFile(file);
  } catch {
    throw codedError("ui-asset-missing", `缺少独立窗口需要的文件：${file}`);
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Length", String(body.byteLength));
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
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

// Re-exported for tests: the envelope helpers, and the two halves of the
// revision contract (how a request states what it expects, and the status a
// mismatch is answered with). Both are pure functions of their arguments, so
// testing them needs no HTTP server.
export { expectedRevision, send, statusFor };
