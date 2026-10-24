/**
 * dsh-session-navigator — the browser component ("浏览器组件").
 *
 * The detached window needs a runtime the host will not give us: DSH's desktop
 * main process denies `window.open` and exposes no `BrowserWindow` to plugins.
 * This plugin therefore ships an *optional* Electron runtime that the user
 * downloads explicitly, into its own directory, with its own pinned checksum.
 * Nothing is shared with, or borrowed from, any other plugin.
 *
 * Everything here is about that runtime and nothing else:
 *
 *   layout.js     where the files go and how big they are
 *   state.js      the persisted lifecycle record (survives a restart)
 *   downloader.js streaming download with resume, progress and mirrors
 *   install.js    verify → extract → atomic publish
 *   manager.js    the single-flight state machine over the four above
 *
 * Design rules that the rest of the plugin relies on:
 *
 *   1. The component is never downloaded implicitly. Absent is the normal state
 *      and the main plugin is fully usable without it.
 *   2. `ready` means "the marker file and the binary both exist". Nothing else
 *      may claim readiness.
 *   3. Every mutation (install/cancel/remove) shares one promise lock, so two
 *      clicks cannot interleave and leave a half-extracted directory.
 *   4. A failed install never deletes a previously working install: the new
 *      bytes land in a staging directory and are published by rename.
 *
 * The pinned hashes come from Electron's official `SHASUMS256.txt` for the
 * version below; a mismatch aborts the install before extraction.
 */

import { join } from "node:path";

export const COMPONENT_VERSION = 1;

/** Electron release this build installs and reuses. */
export const ELECTRON_VERSION = "44.0.0";

/**
 * SHA-256 of the official release zip, per platform/arch.
 *
 * These are copied from Electron's `SHASUMS256.txt` for 44.0.0. A mismatch
 * aborts the install *before* extraction, so a truncated or tampered download
 * can never be executed.
 */
export const PINNED_SHA256 = Object.freeze({
  "electron-v44.0.0-darwin-arm64.zip": "076d79742986e1b100b69ebecc691cb07368045e54c9087cef631b8622b76a80",
  "electron-v44.0.0-darwin-x64.zip": "28429e700ad68d9624aaa90b6543ffe891a48c14121fd904cd294e5edcee63ff",
  "electron-v44.0.0-linux-arm64.zip": "74b6f18bc29c0d52cf8e963c45d476800419097c6f3d53b27c5df335207e52bb",
  "electron-v44.0.0-linux-x64.zip": "d65286d812719f2b4c1a1b806a80f288a1058c89c7b058dae1e03ab25e499446",
  "electron-v44.0.0-win32-arm64.zip": "984c8f3b9ffaf3c0a3f3501c96277effc05a9f0df5a5d920b2610c09ebaf4368",
  "electron-v44.0.0-win32-x64.zip": "e61aa3bcea8152bc0730abd015e47c032d778a0ef10e2a1c78ba3c4ea47942f9",
});

/**
 * Download mirrors, tried in order.
 *
 * Three independent Chinese mirrors come before GitHub, because GitHub's
 * release download is unreliable from mainland China (302 to a CDN that often
 * stalls). They all serve the *same* official zip, which the pinned SHA-256
 * still verifies, so a mirror cannot substitute different bytes.
 *
 *   mirror   npmmirror CDN (fastest here)
 *   backup   Huawei Cloud mirror (independent infrastructure)
 *   npmreg   npmmirror's registry endpoint (same operator, different edge)
 *   github   official release, last resort
 *
 * @type {ReadonlyArray<{ id: string, label: string, prefix: string }>}
 */
export const MIRRORS = Object.freeze([
  {
    id: "mirror",
    label: "npmmirror",
    prefix: `https://cdn.npmmirror.com/binaries/electron/v${ELECTRON_VERSION}/`,
  },
  {
    id: "backup",
    label: "华为云镜像",
    prefix: `https://mirrors.huaweicloud.com/electron/${ELECTRON_VERSION}/`,
  },
  {
    id: "npmreg",
    label: "npmmirror registry",
    prefix: `https://registry.npmmirror.com/-/binary/electron/v${ELECTRON_VERSION}/`,
  },
  {
    id: "github",
    label: "GitHub",
    prefix: `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/`,
  },
]);

/**
 * Real sizes of one install, measured on win32-x64 with Electron 44.0.0.
 *
 * These are shown to the user before they start, so they must be the actual
 * numbers rather than a rounded guess: 150 MB to download, 366 MB on disk.
 */
export const RUNTIME_SIZE_APPROX = {
  downloadBytes: 157_455_369,
  diskBytes: 383_650_096,
};

/**
 * The zip file name for one platform/arch, matching Electron's release assets.
 *
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string}
 */
export function assetName(platform = process.platform, arch = process.arch) {
  return `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`;
}

