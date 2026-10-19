/**
 * dsh-session-explorer — the browser component ("浏览器组件").
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

/** How many releases the runtime is, for the settings copy. */
export const RUNTIME_SIZE_APPROX = { downloadBytes: 110 * 1024 * 1024, diskBytes: 370 * 1024 * 1024 };

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
 * Every path the component manager touches.
 *
 * The whole runtime lives under the plugin data directory, so a P3 migration
 * moves it with everything else:
 *
 *   <dataDir>/component/
 *   ├─ state.v1.json              lifecycle record (see host/component.js)
 *   ├─ manifest.v1.json           what was installed, when, from where
 *   ├─ download/<asset>.part      resumable download body
 *   ├─ download/<asset>.part.json { url, etag, received, totalBytes }
 *   └─ runtime/                   extracted Electron, published atomically
 *       └─ .complete-44.0.0        ← marker: present means "ready"
 *
 * @param {string} dataDir the plugin data directory
 * @param {string} [platform]
 * @returns {Record<string, string>}
 */
export function componentPaths(dataDir, platform = process.platform) {
  const root = join(dataDir, "component");
  const asset = assetName(platform);
  return {
    root,
    state: join(root, "state.v1.json"),
    manifest: join(root, "manifest.v1.json"),
    downloadDir: join(root, "download"),
    part: join(root, "download", `${asset}.part`),
    partMeta: join(root, "download", `${asset}.part.json`),
    runtime: join(root, "runtime"),
    // Staging lives *outside* `component/` on purpose. A half-extracted tree
    // inside it would make "remove the component" fail with EBUSY on whatever
    // left those files, and the user cannot delete what they were told is one
    // directory. Keeping it beside means remove() can always nuke component/.
    staging: join(dataDir, ".component-staging"),
    marker: join(root, "runtime", `.complete-${ELECTRON_VERSION}`),
    binary: binaryPath(join(root, "runtime"), platform),
    assetName: asset,
  };
}
