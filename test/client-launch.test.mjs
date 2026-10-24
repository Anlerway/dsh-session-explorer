/**
 * The two entry points, exercised against stub host surfaces.
 *
 * Two things are pinned here, both of which broke in the field rather than in a
 * unit test:
 *
 *   1. 更多设置… must reach DSH's own settings window through a route that does
 *      not depend on the onboarding roster being mounted. The test drives the
 *      real `openNativeSettings` against a stub command registry and asserts the
 *      product command `settings.open` is what gets invoked, with the same
 *      context a native menu would pass.
 *   2. 默认打开方式 must decide where a launch lands, and a 独立弹窗 that cannot
 *      open must fall back to 浮窗 *and say so* instead of doing nothing.
 *   3. 更多设置… must work from the detached window too, where there is no
 *      settings shell to open: the press travels to the DSH page as a bridge
 *      command, and the window's copy of that command is ignored rather than
 *      acted on.
 *   4. 打开 from the window must open the session in DSH even though 独立弹窗 mode
 *      leaves the DSH page without a panel — the page navigates itself instead of
 *      asking a panel that is not there, and the window stays open afterwards
 *      (a window is not an overlay; only the user closes it).
 *
 * No DOM library: the stubs below answer exactly the selectors the bundle uses,
 * which also documents them.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle, recordingFetch } from "./support/client-bundle.mjs";

const EXPOSE = [
  "openNativeSettings",
  "openSettingsTarget",
  "openSettingsFromBridge",
  "windowHost",
  "productModal",
  "settingsModalElement",
  "launchExplorer",
  "refreshOpenMode",
  "peekLaunchHint",
  "clearLaunchHint",
  "openMode",
  "revealInExplorer",
  "publishReveal",
  "bridgeActions",
  "FooterAction",
];

/**
 * A DOM just wide enough for the launch path.
 *
 * `settingsOpen` is the whole state of the settings modal; `nav` are the cells
 * its rail would hold. Every fake records what was asked of it, so a test can
 * assert that a selector was *not* used as easily as that it was.
 */
function makeDom() {
  const nav = [
    { textContent: "通用", clicks: 0, click() { this.clicks += 1; } },
    { textContent: "  会话资源管理器  ", clicks: 0, click() { this.clicks += 1; } },
  ];
  const dom = {
    settingsOpen: false,
    nav,
    otherModals: [],
    element() {
      return {
        querySelectorAll(selector) {
          return selector === "nav button" ? nav : [];
        },
      };
    },
  };
  const document = {
    querySelector(selector) {
      if (selector === '[data-shortcut-modal="settings"]') return dom.settingsOpen ? dom.element() : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== "[data-shortcut-modal]") return [];
      const all = dom.otherModals.map((id) => ({ dataset: { shortcutModal: id } }));
      if (dom.settingsOpen) all.push({ dataset: { shortcutModal: "settings" } });
      return all;
    },
    createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, textContent: "" }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    documentElement: { getAttribute: () => null },
  };
  return { document, dom };
}

/** A `fetch` that answers a route table and keeps its calls. */
function routedFetch(routes) {
  return recordingFetch((call) => {
    const path = call.url.replace("/session-navigator/api", "");
    const route = routes.find((entry) => entry.method === call.method && entry.path === path);
    return route ? route.answer : { ok: true, result: {} };
  });
}

/**
 * The host context the entry points need: a `shortcuts` service, and — only when
 * a test is playing the detached window — a `hostBridge`. `uiWorkspace` is
 * DSH's own navigation service, and only the page inside DSH has it.
 *
 * `locale.bind` answers `navLabel` the way the real dictionaries do, because the
 * section is found by its label: a translator that echoed keys back would hide a
 * regression in the click-the-right-cell step.
 */
function makeHost({ invocations, onInvoke, hostBridge, uiWorkspace } = {}) {
  const service = {
    registry: {
      invoke(id, context) {
        invocations?.push({ id, context });
        onInvoke?.(id, context);
      },
    },
  };
  return {
    locale: {
      register: () => () => {},
      bind: () => (key) => (key === "navLabel" ? "会话资源管理器" : key),
    },
    slots: { inject: () => () => {}, register: () => () => {} },
    effect: () => () => {},
    get: (name) => {
      if (name === "shortcuts") return service;
      if (name === "hostBridge") return hostBridge;
      if (name === "uiWorkspace") return uiWorkspace;
      return undefined;
    },
    shortcuts: service,
  };
}

