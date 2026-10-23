/**
 * Tests for the detached window — the page, the routes that serve it, and the
 * shim that stands in for DSH while the panel's module mounts.
 *
 * The window used to carry its own 3.5k-line UI (assets/detached/shell.js) and a
 * test file that drove it through a mini DOM. Both are gone: the window now runs
 * lib/client.js, so the UI itself is covered by test/render-smoke.mjs and what is
 * left to pin down here is the seam — one UI, two surfaces.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const here = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(here(path), "utf8");

const SHIM = read("assets/detached/shim.js");
const PAGE = read("assets/detached/index.html");
const HOST = read("lib/index.js");

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A window with just enough of a document for the shim to run.
 *
 * No React and no real DOM: the shim only needs `createElement`, `createRoot`
 * and a container, so the harness can assert on *what* was rendered without
 * rendering it.
 *
 * @param {{ respond?: (call: any) => any }} [options]
 */
function harness(options = {}) {
  const calls = [];
  const rendered = [];
  const respond = options.respond ?? (() => ({ ok: true, result: {} }));

  async function fakeFetch(input, init) {
    const url = typeof input === "string" ? input : String(input?.url ?? "");
    const call = { url, method: String(init?.method ?? "GET").toUpperCase(), body: init?.body ?? null };
    calls.push(call);
    const answer = respond(call) ?? { ok: true, result: {} };
    return { ok: true, status: 200, json: async () => answer };
  }

  const root = { id: "root" };

  /**
   * The least an element needs to be: somewhere to hang children, attributes,
   * and listeners. Enough for the shim to build the caption buttons and for the
   * test to click them.
   */
  const element = (tag) => {
    const node = {
      tag,
      id: "",
      className: "",
      type: "",
      dataset: {},
      children: [],
      attributes: {},
      listeners: {},
      textContent: "",
      appendChild(child) {
        node.children.push(child);
        if (child && child.id) byId.set(child.id, child);
        return child;
      },
      setAttribute(name, value) {
        node.attributes[name] = String(value);
      },
      addEventListener(type, handler) {
        (node.listeners[type] = node.listeners[type] ?? []).push(handler);
      },
      /** Fire a listener the way a user would. */
      click() {
        for (const handler of node.listeners.click ?? []) handler({ type: "click" });
      },
    };
    return node;
  };

  // The page's own chrome, as index.html ships it: the boot card and its line,
  // which the shim rewrites when the window is in English.
  const bootTitle = element("div");
  bootTitle.className = "boot-title";
  bootTitle.textContent = "会话资源管理器";
  const bootSub = element("div");
  bootSub.id = "boot-sub";
  bootSub.textContent = "正在启动…";

  const byId = new Map([
    ["root", root],
    ["boot-sub", bootSub],
  ]);
  const body = element("body");
  const document = {
    body,
    documentElement: { style: { setProperty() {} }, setAttribute() {} },
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (selector) => (selector === ".boot-title" ? bootTitle : null),
    createElement: (tag) => element(tag),
    createElementNS: (_namespace, tag) => element(tag),
  };

  const React = {
    Fragment: "fragment",
    createElement: (type, props, ...children) => ({ type, props, children }),
  };
  const ReactDOM = {
    createPortal: (element) => element,
    createRoot: (container) => ({ render: (element) => rendered.push({ container, element }) }),
  };

  // \`lang\` is how the Host tells the page which language to draw in (the window
  // cannot see DSH's switch), so a harness without it is a 中文 window.
  const window = { React, ReactDOM, fetch: fakeFetch };
  if (options.lang) {
    window.location = { href: "http://127.0.0.1:1234/session-explorer/api/ui?lang=" + options.lang };
  }
  window.se = {
    async window(action) {
      calls.push({ url: "/window", method: action, body: null });
      // The frame answers the caption's state question; anything else is void.
      return options.frame ? options.frame(action) : undefined;
    },
  };

  const run = new Function("window", "document", "setTimeout", "console", SHIM);
  run(window, document, setTimeout, { log() {}, warn() {}, error() {} });

  return { window, document, root, calls, rendered, bootTitle, bootSub, React, ReactDOM };
}

