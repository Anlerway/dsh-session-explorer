/**
 * dsh-session-explorer — settings document shape.
 *
 * One place that knows every setting the plugin stores, so the sidecar default,
 * the HTTP coercion and the settings page can never drift apart.
 *
 * The document is nested on purpose:
 *
 *   {
 *     autoTrash, confirmDelete, defaultView, pageSize,   <- P2, flat, kept as-is
 *     shell: {
 *       openMode: 'modal' | 'window' | 'detached',
 *       modal:  { size, dim, closeOnBackdrop, rememberBounds },
 *       window: { alwaysOnTop },
 *     },
 *     component: { reuseOrbRuntime },
 *     dataDir:   { current },
 *   }
 *
 * `settings.v1.json` is written by `store/sidecar.js`, which merges a patch onto
 * the stored payload. Normalisation here is therefore total: whatever is on
 * disk, the host hands the client a complete, type-correct object.
 *
 * Hard constraint 10 in 实现粗规划.md lives here too: `modal.dim` defaults to 0
 * (no scrim, no darkening) and is capped at 0.8, because the panel must stay
 * readable over a wallpaper.
 */

/** Ways the panel can present itself. */
export const OPEN_MODES = Object.freeze(["modal", "window", "detached"]);

/** Preset modal sizes; the client maps them to pixels. */
export const MODAL_SIZES = Object.freeze(["sm", "md", "lg", "full"]);

/** Upper bound for the scrim, so a wallpaper never goes black. */
export const MAX_DIM = 0.8;

/**
 * A fresh settings document.
 *
 * @returns {any}
 */
export function defaultSettings() {
  return {
    autoTrash: false,
    confirmDelete: true,
    defaultView: "details",
    pageSize: 200,
    shell: {
      openMode: "modal",
      modal: { size: "md", dim: 0, closeOnBackdrop: true, rememberBounds: true },
      window: { alwaysOnTop: false },
    },
    component: { reuseOrbRuntime: true },
    dataDir: { current: null },
  };
}

/**
 * Merge a client patch onto the stored document, keeping only known keys.
 *
 * The merge is deliberately shallow at the top and two levels deep inside
 * `shell`; an unknown key is dropped here rather than being written to disk and
 * confusing the next version of the plugin.
 *
 * @param {any} current stored payload (may be null on first run)
 * @param {any} patch incoming partial document
 * @returns {any} merged, unnormalised
 */
export function mergeSettings(current, patch) {
  const base = current && typeof current === "object" ? current : {};
  const incoming = patch && typeof patch === "object" ? patch : {};
  /** @type {any} */
  const merged = { ...base };

  for (const key of ["autoTrash", "confirmDelete", "defaultView", "pageSize"]) {
    if (key in incoming) merged[key] = incoming[key];
  }

  if (incoming.shell && typeof incoming.shell === "object") {
    const shell = { ...(base.shell && typeof base.shell === "object" ? base.shell : {}) };
    if ("openMode" in incoming.shell) shell.openMode = incoming.shell.openMode;
    if (incoming.shell.modal && typeof incoming.shell.modal === "object") {
      shell.modal = {
        ...(shell.modal && typeof shell.modal === "object" ? shell.modal : {}),
        ...incoming.shell.modal,
      };
    }
    if (incoming.shell.window && typeof incoming.shell.window === "object") {
      shell.window = {
        ...(shell.window && typeof shell.window === "object" ? shell.window : {}),
        ...incoming.shell.window,
      };
    }
    merged.shell = shell;
  }

  if (incoming.component && typeof incoming.component === "object") {
    merged.component = {
      ...(base.component && typeof base.component === "object" ? base.component : {}),
      ...incoming.component,
    };
  }

  if (incoming.dataDir && typeof incoming.dataDir === "object") {
    merged.dataDir = {
      ...(base.dataDir && typeof base.dataDir === "object" ? base.dataDir : {}),
      ...incoming.dataDir,
    };
  }

  return merged;
}

/**
 * Coerce a stored document into the exact shape the client may rely on.
 *
 * Out-of-range values fall back to the default instead of being echoed back and
 * confusing the UI; a value that survives this function is safe to render.
 *
 * @param {any} raw
 * @returns {any}
 */
export function normalizeSettings(raw) {
  const out = defaultSettings();
  if (!raw || typeof raw !== "object") return out;

  if (typeof raw.autoTrash === "boolean") out.autoTrash = raw.autoTrash;
  if (typeof raw.confirmDelete === "boolean") out.confirmDelete = raw.confirmDelete;
  if (["details", "list", "icons"].includes(raw.defaultView)) out.defaultView = raw.defaultView;
  if (Number.isFinite(raw.pageSize) && raw.pageSize >= 20 && raw.pageSize <= 2000) {
    out.pageSize = Math.round(raw.pageSize);
  }

  const shell = raw.shell && typeof raw.shell === "object" ? raw.shell : {};
  if (OPEN_MODES.includes(shell.openMode)) out.shell.openMode = shell.openMode;

  const modal = shell.modal && typeof shell.modal === "object" ? shell.modal : {};
  if (MODAL_SIZES.includes(modal.size)) out.shell.modal.size = modal.size;
  if (Number.isFinite(modal.dim)) out.shell.modal.dim = Math.min(MAX_DIM, Math.max(0, modal.dim));
  if (typeof modal.closeOnBackdrop === "boolean") out.shell.modal.closeOnBackdrop = modal.closeOnBackdrop;
  if (typeof modal.rememberBounds === "boolean") out.shell.modal.rememberBounds = modal.rememberBounds;

  const windowOptions = shell.window && typeof shell.window === "object" ? shell.window : {};
  if (typeof windowOptions.alwaysOnTop === "boolean") out.shell.window.alwaysOnTop = windowOptions.alwaysOnTop;

  const component = raw.component && typeof raw.component === "object" ? raw.component : {};
  if (typeof component.reuseOrbRuntime === "boolean") out.component.reuseOrbRuntime = component.reuseOrbRuntime;

  const dataDir = raw.dataDir && typeof raw.dataDir === "object" ? raw.dataDir : {};
  if (typeof dataDir.current === "string" && dataDir.current.trim() !== "") {
    out.dataDir.current = dataDir.current;
  }

  return out;
}

/**
 * Pixel size for a modal preset, at a given viewport.
 *
 * `full` is a percentage so a small window does not get a panel wider than the
 * screen; the other three are fixed so the panel does not jump when the browser
 * is resized.
 *
 * @param {string} size
 * @returns {{ width: string, height: string }}
 */
export function modalSizeOf(size) {
  switch (size) {
    case "sm":
      return { width: "900px", height: "600px" };
    case "lg":
      return { width: "1280px", height: "800px" };
    case "full":
      return { width: "96%", height: "92%" };
    case "md":
    default:
      return { width: "1100px", height: "720px" };
  }
}