const settingsRoute = (mode, revision = 3) => ({
  method: "GET",
  path: "/settings",
  answer: { ok: true, result: { settings: { shell: { open: { mode } } }, revision } },
});

/** One launch, with the mode the host would answer. */
async function launch(mode, { detachedAnswer } = {}) {
  const { document } = makeDom();
  const fetchImpl = routedFetch([
    settingsRoute(mode),
    { method: "POST", path: "/detached/open", answer: detachedAnswer ?? { ok: true, result: { open: true } } },
  ]);
  const { bundle, test: api } = loadClientBundle({ document, fetch: fetchImpl, expose: EXPOSE });
  bundle.apply(makeHost());
  await api.launchExplorer();
  return { bundle, api, calls: fetchImpl.calls };
}

test("默认打开方式 浮窗: the launch opens the panel and asks for no window", async () => {
  const { bundle, api, calls } = await launch("panel");
  assert.equal(bundle.panelStore.getSnapshot(), true);
  assert.equal(calls.some((call) => call.url.endsWith("/detached/open")), false);
  assert.equal(api.peekLaunchHint(), "");
});

test("默认打开方式 独立弹窗: the launch asks the host for the window and leaves the panel closed", async () => {
  const { bundle, api, calls } = await launch("detached");
  assert.equal(bundle.panelStore.getSnapshot(), false);
  assert.equal(calls.some((call) => call.method === "POST" && call.url.endsWith("/detached/open")), true);
  assert.equal(api.peekLaunchHint(), "");
});

test("a 独立弹窗 that cannot open falls back to 浮窗 and says why", async () => {
  const { bundle, api } = await launch("detached", {
    detachedAnswer: {
      ok: false,
      error: "download the browser component before opening a detached window",
      code: "component-not-installed",
    },
  });
  // Falling back is the point: the user pressed one button and one surface opened.
  assert.equal(bundle.panelStore.getSnapshot(), true);
  assert.match(api.peekLaunchHint(), /浏览器组件/);
  // The hint is read once, so the next launch is not carrying it.
  api.clearLaunchHint();
  assert.equal(api.peekLaunchHint(), "");
});

test("the launch re-reads 默认打开方式 instead of trusting the first answer", async () => {
  const { document } = makeDom();
  let mode = "panel";
  const fetchImpl = recordingFetch(() => ({
    ok: true,
    result: { settings: { shell: { open: { mode } } }, revision: 1 },
  }));
  const { bundle, test: api } = loadClientBundle({ document, fetch: fetchImpl, expose: EXPOSE });
  bundle.apply(makeHost());
  await api.refreshOpenMode();
  assert.equal(api.openMode.mode, "panel");
  mode = "detached";
  await api.refreshOpenMode();
  assert.equal(api.openMode.mode, "detached");
  // An unreadable document is not an error path that guesses: 浮窗 it is.
  mode = "nonsense";
  await api.refreshOpenMode();
  assert.equal(api.openMode.mode, "panel");
});

test("更多设置… drives the product command that the sidebar Settings button runs", async () => {
  const { document, dom } = makeDom();
  const invocations = [];
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(
    makeHost({
      invocations,
      // Opening the modal is DSH's job; the stub does what the real shell does.
      onInvoke: (id) => {
        if (id === "settings.open") dom.settingsOpen = true;
      },
    }),
  );

  const opened = await api.openNativeSettings("session-navigator", "会话资源管理器");
  assert.equal(opened, true);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].id, "settings.open");
  // The context is the one a native menu passes; `region: "page"` and a free
  // modal is what makes the command runnable at all.
  assert.equal(invocations[0].context.region, "page");
  assert.equal(invocations[0].context.modal, null);
  // And the window landed on our section, found by its label — the store's
  // active id is not reachable from outside.
  assert.equal(dom.nav[1].clicks, 1);
  assert.equal(dom.nav[0].clicks, 0);
});

test("更多设置… does not toggle an already-open settings window shut", async () => {
  const { document, dom } = makeDom();
  dom.settingsOpen = true;
  const invocations = [];
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(makeHost({ invocations }));

  const opened = await api.openNativeSettings("session-navigator", "会话资源管理器");
  assert.equal(opened, true);
  // `settings.open` closes when the modal is already up, so it must not be run.
  assert.equal(invocations.length, 0);
  assert.equal(dom.nav[1].clicks, 1);
});

