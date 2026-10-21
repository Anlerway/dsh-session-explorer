// session-explorer detached — preload.
//
// The page is the plugin's own module, served by the Host on the Host's origin,
// so it reaches the API with ordinary `fetch` and needs no help from here. What
// a page cannot do for itself is drive the frame:
//
//   se.window(action)  → minimize | maximize | close | focus | state
//                        returns { maximized }, so the page can label its own
//                        maximise button and re-read it after a resize
//   se.detached        → true, so the page knows it is this window
//
// That is the whole bridge. In particular there is no API proxy: the renderer
// talks to 127.0.0.1 over the same origin as the page, and the Host token never
// has a reason to cross into it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("se", {
  window: (action) => ipcRenderer.invoke("se:window", action),
  detached: true,
});
