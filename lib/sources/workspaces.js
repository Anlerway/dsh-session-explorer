/**
 * dsh-session-navigator — workspace registry read path.
 *
 * DSH keeps its workspace registry in two places at once:
 *
 *   runtime:  ctx.workspaceRegistry  (live entities, includes sessions created
 *             but not yet flushed to disk)
 *   storage:  <dshHome>/storages/workspace.json  (durable, version 2)
 *
 * The service is preferred when present — it is the single source of truth and
 * sees sessions the file has not caught up with. The file is the fallback for a
 * stripped profile and for the self-test harness, which runs without a kernel.
 *
 * Only reads live here. Archive/pin *writes* stay on the service (see
 * `ctx.workspaceRegistry.archiveSession` / `pinSession`) because this plugin must
 * never write DSH's storage files behind the kernel's back.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Durable registry file, relative to the DSH home. */
export const WORKSPACE_FILE = join("storages", "workspace.json");

/**
 * Read `workspace.json`.
 *
 * @param {string} dshHome
 * @returns {Promise<{ workspaceIds: string[], workspaces: Map<string, {id:string,title:string,path:string,createdAt:string|null,updatedAt:string|null,sessionIds:string[]}>, archivedSessionIds: string[], pinnedSessionIds: string[], defaultWorkspaceId: string | null } | null>}
 */
export async function readWorkspaceFile(dshHome) {
  let text;
  try {
    text = await readFile(join(dshHome, WORKSPACE_FILE), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const global = parsed?.global ?? {};
  const table = parsed?.tables?.workspaces ?? {};

  const workspaceIds = Array.isArray(global.workspaceIds) ? global.workspaceIds.map(String) : [];
  /** @type {Map<string, any>} */
  const workspaces = new Map();
  for (const [id, record] of Object.entries(table)) {
    if (!record || typeof record !== "object") continue;
    workspaces.set(id, {
      id,
      title: typeof record.title === "string" && record.title ? record.title : (typeof record.path === "string" ? baseName(record.path) : id),
      path: typeof record.path === "string" ? record.path : "",
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
      sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.map(String) : [],
    });
  }
  // Order is authoritative: append any table entry the order forgot instead of
  // dropping it, so a corrupt ordering never hides a session.
  for (const id of workspaces.keys()) if (!workspaceIds.includes(id)) workspaceIds.push(id);

  return {
    workspaceIds,
    workspaces,
    archivedSessionIds: Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds.map(String) : [],
    pinnedSessionIds: Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds.map(String) : [],
    defaultWorkspaceId: typeof global.defaultWorkspaceId === "string" ? global.defaultWorkspaceId : null,
  };
}

/**
 * Normalize the live registry service into the same shape as the file reader.
 *
 * @param {any} service `ctx.workspaceRegistry`
 * @returns {ReturnType<typeof readWorkspaceFile> extends Promise<infer T> ? T : never | null}
 */
export function readWorkspaceService(service) {
  if (!service || typeof service.list !== "function") return null;
  let entities;
  try {
    entities = service.list();
  } catch {
    return null;
  }
  if (!Array.isArray(entities)) return null;

  /** @type {Map<string, any>} */
  const workspaces = new Map();
  const workspaceIds = [];
  for (const entity of entities) {
    const id = typeof entity?.id === "string" ? entity.id : null;
    if (!id) continue;
    workspaceIds.push(id);
    workspaces.set(id, {
      id,
      title: typeof entity.title === "string" && entity.title ? entity.title : baseName(entity.path ?? id),
      path: typeof entity.path === "string" ? entity.path : "",
      createdAt: typeof entity.createdAt === "string" ? entity.createdAt : null,
      updatedAt: typeof entity.updatedAt === "string" ? entity.updatedAt : null,
      sessionIds: Array.isArray(entity.sessionIds) ? entity.sessionIds.map(String) : [],
    });
  }

  const archivedSessionIds = Array.isArray(service.archivedSessionIds) ? service.archivedSessionIds.map(String) : [];
  const pinnedSessionIds = Array.isArray(service.pinnedSessionIds) ? service.pinnedSessionIds.map(String) : [];

  return {
    workspaceIds,
    workspaces,
    archivedSessionIds,
    pinnedSessionIds,
    defaultWorkspaceId: workspaceIds[0] ?? null,
  };
}

/**
 * @param {string} path
 * @returns {string}
 */
function baseName(path) {
  const trimmed = String(path ?? "").replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}