/**
 * A module shaped like lib/client.js: an `apply` that registers the footer slot
 * and a panel store that starts closed.
 *
 * @param {{ dictionary?: object }} [options]
 */
function fakeModule(options = {}) {
  const Component = function Panel() {
    return null;
  };
  const listeners = new Set();
  // Shaped like the real store: a close carries why it happened, and the
  // listener is told — that is the only thing that lets the window tell a
  // dismissal from the panel stepping aside.
  const store = {
    open: false,
    reason: "open",
    set(value, reason = "auto") {
      store.open = value;
      store.reason = value ? "open" : reason;
      for (const listener of [...listeners]) listener(store.reason);
    },
    toggle() {
      store.set(!store.open, "user");
    },
    getSnapshot() {
      return store.open;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const state = { ctx: null, Component, store };
  state.exports = {
    apply(ctx) {
      state.ctx = ctx;
      if (options.dictionary) ctx.locale.register("session-explorer", options.dictionary);
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({ name: "sidebar.footer.action", id: "session-explorer-footer" }, Component),
      );
    },
    panelStore: store,
  };
  return state;
}

/**
 * Boot the shim with a fake module, the way index.html does.
 *
 * @param {ReturnType<typeof fakeModule>} module
 * @param {ReturnType<typeof harness>} ctx
 */
function load(module, ctx) {
  ctx.window.__ModuleLoader__.load({
    id: "dsh-session-explorer",
    factory: (require) => {
      assert.equal(require("react"), ctx.React, "the factory gets the page's React");
      return module.exports;
    },
  });
  return module;
}

// ── the page ──────────────────────────────────────────────────────────────

test("the window's page loads one UI, from the Host's own origin", () => {
  const scripts = [...PAGE.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scripts, [
    "/session-explorer/api/ui/react.js",
    "/session-explorer/api/ui/react-dom.js",
    "/session-explorer/api/ui/shim.js",
    // The panel's own module: the window has no UI of its own any more.
    "/session-explorer/api/ui/client.js",
  ]);

  assert.ok(PAGE.includes('href="/session-explorer/api/ui/window.css"'), "the window stylesheet");
  // The tab and taskbar show the plugin's own folder mark, not a blank page.
  assert.ok(
    PAGE.includes('<link rel="icon" type="image/png" href="/session-explorer/api/ui/icon.png">'),
    "the window favicon",
  );
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(PAGE), "no inline script");

  // Same origin is what lets the module's own fetch() calls reach the API.
  assert.match(PAGE, /Content-Security-Policy/);
  assert.match(PAGE, /script-src 'self'/);
  assert.match(PAGE, /connect-src 'self'/);
});

test("the Host serves the page, its stylesheet, its shim and the panel's module", () => {
  for (const route of [
    "GET /ui",
    "GET /ui/window.css",
    "GET /ui/shim.js",
    "GET /ui/client.js",
    "GET /ui/react.js",
    "GET /ui/react-dom.js",
    "GET /ui/icon.png",
  ]) {
    assert.ok(HOST.includes(`"${route}"`), `route ${route} is registered`);
  }

  for (const file of [
    "assets/detached/index.html",
    "assets/detached/window.css",
    "assets/detached/shim.js",
    "lib/client.js",
    "assets/vendor/react.production.min.js",
    "assets/vendor/react-dom.production.min.js",
    "assets/icon.png",
  ]) {
    assert.ok(existsSync(here(file)), `${file} exists`);
  }
});

// ── the platform ──────────────────────────────────────────────────────────

test("the shim answers what client.js asks the platform for", () => {
  const ctx = harness();
  const loader = ctx.window.__ModuleLoader__;
  assert.equal(typeof loader.load, "function");

  assert.equal(loader.require("react"), ctx.React);
  assert.equal(loader.require("react-dom").createPortal, ctx.ReactDOM.createPortal);
  // Anything else is a build that expects a module the window does not have.
  assert.throws(() => loader.require("lodash"), /no module "lodash"/);
});

