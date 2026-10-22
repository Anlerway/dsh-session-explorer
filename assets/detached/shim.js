/**
 * dsh-session-explorer — the detached window's host shim.
 *
 * The window and the panel are one UI. The window loads lib/client.js verbatim
 * and this file pretends to be DSH for as long as it takes that module to
 * mount. client.js knows nothing about any of this: it asks the platform for
 * four things, and the shim answers all four.
 *
 *   window.__ModuleLoader__.load({ id, factory })   → factory(require)
 *   require("react")                                → the vendored UMD build
 *   ctx.slots / ctx.locale / ctx.effect / ctx.get   → a ctx with just enough
 *   document.body + createPortal                    → the window's own document
 *
 * That is the whole trick. The panel renders itself through a portal into
 * document.body (lib/client.js getOverlayRoot), which works in any document, so
 * the window only has to render the footer-action slot once and switch the
 * panel store on.
 *
 * What the shim deliberately does *not* do:
 *   - report the theme: the window is themed *from* the Host, so echoing its
 *     own shell back would post an empty palette over the real one;
 *   - subscribe to the command bridge: the window asks the Host for navigation,
 *     the panel inside DSH performs it. A window that also listened would hear
 *     its own request and send it again (guarded by ECHO_MS below).
 */

(function () {
  "use strict";

  const API = "/session-explorer/api";
  const NS = "session-explorer";

  const React = window.React;
  const ReactDOM = window.ReactDOM;

  function note(text) {
    const sub = document.getElementById("boot-sub");
    if (sub) sub.textContent = text;
  }

  function warn(message, error) {
    if (error === undefined) console.error(`session-explorer detached: ${message}`);
    else console.error(`session-explorer detached: ${message}`, error);
  }

  if (!React || !ReactDOM) {
    note("React 未能加载，窗口无法启动。");
    warn("react did not load");
    return;
  }

  const realFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  // ── The palette comes from the Host, never from this window ──────────────
  /**
   * client.js posts the tokens it reads out of its own shell so the Host can
   * hand them to a window that cannot see DSH's stylesheet. Here that reading is
   * circular — the shell is themed from the Host — and before the first reply
   * lands it would post an empty palette over the real one. Those posts are
   * dropped; everything else passes through untouched.
   *
   * @param {any} input fetch input
   * @returns {string}
   */
  function pathOf(input) {
    const raw = typeof input === "string" ? input : input && typeof input.url === "string" ? input.url : "";
    try {
      return new URL(raw, "http://127.0.0.1/").pathname;
    } catch {
      return raw;
    }
  }

  /**
   * A minimal JSON response, so a dropped request still resolves like a real one.
   *
   * @param {unknown} value
   * @returns {any}
   */
  function jsonResponse(value) {
    if (typeof Response === "function") {
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
  }

  if (realFetch) {
    window.fetch = function fetchFromWindow(input, init) {
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (method === "POST" && pathOf(input) === API + "/theme") {
        return Promise.resolve(jsonResponse({ ok: true, result: null }));
      }
      return realFetch(input, init);
    };
  }

  // ── Locale ───────────────────────────────────────────────────────────────
  /** @type {{ zh: Record<string, string>, en: Record<string, string> }} */
  let dictionaries = { zh: {}, en: {} };

  /**
   * `t("badge", { n: 3 })` → the dictionary text with `{n}` replaced.
   *
   * @param {string} text
   * @param {Record<string, unknown> | undefined} vars
   * @returns {string}
   */
  function interpolate(text, vars) {
    if (!vars || typeof vars !== "object") return String(text);
    return String(text).replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
  }

  /**
   * The window's copy is Chinese, like the panel's default: the plugin's own
   * strings are authored in Chinese and the English dictionary exists for DSH's
   * language switch, which a detached window cannot observe.
   *
   * @param {string} key
   * @param {Record<string, unknown>} [vars]
   * @returns {string}
   */
  function translate(key, vars) {
    const dictionary = dictionaries.zh || {};
    const text = typeof dictionary[key] === "string" ? dictionary[key] : key;
    return interpolate(text, vars);
  }

  const locale = {
    register(namespace, dictionary) {
      if (!dictionary || typeof dictionary !== "object") return () => {};
      dictionaries = {
        zh: dictionary.zh || dictionaries.zh,
        en: dictionary.en || dictionaries.en,
      };
      return () => {};
    },
    bind() {
      return translate;
    },
    current() {
      return "zh";
    },
    language() {
      return "zh";
    },
  };

  // ── Slots ────────────────────────────────────────────────────────────────
  // DSH renders slots; here the only slot that matters is the panel's own entry
  // point, and registering it is enough — the shim renders it once, below.
  /** @type {Map<string, { spec: any, Component: any }>} */
  const slotRegistry = new Map();

  const slots = {
    inject(_name, factory) {
      try {
        const dispose = factory();
        return typeof dispose === "function" ? dispose : () => {};
      } catch (error) {
        warn("a slot injection failed", error);
        return () => {};
      }
    },
    register(spec, Component) {
      const name = spec && typeof spec.name === "string" ? spec.name : "";
      if (!name || typeof Component !== "function") return () => {};
      slotRegistry.set(name, { spec, Component });
      return () => slotRegistry.delete(name);
    },
  };

  // ── Services ─────────────────────────────────────────────────────────────
  /**
   * How long a command counts as "just sent".
   *
   * The window publishes navigation through the Host's command bus; the panel
   * inside DSH hears it, opens the session and is done. The window is *also* a
   * subscriber (client.js subscribes unconditionally), so it hears the same
   * command and would publish it again — forever. A command repeated inside this
   * window in this interval is that echo, not a second click.
   */
  const ECHO_MS = 1500;
  /** @type {Map<string, number>} */
  const sent = new Map();

  /**
   * Ask the Host to deliver one command to the panel.
   *
   * @param {string} kind
   * @param {Record<string, unknown>} payload
   * @returns {Promise<unknown>}
   */
  async function publish(kind, payload) {
    const key = kind + ":" + JSON.stringify(payload || null);
    const now = Date.now();
    const previous = sent.get(key) || 0;
    if (now - previous < ECHO_MS) return null;
    sent.set(key, now);
    if (!realFetch) throw new Error("窗口无法访问 Host");
    const response = await realFetch(API + "/bridge/commands", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ kind, payload }),
    });
    const envelope = await response.json().catch(() => null);
    if (!envelope || envelope.ok !== true) {
      throw new Error((envelope && envelope.error) || "命令未能送达 DSH");
    }
    return envelope.result;
  }

  /**
   * The two DSH services the panel reaches for.
   *
   * Both are navigation, and DSH owns navigation: the panel is the side that
   * holds `uiWorkspace`, so the window asks it through the Host instead of
   * trying to drive the app's own view. A failure is reported to the panel's
   * own hint line by the caller (it wraps these in try/catch).
   */
  const services = {
    uiWorkspace: {
      openSession(sessionId) {
        if (typeof sessionId !== "string" || sessionId === "") return;
        publish("open-session", { sessionId }).catch((error) => warn("open-session failed", error));
      },
      startSession(workspaceId) {
        const payload = typeof workspaceId === "string" && workspaceId ? { workspaceId } : {};
        publish("new-session", payload).catch((error) => warn("new-session failed", error));
      },
    },
    // DSH re-reads its own persistence and workspace registry on refresh. The
    // window has no baseline of its own to re-pull, and the panel does this for
    // itself after a move.
    sessions: { refresh: async () => {} },
    workspaces: { refresh: async () => {} },
    /**
     * The one service that is named after *this file* rather than after DSH:
     * a request back to the plugin's own code in the DSH page, for the things
     * only that page can do. Its presence is also how client.js tells that it
     * is running in the window instead of inside DSH.
     */
    hostBridge: {
      request(kind, payload) {
        return publish(String(kind), payload);
      },
    },
  };

  /** The ctx client.js is handed. Only the members it actually uses exist. */
  const ctx = {
    get(name) {
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : null;
    },
    effect(run) {
      try {
        const dispose = run();
        return typeof dispose === "function" ? dispose : () => {};
      } catch (error) {
        warn("an effect failed", error);
        return () => {};
      }
    },
    slots,
    locale,
    logger: () => ({ info() {}, warn() {}, error: warn }),
  };

  // ── The platform client.js expects ───────────────────────────────────────
  /**
   * `require` inside the module factory. Only React is ever asked for; anything
   * else is a build that expects a module the window does not have, and saying
   * so is better than handing back `undefined`.
   *
   * @param {string} id
   * @returns {any}
   */
  function requireShim(id) {
    if (id === "react") return React;
    if (id === "react-dom" || id === "react-dom/client") {
      return { createPortal: ReactDOM.createPortal, createRoot: ReactDOM.createRoot, render: ReactDOM.render };
    }
    throw new Error(`the detached window has no module "${id}"`);
  }

  window.__ModuleLoader__ = {
    /**
     * @param {{ id: string, factory: (require: (id: string) => any) => any }} spec
     */
    load(spec) {
      const id = spec && typeof spec.id === "string" ? spec.id : "?";
      if (!spec || typeof spec.factory !== "function") throw new Error("__ModuleLoader__.load needs a factory");
      let exports;
      try {
        exports = spec.factory(requireShim);
      } catch (error) {
        note("面板加载失败。");
        warn(`module ${id} threw while loading`, error);
        throw error;
      }
      boot(exports);
    },
    require: requireShim,
    modules: Object.create(null),
  };

  // ── Mount ────────────────────────────────────────────────────────────────
  let mounted = false;

  /**
   * Run the plugin's entry point and render its slot.
   *
   * @param {any} exports the module's exports (`apply`, `panelStore`, …)
   */
  function boot(exports) {
    if (mounted) return;
    mounted = true;

    try {
      exports.apply(ctx);
    } catch (error) {
      note("面板未能启动。");
      warn("apply() failed", error);
      throw error;
    }

    const entry = slotRegistry.get("sidebar.footer.action");
    if (!entry) {
      note("面板没有注册入口。");
      warn("no sidebar.footer.action slot was registered");
      return;
    }

    const container = document.getElementById("root");
    if (!container) {
      warn("#root is missing");
      return;
    }

    try {
      ReactDOM.createRoot(container).render(React.createElement(entry.Component, { t: translate }));
    } catch (error) {
      note("面板渲染失败。");
      warn("render failed", error);
      throw error;
    }

    // The window frame is drawn by the page, so the buttons exist as soon as
    // there is a body to hang them on — before the panel has anything to show.
    try {
      mountCaption();
    } catch (error) {
      warn("caption failed", error);
    }

    // In DSH the panel is an overlay that starts closed. In the window it is the
    // whole surface, so it starts open — and closing it closes the window.
    const store = exports.panelStore;
    if (store && typeof store.set === "function") store.set(true);
    watch(store);
  }

  /**
   * Close the window when the panel closes.
   *
   * The panel's own close button, Escape, and "在 DSH 中打开" all end with
   * `panelStore.set(false)`; in a window that means "done here".
   *
   * @param {any} store
   */
  function watch(store) {
    if (!store || typeof store.subscribe !== "function" || typeof store.getSnapshot !== "function") return;
    store.subscribe(() => {
      let open = true;
      try {
        open = store.getSnapshot();
      } catch {
        /* a broken store is not a reason to stay open forever */
      }
      if (!open) closeWindow();
    });
  }

  let closing = false;

  /** Ask the main process to close the frame; fall back to the DOM's own close. */
  function closeWindow() {
    if (closing) return;
    closing = true;
    const bridge = window.se;
    if (bridge && typeof bridge.window === "function") {
      Promise.resolve()
        .then(() => bridge.window("close"))
        .catch(() => window.close());
      return;
    }
    window.close();
  }

  // ── Caption ──────────────────────────────────────────────────────────────
  /**
   * Draw the window's minimise / maximise / close buttons.
   *
   * Not Electron's `titleBarOverlay`: that chrome is painted above the page by
   * the browser, cannot read the panel's tokens, and in this window did not paint
   * at all while still reporting `navigator.windowControlsOverlay.visible`. The
   * buttons are therefore ordinary DOM in the page — they follow the theme
   * because they are drawn with the panel's own custom properties, and they talk
   * to the frame over the one IPC call the preload already exposes.
   *
   * The close button routes through `closeWindow()` so the panel's own close
   * button, Escape and this button all end the same way.
   */
  function mountCaption() {
    const doc = document;
    if (!doc || typeof doc.createElement !== "function" || !doc.body) return;
    if (typeof doc.getElementById === "function" && doc.getElementById("se-caption")) return;
    const bridge = window.se;
    if (!bridge || typeof bridge.window !== "function") return;

    const bar = doc.createElement("div");
    bar.id = "se-caption";
    bar.className = "se-caption";

    /** One button: an icon, a title, and an action. */
    const addButton = (action, label, shape, onClick) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "se-caption-btn";
      if (action === "close") button.className = "se-caption-btn se-caption-close";
      button.setAttribute("title", label);
      button.setAttribute("aria-label", label);
      button.dataset.caption = action;
      const icon = typeof doc.createElementNS === "function" ? doc.createElementNS("http://www.w3.org/2000/svg", "svg") : null;
      if (icon) {
        icon.setAttribute("viewBox", "0 0 16 16");
        icon.setAttribute("width", "12");
        icon.setAttribute("height", "12");
        icon.setAttribute("fill", "none");
        icon.setAttribute("stroke", "currentColor");
        icon.setAttribute("stroke-width", "1.2");
        icon.setAttribute("aria-hidden", "true");
        for (const d of shape) {
          const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", d);
          icon.appendChild(path);
        }
        button.appendChild(icon);
      } else {
        button.textContent = label.slice(0, 1);
      }
      button.addEventListener("click", onClick);
      bar.appendChild(button);
      return button;
    };

    addButton("minimize", "最小化", ["M3 8h10"], () => void Promise.resolve(bridge.window("minimize")).catch(() => {}));

    // Maximise is a toggle, and the glyph stays the same in both states: what
    // changes is the label, which is what a screen reader and the tooltip read.
    const toggle = addButton("maximize", "最大化", ["M3.5 3.5h9v9h-9z"], () => {
      void Promise.resolve(bridge.window("maximize"))
        .then(sync)
        .catch(() => {});
    });

    addButton("close", "关闭", ["M3.5 3.5l9 9", "M12.5 3.5l-9 9"], () => closeWindow());

    /** @param {{ maximized?: boolean } | undefined} state */
    function sync(state) {
      if (!state || typeof state.maximized !== "boolean") return;
      const label = state.maximized ? "还原" : "最大化";
      toggle.setAttribute("title", label);
      toggle.setAttribute("aria-label", label);
    }

    // Maximise also happens without this button — double-clicking the strip or
    // Win+Up — and the frame cannot push it, so the button asks after a resize.
    let pending = 0;
    if (typeof window.addEventListener === "function") {
      window.addEventListener("resize", () => {
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          const result = bridge.window("state");
          if (result && typeof result.then === "function") result.then(sync).catch(() => {});
        }, 150);
      });
    }

    doc.body.appendChild(bar);
    const state = bridge.window("state");
    if (state && typeof state.then === "function") state.then(sync).catch(() => {});
  }

  // ── Theme ────────────────────────────────────────────────────────────────
  /**
   * Paint the palette the panel last reported.
   *
   * The Host stores exactly the tokens the stylesheets consume, already filtered
   * (lib/host/theme.js), so they are safe to write as custom properties. A
   * `null` snapshot means DSH has never shown the panel; the stylesheet's own
   * fallbacks are a legible dark palette, so this is an improvement, not a
   * requirement.
   *
   * @returns {Promise<boolean>} whether a palette was applied
   */
  async function applyTheme() {
    if (!realFetch) return false;
    try {
      const response = await realFetch(API + "/theme", { headers: { accept: "application/json" } });
      const envelope = await response.json();
      const snapshot = envelope && envelope.ok === true ? envelope.result : null;
      const tokens = snapshot && snapshot.tokens ? snapshot.tokens : null;
      if (!tokens) return false;
      const root = document.documentElement;
      if (!root) return false;
      if (root.style && typeof root.style.setProperty === "function") {
        for (const [name, value] of Object.entries(tokens)) {
          if (typeof value === "string" && value !== "") root.style.setProperty(name, value);
        }
      }
      if (typeof root.setAttribute === "function" && (snapshot.mode === "light" || snapshot.mode === "dark")) {
        root.setAttribute("data-theme", snapshot.mode);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A window can open before the panel ever mounted, and the palette only
   * exists after it reports once. Four attempts over ~4.6s cover that without
   * polling forever; after that the fallbacks stand.
   */
  void (async function paintTheme() {
    const waits = [0, 400, 1200, 3000];
    for (const wait of waits) {
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (await applyTheme()) return;
    }
  })();
})();