/**
 * The executable's path inside an extracted runtime directory.
 *
 * @param {string} dir
 * @param {string} [platform]
 * @returns {string}
 */
export function binaryPath(dir, platform = process.platform) {
  if (platform === "win32") return `${dir}\\electron.exe`;
  if (platform === "darwin") return `${dir}/Electron.app/Contents/MacOS/Electron`;
  return `${dir}/electron`;
}

/**
 * The one file every official Electron zip ships that this plugin cannot use.
 *
 * `resources/default_app.asar` is Electron's fallback app: its only job is to
 * run the script handed to it on the command line, which this plugin never does.
 * On Windows it is also the only file in the runtime that cannot be deleted
 * while DSH lives — Electron's `node:fs` opens it through an asar shim that
 * caches the handle for the life of the process, even for a bare `stat` (see
 * `removeTree`). So this build does not install it at all: `extractZip` skips
 * it and the helper is started from `resources/app` instead.
 */
export const DEFAULT_APP_ENTRY = "resources/default_app.asar";

/**
 * Every path the component manager touches.
 *
 * The whole runtime lives under the plugin data directory, so a P3 migration
 * moves it with everything else:
 *
 *   <dataDir>/component/
 *   ├─ state.v1.json              lifecycle record
 *   ├─ manifest.v1.json           what was installed, when, from where
 *   ├─ download/<asset>.part      resumable download body
 *   ├─ download/<asset>.part.json { url, etag, received, totalBytes }
 *   └─ runtime-<stamp>/           one *immutable* runtime per install
 *       └─ .complete-44.0.0        ← marker: present means "ready"
 *
 * **Why the runtime directory is versioned.** An install publishes into a fresh
 * `runtime-<stamp>` and points the state at it, instead of renaming over
 * `runtime/`. Windows refuses to rename (EPERM) or delete (EBUSY) a directory
 * while *any* file inside it is open — Defender's scanner, the search indexer,
 * or a helper that has not exited. Overwriting a fixed path therefore fails at
 * random with no recovery, while a fresh path simply works and leaves the old
 * directory to be swept later. Nothing is ever renamed out of the way.
 *
 * @param {string} dataDir the plugin data directory
 * @param {string} [platform]
 * @param {string} [stamp] runtime directory suffix; defaults to the stable name
 * @returns {Record<string, string>}
 */
export function componentPaths(dataDir, platform = process.platform, stamp) {
  const root = join(dataDir, "component");
  const asset = assetName(platform);
  const runtimeName = stamp ? `runtime-${stamp}` : "runtime";
  const runtime = join(root, runtimeName);
  return {
    root,
    state: join(root, "state.v1.json"),
    manifest: join(root, "manifest.v1.json"),
    // Paths an uninstall could not delete (DSH had them open). Swept on the
    // next start, when those handles are gone.
    pending: join(root, "pending-cleanup.v1.json"),
    downloadDir: join(root, "download"),
    part: join(root, "download", `${asset}.part`),
    partMeta: join(root, "download", `${asset}.part.json`),
    runtime,
    runtimeName,
    // Staging lives *outside* `component/` on purpose. A half-extracted tree
    // inside it would make "remove the component" fail on whatever left those
    // files, and the user cannot delete what they were told is one directory.
    staging: join(dataDir, ".component-staging"),
    marker: join(runtime, `.complete-${ELECTRON_VERSION}`),
    binary: binaryPath(runtime, platform),
    // Where Electron looks for the app when it is started without a path
    // argument. This build owns that directory (two files, written by
    // `installHelperApp`); the bundled `default_app.asar` next to it is stripped
    // on install, because a runtime that still has it can never be deleted.
    // Starting from here works for both: Electron prefers `resources/app` over
    // the default app, so a runtime published by an earlier build keeps working.
    app: join(runtime, "resources", "app"),
    defaultApp: join(runtime, DEFAULT_APP_ENTRY),
    assetName: asset,
  };
}

/**
 * Paths for an arbitrary runtime directory under the component root.
 *
 * The manager needs this to read the runtime a previous install published
 * (whose stamp is recorded in the state file) and to sweep stale ones.
 *
 * @param {string} dataDir
 * @param {string} runtimeName e.g. `runtime-k3f9`
 * @param {string} [platform]
 */
export function runtimePaths(dataDir, runtimeName, platform = process.platform) {
  const paths = componentPaths(dataDir, platform);
  const runtime = join(paths.root, runtimeName);
  return {
    ...paths,
    runtime,
    runtimeName,
    marker: join(runtime, `.complete-${ELECTRON_VERSION}`),
    binary: binaryPath(runtime, platform),
    app: join(runtime, "resources", "app"),
    defaultApp: join(runtime, DEFAULT_APP_ENTRY),
  };
}