test("booting renders the panel's own slot and opens it", () => {
  const ctx = harness();
  const module = load(fakeModule(), ctx);

  assert.equal(ctx.rendered.length, 1, "rendered once");
  assert.equal(ctx.rendered[0].container, ctx.root, "into #root");
  assert.equal(ctx.rendered[0].element.type, module.Component, "the registered slot component");
  // The panel is an overlay in DSH; here it is the whole window, so it is open.
  assert.equal(module.store.getSnapshot(), true);
});

test("the window translates with the dictionary the module registers", () => {
  const ctx = harness();
  load(
    fakeModule({
      dictionary: { zh: { footerLabel: "会话资源管理器", count: "{n} 个会话" }, en: { footerLabel: "Sessions" } },
    }),
    ctx,
  );

  const t = ctx.rendered[0].element.props.t;
  assert.equal(t("footerLabel"), "会话资源管理器");
  assert.equal(t("count", { n: 3 }), "3 个会话");
  // An unknown key is its own name rather than "undefined" on screen.
  assert.equal(t("missing"), "missing");
});

test("a panel close the user asked for closes the window", async () => {
  const ctx = harness();
  const module = load(fakeModule(), ctx);

  module.store.set(false, "user");
  await tick();

  const closes = ctx.calls.filter((call) => call.url === "/window" && call.method === "close");
  assert.equal(closes.length, 1, "the frame was asked to close, once");

  module.store.set(false, "user");
  await tick();
  assert.equal(ctx.calls.filter((call) => call.method === "close").length, 1, "and only once");
});

test("a panel close the code performed leaves the window standing", async () => {
  const ctx = harness();
  const module = load(fakeModule(), ctx);

  // 在 DSH 中打开, a new draft, moving out to the window: the panel steps aside
  // for a view it would cover. That is an overlay concern, and in a window it
  // would mean the window vanishing the instant a session was opened.
  module.store.set(false);
  await tick();

  assert.equal(ctx.calls.filter((call) => call.method === "close").length, 0, "the frame was left alone");
  assert.equal(module.store.getSnapshot(), true, "and the panel is back on screen");
});

// ── the caption ───────────────────────────────────────────────────────────

/** The caption bar the shim mounts, or undefined if it did not. */
const caption = (ctx) => ctx.document.getElementById("se-caption");

test("the window draws its own caption buttons", () => {
  const ctx = harness();
  load(fakeModule(), ctx);

  const bar = caption(ctx);
  assert.ok(bar, "the bar is mounted on the body");
  assert.ok(ctx.document.body.children.includes(bar), "on the body, not somewhere else");

  const buttons = bar.children;
  assert.deepEqual(
    buttons.map((button) => button.dataset.caption),
    ["minimize", "maximize", "close"],
    "minimise, maximise, close — in that order",
  );
  assert.deepEqual(
    buttons.map((button) => button.attributes["aria-label"]),
    ["最小化", "最大化", "关闭"],
    "each button is labelled for a screen reader",
  );
  assert.equal(buttons[2].className, "se-caption-btn se-caption-close", "the close button is the red one");
  // Each icon is a 16-grid SVG stroked in the current colour, so it follows the theme.
  const icon = buttons[0].children[0];
  assert.equal(icon.tag, "svg");
  assert.equal(icon.attributes.fill, "none");
  assert.equal(icon.attributes.stroke, "currentColor");
});

test("each caption button drives the frame", async () => {
  const ctx = harness();
  load(fakeModule(), ctx);
  const buttons = caption(ctx).children;
  const actions = () => ctx.calls.filter((call) => call.url === "/window").map((call) => call.method);

  buttons[0].click();
  buttons[1].click();
  await tick();
  assert.deepEqual(actions().filter((name) => name !== "state"), ["minimize", "maximize"]);

  // The close button takes the same path as the panel's own close: asked once.
  buttons[2].click();
  buttons[2].click();
  await tick();
  assert.equal(actions().filter((name) => name === "close").length, 1, "asked once, not twice");
});

test("booting asks the frame whether it is maximised", async () => {
  const ctx = harness({ frame: (action) => (action === "state" ? { maximized: true } : undefined) });
  load(fakeModule(), ctx);
  await tick();

  const toggle = caption(ctx).children.find((button) => button.dataset.caption === "maximize");
  assert.equal(toggle.attributes.title, "还原", "a maximised window offers to restore");
  assert.equal(toggle.attributes["aria-label"], "还原");

  toggle.click();
  await tick();
});

