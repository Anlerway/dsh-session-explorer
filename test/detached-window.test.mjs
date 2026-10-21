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

  const byId = new Map([["root", root]]);
  const body = element("body");
  const document = {
    body,
    documentElement: { style: { setProperty() {} }, setAttribute() {} },
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: () => null,
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

  const window = { React, ReactDOM, fetch: fakeFetch };
  window.se = {
    async window(action) {
      calls.push({ url: "/window", method: action, body: null });
      // The frame answers the caption's state question; anything else is void.
      return options.frame ? options.frame(action) : undefined;
    },
  };

  const run = new Function("window", "document", "setTimeout", "console", SHIM);
  run(window, document, setTimeout, { log() {}, warn() {}, error() {} });

  return { window, document, root, calls, rendered, React, ReactDOM };
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
  const store = {
    open: false,
    set(value) {
      store.open = value;
      for (const listener of [...listeners]) listener();
    },
    toggle() {
      store.set(!store.open);
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

test("closing the panel closes the window", async () => {
  const ctx = harness();
  const module = load(fakeModule(), ctx);

  module.store.set(false);
  await tick();

  const closes = ctx.calls.filter((call) => call.url === "/window" && call.method === "close");
  assert.equal(closes.length, 1, "the frame was asked to close, once");

  module.store.set(false);
  await tick();
  assert.equal(ctx.calls.filter((call) => call.method === "close").length, 1, "and only once");
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
