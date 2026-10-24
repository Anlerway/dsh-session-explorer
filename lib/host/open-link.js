/**
 * dsh-session-navigator — open one of the project's pages in the user's browser.
 *
 * The client cannot do this itself: the panel is a browser document (a plain
 * `window.open` from the panel inherits whatever popup and sandbox rules the
 * host page has) and the detached window's main process denies `window.open`
 * outright. So the click travels to the host, which starts the platform's
 * opener.
 *
 * **The target is an allowlist, not a URL.** A route that opens whatever it is
 * handed is a primitive any page on this origin could use to launch a browser,
 * and the plugin's own routes carry no token. `target` names one of four links;
 * a value that is not in the table is a 400.
 */

import { spawn } from "node:child_process";

import { REPO_URL } from "../constants.js";
import { codedError } from "../store/sidecar.js";

/**
 * Every link this route may open.
 *
 * Star and the repository are the same page on purpose: GitHub has no
 * "star this" URL, and the repo page is where the button is.
 */
export const LINK_TARGETS = Object.freeze({
  repo: REPO_URL,
  star: REPO_URL,
  issues: `${REPO_URL}/issues`,
  releases: `${REPO_URL}/releases`,
});

/** How long one opener strategy may take before its answer stops mattering. */
const ATTEMPT_TIMEOUT_MS = 4_000;

/**
 * Quote a value for a PowerShell single-quoted literal.
 *
 * @param {string} value
 * @returns {string}
 */
function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * The opener strategies for one platform, in the order they are tried.
 *
 * Windows gets two on purpose. `rundll32 url.dll,FileProtocolHandler` is a bare
 * ShellExecute: no console host, no inherited window state, nothing that can
 * swallow the launch when the caller itself has no window. The PowerShell
 * fallback stays because `Start-Process` is the documented way and covers the
 * machines where the ShellExecute shortcut is unavailable.
 *
 * @param {string} platform
 * @param {string} url
 * @returns {{ command: string, args: string[] }[]}
 */
function strategiesFor(platform, url) {
  if (platform === "win32") {
    return [
      { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] },
      // `Start-Process` rather than `cmd /c start`: the latter re-parses the URL
      // and treats `&` as a command separator.
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `Start-Process '${psQuote(url)}'`],
      },
    ];
  }
  if (platform === "darwin") return [{ command: "open", args: [url] }];
  return [
    { command: "xdg-open", args: [url] },
    { command: "gio", args: ["open", url] },
  ];
}

/**
 * Run one opener and report whether it accepted the URL.
 *
 * Detached and with no stdio: the browser outlives this request, and the child
 * must not keep the DSH process alive. The exit code is the answer: a strategy
 * that merely started proves nothing, which is exactly how a broken link could
 * look like a success.
 *
 * @param {{ command: string, args: string[] }} strategy
 * @param {typeof spawn} spawnImpl
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
function attempt(strategy, spawnImpl) {
  const { command, args } = strategy;
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.unref?.();
      } catch {
        /* already gone */
      }
      resolve(outcome);
    };
    const fail = (reason) => settle({ ok: false, reason: `${command}: ${reason}` });
    const timer = setTimeout(() => {
      // Still running after four seconds. That is not a failure to report: a
      // slow shell is no reason to complain over a page that did open, and a
      // second strategy would open it twice.
      settle({ ok: true });
    }, ATTEMPT_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    try {
      child = spawnImpl(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch (error) {
      fail(error?.message ?? String(error));
      return;
    }
    child.once("error", (error) => fail(error?.message ?? String(error)));
    child.once("exit", (code, signal) => {
      if (code === 0) settle({ ok: true });
      else fail(signal ? `killed by ${signal}` : `exited ${code}`);
    });
  });
}

/**
 * Hand a URL to the platform's default browser.
 *
 * Every strategy is tried in turn until one reports success; if none does, the
 * error names the URL so the panel can show it to the user instead of failing
 * silently.
 *
 * @param {string} url
 * @param {{ spawnImpl?: typeof spawn, platform?: string }} [options] injected for tests
 * @returns {Promise<void>}
 */
export async function openInBrowser(url, options = {}) {
  const spawnImpl = typeof options.spawnImpl === "function" ? options.spawnImpl : spawn;
  const platform = typeof options.platform === "string" ? options.platform : process.platform;
  const reasons = [];
  for (const strategy of strategiesFor(platform, url)) {
    const outcome = await attempt(strategy, spawnImpl);
    if (outcome.ok) return;
    reasons.push(outcome.reason);
  }
  throw codedError("open-failed", `cannot open ${url} (${reasons.join("; ")})`);
}

/**
 * Open one of the allowlisted pages.
 *
 * @param {unknown} target one of `LINK_TARGETS`
 * @param {{ open?: (url: string) => Promise<void> }} [options] injected opener (tests)
 * @returns {Promise<{ target: string, url: string, opened: true }>}
 */
export async function openLink(target, options = {}) {
  const key = String(target ?? "");
  const url = Object.prototype.hasOwnProperty.call(LINK_TARGETS, key) ? LINK_TARGETS[key] : null;
  if (!url) {
    throw codedError("bad-request", `unknown link target: ${key || "(none)"}`);
  }
  const open = typeof options.open === "function" ? options.open : openInBrowser;
  await open(url);
  return { target: key, url, opened: true };
}
