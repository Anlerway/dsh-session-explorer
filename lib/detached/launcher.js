/**
 * dsh-session-explorer — the detached-window helper processes.
 *
 * Two files, two processes, one job: show the explorer UI in a real OS window.
 *
 *   launcher.js  Host-side lifecycle: spawn / retry / focus / close, env setup,
 *                log redaction and the `node:net` control channel.
 *   main.cjs     runs *inside* the downloaded Electron runtime; owns the
 *                BrowserWindow and loads the local page.
 *
 * The one non-obvious detail is `ELECTRON_RUN_AS_NODE`. The DSH desktop app
 * itself runs with that variable set to `1`; a child that inherits it does not
 * start Chromium at all, so the window silently never appears. `launch()`
 * deletes it.
 *
 * The helper connects back over a local socket rather than being told what to
 * do over stdio: a socket survives a renderer reload, and it lets the Host know
 * the helper is alive without parsing logs.
 */

import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Retry delays for a crashing helper, in milliseconds. */
const RETRY_DELAYS_MS = [1000, 3000, 8000];

/**
 * The Chromium profile directory for one DSH profile.
 *
 * A dedicated `--user-data-dir` is mandatory: sharing the main app's profile
 * would fight its single-instance lock, and the helper would refuse to start.
 *
 * @param {string} dataDir
 * @param {string} profileKey
 * @returns {string}
 */
export function helperProfileDir(dataDir, profileKey) {
  const id = createHash("sha256").update(profileKey).digest("hex").slice(0, 16);
  return join(dataDir, "detached", "chromium", id);
}

/**
 * @param {string[]} lines
 * @returns {string[]} the lines that are safe to log
 */
export function redactLines(lines) {
  return lines.filter((line) => line.trim() !== "" && !/token=|api[_-]?key|authorization|Bearer\s/i.test(line));
}

/**
 * Create the detached-window controller.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.helperMain absolute path to main.cjs (inside the component)
 * @param {() => Promise<{ binary: string, ready: boolean }>} options.runtime
 * @param {() => number} options.webPort
 * @param {(level: string, message: string) => void} [options.log]
 * @param {string} [options.profileKey]
 * @returns {object}
 */
