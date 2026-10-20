/**
 * dsh-session-explorer — the Electron helper's main process.
 *
 * This file runs *inside* the downloaded browser component, not inside DSH.
 * It is deliberately tiny: one window, no Node integration, no remote content,
 * and a single local page loaded from the plugin's own assets.
 *
 * Security posture (mirrors the advice in 实现粗规划 §5.6 ⑦):
 *
 *   - `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`;
 *   - the only preload is the plugin's own, and it exposes three IPC calls;
 *   - `setWindowOpenHandler` denies every popup and `will-navigate` refuses
 *     remote navigations; links open in the user's real browser instead;
 *   - the page is loaded with `loadFile`, never with a remote URL. It is the
 *     explorer itself, not the DSH app: no React, no module loader, no second
 *     copy of DSH behind a second window.
 *
 * The helper talks to the Host over the same HTTP API the in-app panel uses,
 * authenticated with the token the Host put in the environment. The token never
 * reaches the page's JavaScript: the preload attaches it to fetches.
 *
 * NOTE: this file is shipped as-is; Electron loads it as a CommonJS main.
 */

const { app, BrowserWindow, ipcMain, screen, shell, session } = require("electron");
const { join } = require("node:path");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { createConnection } = require("node:net");

const TOKEN = process.env.DSH_SE_HELPER_TOKEN ?? "";
const PORT = Number(process.env.DSH_SE_HELPER_PORT ?? 0);
const WEB_PORT = Number(process.env.DSH_SE_WEB_PORT ?? 0);
const DATA_DIR = process.env.DSH_SE_DATA_DIR ?? "";
const ASSET_ROOT = join(__dirname, "..", "..", "assets", "detached");
const WINDOW_FILE = DATA_DIR ? join(DATA_DIR, "detached", "window.json") : "";

app.disableHardwareAcceleration?.();

/** @type {BrowserWindow | null} */
let win = null;
/** @type {import("node:net").Socket | null} */
let control = null;

/**
 * Remembered geometry, clamped to a visible display.
 *
 * @returns {{ width: number, height: number, x?: number, y?: number }}
 */
function initialBounds() {
  const fallback = { width: 1280, height: 820 };
  try {
    if (!WINDOW_FILE || !existsSync(WINDOW_FILE)) return fallback;
    const raw = JSON.parse(readFileSync(WINDOW_FILE, "utf8"));
    const width = Number(raw.width);
    const height = Number(raw.height);
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 720 || height < 480) return fallback;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height };
    // A window restored onto a monitor that is gone would be invisible.
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return x >= area.x - 40 && y >= area.y - 40 && x < area.x + area.width - 80 && y < area.y + area.height - 80;
    });
    return visible ? { width, height, x, y } : { width, height };
  } catch {
    return fallback;
  }
}

/**
 * @param {string} event
 * @param {any} payload
 */
function send(event, payload) {
  if (control?.writable) {
    try {
      control.write(`${JSON.stringify({ type: event, ...payload })}\n`);
    } catch {
      /* the Host is gone; the window stays usable read-only */
    }
  }
}

/**
 * Run `fn` at most once per `ms`, trailing edge.
 *
 * A resize fires dozens of events per second; writing the geometry (and posting
 * it to the Host) on each one would turn a drag into a disk-thrashing loop.
 *
 * @param {() => void} fn
 * @param {number} ms
 * @returns {() => void}
 */
function throttle(fn, ms) {
  let timer = null;
  return () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        fn();
      } catch {
        /* geometry memory is a convenience */
      }
    }, ms);
    timer.unref?.();
  };
}

function persistBounds() {
  if (!win || win.isDestroyed() || !WINDOW_FILE) return;
  try {
    mkdirSync(join(WINDOW_FILE, ".."), { recursive: true });
    writeFileSync(WINDOW_FILE, `${JSON.stringify(win.getBounds(), null, 2)}\n`, "utf8");
  } catch {
    /* geometry memory is a convenience */
  }
}

function connectControl() {
  if (!PORT) return;
  const socket = createConnection({ host: "127.0.0.1", port: PORT });
  control = socket;
  socket.setEncoding("utf8");
  socket.write(`${JSON.stringify({ type: "hello", token: TOKEN, pid: process.pid })}\n`);

  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      let message;
      try {
        message = JSON.parse(part);
      } catch {
        continue;
      }
      if (message.type === "focus" && win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      } else if (message.type === "reveal" && win && win.webContents) {
        // The panel asked for one session to be shown. The window owns what
        // "showing" means (select the row, open its container, scroll it in);
        // main only forwards, because the page is the only thing that knows
        // which tab is active.
        win.webContents.send("se:command", { kind: "reveal", payload: { sessionId: String(message.sessionId ?? "") } });
      } else if (message.type === "command" && win && win.webContents) {
        win.webContents.send("se:command", {
          kind: String(message.kind ?? ""),
          payload: message.payload && typeof message.payload === "object" ? message.payload : null,
        });
      } else if (message.type === "close") {
        app.quit();
      }
    }
  });
  socket.on("error", () => {
    control = null;
  });
  socket.on("close", () => {
    control = null;
  });

  const heartbeat = setInterval(() => send("ping", {}), 20_000);
  heartbeat.unref?.();
}

