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
 * @typedef {object} PluginApi
 * @property {any} ctx
 * @property {string} dataDir
 * @property {ReturnType<typeof dataPaths>} paths
 * @property {() => ReturnType<typeof probeCapabilities>} capabilities
 */

/** @type {Record<string, RouteHandler>} */
const ROUTES = {
  "GET /bootstrap": (api) => ({
    hello: { plugin: PLUGIN_ID, schema: 1 },
    capabilities: api.capabilities(),
  }),
};

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
