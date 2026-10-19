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
 *   - the only preload is the plugin's own, and it exposes two IPC calls;
 *   - `setWindowOpenHandler` denies every popup and `will-navigate` refuses
 *     remote navigations; links open in the user's real browser instead;
 *   - the page is loaded with `loadFile`, never with a remote URL.
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
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#00000000",
    webPreferences: {
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
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  win.once("ready-to-show", () => win?.show());
  win.on("close", () => persistBounds());
  win.on("closed", () => {
    win = null;
    send("closed", {});
    app.quit();
  });

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

ipcMain.handle("se:window", (_event, action) => {
  if (!win) return null;
  if (action === "minimize") win.minimize();
  else if (action === "maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === "close") win.close();
  return { maximized: win.isMaximized() };
});

app.whenReady().then(() => {
  // The page is a local file; no remote origin may ever share its session.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowed = url.startsWith("file://") || /^https?:\/\/127\.0\.0\.1(:\d+)?\//.test(url) || url.startsWith("devtools://");
    callback({ cancel: !allowed });
  });
  connectControl();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