test("the modal in front is reported to the command, exactly as a menu would", async () => {
  const { document, dom } = makeDom();
  dom.otherModals = ["confirm"];
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(makeHost());
  assert.equal(api.productModal(), "confirm");
  dom.otherModals = [];
  assert.equal(api.productModal(), null);
});

test("the sidebar button launches where the setting says, and closes what it opened", async () => {
  const { document } = makeDom();
  const fetchImpl = routedFetch([
    settingsRoute("detached"),
    { method: "POST", path: "/detached/open", answer: { ok: true, result: { open: true } } },
  ]);
  const { bundle, test: api } = loadClientBundle({ document, fetch: fetchImpl, expose: EXPOSE });
  bundle.apply(makeHost());
  const t = (key) => key;
  // The component returns a fragment; one child is the button.
  const buttonOf = (tree) => tree.children.find((child) => child && child.type === "button");

  // Closed button press: 默认打开方式 decides, and it says 独立弹窗.
  buttonOf(api.FooterAction({ t, wide: true })).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bundle.panelStore.getSnapshot(), false);
  assert.equal(api.openMode.mode, "detached");

  // Open button press: it takes the panel back instead of toggling a second
  // surface the user did not ask for.
  bundle.panelStore.set(true);
  buttonOf(api.FooterAction({ t, wide: true })).props.onClick();
  assert.equal(bundle.panelStore.getSnapshot(), false);
});

// ── 更多设置… from the detached window ──────────────────────────────────────
// The window is its own document: no settings shell, no command registry. The
// press therefore has to *travel* to the DSH page, and the panel has to say so
// rather than closing over a window it cannot open.

test("更多设置… inside DSH opens the settings window here and lets the panel step aside", async () => {
  const { document, dom } = makeDom();
  const invocations = [];
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(
    makeHost({
      invocations,
      onInvoke: (id) => {
        if (id === "settings.open") dom.settingsOpen = true;
      },
    }),
  );
  bundle.panelStore.set(true);

  // "" means "opened in this document": no hint, the caller closes the panel.
  assert.equal(await api.openSettingsTarget("会话资源管理器"), "");
  assert.equal(dom.settingsOpen, true);
  assert.equal(dom.nav[1].clicks, 1);

  // The bridge's own path does the same and closes the panel itself, because
  // there is no panel callback to do it (the window may ask while it is shut).
  assert.equal(await api.openSettingsFromBridge(), true);
  assert.equal(bundle.panelStore.getSnapshot(), false);
});

test("更多设置… in the detached window asks the DSH page and says where it went", async () => {
  const { document, dom } = makeDom();
  const invocations = [];
  const requests = [];
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(
    makeHost({
      invocations,
      hostBridge: {
        request(kind, payload) {
          requests.push({ kind, payload });
          return Promise.resolve(null);
        },
      },
    }),
  );

  assert.equal(await api.openSettingsTarget("会话资源管理器"), "setOpenedInHost");
  assert.deepEqual(requests, [{ kind: "open-settings", payload: {} }]);
  // Nothing was opened *here*: the window has no settings shell to open, and it
  // must not try the local doors (they would fail slowly and mislead the user).
  assert.equal(dom.settingsOpen, false);
  assert.equal(invocations.length, 0);

  // The command then arrives back on the window's own bus subscription. That is
  // the window's request echoing, not a second press: acting on it would open a
  // settings window the window does not have.
  assert.equal(await api.openSettingsFromBridge(), false);
  assert.equal(invocations.length, 0);
});

test("a window that cannot reach the DSH page reports it instead of pretending", async () => {
  const { document } = makeDom();
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(
    makeHost({ hostBridge: { request: () => Promise.reject(new Error("窗口无法访问 Host")) } }),
  );
  assert.equal(await api.openSettingsTarget("会话资源管理器"), "setOpenHostFailed");
});

test("inside DSH there is no hostBridge, which is how the panel knows it is not the window", async () => {
  const { document } = makeDom();
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(makeHost());
  assert.equal(api.windowHost(), null);
});

// ── The bus, in the direction a surface cannot do itself ────────────────────

/**
 * Run `body` with a stub `EventSource`, so a test can deliver the bus frames the
 * real host would stream. Returns nothing the body gave; the frames are handed
 * to it instead.
 */
