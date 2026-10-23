/**
 * A long-lived PowerShell used for reveal requests.
 *
 * Each reveal used to pay for a fresh `powershell.exe`: about one second of
 * process start plus ~350ms of `Add-Type` compiling the same three P/Invokes
 * every time. Measured on this machine: 1.9–3.2s per click, which is what made
 * "打开" feel slow. One process that stays up pays that once; a request after
 * that is a line of stdin and a line of stdout.
 *
 * The protocol is deliberately dumb: write one line, read until a sentinel.
 * Anything the shell prints on its own — prompts, progress records — is
 * ignored, because only `#R:<state>#` is ever matched.
 *
 * Failure is never fatal: any error here rejects, and the caller falls back to
 * the one-shot path it used before. A missing agent costs speed, not function.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long a request may take before the agent is considered wedged. */
const REQUEST_TIMEOUT_MS = 10_000;

/** How long the process may sit idle before it is shut down again. */
const IDLE_TIMEOUT_MS = 180_000;

/** Quote a value for a single-quoted PowerShell literal. */
function psQuote(value) {
  return String(value ?? "").replace(/'/g, "''");
}

/**
 * The agent process, or null when none is running.
 *
 * @type {{ child: import("node:child_process").ChildProcess, buffer: string, waiters: Map<number, { resolve: (state: string) => void, reject: (error: Error) => void }>, timer: NodeJS.Timeout | null } | null}
 */
let agent = null;

/** Serializes requests: one line in, one line out, no interleaving. */
let queue = Promise.resolve();

/** @type {number} */
let sequence = 0;

/** @type {string | null} */
let scriptPath = null;

/**
 * Write the reveal script next to the OS temp directory, once per process.
 *
 * It is a file rather than an inline command because it contains a here-string
 * (`Add-Type -MemberDefinition @'…'@`), and stdin-mode PowerShell executes one
 * line at a time.
 *
 * @param {string} script
 * @returns {string}
 */
function ensureScript(script) {
  if (scriptPath) return scriptPath;
  const path = join(tmpdir(), `dsh-session-explorer-reveal-${process.pid}.ps1`);
  writeFileSync(path, script, "utf8");
  scriptPath = path;
  return path;
}

/** Start the agent if it is not running. */
function ensureAgent(script) {
  if (agent) return agent;
  const path = ensureScript(script);
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  /** @type {any} */
  const state = { child, buffer: "", waiters: new Map(), timer: null, scriptPath: path };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.buffer += chunk;
    // A finished request always ends with `#REND:<n>#`; everything before it
    // that looks like `#R:<state>#` belongs to that request.
    let match;
    while ((match = /#REND:(\d+)#/.exec(state.buffer)) !== null) {
      const id = Number(match[1]);
      const head = state.buffer.slice(0, match.index);
      state.buffer = state.buffer.slice(match.index + match[0].length);
      const found = /#R:(\w+)#/g;
      let last = "none";
      let hit;
      while ((hit = found.exec(head)) !== null) last = hit[1];
      const waiter = state.waiters.get(id);
      if (waiter) {
        state.waiters.delete(id);
        waiter.resolve(last);
      }
    }
  });
  // stderr is diagnostics only: a broken agent must not look like a broken
  // reveal, and the caller has the one-shot path as a fallback.
  child.stderr.on("data", () => {});
  child.on("exit", () => {
    for (const waiter of state.waiters.values()) {
      waiter.reject(new Error("reveal agent exited"));
    }
    state.waiters.clear();
    if (agent === state) agent = null;
  });
  child.on("error", () => {
    if (agent === state) agent = null;
  });
  agent = state;
  return state;
}

/** Shut the agent down (idle timeout, or a wedged request). */
function stopAgent() {
  if (!agent) return;
  const current = agent;
  agent = null;
  if (current.timer) clearTimeout(current.timer);
  try {
    current.child.stdin.end();
    current.child.kill();
  } catch {
    // Already gone.
  }
}

/**
 * Run one reveal request through the agent.
 *
 * @param {string} script
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<string>} one of `opened` | `focused` | `behind` | `activated` | `none`
 */
export function revealWithAgent(script, dir, name) {
  const run = () => new Promise((resolve, reject) => {
    let state;
    try {
      state = ensureAgent(script);
    } catch (error) {
      reject(error);
      return;
    }
    const id = ++sequence;
    if (state.timer) clearTimeout(state.timer);
    const timer = setTimeout(() => {
      // A wedged shell would otherwise hold every later reveal behind it.
      stopAgent();
      reject(new Error("reveal agent timed out"));
    }, REQUEST_TIMEOUT_MS);
    state.waiters.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        state.timer = setTimeout(stopAgent, IDLE_TIMEOUT_MS);
        if (state.timer.unref) state.timer.unref();
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    const line =
      `$env:DSH_REVEAL_DIR='${psQuote(dir)}'; ` +
      `$env:DSH_REVEAL_NAME='${psQuote(name)}'; ` +
      `& '${psQuote(state.scriptPath)}'; "#REND:${id}#"`;
    try {
      state.child.stdin.write(`${line}\n`);
    } catch (error) {
      stopAgent();
      reject(error);
    }
  });
  // Serialize: two clicks in a row must not interleave their stdin lines.
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/**
 * Start the agent before it is needed.
 *
 * The first reveal pays for PowerShell start plus `Add-Type`; opening the panel
 * is when that cost becomes likely, so it is paid there instead of on the click.
 * Never throws — a failed warm-up just means the first click pays it.
 *
 * @param {string} script
 */
export function warmRevealAgent(script) {
  try {
    ensureAgent(script);
  } catch {
    // The one-shot path still works.
  }
}

/** Test seam: shut the agent down so a test run leaves no process behind. */
export function stopRevealAgent() {
  stopAgent();
}
