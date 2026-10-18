/**
 * dsh-session-explorer — the four sidecar documents this plugin owns.
 *
 * `tree.v1.json`        user folders + workspace placement + workspace order
 * `annotations.v1.json` tags, notes, priority, favorite/todo flags per session
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
    version: SIDECAR_VERSION,
    empty: () => ({ folders: {}, placement: {}, workspaceOrder: {}, sessionOrder: {} }),
    migrate: migrateTree,
  });

  const annotations = createSidecar({
    path: paths.annotations,
    tmpDir: paths.tmpDir,
    version: SIDECAR_VERSION,
    empty: () => ({ sessions: {} }),
    migrate: migrateAnnotations,
  });

  const settings = createSidecar({
    path: paths.settings,
    tmpDir: paths.tmpDir,
    version: SIDECAR_VERSION,
    empty: () => ({
      autoTrash: false,
      confirmDelete: true,
      defaultView: "details",
      pageSize: 200,
    }),
    migrate: null,
  });

  const trash = createSidecar({
    path: paths.trashIndex,
    tmpDir: paths.tmpDir,
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
    sessionOrder: raw?.sessionOrder && typeof raw.sessionOrder === "object" ? raw.sessionOrder : {},
  };
}

/**
 * A v0 payload stored annotations as an array keyed by session id.
 *
 * @param {any} raw
 */
function migrateAnnotations(raw) {
  const sessions = {};
  if (Array.isArray(raw?.sessions)) {
    for (const entry of raw.sessions) {
      if (entry && typeof entry.id === "string") sessions[entry.id] = entry;
    }
  } else if (raw?.sessions && typeof raw.sessions === "object") {
    Object.assign(sessions, raw.sessions);
  }
  return { sessions };
}
