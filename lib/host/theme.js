/**
 * dsh-session-navigator — the live theme, as a tiny shared store.
 *
 * The floating panel runs inside the DSH document, so `getComputedStyle` on its
 * own shell resolves every `--dsw-alias-*` token to the theme's current value.
 * The detached window is another document in another process: it runs the same
 * UI, but DSH's stylesheet is not there, so those tokens would fall back to the
 * panel's own defaults.
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
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-state-business-primary",
  "--dsw-alias-brand-primary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-interactive-bg-hover",
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
      const mode = input?.mode === "light" ? "light" : "dark";
      /** @type {Record<string, string>} */
      const tokens = {};
      const source = input?.tokens && typeof input.tokens === "object" ? input.tokens : {};
      for (const name of THEME_TOKENS) {
        const value = source[name];
        if (isSafeTokenValue(value)) tokens[name] = String(value).trim();
      }
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
