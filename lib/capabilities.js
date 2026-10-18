/**
 * dsh-session-explorer — host capability probe.
 *
 * Every DSH service this plugin touches is looked up defensively: a service row
 * may be missing on a stripped-down profile, and a missing service must degrade
 * a single feature rather than take the whole plugin down. The probe result is
 * echoed to the client in `/bootstrap` so the UI can disable what is not there
 * instead of failing silently.
 */

/**
 * Read a Cordis service from the plugin context.
 *
 * `ctx.get()` is the supported accessor, but a row may also be exposed as a
 * plain property on the context object; both are tried so a kernel change in
 * either direction does not break the probe.
 *
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
export function getService(ctx, name) {
  try {
    if (typeof ctx?.get === "function") {
      const value = ctx.get(name);
      if (value !== undefined && value !== null) return value;
    }
  } catch {
    /* a throwing accessor means "not available" */
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * Snapshot which host services are usable right now.
 *
 * @param {any} ctx
 * @param {{ dataDir?: string }} [extra]
 */
export function capabilities(ctx, extra = {}) {
  const webServer = getService(ctx, "webServer");
  const workspaces = getService(ctx, "workspaceRegistry") ?? getService(ctx, "workspaces");
  const sessions = getService(ctx, "sessions");
  const persistence = getService(ctx, "sessionPersistence");
  const agents = getService(ctx, "agents");

  const workspacesApi = typeof workspaces?.list === "object" || typeof workspaces?.getSnapshot === "function";
  const archiveApi = typeof workspaces?.archiveSession === "function";
  const pinApi = typeof workspaces?.pinSession === "function";

  return {
    webServer: typeof webServer?.register === "function",
    workspaces: Boolean(workspaces),
    workspacesList: workspacesApi,
    archive: archiveApi,
    pin: pinApi,
    sessions: Boolean(sessions),
    sessionPersistence: typeof persistence?.locate === "function" || Boolean(persistence),
    agents: Boolean(agents),
    dataDir: extra.dataDir ?? null,
    platform: process.platform,
    node: process.versions.node,
  };
}