async function withBus(body) {
  const sources = [];
  const previous = globalThis.EventSource;
  globalThis.EventSource = class {
    constructor(url) {
      this.url = String(url);
      this.listeners = new Map();
      sources.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    emit(type, data) {
      this.listeners.get(type)?.({ data: JSON.stringify(data) });
    }
  };
  try {
    await body(sources);
  } finally {
    globalThis.EventSource = previous;
  }
}

test("the detached window follows a reveal command that names a session", async () => {
  await withBus(async (sources) => {
    const { document } = makeDom();
    const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
    const host = makeHost({ hostBridge: { request: async () => null } });
    // The real host runs the effect at apply time and keeps the disposer.
    host.effect = (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    };
    bundle.apply(host);
    const revealed = [];
    api.bridgeActions.reveal = (id) => revealed.push(id);

    const source = sources.at(-1);
    assert.match(source.url, /\/bridge\/events\?since=0$/);
    source.emit("command", { seq: 4, kind: "reveal", payload: { sessionId: "s1" } });
    assert.deepEqual(revealed, ["s1"]);
  });
});

test("the DSH page ignores a reveal it published itself", async () => {
  await withBus(async (sources) => {
    const { document } = makeDom();
    const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
    const host = makeHost();
    host.effect = (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    };
    bundle.apply(host);
    const revealed = [];
    api.bridgeActions.reveal = (id) => revealed.push(id);

    // This is the command 独立弹窗 publishes from `revealInExplorer`; acting on
    // it here would raise the panel over the window it just opened.
    sources.at(-1).emit("command", { seq: 5, kind: "reveal", payload: { sessionId: "s1" } });
    assert.deepEqual(revealed, []);
  });
});

// These menus are the other way into the explorer, so they answer to the same
// setting: 浮窗 opens the panel, 独立弹窗 gets the window, and the panel is only
// the fallback when the window cannot open.

// ── 在会话资源管理器查看, from DSH's header strip and row menu ───────────────
// These menus are the other way into the explorer, so they answer to the same
// setting: 浮窗 opens the panel, 独立弹窗 gets the window, and the panel is only
// the fallback when the window cannot open.

/** One reveal, with the mode the host would answer. */
async function reveal(mode, { detachedAnswer, panelOpen = false, bridge } = {}) {
  const { document } = makeDom();
  const fetchImpl = routedFetch([
    settingsRoute(mode),
    { method: "POST", path: "/detached/open", answer: detachedAnswer ?? { ok: true, result: { open: true } } },
    { method: "POST", path: "/bridge/commands", answer: bridge ?? { ok: true, result: { seq: 1 } } },
  ]);
  const { bundle, test: api } = loadClientBundle({ document, fetch: fetchImpl, expose: EXPOSE });
  bundle.apply(makeHost());
  bundle.panelStore.set(panelOpen);
  const revealed = [];
  api.bridgeActions.reveal = (id) => revealed.push(id);
  await api.revealInExplorer("s1");
  const paths = fetchImpl.calls.map((call) => call.url.replace("/session-navigator/api", ""));
  return { bundle, api, calls: fetchImpl.calls, paths, revealed };
}

test("在会话资源管理器查看 浮窗: the session lands in the panel and no window is asked for", async () => {
  const { bundle, paths } = await reveal("panel");
  assert.equal(bundle.panelStore.getSnapshot(), true);
  assert.equal(paths.some((path) => path === "/detached/open"), false);
  assert.equal(paths.some((path) => path === "/bridge/commands"), false);
});

test("在会话资源管理器查看 独立弹窗: the window is opened and told which session", async () => {
  const { bundle, paths, calls } = await reveal("detached");
  assert.equal(bundle.panelStore.getSnapshot(), false);
  const published = calls.filter((call) => call.url.endsWith("/bridge/commands"));
  assert.deepEqual(published.map((call) => call.body), [{ kind: "reveal", payload: { sessionId: "s1" } }]);
  // Published first: a window already on screen acts at once, and one that is
  // still starting reads the command back out of the ring buffer.
  assert.deepEqual(paths.slice(-2), ["/bridge/commands", "/detached/open"]);
});

test("在会话资源管理器查看 falls back to the panel when the window cannot open", async () => {
  const { bundle, paths, revealed } = await reveal("detached", {
    detachedAnswer: { ok: false, error: "no component", code: "component-not-installed" },
  });
  // The user asked to see one session; one surface has to show it.
  assert.equal(bundle.panelStore.getSnapshot(), true);
  assert.equal(revealed.length, 0); // the panel was closed, so it has to mount first
  assert.equal(paths.filter((path) => path === "/bridge/commands").length, 1);
});

test("revealing a session in a panel that is already up never spawns a window", async () => {
  const { bundle, paths, revealed } = await reveal("detached", { panelOpen: true });
  assert.equal(revealed.at(-1), "s1");
  // Not even the setting is read: the surface the user is looking at wins, and
  // an extra round trip would only delay a navigation that is already possible.
  assert.deepEqual(paths, []);
  assert.equal(bundle.panelStore.getSnapshot(), true);
});

// ── 打开, from the detached window ──────────────────────────────────────────
// In 独立弹窗 mode the panel is never mounted on the DSH page — the window *is*
// the explorer — so the bridge handler cannot reach the panel's callback. It
// used to, found nothing, and the request vanished: double-clicking a session in
// the window opened nothing in DSH.

/** Boot the bundle with a bus, a host, and no panel ever mounted. */
async function withPage({ hostBridge, uiWorkspace } = {}) {
  const page = {};
  await withBus(async (sources) => {
    const { document } = makeDom();
    const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
    const host = makeHost({ hostBridge, uiWorkspace });
    host.effect = (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    };
    bundle.apply(host);
    page.bundle = bundle;
    page.api = api;
    page.emit = (command) => sources.at(-1).emit("command", command);
  });
  return page;
}

test("a session the window opens is opened in DSH with no panel on the page", async () => {
  const opened = [];
  const page = await withPage({
    uiWorkspace: {
      openSession: (id) => opened.push(id),
      startSession: () => {},
    },
  });
  assert.equal(page.bundle.panelStore.getSnapshot(), false, "no panel is mounted on this page");

  page.emit({ seq: 11, kind: "open-session", payload: { sessionId: "s1" } });

  assert.deepEqual(opened, ["s1"], "DSH was asked to open it");
  // The window is the surface the user is looking at; raising a panel here would
  // cover the main view *and* leave two explorers on screen.
  assert.equal(page.bundle.panelStore.getSnapshot(), false);
});

test("a new session the window starts is started in DSH with no panel on the page", async () => {
  const started = [];
  const page = await withPage({
    uiWorkspace: {
      openSession: () => {},
      startSession: (workspaceId) => started.push(workspaceId),
    },
  });

  page.emit({ seq: 12, kind: "new-session", payload: { workspaceId: "w1" } });

  assert.deepEqual(started, ["w1"]);
  assert.equal(page.bundle.panelStore.getSnapshot(), false);
});

test("the window ignores the open-session it published itself", async () => {
  const opened = [];
  const page = await withPage({
    // `hostBridge` is what makes this document the window.
    hostBridge: { request: async () => null },
    // The window's `uiWorkspace` is the shim's: asking it again would publish
    // the same command back at the page.
    uiWorkspace: { openSession: (id) => opened.push(id), startSession: () => {} },
  });
  assert.ok(page.api.windowHost(), "this document is the window");

  page.emit({ seq: 13, kind: "open-session", payload: { sessionId: "s1" } });

  assert.deepEqual(opened, [], "the window is where the command came from");
});

test("an open this page cannot serve raises the panel that can explain it", async () => {
  // No `uiWorkspace`: an older DSH. Nothing here can navigate, and the panel is
  // the one surface that can say so — so the request is queued for it instead of
  // disappearing.
  const page = await withPage();
  page.emit({ seq: 14, kind: "open-session", payload: { sessionId: "s1" } });
  assert.equal(page.bundle.panelStore.getSnapshot(), true);
});

// ── The store's close reason ───────────────────────────────────────────────
// The window has to tell "the user dismissed this" from "the code stepped
// aside". It cannot infer that from call sites, so the store states it.

test("a panel close states whether the user asked for it", () => {
  const { document } = makeDom();
  const { bundle } = loadClientBundle({ document, expose: EXPOSE });
  const reasons = [];
  bundle.panelStore.subscribe((reason) => reasons.push(reason));

  bundle.panelStore.set(true);
  bundle.panelStore.set(false); // 在 DSH 中打开, a new draft, moving out to the window
  bundle.panelStore.set(true);
  bundle.panelStore.set(false, "user"); // the × button, Escape
  bundle.panelStore.set(true);
  bundle.panelStore.toggle(); // the sidebar entry

  assert.deepEqual(reasons, ["open", "auto", "open", "user", "open", "user"]);
});

