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
 * @param {{ dataDir?: string, component?: string }} [extra]
 */
export function capabilities(ctx, extra = {}) {
  const webServer = getService(ctx, "webServer");
  const workspaces = getService(ctx, "workspaceRegistry") ?? getService(ctx, "workspaces");
  const sessions = getService(ctx, "sessions");
  const persistence = getService(ctx, "sessionPersistence");
  const agents = getService(ctx, "agents");

  const archiveApi = typeof workspaces?.archiveSession === "function";
  const pinApi = typeof workspaces?.pinSession === "function";

  return {
    webServer: typeof webServer?.register === "function",
    // 独立窗口 needs the optional browser component; "absent" is the normal
    // state and the settings page offers to install it.
    component: extra.component ?? "absent",
    workspaces: Boolean(workspaces),
    archive: archiveApi,
    pin: pinApi,
    // 跨工作区移动 needs the live registry (accounting swap) *and* the
    // controller-owned entity methods attachSession/detachSession. Reading the
    // capability off the registry is what the move path itself requires.
    move: typeof workspaces?.list === "function" && typeof workspaces?.enqueueOperation === "function",
    sessions: Boolean(sessions),
    sessionPersistence: typeof persistence?.locate === "function" || Boolean(persistence),
    agents: Boolean(agents),
    dataDir: extra.dataDir ?? null,
    platform: process.platform,
    node: process.versions.node,
  };
}
