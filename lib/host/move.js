/**
 * dsh-session-explorer — cross-workspace move and copy.
 *
 * DSH decides a session's workspace from the `cwd` in its artifact header, not
 * from the workspace registry alone: a session whose header cwd does not resolve
 * to the workspace's own path is filtered out of that workspace's membership.
 * A move therefore has to do two things together:
 *
 *   1. relocate the artifact into the target workspace's project directory and
 *      rewrite the header's `cwd`;
 *   2. swap the registry accounting (detach from every old workspace, attach to
 *      the target) through the registry's own write path.
 *
 * Doing only the second loses the session at the next start; doing only the
 * first leaves a file DSH cannot find from its workspace list. The transaction
 * below is ordered so that any failure leaves a readable artifact either where
 * it started or at the destination with its original header — never a
 * half-written log.
 *
 * Live sessions are refused. DSH keeps a write handle open on the old path and
 * rebinding it is undocumented internal state; moving the file under an open
 * writer corrupts the tail. The trash route makes the same call for the same
 * reason, so the rule is consistent across the plugin.
 */

import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { getService } from "../capabilities.js";
import { dshHome } from "../dsh/home.js";
import { codedError } from "../store/sidecar.js";
import { readAllHeaders, sessionsDir } from "../sources/heads.js";
import {
  encodeArtifact,
  encodeSegment,
  inheritedCutOf,
  isContiguousLog,
  projectKey,
  readArtifact,
  tempPathFor,
} from "../sources/artifact.js";

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/**
 * The workspace registry (native service), or a coded error.
 *
 * @param {any} ctx
 * @returns {any}
 */
function registryOf(ctx) {
  const registry = getService(ctx, "workspaceRegistry") ?? getService(ctx, "workspaces");
  if (!registry || typeof registry.list !== "function") {
    throw codedError("capability-missing", "this DSH build mounts no workspace registry, so sessions cannot be moved");
  }
  return registry;
}

/**
 * @param {any} api
 * @returns {string}
 */
function homeOf(api) {
  return typeof api.dshHome === "function" ? api.dshHome() : dshHome();
}

/**
 * Resolve a target workspace entity and the canonical directory its sessions
 * must claim.
 *
 * @param {any} registry
 * @param {any} target
 * @returns {{ id: string, title: string, path: string }}
 */
async function resolveTarget(registry, target) {
  const workspaceId = typeof target?.workspaceId === "string" ? target.workspaceId : "";
  if (!workspaceId) throw codedError("bad-request", "a target workspace id is required");
  const entity = registry.list().find((candidate) => candidate?.id === workspaceId);
  if (!entity) throw codedError("workspace-not-found", `workspace ${workspaceId} does not exist`);
  const path = typeof entity.path === "string" ? entity.path : "";
  if (!path) throw codedError("workspace-not-found", `workspace ${workspaceId} has no directory`);
  return { id: workspaceId, title: entity.title || workspaceId, path };
}

/**
 * Every workspace that currently accounts for one session.
 *
 * @param {any} registry
 * @param {string} sessionId
 * @returns {string[]}
 */
function workspacesHolding(registry, sessionId) {
  /** @type {string[]} */
  const ids = [];
  for (const entity of registry.list()) {
    const raw = Array.isArray(entity?.record?.sessionIds)
      ? entity.record.sessionIds
      : Array.isArray(entity?.sessionIds)
        ? entity.sessionIds
        : [];
    if (raw.includes(sessionId)) ids.push(entity.id);
  }
  return ids;
}

/**
 * Run one registry mutation on the registry's own write chain when it has one.
 *
 * @param {any} registry
 * @param {() => Promise<void>} operation
 * @returns {Promise<void>}
 */
async function enqueue(registry, operation) {
  if (typeof registry.enqueueOperation === "function") return registry.enqueueOperation(operation);
  return operation();
}

/**
 * Bring the registry's header index up to date for one session.
 *
 * `attachSession` validates the stored cwd against the workspace path and reads
 * it from that index, which is otherwise cached until a restart. Without this
 * refresh a move would fail its own validation with the *old* cwd.
 *
 * @param {any} registry
 * @param {any} header
 */
async function reindex(registry, header) {
  if (typeof registry.indexHeader === "function") {
    await registry.indexHeader(header);
    return;
  }
  if (typeof registry.replaceHeaderIndex === "function" && typeof registry.listStoredHeaders === "function") {
    const headers = await registry.listStoredHeaders();
    await registry.replaceHeaderIndex([...headers.filter((entry) => entry?.id !== header.id), header]);
  }
}

/**
 * Refold the projection cache for a relocated artifact.
 *
 * The cache record is bound to `{formatVersion, createdAt, cwd, isSeeded}`; a
 * move changes `cwd`, so the old record stops matching and the listing would
 * silently fall back to the cwd folder name. Best effort: a cache that cannot be
 * refolded costs a title, never the session.
 *
 * @param {any} ctx
 * @param {any} header
 * @param {any[]} events
 */
