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
import { pluginDataDir, ensureDataDir, dataPaths } from "./paths.js";
import { fail, ok, readJsonBody, routeOf, send } from "./http.js";
import { dshHome } from "./dsh/home.js";
import { createReader } from "./sources/reader.js";
import { sessionsOfNode } from "./domain/tree.js";

export const name = "dsh-session-explorer";
export const inject = ["webServer"];

/**
 * Route table: `path` → handler. `/bootstrap` is the one the client calls on
 * open; the rest arrive with the features that need them.
 *
 * @typedef {(api: PluginApi, req: any, res: any, url: URLSearchParams) => Promise<any> | any} RouteHandler
 */

/**
 * @param {any} ctx
 */
export function apply(ctx) {
  const webServer = getService(ctx, "webServer");
  if (!webServer || typeof webServer.register !== "function") return;

  const dataDir = pluginDataDir();
  const created = ensureDataDir(dataDir);
  if (created.created) log(ctx, "info", `data directory created at ${dataDir}`);

  /** @type {PluginApi} */
  const api = {
    ctx,
    dataDir,
    paths: dataPaths(dataDir),
    capabilities: () => probeCapabilities(ctx, { dataDir }),
    reader: createReader({
      dshHome: () => dshHome(),
      // Live services are optional: `getService` is re-asked on every read, so
      // a row that appears after this plugin was applied is still picked up.
      workspaceService: () => getService(ctx, "workspaceRegistry") ?? getService(ctx, "workspaces"),
      runningIds: () => runningSessionIds(ctx),
    }),
  };

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
    return {
      hello: { plugin: PLUGIN_ID, schema: 1 },
      capabilities: api.capabilities(),
      workspaces: serializeWorkspaces(snapshot.registry),
      sessions: snapshot.sessions,
      tree: snapshot.tree,
      stats: snapshot.stats,
      scannedAt: snapshot.scannedAt,
    };
  },

  /** Sessions only — the panel polls this when it wants fresher numbers. */
  "GET /sessions": async (api, _req, _res, query) => {
    const snapshot = await api.reader.snapshot({ refresh: query?.get("refresh") === "1" });
    return { sessions: snapshot.sessions, stats: snapshot.stats, scannedAt: snapshot.scannedAt };
  },

  /** Sessions under one tree node; the client keeps the tree and asks per node. */
  "GET /sessions/by-node": async (api, _req, _res, query) => {
    const nodeId = query?.get("node") ?? "";
    if (!nodeId) throw badRequest("node is required");
    const snapshot = await api.reader.snapshot({});
    if (!snapshot.tree.nodes[nodeId]) throw badRequest(`unknown node ${nodeId}`);
    return {
      node: nodeId,
      sessions: sessionsOfNode(nodeId, snapshot.view, snapshot.tree),
    };
  },
};

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
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = "bad-request";
  return error;
}

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
  const handler = ROUTES[`${method} ${route.path}`];
  if (!handler) return fail(res, 404, "bad-request", `no route for ${method} ${route.path}`);

  try {
    if (method !== "GET" && method !== "HEAD") {
      /** @type {any} */ (req).body = await readJsonBody(req);
    }
    const result = await handler(api, req, res, route.query);
    if (res.writableEnded) return;
    ok(res, result);
  } catch (err) {
    const code = typeof err?.code === "string" ? err.code : "bad-request";
    const status = code === "bad-request" ? 400 : 500;
    log(api.ctx, "warn", `${method} ${route.path} failed: ${err?.message ?? err}`);
    if (!res.writableEnded) fail(res, status, code, String(err?.message ?? err));
  }
}