function createWindow() {
  const bounds = initialBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // The page draws its own toolbar and tab strip, so the window is frameless
    // and the native title bar is hidden; the page's own drag region moves it.
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#00000000",
    webPreferences: {
      // The page reaches the Host only through this preload: it exposes three
      // IPC calls and never the helper token itself.
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The preload attaches the Host token to API requests, so the page needs
      // network access to 127.0.0.1 only; nothing else is allowed below.
      webSecurity: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // A popup the page asks for is still a new OS window, which this helper does
    // not manage: send real links to the browser and refuse the rest.
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The page is a local file and stays one. Anything else is either a link the
  // user meant to follow (their browser opens it) or an attempt to navigate the
  // window away from the explorer (refused).
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://")) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  // A window that never paints would otherwise stay invisible forever: the
  // page is a local file with no network fetches, so "ready-to-show" is the
  // normal path, and the timer is the fallback for a renderer that failed to
  // paint at all (a syntax error in the page, a GPU-less profile).
  win.once("ready-to-show", () => win?.show());
  const showTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }, 2500);
  showTimer.unref?.();
  win.webContents.on("did-finish-load", () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`session-explorer detached: page failed to load (${code} ${description}) ${url}`);
  });
  // The renderer's own errors are the only signal a broken page gives: without
  // this, a thrown error in shell.js is an empty window and nothing else.
  win.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level >= 2) console.error(`session-explorer detached: ${source}:${line} ${message}`);
  });
  // The Host owns the remembered geometry, but it can only learn it if this
  // process reports it. `bounds` was wired into the launcher from the start and
  // nothing ever sent it, so every reopen landed on the fallback size.
  const reportBounds = throttle(() => {
    if (win && !win.isDestroyed() && !win.isMinimized() && !win.isMaximized()) {
      send("bounds", { bounds: win.getBounds() });
    }
  }, 500);
  win.on("resize", reportBounds);
  win.on("move", reportBounds);
  win.on("close", () => {
    persistBounds();
    if (win && !win.isDestroyed() && !win.isMinimized() && !win.isMaximized()) {
      send("bounds", { bounds: win.getBounds() });
    }
  });
  win.on("closed", () => {
    win = null;
    send("closed", {});
    app.quit();
  });
  // A renderer that crashed or was reloaded leaves a window that exists but
  // cannot hear commands; logging it is the only signal the Host ever gets.
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`session-explorer detached: renderer gone (${details?.reason ?? "unknown"})`);
  });

  // The window is the explorer, not the DSH app: it loads the plugin's own
  // local page, which reaches the Host through the preload bridge. Nothing here
  // navigates to the app itself, so the window cannot show a second DSH.
  win.loadFile(join(ASSET_ROOT, "index.html")).catch((error) => {
    console.error(`session-explorer detached: page failed to load: ${error?.message ?? error}`);
  });
}

ipcMain.handle("se:context", () => ({
  port: WEB_PORT,
  dataDir: DATA_DIR,
  tokenSet: TOKEN !== "",
}));

/**
 * Proxy one API call, attaching the Host token in the main process.
 *
 * The renderer never sees the token: a script injected into the page can only
 * ask for a path, and the main process decides which origin receives the
 * credential. Only the plugin's own prefix is reachable, so the bridge cannot
 * be turned into an arbitrary HTTP client.
 */
ipcMain.handle("se:api", async (_event, path, init) => {
  const relative = String(path ?? "");
  if (!relative.startsWith("/session-explorer/api")) {
    throw new Error("se.api only reaches /session-explorer/api");
  }
  if (!WEB_PORT) throw new Error("the Host port is unknown");
  const response = await fetch(`http://127.0.0.1:${WEB_PORT}${relative}`, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init?.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      "x-dsh-se-helper": TOKEN,
    },
    body: init?.body === undefined || init?.body === null ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { ok: false, error: `HTTP ${response.status}` };
  }
  return payload;
});

/**
 * Ask the Host for the theme DSH is currently using.
 *
 * The window is a `file://` page, so it never sees DSH's stylesheet and all of
 * its `--dsw-alias-*` tokens resolve to the fallbacks in shell.css. The Host can
 * read the live tokens out of the app's own CSS custom properties, so it is the
 * one place that knows what "the current theme" means.
 *
 * Cached briefly: every window focus asks, and the answer only changes when the
 * user switches theme, which is not a per-second event.
 *
 * @returns {Promise<{ mode: string, tokens: Record<string,string>, at: number } | null>}
 */
let themeCache = { at: 0, value: null };

async function readTheme() {
  if (!WEB_PORT) return null;
  const age = Date.now() - themeCache.at;
  if (themeCache.value && age < 5000) return themeCache.value;
  try {
    const response = await fetch(`http://127.0.0.1:${WEB_PORT}/session-explorer/api/theme`, {
      headers: { accept: "application/json", "x-dsh-se-helper": TOKEN },
    });
    const payload = await response.json();
    if (payload?.ok === true) {
      themeCache = { at: Date.now(), value: payload.result };
      return payload.result;
    }
  } catch {
    /* the window keeps its fallbacks */
  }
  return null;
}

ipcMain.handle("se:theme", async () => readTheme());

ipcMain.handle("se:window", (_event, action) => {
  if (!win) return null;
  if (action === "minimize") win.minimize();
  else if (action === "maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === "close") win.close();
  else if (action === "focus") {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  return { maximized: win.isMaximized() };
});


app.whenReady().then(() => {
  // The page is a local file; no remote origin may ever share its session.
  // Only local assets, devtools and loopback (should a future page ever fetch
  // one) are reachable; everything else is cancelled before it leaves.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowed =
      url.startsWith("file://") ||
      url.startsWith("devtools://") ||
      url.startsWith("blob:") ||
      url.startsWith("data:") ||
      /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
    callback({ cancel: !allowed });
  });
  connectControl();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
