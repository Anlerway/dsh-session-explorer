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
  // The token itself is never returned to the renderer: the main process adds
  // it, so a script injected into the page cannot exfiltrate it.
  api: async (path, init) => ipcRenderer.invoke("se:api", path, init ?? null),
});
