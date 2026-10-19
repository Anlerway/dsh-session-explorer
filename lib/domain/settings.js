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
 *       openMode: 'float'   (独立窗口 'window' arrives with P6)
 *       modal:  { sizing, size, percent, dim, closeOnBackdrop },
 *       window: { alwaysOnTop, bounds },
 *     },
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

/**
 * How the panel is presented. Exactly one value today.
 *
 *   float — 浮窗模式: a card centred over the app, with the optional scrim.
 *
 * 独立窗口 is deliberately *not* in this vocabulary yet. It means a real browser
 * window that lives outside DSH (its own Chromium window loading this plugin's
 * page, driven by the Electron component described in §5.6 of 实现粗规划.md), not
 * a panel that slides around inside the app. That is P6 work: it needs the
 * component installed, a host process, and its own window lifecycle. Shipping
 * the setting before the window exists would offer a choice that silently does
 * nothing — and an in-app "draggable window" is not what the name promises.
 *
 * The old `"modal"` value (the centred card) and `"detached"` (the never-shipped
 * separate-window component) both normalise to `"float"`, so a settings file
 * written by an earlier build stays usable.
 *
 * A third axis that also used to exist — 弹窗模式 vs 原生弹窗, i.e. whether DSH's
 * `Modal` primitive hosted the panel — is gone for a concrete reason: that
 * primitive paints at the app's dialog tier (z-index 1000), which is below the
 * panel's own layer, so a confirmation opened from the panel could be drawn
 * *underneath* the window that opened it.
 */
export const OPEN_MODES = Object.freeze(["float"]);

/** The mode 独立窗口 will use once P6 ships; kept so the UI can name it. */
export const OPEN_MODE_DETACHED = "window";

/**
 * Whether the detached browser window is available in this build.
 *
 * It is not: 独立窗口 means a real OS window outside DSH (the Electron component
 * in §5.6), which is P6. The settings page still *names* the mode so the plan is
 * visible, but selects it as disabled with the reason — offering a live choice
 * that silently falls back to the in-app card would be worse than saying "later".
 */
export const DETACHED_AVAILABLE = false;

/**
 * How the panel's size is expressed.
 *
 *   fixed   — a pixel size that does not change when the browser resizes, so
 *             the panel keeps its exact geometry (what a desktop window does).
 *   percent — a share of the viewport, so the panel grows with the window.
 *
 * The two are kept apart instead of being folded into one preset list: "80%"
 * and "1280px" are different intents, and a single list would have to guess
 * which one the user meant when they resized.
 */
export const MODAL_SIZING = Object.freeze(["fixed", "percent"]);

/** Preset fixed sizes, in pixels; the client maps them to CSS. */
export const MODAL_FIXED_SIZES = Object.freeze(["sm", "md", "lg", "xl"]);

