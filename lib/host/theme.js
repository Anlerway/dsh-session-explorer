/**
 * dsh-session-explorer — the live theme, as a tiny shared store.
 *
 * The floating panel runs inside the DSH document, so `getComputedStyle` on its
 * own shell resolves every `--dsw-alias-*` token to the theme's current value.
 * The detached window is a `file://` page in another process: it has no such
 * document, and its `shell.css` falls back to a hard-coded dark palette.
 *
 * This store is the hand-off. The panel reports what it sees, and the window
 * asks for it, so switching DSH to a light theme or installing a theme plugin
 * repaints the window too.
 *
 * Only the tokens the stylesheet actually uses are accepted, and only as
 * strings: the value ends up inside a CSS custom property, so an unbounded map
 * from the network would be a style-injection channel.
 */

/**
 * Tokens the detached window's stylesheet consumes. `--se-*` is the window's own
 * bridge, `--dsw-alias-*` is DSH's palette.
 */
export const THEME_TOKENS = Object.freeze([
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-bg-layer-4",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-label-quaternary",
  "--dsw-alias-label-primary-inverted",
  "--dsw-alias-label-error",
  "--dsw-alias-brand-text",
  "--dsw-alias-link",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-border-l3",
  "--dsw-alias-border-l4",
  "--dsw-alias-fill-l1",
  "--dsw-alias-fill-l2",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-brand-primary",
  "--dsw-alias-state-business-primary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-warning-primary",
]);

/** Longest accepted token value: a colour or a small colour-mix expression. */
const VALUE_MAX = 160;

/**
 * Reject anything that could break out of a declaration.
 *
 * A value is written as `root.style.setProperty(name, value)`, so a `;` or a
 * `}` cannot escape on its own — but a URL or an `expression()` still can, and
 * neither belongs in a palette token.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isSafeTokenValue(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || text.length > VALUE_MAX) return false;
  if (/[;{}]/.test(text)) return false;
  if (/url\(|expression\(|@import|javascript:/i.test(text)) return false;
  return /^[#\w\s.,%()\-+/'"*]+$/.test(text);
}

/**
 * Luminance of a plain CSS colour, or -1 when the value is not one we can read
 * (a `color-mix()`, a gradient, an empty string).
 *
 * @param {string | undefined} value
 * @returns {number}
 */
function surfaceLuminance(value) {
  if (typeof value !== "string") return -1;
  const text = value.trim();
  /** @type {number[] | null} */
  let parts = null;
  if (text.charAt(0) === "#") {
    const body = text.slice(1);
    if (body.length !== 3 && body.length !== 6) return -1;
    const full = body.length === 3 ? body.charAt(0) + body.charAt(0) + body.charAt(1) + body.charAt(1) + body.charAt(2) + body.charAt(2) : body;
    parts = [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16));
  } else if (text.slice(0, 3) === "rgb") {
    parts = text
      .replace(/[^0-9.]+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 3)
      .map(Number);
  }
  if (!parts || parts.length < 3) return -1;
  if (parts.some((entry) => !Number.isFinite(entry))) return -1;
  const red = parts[0];
  const green = parts[1];
  const blue = parts[2];
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

/**
 * @param {{ now?: () => number }} [options]
 */
export function createThemeStore(options = {}) {
  const now = () => (typeof options.now === "function" ? options.now() : Date.now());
  /** @type {{ mode: string, tokens: Record<string, string>, at: number } | null} */
  let current = null;

  return {
    /**
     * Record what the panel reports.
     *
     * @param {{ mode?: string, tokens?: Record<string, string> }} input
     * @returns {{ mode: string, tokens: Record<string, string>, at: number }}
     */
    record(input) {
      /** @type {Record<string, string>} */
      const tokens = {};
      const source = input?.tokens && typeof input.tokens === "object" ? input.tokens : {};
      for (const name of THEME_TOKENS) {
        const value = source[name];
        if (isSafeTokenValue(value)) tokens[name] = String(value).trim();
      }
      // The palette is the authority, the caller's claim is only a fallback: a
      // light background under a "dark" claim would paint dark-mode form controls
      // and scrollbars onto a white surface.
      const surface = surfaceLuminance(tokens["--dsw-alias-bg-layer-1"]);
      const mode = surface >= 0 ? (surface > 0.5 ? "light" : "dark") : input?.mode === "light" ? "light" : "dark";
      current = { mode, tokens, at: now() };
      return current;
    },

    /**
     * The last reported palette, or `null` when the panel has never reported one
     * (the window then keeps its own fallbacks).
     */
    snapshot() {
      return current;
    },

    /** Drop the stored palette (a data-directory migration, tests). */
    clear() {
      current = null;
    },
  };
}