export function createDetachedController(options) {
  const log = options.log ?? (() => {});
  const token = randomBytes(24).toString("hex");
  const profileKey = options.profileKey ?? "default";
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  /** @type {import("node:net").Server | null} */
  let server = null;
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  let port = 0;
  let failures = 0;
  let retryTimer = null;
  let stopped = false;
  /**
   * Set when the window told us it closed itself.
   *
   * `close` is a *request*; the process exits a moment later, and the exit
   * handler used to treat that as a crash and respawn the window — which is
   * exactly "关掉之后它又自己弹出来". The control-channel message is the only
   * signal that the exit was intentional, so it has to be remembered before the
   * exit arrives.
   */
  let closedByUser = false;

  /**
   * Open the control socket. It listens on 127.0.0.1:0 — an ephemeral port that
   * is handed to the helper through the environment, never written to disk.
   *
   * @returns {Promise<{ port: number, token: string }>}
   */
  async function bind() {
    if (server) return { port, token };
    server = createServer((socket) => accept(socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("detached: control socket has no port");
    port = address.port;
    return { port, token };
  }

  /**
   * @param {import("node:net").Socket} socket
   */
  function accept(socket) {
    socket.setEncoding("utf8");
    let authed = false;
    let buffer = "";
    const timer = setTimeout(() => {
      if (!authed) socket.destroy();
    }, 5000);
    timer.unref?.();

    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1_000_000) {
        socket.destroy();
        return;
      }
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        let message;
        try {
          message = JSON.parse(part);
        } catch {
          socket.destroy();
          return;
        }
        if (!authed) {
          if (!tokenMatches(message?.token)) {
            socket.destroy();
            return;
          }
          authed = true;
          clearTimeout(timer);
          sockets.add(socket);
          socket.write(`${JSON.stringify({ type: "hello-ok" })}\n`);
          continue;
        }
        if (message?.type === "ping") socket.write(`${JSON.stringify({ type: "pong" })}\n`);
        else if (message?.type === "bounds") rememberBounds(message.bounds).catch(() => {});
        else if (message?.type === "closed") {
          sockets.delete(socket);
          child = null;
          closedByUser = true;
          notify("closed");
        } else if (message?.type === "hello-ok") {
          // The helper only writes this once the token matched, so it is the
          // earliest proof that a window is actually alive and listening.
          notify("hello");
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }

  /**
   * @param {string} given
   * @returns {boolean}
   */
  function tokenMatches(given) {
    if (typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** @param {any} bounds */
  async function rememberBounds(bounds) {
    const { writeFile } = await import("node:fs/promises");
    const file = join(options.dataDir, "detached", "window.json");
    await mkdir(join(options.dataDir, "detached"), { recursive: true });
    await writeFile(file, `${JSON.stringify(bounds, null, 2)}\n`, "utf8");
  }

  /**
   * Launch the helper if it is not already running.
   *
   * @returns {Promise<{ pid: number | null, port: number }>}
   */
  async function launch() {
    const runtime = await options.runtime();
    if (!runtime?.ready || !runtime.binary) {
      const error = new Error("the browser component is not installed");
      error.code = "component-not-installed";
      throw error;
    }
    const control = await bind();
    if (child && child.exitCode === null) {
      // Single instance: ask the running window to come forward.
      broadcast({ type: "focus" });
      return { pid: child.pid ?? null, port: control.port };
    }

    const userData = helperProfileDir(options.dataDir, profileKey);
    await mkdir(userData, { recursive: true });

    const env = {
      ...process.env,
      DSH_SE_HELPER_TOKEN: token,
      DSH_SE_HELPER_PORT: String(control.port),
      DSH_SE_WEB_PORT: String(options.webPort()),
      DSH_SE_DATA_DIR: options.dataDir,
    };
    // ★ The DSH desktop app runs with ELECTRON_RUN_AS_NODE=1; inheriting it makes
    // the child a plain Node process with no BrowserWindow at all.
    delete env.ELECTRON_RUN_AS_NODE;

    const launched = spawn(runtime.binary, [`--user-data-dir=${userData}`, options.helperMain], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child = launched;

    const forward = (chunk) => {
      for (const line of redactLines(String(chunk).split("\n"))) log("info", `detached: ${line}`);
    };
    launched.stdout?.setEncoding("utf8");
    launched.stderr?.setEncoding("utf8");
    launched.stdout?.on("data", forward);
    launched.stderr?.on("data", forward);

    launched.once("error", (error) => scheduleRetry(error.message));
    launched.once("exit", (code, signal) => {
      if (stopped) return;
      child = null;
      // A window the user closed is not a crash: respawning it would ignore the
      // one instruction they gave (see `closedByUser`).
      if (closedByUser) {
        closedByUser = false;
        failures = 0;
        log("info", "detached: window closed by the user");
        return;
      }
      scheduleRetry(`helper exited (${code ?? signal})`);
    });
    return { pid: launched.pid ?? null, port: control.port };
  }

  /**
   * @param {string} reason
   */
  function scheduleRetry(reason) {
    failures += 1;
    const delay = RETRY_DELAYS_MS[failures - 1];
    if (delay === undefined) {
      log("warn", `detached: helper failed repeatedly (${reason}); giving up`);
      return;
    }
    log("warn", `detached: helper failed (${reason}); retry in ${delay}ms`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      launch().catch((error) => log("warn", `detached: retry failed: ${error?.message ?? error}`));
    }, delay);
    retryTimer.unref?.();
  }

  /**
   * Forward a lifecycle event to whoever asked for them.
   *
   * @param {string} event
   */
  function notify(event) {
    if (typeof options.onEvent !== "function") return;
    try {
      options.onEvent(event);
    } catch {
      /* a listener that throws must not corrupt the control channel */
    }
  }

  /**
   * @param {any} message
   */
  function broadcast(message) {
    const line = `${JSON.stringify(message)}\n`;
    for (const socket of sockets) {
      try {
        socket.write(line);
      } catch {
        socket.destroy();
      }
    }
  }

  return {
    /** Bring the window forward, starting it if needed. */
    async open() {
      // An explicit open always wins over a previous close: the flag only
      // suppresses the *automatic* restart of a window that just went away.
      closedByUser = false;
      const result = await launch();
      broadcast({ type: "focus" });
      return result;
    },
    /** Ask the window to come forward; never spawns. */
    async focus() {
      if (!child) return { focused: false };
      broadcast({ type: "focus" });
      return { focused: true };
    },
    /**
     * Close the window.
     *
     * @returns {Promise<boolean>} whether a helper was running and was asked to stop
     */
    async close() {
      if (!child) return true;
      closedByUser = true;
      broadcast({ type: "close" });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (child && child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      child = null;
      return true;
    },
    /** Tear everything down (plugin unload). */
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      broadcast({ type: "close" });
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server?.close();
      server = null;
      if (child && child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      child = null;
    },
    get running() {
      return Boolean(child && child.exitCode === null);
    },
    get pid() {
      return child?.pid ?? null;
    },
  };
}
