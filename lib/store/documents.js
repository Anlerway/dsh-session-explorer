/**
 * dsh-session-explorer — the four sidecar documents this plugin owns.
 *
 * `tree.v1.json`        user folders + workspace placement + workspace order
 * `annotations.v1.json` tags, notes, favorite/todo flags per session,
 *                       plus the shared tag library
 * `settings.v1.json`    panel preferences that should follow the user across
 *                       browsers (layout lives in localStorage; this is for
 *                       things the host must know, e.g. whether to auto-trash)
 * `trash/index.v1.json` what is in the trash, and where it came from
 *
 * Nothing here duplicates a DSH-native attribute. Title, cwd, timestamps, turn
 * counts, the archived set and the pinned set are read from DSH on every
 * request; the sidecar only ever stores what DSH does not know (S8 in
 * 实现粗规划.md). That is why a sidecar can be deleted without losing a session.
 */

import { dataPaths } from "../paths.js";
import { defaultSettings } from "../domain/settings.js";
import { createSidecar } from "./sidecar.js";

/** Schema version written by this build. Bump it when a payload shape changes. */
export const SIDECAR_VERSION = 1;

/**
 * @param {object} [paths]
 * @returns {{ tree: any, annotations: any, settings: any, trash: any, paths: any }}
 */
export function openDocuments(paths = dataPaths()) {
  const tree = createSidecar({
    path: paths.tree,
    tmpDir: paths.tmpDir,
    quarantineDir: paths.quarantine,
    version: SIDECAR_VERSION,
    // `shortcuts` holds the 快捷方式 nodes: references to a folder, a workspace
    // or a session that live in 收藏 / 待办 / any folder without moving the target.
    // `sessionPlacement` maps a session id to the container node it should be
    // *shown* in. It exists because DSH derives a session's workspace from the
    // header `cwd`, so the only physical way to re-home a session is to move its
    // directory — which this plugin never does. The override is grouping-only.
    empty: () => ({ folders: {}, placement: {}, workspaceOrder: {}, shortcuts: {}, pins: {}, sessionPlacement: {} }),
    migrate: migrateTree,
  });

  const annotations = createSidecar({
    path: paths.annotations,
    tmpDir: paths.tmpDir,
    quarantineDir: paths.quarantine,
    version: SIDECAR_VERSION,
    // `tags` is the shared tag library (the user's own vocabulary, picked from
    // in the detail pane); `sessions` is the per-session annotation.
    empty: () => ({ sessions: {}, tags: [] }),
    migrate: migrateAnnotations,
  });

  const settings = createSidecar({
    path: paths.settings,
    tmpDir: paths.tmpDir,
    quarantineDir: paths.quarantine,
    version: SIDECAR_VERSION,
    // The full settings shape lives in domain/settings.js so the sidecar, the
    // HTTP layer and the settings page cannot drift apart.
    empty: () => defaultSettings(),
    migrate: null,
  });

  const trash = createSidecar({
    path: paths.trashIndex,
    tmpDir: paths.tmpDir,
    quarantineDir: paths.quarantine,
    version: SIDECAR_VERSION,
    empty: () => ({ entries: {} }),
    migrate: null,
  });

  return { tree, annotations, settings, trash, paths };
}

/**
 * A v0 payload stored folders as an array. Converting keeps the user's folders
 * instead of quarantining the file.
 *
 * @param {any} raw
 */
function migrateTree(raw) {
  const folders = {};
  if (Array.isArray(raw?.folders)) {
    for (const folder of raw.folders) {
      if (folder && typeof folder.id === "string") folders[folder.id] = folder;
    }
  } else if (raw?.folders && typeof raw.folders === "object") {
    Object.assign(folders, raw.folders);
  }
  return {
    folders,
    placement: raw?.placement && typeof raw.placement === "object" ? raw.placement : {},
    workspaceOrder: raw?.workspaceOrder && typeof raw.workspaceOrder === "object" ? raw.workspaceOrder : {},
    shortcuts: raw?.shortcuts && typeof raw.shortcuts === "object" ? raw.shortcuts : {},
    // `pins` maps a container node id to a sequence number. DSH pins *sessions*;
    // this plugin pins folders and workspaces, and both land in the same visual
    // 置顶 group, so the two pin sets stay separate stores.
    pins: raw?.pins && typeof raw.pins === "object" ? raw.pins : {},
    // See `empty` above: a virtual, sidecar-only placement for a session whose
    // real directory still belongs to its original workspace.
    sessionPlacement:
      raw?.sessionPlacement && typeof raw.sessionPlacement === "object" ? raw.sessionPlacement : {},
  };
}

/**
 * A v0 payload stored annotations as an array keyed by session id.
 *
 * @param {any} raw
 */
function migrateAnnotations(raw) {
  const sessions = {};
  const put = (id, entry) => {
    if (typeof id !== "string" || !entry || typeof entry !== "object") return;
    // 优先级 was removed; a payload written by an earlier build still carries
    // it, and the annotation normaliser would drop it on the next write anyway.
    const { priority, ...rest } = entry;
    sessions[id] = rest;
  };
  if (Array.isArray(raw?.sessions)) {
    for (const entry of raw.sessions) put(entry?.id, entry);
  } else if (raw?.sessions && typeof raw.sessions === "object") {
    for (const [id, entry] of Object.entries(raw.sessions)) put(id, entry);
  }
  return { sessions, tags: Array.isArray(raw?.tags) ? raw.tags : [] };
}