async function refoldProjection(ctx, header, events) {
  try {
    const cache = getService(ctx, "sessionProjectionCache");
    if (!cache || typeof cache.coldSnapshot !== "function") return;
    if (!Array.isArray(events) || !isContiguousLog(events)) return;
    const inherited = header?.isSeeded === true ? inheritedCutOf(events) : 0;
    if (inherited === null) return;
    await cache.coldSnapshot(header, inherited, events);
  } catch {
    /* a stale projection is cosmetic; the move already succeeded */
  }
}

/**
 * Write a new header over an existing artifact without touching its events.
 *
 * The bytes are written beside the target and renamed over it, so a crash
 * cannot leave a clipped log. The original `version` is preserved: a v3
 * artifact must not start claiming v4 without a migration.
 *
 * @param {string} filePath
 * @param {any} header
 * @param {string} rest text after the header line, including the final newline
 * @param {boolean} compressed
 */
async function publishHeader(filePath, header, rest, compressed) {
  const bytes = encodeArtifact(header, rest, compressed);
  const temp = tempPathFor(filePath);
  await writeFile(temp, bytes);
  try {
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Move one session directory. Same volume is one rename; across volumes it is a
 * copy followed by a delete, which is all the filesystem allows.
 *
 * @param {string} from
 * @param {string} to
 */
async function relocate(from, to) {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") throw error;
  }
  await cp(from, to, { recursive: true, force: false, errorOnExist: true });
  await rm(from, { recursive: true, force: true });
}

/**
 * Shared preamble: locate the artifact, refuse what must not move.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {string} action
 * @returns {Promise<{ home: string, root: string, stored: any, artifact: any }>}
 */
async function prepare(api, sessionId, action) {
  const home = homeOf(api);
  const root = sessionsDir(home);
  const headers = await readAllHeaders(home);
  const stored = headers.get(sessionId);
  if (!stored?.logPath) {
    throw codedError("session-not-found", `${sessionId} has no session log on disk`);
  }
  if (stored.origin === "subagent") {
    throw codedError("subagent-unsupported", `${sessionId} is a subagent session; subagent logs cannot be ${action}`);
  }
  const live = getService(api.ctx, "sessions")?.get?.(sessionId);
  if (live) {
    throw codedError("session-active", `${sessionId} is open in this DSH process; close it before moving it`);
  }
  const artifact = await readArtifact(stored.logPath);
  return { home, root, stored, artifact };
}

/**
 * Move one session to a target workspace.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {any} target
 * @returns {Promise<object>}
 */
async function moveOne(api, sessionId, target) {
  const registry = registryOf(api.ctx);
  const resolved = await resolveTarget(registry, target);
  const { root, stored, artifact } = await prepare(api, sessionId, "moved");

  const fromWorkspaces = workspacesHolding(registry, sessionId);
  if (fromWorkspaces.length === 1 && fromWorkspaces[0] === resolved.id) {
    return {
      sessionId,
      moved: false,
      fromWorkspaceIds: fromWorkspaces,
      toWorkspaceId: resolved.id,
      artifactFrom: stored.logPath,
      artifactTo: stored.logPath,
      message: "会话已属于目标工作区",
    };
  }

  // A workspace whose directory has disappeared cannot own a session: the
  // registry's own attachSession would refuse the move after the bytes had
  // already been relocated, so refuse it here while nothing has moved yet.
  if (!(await exists(resolved.path))) {
    throw codedError("workspace-not-found", `workspace ${resolved.id} points at ${resolved.path}, which does not exist`);
  }

  const sourceDir = dirname(stored.logPath);
  const directoryName = sourceDir.split(/[\\/]/).pop();
  const targetDir = join(root, projectKey(resolved.path), directoryName);
  if (!inside(root, targetDir)) {
    throw codedError("bad-request", `refusing to move ${sessionId} outside the sessions root`);
  }
  if (targetDir === sourceDir) {
    throw codedError("target-exists", `${targetDir} already holds this session`);
  }
  await mkdir(dirname(targetDir), { recursive: true });
  if (await exists(targetDir)) {
    throw codedError("target-exists", `${targetDir} already exists`);
  }

  await relocate(sourceDir, targetDir);

  const newline = artifact.text.indexOf("\n");
  const rest = artifact.text.slice(newline + 1);
  const header = { ...artifact.header, cwd: resolved.path };
  const targetLog = join(targetDir, artifact.fileName);

  try {
    await publishHeader(targetLog, header, rest, artifact.compressed);
  } catch (error) {
    // The directory moved but its header still names the old cwd: put the
    // directory back, where the old header is still truthful.
    await relocate(targetDir, sourceDir).catch(() => {});
    throw error;
  }

  try {
    await reindex(registry, header);
    await enqueue(registry, async () => {
      // Attach first, detach second. The two orderings differ only while the
      // write is in flight: this one can leave the session accounted twice for
      // a moment, the other leaves it accounted nowhere if the attach fails.
      const targetEntity = registry.list().find((entity) => entity.id === resolved.id);
      if (!targetEntity) throw codedError("workspace-not-found", `workspace ${resolved.id} disappeared during the move`);
      await targetEntity.attachSession(sessionId);
      try {
        for (const entity of registry.list()) {
          if (entity.id === resolved.id) continue;
          const raw = Array.isArray(entity?.record?.sessionIds) ? entity.record.sessionIds : [];
          if (raw.includes(sessionId)) await entity.detachSession(sessionId);
        }
      } catch (error) {
        // Undo the attach so the rollback below starts from "accounted nowhere"
        // instead of "accounted twice".
        await targetEntity.detachSession(sessionId).catch(() => {});
        throw error;
      }
    });
  } catch (error) {
    // Accounting failed. The directory goes back first, then its header, so the
    // restored log describes exactly the workspace that still accounts for it.
    await relocate(targetDir, sourceDir).catch(() => {});
    await publishHeader(stored.logPath, artifact.header, rest, artifact.compressed).catch(() => {});
    await reindex(registry, stored).catch(() => {});
    throw error;
  }

  await refoldProjection(api.ctx, header, artifact.events);
  api.reader.invalidate();
  return {
    sessionId,
    moved: true,
    fromWorkspaceIds: fromWorkspaces,
    toWorkspaceId: resolved.id,
    toWorkspaceTitle: resolved.title,
    artifactFrom: stored.logPath,
    artifactTo: targetLog,
  };
}

/**
 * Copy one session into a target workspace under a fresh id.
 *
 * A copy is a second, independent session: a new id in the header and in the
 * directory name, the same events, and the target cwd. DSH's own fork is the
 * "continue from here" tool; this is the file manager's "duplicate".
 *
 * The copied header keeps `isSeeded`/`parentSession` verbatim: rewriting them
 * would make the log claim a lineage its event stream does not describe.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {any} target
 * @returns {Promise<object>}
 */
async function copyOne(api, sessionId, target) {
  const registry = registryOf(api.ctx);
  const resolved = await resolveTarget(registry, target);
  const { root, stored, artifact } = await prepare(api, sessionId, "copied");

  if (!(await exists(resolved.path))) {
    throw codedError("workspace-not-found", `workspace ${resolved.id} points at ${resolved.path}, which does not exist`);
  }

  const newId = `session-${randomId()}`;
  const header = { ...artifact.header, id: newId, cwd: resolved.path };
  const newline = artifact.text.indexOf("\n");
  const rest = artifact.text.slice(newline + 1);
  const targetDir = join(root, projectKey(resolved.path), encodeSegment(newId));
  if (!inside(root, targetDir)) throw codedError("bad-request", "refusing to write outside the sessions root");
  if (await exists(targetDir)) throw codedError("target-exists", `${targetDir} already exists`);

  await mkdir(targetDir, { recursive: true });
  const targetLog = join(targetDir, artifact.fileName);
  try {
    await publishHeader(targetLog, header, rest, artifact.compressed);
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  try {
    await reindex(registry, header);
    await enqueue(registry, async () => {
      const targetEntity = registry.list().find((entity) => entity.id === resolved.id);
      if (!targetEntity) throw codedError("workspace-not-found", `workspace ${resolved.id} disappeared during the copy`);
      await targetEntity.attachSession(newId);
    });
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  await refoldProjection(api.ctx, header, artifact.events);
  api.reader.invalidate();
  return {
    sessionId: newId,
    sourceSessionId: sessionId,
    copied: true,
    toWorkspaceId: resolved.id,
    toWorkspaceTitle: resolved.title,
    artifactFrom: stored.logPath,
    artifactTo: targetLog,
  };
}

/**
 * A random RFC 4122-shaped id body, so a copied session reads like DSH's own.
 *
 * @returns {string}
 */
function randomId() {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Move or copy a batch of sessions.
 *
 * Sessions are processed one at a time: their workspaces are independent, and
 * stopping at the first failure keeps the reported result truthful instead of
 * implying an all-or-nothing batch.
 *
 * @param {any} api
 * @param {{ ids?: string[], target?: any, copy?: boolean }} body
 * @returns {Promise<{ results: object[] }>}
 */
export async function moveSessions(api, body) {
  const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
  if (ids.length === 0) throw codedError("bad-request", "ids must be a non-empty array");
  const copy = body?.copy === true;
  const target = body?.target ?? { workspaceId: body?.targetWorkspaceId };
  /** @type {object[]} */
  const results = [];
  for (const id of ids) {
    results.push(copy ? await copyOne(api, id, target) : await moveOne(api, id, target));
  }
  return { results };
}