/** Preset percentage sizes, as a share of the viewport. */
export const MODAL_PERCENT_SIZES = Object.freeze(["p50", "p70", "p85", "p100"]);

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
      openMode: "float",
      modal: {
        sizing: "fixed",
        size: "md",
        percent: "p70",
        dim: 0,
        closeOnBackdrop: true,
      },
      // Remembered geometry of 独立窗口. null means "never placed yet": the
      // client then centres it once and records where it landed.
      window: { alwaysOnTop: false, bounds: null },
    },
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
  if (["details", "icons"].includes(raw.defaultView)) out.defaultView = raw.defaultView;
  if (Number.isFinite(raw.pageSize) && raw.pageSize >= 20 && raw.pageSize <= 2000) {
    out.pageSize = Math.round(raw.pageSize);
  }

  const shell = raw.shell && typeof raw.shell === "object" ? raw.shell : {};
  // Only 浮窗 exists. A stored "modal" (the old name for it) and "detached"
  // (the separate-window component that never shipped) both land here, so no
  // settings file can put the panel into a mode the build cannot render.
  if (OPEN_MODES.includes(shell.openMode)) out.shell.openMode = shell.openMode;

  const modal = shell.modal && typeof shell.modal === "object" ? shell.modal : {};
  if (MODAL_SIZING.includes(modal.sizing)) out.shell.modal.sizing = modal.sizing;
  // The legacy preset names (sm/md/lg/full) still arrive from a settings file
  // written by an earlier build; fold them into the new fixed/percent split
  // instead of discarding the user's choice.
  if (MODAL_FIXED_SIZES.includes(modal.size)) out.shell.modal.size = modal.size;
  else if (modal.size === "full") {
    out.shell.modal.sizing = "percent";
    out.shell.modal.percent = "p100";
  }
  if (MODAL_PERCENT_SIZES.includes(modal.percent)) out.shell.modal.percent = modal.percent;
  if (Number.isFinite(modal.dim)) out.shell.modal.dim = Math.min(MAX_DIM, Math.max(0, modal.dim));
  if (typeof modal.closeOnBackdrop === "boolean") out.shell.modal.closeOnBackdrop = modal.closeOnBackdrop;

  const windowOptions = shell.window && typeof shell.window === "object" ? shell.window : {};
  if (typeof windowOptions.alwaysOnTop === "boolean") out.shell.window.alwaysOnTop = windowOptions.alwaysOnTop;
  // Bounds used to live on `modal.bounds`; fold them in so an existing user
  // keeps the position of their window across the rename.
  out.shell.window.bounds = normalizeBounds(windowOptions.bounds) ?? normalizeBounds(modal.bounds);

  const dataDir = raw.dataDir && typeof raw.dataDir === "object" ? raw.dataDir : {};
  if (typeof dataDir.current === "string" && dataDir.current.trim() !== "") {
    out.dataDir.current = dataDir.current;
  }

  return out;
}

/**
 * A remembered window rectangle, or null when the record is unusable.
 *
 * Only the four numbers are kept: a stray key in the stored payload must never
 * reach the DOM as an inline style.
 *
 * @param {any} value
 * @returns {{ left: number, top: number, width: number, height: number } | null}
 */
export function normalizeBounds(value) {
  if (!value || typeof value !== "object") return null;
  const numbers = ["left", "top", "width", "height"].map((key) => Number(value[key]));
  if (!numbers.every((number) => Number.isFinite(number))) return null;
  const [left, top, width, height] = numbers;
  if (width < 240 || height < 180) return null;
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * CSS size for a modal, honouring the fixed/percent split.
 *
 * A fixed size is clamped to the viewport with `min()`, so choosing 1280px on a
 * 900px-wide browser shrinks the panel instead of pushing its edges off-screen.
 * A percentage is taken from the viewport directly, which is what "跟随窗口"
 * means to the user.
 *
 * @param {{ sizing?: string, size?: string, percent?: string } | null | undefined} modal
 * @returns {{ width: string, height: string }}
 */
export function modalSizeOf(modal) {
  const sizing = modal?.sizing === "percent" ? "percent" : "fixed";
  if (sizing === "percent") {
    const share = PERCENT_SHARES[modal?.percent] ?? PERCENT_SHARES.p70;
    return { width: `${share}vw`, height: `${share}vh` };
  }
  const preset = FIXED_SIZES[modal?.size] ?? FIXED_SIZES.md;
  return {
    width: `min(${preset.width}px, 94vw)`,
    height: `min(${preset.height}px, 90vh)`,
  };
}

/** Fixed presets, in CSS pixels. */
const FIXED_SIZES = Object.freeze({
  sm: { width: 860, height: 560 },
  md: { width: 1100, height: 720 },
  lg: { width: 1320, height: 820 },
  xl: { width: 1600, height: 960 },
});

/** Percentage presets, as whole viewport shares. */
const PERCENT_SHARES = Object.freeze({ p50: 50, p70: 70, p85: 85, p100: 100 });
