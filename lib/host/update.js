/**
 * dsh-session-explorer — "is there a newer release?" and the project links.
 *
 * Both live on the host, and for the same two reasons:
 *
 *   - The page that asks is a browser document. `api.github.com` answers it with
 *     no CORS headers, so a client-side `fetch` fails closed and looks exactly
 *     like "no update available".
 *   - A link has to be opened by the OS. The detached window's main process
 *     denies `window.open`, so an `<a target="_blank">` in that surface is a
 *     dead click (see lib/component/layout.js).
 *
 * The check itself is one GET against the releases API. It is deliberately
 * never automatic on load: a plugin that phones home every time the settings
 * page opens is a plugin people uninstall. The user presses 检查更新, and the
 * answer is cached for a few minutes so pressing it twice does not spend two
 * rate-limit tokens.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_URL } from "../constants.js";
import { codedError } from "../store/sidecar.js";

/** How long an answer stays fresh. GitHub allows 60 anonymous requests / hour. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** GitHub gives up before a stuck connection does. */
const REQUEST_TIMEOUT_MS = 8_000;

/** `https://github.com/owner/repo` → `https://api.github.com/repos/owner/repo`. */
const API_BASE = REPO_URL.replace("https://github.com/", "https://api.github.com/repos/");

/** The newest published release, or 404 when the project has none yet. */
const LATEST_RELEASE = `${API_BASE}/releases/latest`;

/** @type {string | null} */
let versionCache = null;

/**
 * The version this build was packaged as.
 *
 * Read from `package.json` rather than duplicated in a constant: a second copy
 * is a second thing to forget when the version is bumped.
 *
 * @returns {string}
 */
export function pluginVersion() {
  if (versionCache) return versionCache;
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    versionCache = typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
  } catch {
    // A missing package.json means a source checkout run out of context; the
    // check still works, it just cannot say what "current" is.
    versionCache = "0.0.0";
  }
  return versionCache;
}

/**
 * Split `v1.2.3-rc.1+build` into its comparable parts.
 *
 * @param {unknown} value
 * @returns {{ numbers: number[], pre: string }}
 */
function parseVersion(value) {
  const text = String(value ?? "").trim().replace(/^v/i, "");
  const [core = "", ...prerelease] = text.split("-");
  const numbers = core
    .split("+")[0]
    .split(".")
    .map((part) => {
      const digits = /^\d+/.exec(part);
      return digits ? Number(digits[0]) : 0;
    });
  return { numbers, pre: prerelease.join("-").split("+")[0] };
}

/**
 * Order two versions the way a human reads them.
 *
 * A prerelease sorts before the release it leads to (`1.0.0-rc.1 < 1.0.0`), so
 * a project publishing release candidates does not tell its users that an rc
 * is newer than the release they already run.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.numbers[index] ?? 0;
    const y = right.numbers[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * The fields of a GitHub release this plugin uses.
 *
 * @param {any} payload
 * @returns {{ latest: string | null, url: string, name: string, publishedAt: string | null, notes: string }}
 */
export function parseRelease(payload) {
  const tag = typeof payload?.tag_name === "string" && payload.tag_name.trim()
    ? payload.tag_name.trim()
    : typeof payload?.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : "";
  const latest = tag ? tag.replace(/^v/i, "") : null;
  return {
    latest,
    url: typeof payload?.html_url === "string" && payload.html_url ? payload.html_url : `${REPO_URL}/releases`,
    name: typeof payload?.name === "string" ? payload.name : "",
    publishedAt: typeof payload?.published_at === "string" ? payload.published_at : null,
    // Enough of the notes to be useful in a row; the page itself is the place
    // to read the whole thing.
    notes: typeof payload?.body === "string" ? payload.body.slice(0, 2000) : "",
  };
}

/** @type {{ at: number, current: string, result: any } | null} */
let cached = null;

/** Forget the cached answer. Tests only: production lets the TTL do it. */
export function resetUpdateCache() {
  cached = null;
}

/**
 * Ask GitHub for the newest release and compare it with this build.
 *
 * @param {{ force?: boolean, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ current: string, latest: string | null, hasUpdate: boolean, url: string, name: string, publishedAt: string | null, notes: string, checkedAt: number }>}
 */
export async function checkUpdate(options = {}) {
  const current = pluginVersion();
  const now = Date.now();
  if (!options.force && cached && cached.current === current && now - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw codedError("update-unreachable", "this runtime has no fetch, so the update check cannot run");
  }

  /** @type {any} */
  let response;
  try {
    response = await doFetch(LATEST_RELEASE, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `dsh-session-explorer/${current}`,
      },
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
    });
  } catch (error) {
    throw codedError("update-unreachable", `cannot reach GitHub: ${error?.message ?? error}`);
  }

  // No published release yet is not a failure: it is the normal state of a
  // project between its first commit and its first tag.
  if (response.status === 404) {
    const result = {
      current,
      latest: null,
      hasUpdate: false,
      url: `${REPO_URL}/releases`,
      name: "",
      publishedAt: null,
      notes: "",
      checkedAt: now,
    };
    cached = { at: now, current, result };
    return result;
  }
  if (!response.ok) {
    throw codedError("update-unreachable", `GitHub answered HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw codedError("update-unreachable", "GitHub answered with something that is not JSON");
  }

  const release = parseRelease(payload);
  /** @type {any} */
  const result = {
    current,
    ...release,
    hasUpdate: release.latest !== null && compareVersions(release.latest, current) > 0,
    checkedAt: now,
  };
  cached = { at: now, current, result };
  return result;
}
