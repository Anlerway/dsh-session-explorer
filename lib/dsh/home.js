/**
 * dsh-session-navigator — DSH home resolution.
 *
 * The plugin reads DSH's own data tree (sessions, workspace registry, projection
 * cache) and must resolve it exactly the way the kernel does. The kernel's rule
 * (`@deepseek-ai/dsh-home-paths`) is: an explicit configured path, then
 * `$DSH_HOME`, then `~/.dsh`; a blank `$DSH_HOME` counts as unset.
 *
 * The helper package is not re-exported at runtime (its entry point is only
 * guaranteed inside `cordis.yml` `!!js` expressions), so the four-line rule is
 * reproduced here rather than imported. It is small, stable and covered by the
 * self-test; duplicating it is cheaper than depending on an unexported module.
 */

import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";

/** Environment variable that relocates the whole DSH home. */
export const DSH_HOME_ENV = "DSH_HOME";

/** Default directory name under the user's home. */
export const DSH_HOME_DIR_NAME = ".dsh";

/**
 * Resolve the DSH home directory.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [configured] explicit override, highest precedence
 * @returns {string} absolute path
 */
export function dshHome(env = process.env, configured) {
  const candidate = typeof configured === "string" && configured.trim() ? configured.trim() : env?.[DSH_HOME_ENV];
  if (typeof candidate === "string" && candidate.trim() !== "") {
    const abs = resolve(candidate.trim());
    if (parse(abs).root !== abs) return abs;
  }
  return join(homedir(), DSH_HOME_DIR_NAME);
}