test("a window without the bridge stays a plain page", () => {
  const ctx = harness();
  delete ctx.window.se;
  load(fakeModule(), ctx);

  assert.equal(caption(ctx), null, "no bridge, no buttons to point at nothing");
  assert.equal(ctx.rendered.length, 1, "and the panel still rendered");
});

// ── navigation and theme ──────────────────────────────────────────────────

test("opening a session asks the Host's command bus, once per click", async () => {
  const ctx = harness();
  const module = load(fakeModule(), ctx);
  const workspace = module.ctx.get("uiWorkspace");
  assert.ok(workspace, "the window has a uiWorkspace");

  workspace.openSession("session-a");
  await tick();

  const sent = ctx.calls.filter((call) => call.url.endsWith("/bridge/commands"));
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { kind: "open-session", payload: { sessionId: "session-a" } });

  // The window subscribes to the same bus, so it hears its own command and would
  // ask again — forever. The echo is dropped.
  workspace.openSession("session-a");
  await tick();
  assert.equal(ctx.calls.filter((call) => call.url.endsWith("/bridge/commands")).length, 1);
});

test("starting a session without a workspace asks for a plain new session", async () => {
  const ctx = harness();
  const module = load(fakeModule(), ctx);

  module.ctx.get("uiWorkspace").startSession(undefined);
  await tick();

  const sent = ctx.calls.filter((call) => call.url.endsWith("/bridge/commands"));
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { kind: "new-session", payload: {} });
});

test("the window never reports its own palette", async () => {
  const ctx = harness();
  const before = ctx.calls.filter((call) => call.method === "POST").length;

  // client.js posts the tokens it reads out of its own shell; in the window that
  // reading is circular and would overwrite the real palette with an empty one.
  const answer = await ctx.window.fetch("/session-explorer/api/theme", { method: "POST", body: "{}" });
  assert.equal((await answer.json()).ok, true, "it still resolves like a real response");
  assert.equal(ctx.calls.filter((call) => call.method === "POST").length, before, "nothing left the window");

  // Reading the palette is how the window gets its colours, so that still works.
  await ctx.window.fetch("/session-explorer/api/theme");
  assert.ok(ctx.calls.some((call) => call.url.endsWith("/theme") && call.method === "GET"));
});

// ── 语言 ────────────────────────────────────────────────────────────────────
// The window is its own process: it cannot observe DSH's language switch, so the
// Host says which language to draw in when it loads the page (?lang=), and
// reloads the page when the panel's language changes. Everything below pins that
// one seam, because a window stuck in Chinese is invisible from inside DSH.

/** The two dictionaries the panel registers, shaped like the settings page's. */
const DICTIONARIES = {
  zh: { langCode: "zh", footerLabel: "会话资源管理器", count: "{n} 个会话" },
  en: { langCode: "en", footerLabel: "Session Explorer" },
};

test("the window draws in the language the Host asked for", () => {
  const ctx = harness({ lang: "en" });
  const module = load(fakeModule({ dictionary: DICTIONARIES }), ctx);

  const t = ctx.rendered[0].element.props.t;
  assert.equal(module.ctx.locale.language(), "en", "the platform reports English");
  assert.equal(module.ctx.locale.current(), "en");
  assert.equal(t("langCode"), "en", "which is how the panel itself finds out");
  assert.equal(t("footerLabel"), "Session Explorer");

  // A key the English dictionary does not carry falls back to Chinese: a label
  // in the wrong language beats a raw key on a button.
  assert.equal(t("count", { n: 3 }), "3 个会话");
  assert.equal(t("missing"), "missing", "and a key neither carries is its own name");
});

test("without a language in the URL the window is 中文", () => {
  const ctx = harness();
  const module = load(fakeModule({ dictionary: DICTIONARIES }), ctx);

  const t = ctx.rendered[0].element.props.t;
  assert.equal(module.ctx.locale.language(), "zh");
  assert.equal(t("footerLabel"), "会话资源管理器");
  assert.equal(ctx.bootTitle.textContent, "会话资源管理器", "the boot card is left alone");
  assert.equal(ctx.bootSub.textContent, "正在启动…");
});

