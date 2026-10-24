/**
 * dsh-session-navigator — settings document shape.
 *
 * One place that knows every setting the plugin stores, so the sidecar default,
 * the HTTP coercion and the settings page can never drift apart.
 *
 * The document is nested on purpose:
 *
 *   {
 *     shell: {
 *       open:   { mode },                 <- 默认打开方式: 浮窗 or 独立弹窗
 *       header: { style },                <- 会话界面按钮样式: 自动 or 仅显示图标
 *       modal:  { sizing, size, percent, dim, closeOnBackdrop },
 *       window: { alwaysOnTop, bounds },   <- geometry of 独立窗口
 *     },
 *     list: {
 *       autoCollapse,   <- 自动折叠: fold a container after entering it
 *       showArchived,   <- 显示已归档的会话: hide the greyed-out tail instead
 *       hideBlank, collapseSubagents,
 *       dateFormat,     <- 日期格式: 详细日期 or 距今时间
 *       sizeFormat,     <- 大小单位: 自动转换 or 固定 KB
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

import { isUsableDataDir } from "../paths.js";

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
 * Where the explorer opens when it is launched from DSH's sidebar.
 *
 *   panel    — 浮窗: the in-page overlay, no extra process, always available.
 *   detached — 独立弹窗: the Electron window, which needs the browser component.
 *
 * 浮窗 is the default because it cannot fail: the detached window needs a
 * component that may not be installed, and a launch that lands nowhere is the
 * worst answer for a button that looks ready.
 */
export const OPEN_MODES = Object.freeze(["panel", "detached"]);

/**
 * How the five buttons in DSH's conversation header are labelled.
 *
 *   auto — icon + word while the window is wide enough, icon alone when the
 *          header gets narrow (the responsive rule the strip always had).
 *   icon — icon alone at every width, for users who know the glyphs and want
 *          the strip to take as little of the title bar as possible.
 *
 * Both keep the label as `title`/`aria-label`, so a bare glyph is never the
 * only name a screen reader or a hover tooltip can give the button.
 */
export const HEADER_STYLES = Object.freeze(["auto", "icon"]);

/**
 * How a row spells its timestamp.
 *
 *   date     — 详细日期: the clock time itself (`10-18 06:55`).
 *   relative — 距今时间: `3 天前`, with the unit following the distance.
 *
 * A date is what you want when comparing two rows; a relative time is what you
 * want when scanning for "the one I was in earlier". Neither is right for
 * everyone, so the choice is stored rather than guessed from row width.
 */
export const DATE_FORMATS = Object.freeze(["date", "relative"]);

/**
 * How a row spells a size.
 *
 *   auto — the largest unit that keeps the number readable (B / KB / MB / GB).
 *   kb   — 固定 KB: one unit for every row, so a column can be compared by eye
 *          at the cost of reading `18734 KB` where `18.3 MB` would do.
 */
export const SIZE_FORMATS = Object.freeze(["auto", "kb"]);

/**
 * The legacy 折叠子智能体 choice, kept only to migrate a stored document.
 *
 * The setting is a switch now (`list.collapseSubagents`), because two states
 * were the whole choice; the words survived as a picker and made a binary
 * preference look like a mode. `expanded` maps to `false`.
 */
export const SUBAGENT_MODES = Object.freeze(["collapsed", "expanded"]);

/**
 * A fresh settings document.
 *
 * @returns {any}
 */
export function defaultSettings() {
  return {
    shell: {
      // 默认打开方式 — 浮窗 out of the box (see OPEN_MODES).
      open: { mode: "panel" },
      // 会话界面按钮样式 — words until the strip runs out of room (see
      // HEADER_STYLES); the old responsive behaviour is the default.
      header: { style: "auto" },
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
    // 归档 = 视觉降权, never hidden (hard constraint 3), so the default keeps
    // showing it; folding a container is a convenience, not a behaviour.
    list: {
      autoCollapse: false,
      showArchived: true,
      // 折叠子智能体 — a run that delegated ten times has ten child rows and
      // none of them is a session the user can act on (see domain/subagents.js),
      // so they fold under the parent by default. The per-parent twist still
      // opens one either way.
      collapseSubagents: true,
      // 过滤空会话 — a session that never started a turn holds nothing to read:
      // it is what a launch that closed the window before typing leaves behind.
      // Hidden by default, and the count stays visible in the status bar.
      hideBlank: true,
      // 日期格式 — 详细日期 out of the box: it is what the list always showed,
      // and "3 天前" is a reading of the same number, not a better one.
      dateFormat: "date",
      // 大小单位 — 自动转换, for the same reason.
      sizeFormat: "auto",
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

  if (incoming.shell && typeof incoming.shell === "object") {
    const shell = { ...(base.shell && typeof base.shell === "object" ? base.shell : {}) };
    if (incoming.shell.open && typeof incoming.shell.open === "object") {
      shell.open = {
        ...(shell.open && typeof shell.open === "object" ? shell.open : {}),
        ...incoming.shell.open,
      };
    }
    if (incoming.shell.header && typeof incoming.shell.header === "object") {
      shell.header = {
        ...(shell.header && typeof shell.header === "object" ? shell.header : {}),
        ...incoming.shell.header,
      };
    }
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

  if (incoming.list && typeof incoming.list === "object") {
    merged.list = {
      ...(base.list && typeof base.list === "object" ? base.list : {}),
      ...incoming.list,
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

  const shell = raw.shell && typeof raw.shell === "object" ? raw.shell : {};

  const open = shell.open && typeof shell.open === "object" ? shell.open : {};
  if (OPEN_MODES.includes(open.mode)) out.shell.open.mode = open.mode;

  const header = shell.header && typeof shell.header === "object" ? shell.header : {};
  if (HEADER_STYLES.includes(header.style)) out.shell.header.style = header.style;

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

  const list = raw.list && typeof raw.list === "object" ? raw.list : {};
  if (typeof list.autoCollapse === "boolean") out.list.autoCollapse = list.autoCollapse;
  if (typeof list.showArchived === "boolean") out.list.showArchived = list.showArchived;
  if (typeof list.hideBlank === "boolean") out.list.hideBlank = list.hideBlank;
  if (DATE_FORMATS.includes(list.dateFormat)) out.list.dateFormat = list.dateFormat;
  if (SIZE_FORMATS.includes(list.sizeFormat)) out.list.sizeFormat = list.sizeFormat;
  // A document written by an earlier build stores the mode word instead of the
  // switch; fold it in *before* the switch itself so nobody's 展开 choice is
  // silently reset to folded, and a document carrying both prefers the switch.
  if (SUBAGENT_MODES.includes(list.subagents)) out.list.collapseSubagents = list.subagents !== "expanded";
  if (typeof list.collapseSubagents === "boolean") out.list.collapseSubagents = list.collapseSubagents;

  const dataDir = raw.dataDir && typeof raw.dataDir === "object" ? raw.dataDir : {};
  // `dataDir.current` decides where the sidecars and the trash live, so it is
  // the one string in this document that can move a recursive delete onto an
  // arbitrary path. It is validated with the same rule the migration target
  // uses; anything else is dropped rather than echoed back to the client.
  if (typeof dataDir.current === "string" && isUsableDataDir(dataDir.current)) {
    out.dataDir.current = dataDir.current.trim();
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
