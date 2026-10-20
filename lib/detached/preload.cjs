// session-explorer detached — preload.
//
// The page is untrusted-ish (it is our own HTML, but it must not be able to
// read the Host token). This bridge exposes exactly two calls:
//
//   se.context()   → { port, dataDir, tokenSet }   (no token)
//   se.fetch(path, init) → attaches the token and proxies to the Host
//
// Everything else the page needs it gets through ordinary DOM APIs.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("se", {
  context: () => ipcRenderer.invoke("se:context"),
  window: (action) => ipcRenderer.invoke("se:window", action),
  /**
   * Subscribe to commands the panel sends through the Host.
   *
   * The payload crosses IPC as a plain object, never as a function or a path:
   * the renderer decides what a kind means, and an unknown one is ignored. The
   * returned unsubscribe is all the page needs to stop listening.
   *
   * @param {(command: { kind: string, payload: any }) => void} handler
   * @returns {() => void}
   */
  onCommand: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, command) => {
      try {
        handler(command);
      } catch {
        /* a throwing handler must not break the channel */
      }
    };
    ipcRenderer.on("se:command", listener);
    return () => ipcRenderer.removeListener("se:command", listener);
  },
  /**
   * Whether this page is the detached window.
   *
   * The app page has no preload at all, so this only answers for the local
   * overview; the app page decides for itself from its own query string.
   */
  detached: true,
  // The token itself is never returned to the renderer: the main process adds
  // it, so a script injected into the page cannot exfiltrate it.
  api: async (path, init) => ipcRenderer.invoke("se:api", path, init ?? null),
});