test("an English window rewrites the page's own chrome", () => {
  const ctx = harness({ lang: "en" });
  load(fakeModule({ dictionary: DICTIONARIES }), ctx);

  // index.html is authored in Chinese and parsed before any script runs, so the
  // shim is the only thing that can change what the first frame says.
  assert.equal(ctx.document.title, "Session Explorer");
  assert.equal(ctx.document.documentElement.lang, "en");
  assert.equal(ctx.bootTitle.textContent, "Session Explorer");
  assert.equal(ctx.bootSub.textContent, "Starting…");
});

test("the caption speaks the window's language too", async () => {
  const ctx = harness({ lang: "en", frame: (action) => (action === "state" ? { maximized: true } : undefined) });
  load(fakeModule({ dictionary: DICTIONARIES }), ctx);
  await tick();

  const buttons = caption(ctx).children;
  // The frame answered "maximised", so the toggle offers to restore — labelled,
  // not just glyphed, and in English like the rest of the window.
  assert.deepEqual(
    buttons.map((button) => button.attributes["aria-label"]),
    ["Minimize", "Restore", "Close"],
  );
  assert.equal(buttons[1].attributes.title, "Restore");
});

test("a failure before the panel loads is reported in the window's language", () => {
  const ctx = harness({ lang: "en" });
  // A factory that throws is the earliest thing that can go wrong: React is up,
  // the panel is not.
  assert.throws(() => {
    ctx.window.__ModuleLoader__.load({
      id: "broken",
      factory: () => {
        throw new Error("boom");
      },
    });
  }, /boom/);
  assert.equal(ctx.bootSub.textContent, "The panel failed to load.");
});

// ── the language's way to the window ───────────────────────────────────────
// Three files have to agree on one string, and a break in the chain is silent
// (the window simply keeps the default), so each hop is pinned.

test("the Host answers the panel's language with a window in it", () => {
  assert.match(
    HOST,
    /"POST \/detached\/open": async \(api, req\) => \{[\s\S]*req\.body\?\.lang === "en" \? "en" : "zh"/,
    "the route reads lang off the request",
  );
  assert.match(HOST, /api\.detached\.open\(\{ lang: /, "and hands it to the controller");
});

test("the controller passes the language to the helper, and to a window already open", () => {
  const launcher = read("lib/detached/launcher.js");
  assert.match(launcher, /DSH_SE_LANG: lang/, "the helper learns it from the environment");
  assert.match(launcher, /async open\(request = \{\}\)/, "open carries the request");
  // A window that is already on screen keeps the dictionary it loaded: the only
  // way to change it is a reload, so the controller has to say so.
  assert.match(launcher, /broadcast\(\{ type: "lang", lang \}\)/, "an open window is told to reload");
});

test("the helper puts the language in the page's URL, and reloads on a switch", () => {
  const main = read("lib/detached/main.cjs");
  assert.match(main, /DSH_SE_LANG === "en" \? "en" : "zh"/, "the helper starts in the language it was spawned with");
  assert.match(main, new RegExp("\\?lang=\\$\\{pageLang\\}"), "and tells the page");
  assert.match(main, /message\.type === "lang"/, "a later switch arrives as a control message");
  assert.match(main, /win\.loadURL\(url\)/, "which reloads the page");
});

test("the panel tells the Host which language it is drawing in", () => {
  const client = read("lib/client.js");
  assert.match(client, /function uiLang\(\)/, "one place answers the question");
  assert.match(client, /bound\("langCode"\) === "en"/, "by asking the bound translator, not a second API");
  // Every entry point that can open the window has to say it: a reveal from the
  // sidebar opens the window on a page that never rendered the panel.
  const opens = [...client.matchAll(/apiSend\("POST", "\/detached\/open", (\{[^}]*\})/g)].map((match) => match[1]);
  assert.equal(opens.length, 4, "four places open the window");
  for (const args of opens) assert.match(args, /lang: uiLang\(\)/, "open-window call carries the language: " + args);
});
