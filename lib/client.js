/**
 * dsh-session-explorer — client half (browser bundle, no build step).
 *
 * Loaded through `window.__ModuleLoader__.load({ id, factory })`, exactly like
 * every other out-of-tree DSH client plugin. `factory` receives a `require`
 * that resolves the host's shared modules (`react`, the UI primitives) — the
 * plugin ships no bundler output and no runtime dependency of its own.
 *
 * P1.5 scope: a read-only browser that mirrors the standalone prototype's
 * window chrome — tabs, breadcrumb bar, command bar, three panes and a status
 * bar. Everything it shows comes from the host's merged session view, so the
 * client never re-derives a fact DSH already computed and never writes to the
 * session store. Commands that need a sidecar (tags, notes, pin, archive,
 * trash) are present in the bar because the layout expects them, but they only
 * report that the write phase has not shipped yet.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-explorer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

    const h = (type, props, ...children) => React.createElement(type, props, ...children);

    const API = "/session-explorer/api";
    const NS = "session-explorer";
    const CSS_ID = "dsh-session-explorer/panel";
    const LAYOUT_KEY = "dsh-session-explorer/layout.v1";

    /**
     * Layout memory.
     *
     * The panel is a transient overlay: closing it unmounts every component, so
     * without persistence the next open would forget the pane widths, the
     * active scope and the collapsed branches. The prototype keeps that state in
     * memory only because it never unmounts; we keep it in localStorage so the
     * panel reopens exactly where it was left. Every read is defensive — a
     * corrupt or half-written entry must never stop the panel from opening.
     */
    function readLayout() {
      try {
        const raw = window.localStorage.getItem(LAYOUT_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    }

    function mergeLayout(patch) {
      try {
        const next = { ...readLayout(), ...patch };
        window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {
        /* storage disabled — the panel still works, it just forgets */
      }
    }

    // One frozen empty array for defaulted list props: a fresh `[]` on every
    // render would break the memo dependencies of every component that gets it.
    const EMPTY_LIST = Object.freeze([]);

    const FIXED = {
      root: "f-root",
      favorites: "f-favorites",
      todos: "f-todos",
      trash: "f-trash",
      ungrouped: "f-ungrouped",
    };

    /**
     * Open this plugin's section in DSH's own settings window.
     *
     * There is no client-side "open settings on section X" call on
     * `uiWorkspace` or `layout`: the settings shell owns its own modal and only
     * publishes slots. The one place the shell hands out its navigation action
     * is the `settings.onboarding` roster, whose props include
     * `openSection(id)`. So a zero-height step registers there purely to
     * capture that function for the panel, then completes immediately and
     * renders nothing.
     *
     * When the host provides no such slot the opener stays null and the caller
     * falls back to the inline settings view.
     */
    let openSettingsSection = null;

    // ── Panel store ────────────────────────────────────────────────────────
    // A single boolean, but it lives outside React so both the sidebar button
    // and the panel itself can drive it, and so a second entry point added
    // later does not need a context provider threaded through the host tree.
    const panelStore = (() => {
      let open = false;
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      return {
        getSnapshot: () => open,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set(next) {
          if (open === next) return;
          open = next;
          emit();
        },
        toggle() {
          open = !open;
          emit();
        },
      };
    })();

    // ── Overlay host ──────────────────────────────────────────────────────
    // The sidebar has `overflow: hidden`, so a panel rendered inside the footer
    // slot would be clipped. Render into a fixed layer appended to <body>
    // instead. 1050 sits above DSH's 1000 backdrop tier and below its 1100
    // tooltip tier.
    let overlayRootElement = null;
    function getOverlayRoot() {
      if (typeof document === "undefined" || !document.body) return null;
      const alive = overlayRootElement && document.body.contains(overlayRootElement);
      let element = alive ? overlayRootElement : document.getElementById("dsh-session-explorer-overlay-root");
      if (!element) {
        element = document.createElement("div");
        element.id = "dsh-session-explorer-overlay-root";
        Object.assign(element.style, {
          position: "fixed",
          inset: "0",
          zIndex: "1050",
          pointerEvents: "none",
          overflow: "visible",
        });
        document.body.appendChild(element);
      }
      overlayRootElement = element;
      return overlayRootElement;
    }

    /**
     * Resolve `createPortal` defensively.
     *
     * The shared `react` the module loader hands out is a thin re-export: it
     * carries the hooks but not always the DOM renderer, and `react-dom` is not
     * guaranteed to be listed as a resolvable module for a plugin. Every source
     * the reference plugin uses is tried in turn; if none resolves we fall back
     * to rendering in place, which still works (the panel is fixed-position) but
     * would be clipped by the sidebar's `overflow: hidden`.
     */
    let cachedCreatePortal;
    function getPortalFn() {
      if (cachedCreatePortal !== undefined) return cachedCreatePortal;
      const candidates = [];
      if (typeof React.createPortal === "function") candidates.push(React.createPortal);
      if (typeof window !== "undefined") {
        if (typeof window.__smReactDOM?.createPortal === "function") candidates.push(window.__smReactDOM.createPortal);
        if (typeof window.ReactDOM?.createPortal === "function") candidates.push(window.ReactDOM.createPortal);
        if (typeof window.React?.createPortal === "function") candidates.push(window.React.createPortal);
      }
      if (typeof require === "function") {
        for (const id of ["react-dom", "react-dom/client"]) {
          try {
            const dom = require(id);
            if (typeof dom?.createPortal === "function") {
              candidates.push(dom.createPortal);
              break;
            }
          } catch {
            /* not resolvable for this plugin — try the next source */
          }
        }
      }
      cachedCreatePortal = candidates[0] ?? null;
      return cachedCreatePortal;
    }

    function portal(node) {
      const root = getOverlayRoot();
      const createPortal = getPortalFn();
      if (!root || typeof createPortal !== "function") return node;
      return createPortal(node, root);
    }

    /**
     * Portal a fragment into the overlay root.
     *
     * The panel is two siblings — the scrim and the shell — and the scrim has to
     * paint *behind* the shell without being inside it. Wrapping both in a
     * fragment keeps that relationship while still using a single portal.
     *
     * @param {any[]} children
     * @returns {any}
     */
    function portalFragment(children) {
      const root = getOverlayRoot();
      const createPortal = getPortalFn();
      if (!root || typeof createPortal !== "function") {
        return h(React.Fragment, null, ...children);
      }
      return createPortal(h(React.Fragment, null, ...children), root);
    }

    // ── Styles ─────────────────────────────────────────────────────────────
    // Ported from the standalone prototype, but every one of its --sm-* colours
    // is bridged onto a DSH alias token (see the bridge at the top of the
    // sheet), so no colour is ever hardcoded here and a theme plugin that
    // republishes the alias layer restyles the whole panel.
    const CSS = `
/* ── token bridge ────────────────────────────────────────────────────────
   The prototype was written against its own --sm-* palette. Every one of
   those names is aliased onto a DSH alias token here, so the ported rules
   below never hardcode a colour and follow the live theme (including a
   third-party theme plugin that republishes the alias layer). */
.se-shell{
  --sm-tint: var(--dsw-alias-bg-layer-1, #232324);
  --sm-text: var(--dsw-alias-label-primary, #f5f6f7);
  --sm-text-2: var(--dsw-alias-label-secondary, #cfd3d6);
  --sm-text-3: var(--dsw-alias-label-tertiary, #979da6);
  --sm-border: var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  --sm-border-soft: var(--dsw-alias-border-l1, rgba(255,255,255,.06));
  /* brand-primary is a neutral bluish text colour, not a hue: the visible
     accent must come from the business/primary state colour (deepseek-500). */
  --sm-accent: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #4176e6));
  --sm-danger: var(--dsw-alias-state-error-primary, #f25a5a);
  --sm-shadow: 0 24px 64px color-mix(in oklab, #000 34%, transparent),
               0 2px 8px color-mix(in oklab, #000 20%, transparent);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
  color: var(--sm-text);
  -webkit-font-smoothing: antialiased;
  pointer-events: auto;
}
/* ── the shell ────────────────────────────────────────────────────────────
   One rule, not three. The shell is a floating surface centred in the viewport:
   fixed + inset 0 + margin auto, because the overlay host is itself a fixed
   pointer-events:none layer and flex centring inside it is unreliable.

   data-size comes from settings.shell.modal.size and is set by Panel, so the
   CSS never has to guess which preset is active.

   Hard constraint 10 (实现粗规划.md): no backdrop-filter and no darkening.
   The panel must stay legible over a wallpaper, so it is painted with an
   opaque-ish tint of the theme surface instead of blurring what is behind it. */
.se-shell{
  position: fixed;
  inset: 0;
  margin: auto;
  z-index: 1050;
  display: flex;
  flex-direction: column;
  width: min(1100px, 92vw);
  height: min(720px, 88vh);
  border-radius: 8px;
  border: 1px solid var(--sm-border);
  box-shadow: var(--sm-shadow);
  overflow: hidden;
  --panel-alpha: 100%;
  background: color-mix(in oklab, var(--sm-tint) var(--panel-alpha), transparent);
  transition: background .18s var(--ease, ease);
}
.se-shell *{box-sizing: border-box;}

/* Preset sizes. "full" is a percentage so a narrow window cannot overflow. */
/* Fixed sizes are pixel presets clamped to the viewport, so a 1600px choice on
   a 900px browser shrinks instead of overflowing. Percentages follow the
   window, which is the other thing a user can mean by "size". Both are written
   by Panel from settings.shell.modal.{sizing,size,percent}. */
.se-shell[data-size="sm"]{width:min(860px,94vw);height:min(560px,90vh)}
.se-shell[data-size="md"]{width:min(1100px,94vw);height:min(720px,90vh)}
.se-shell[data-size="lg"]{width:min(1320px,94vw);height:min(820px,90vh)}
.se-shell[data-size="xl"]{width:min(1600px,94vw);height:min(960px,90vh)}
.se-shell[data-sizing="percent"]{width:var(--se-w);height:var(--se-h)}
.se-shell[data-sizing="percent"][data-size="p50"]{--se-w:50vw;--se-h:50vh}
.se-shell[data-sizing="percent"][data-size="p70"]{--se-w:70vw;--se-h:70vh}
.se-shell[data-sizing="percent"][data-size="p85"]{--se-w:85vw;--se-h:85vh}
.se-shell[data-sizing="percent"][data-size="p100"]{--se-w:100vw;--se-h:100vh}

/* 最大化. The panel is already a fixed layer, so maximising is "fill the
   viewport with a small breathing margin", not a separate window (that is P6's
   独立窗口). The rule comes after the presets so it wins over the size
   vocabulary, and it is a plain attribute rather than an inline style so the
   preset still comes back when the user restores. */

/* One surface. 独立窗口 (a real browser window outside DSH) is P6 and renders in
   its own document, so nothing here has to switch on it. */
/* Material presets stay available, but every one of them is opaque enough to
   read text over: transparency without a blur is just a wallpaper showing
   through, so the weakest is 88%. */
.se-shell[data-material="strong"]{--panel-alpha:88%}
.se-shell[data-material="weak"]{--panel-alpha:96%}
.se-shell[data-material="solid"]{--panel-alpha:100%}


/* The scrim is a sibling of the shell, not a child, so it paints behind it.
   --se-dim comes from settings.shell.modal.dim and defaults to 0: with the
   default settings the scrim is invisible and the wallpaper is untouched. */
.se-scrim{
  position: fixed;
  inset: 0;
  z-index: 1049;
  background: color-mix(in oklab, #000 calc(var(--se-dim, 0) * 100%), transparent);
  pointer-events: none;
}
.se-scrim[data-clickable="1"]{pointer-events: auto}
.se-shell .tabs{display:flex;align-items:flex-end;gap:2px;padding:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.se-shell .tabs::-webkit-scrollbar{display:none}
.se-shell .tab{display:flex;align-items:center;gap:6px;height:30px;padding:0 8px 0 10px;max-width:220px;min-width:110px; border-radius:6px 6px 0 0;font-size:12.5px;color:var(--sm-text-2);cursor:default;flex:0 0 auto; background:transparent;border:1px solid transparent;border-bottom:none;cursor:pointer;}
.se-shell .tab .tname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.se-shell .tab.active{background:color-mix(in oklab, var(--sm-text) 8%, transparent);color:var(--sm-text);border-color:var(--sm-border-soft)}
.se-shell .tab .x{opacity:.45;display:grid;place-items:center;width:16px;height:16px;border-radius:3px;flex:0 0 16px}
.se-shell .tab .x:hover{background:color-mix(in oklab, var(--sm-text) 12%, transparent);opacity:1}
.se-shell .tab .t-ic{display:grid;place-items:center}
.se-shell .tab-add{width:28px;height:28px;display:grid;place-items:center;border-radius:4px;color:var(--sm-text-2);margin-bottom:1px;flex:0 0 28px;background:transparent;border:0;padding:0;cursor:pointer}
.se-shell .tab-add:hover{background:color-mix(in oklab, var(--sm-text) 8%, transparent)}
.se-shell .tab.dragging{opacity:.4}
/* A tab remembers its own scope, so the title has to shrink before the close
   button does: the button is the smaller, more precise target. */
.se-shell .tab .t-x{opacity:.45;display:grid;place-items:center;width:16px;height:16px;border-radius:3px;flex:0 0 16px}
.se-shell .tab .t-x:hover{background:color-mix(in oklab, var(--sm-text) 12%, transparent);opacity:1}
.se-shell .tab:not(.active) .t-x{opacity:0}
.se-shell .tab:not(.active):hover .t-x{opacity:.6}
.se-shell .tab.dropbefore{box-shadow:inset 2px 0 0 var(--sm-accent)}
.se-shell .tab.dropafter{box-shadow:inset -2px 0 0 var(--sm-accent)}
.se-shell .titlebar{flex:0 0 40px;height:40px;display:flex;align-items:flex-end;gap:8px;padding:0 6px 0 8px; user-select:none;border-bottom:1px solid var(--sm-border-soft);}
.se-shell .titlebar .tabs{flex:1;min-width:0;height:38px;align-items:flex-end}
.se-shell .titlebar .wbtns{flex:0 0 auto;margin-bottom:2px}
.se-shell .t-ic{display:grid;place-items:center;color:var(--sm-accent)}
.se-shell .title{font-size:12.5px;font-weight:600;letter-spacing:.2px;white-space:nowrap}
.se-shell .spacer{flex:1}
.se-shell .wbtns{display:flex;align-items:center;gap:2px}
.se-shell .wbtn{width:34px;height:30px;display:grid;place-items:center;border-radius:4px;color:var(--sm-text-2); background:transparent;border:0;cursor:pointer;}
.se-shell .wbtn:hover{background:color-mix(in oklab, var(--sm-text) 9%, transparent);color:var(--sm-text)}
.se-shell .wbtn.close:hover{background:#c42b1c;color:#fff}
.se-shell .wbtn.min,.se-shell .wbtn.max{display:none}
.se-shell .cmdbar{flex:0 0 48px;height:48px;display:flex;align-items:center;gap:4px;padding:0 10px; border-top:1px solid var(--sm-border-soft); border-bottom:1px solid var(--sm-border-soft); background:color-mix(in oklab, var(--sm-text) 3%, transparent); overflow-x:auto;overflow-y:hidden;scrollbar-width:none;}
.se-shell .cmdbar::-webkit-scrollbar{display:none}
.se-shell .cmdbar .spacer{flex:1;min-width:8px}
.se-shell .cmsep{width:1px;height:18px;flex:0 0 1px;margin:0 5px; background:var(--sm-border);}
.se-shell .cmd{display:flex;align-items:center;gap:7px;height:32px;padding:0 10px;border-radius:4px; border:0;background:transparent;color:var(--sm-text);font:inherit;font-size:12.5px;cursor:pointer; white-space:nowrap;}
.se-shell .cmd:hover{background:color-mix(in oklab, var(--sm-text) 8%, transparent)}
.se-shell .cmd:active{background:color-mix(in oklab, var(--sm-text) 12%, transparent)}
.se-shell .cmd:disabled{opacity:.38;pointer-events:none}
.se-shell .cmd.icon-only{padding:0;width:32px;justify-content:center}
.se-shell .cmd .ic{color:var(--sm-text)}
.se-shell .cmd.danger .ic{color:var(--sm-danger)}
.se-shell .sep{width:1px;height:18px;background:var(--sm-border);margin:0 6px;flex:0 0 1px}
.se-shell .cmd-right{margin-left:auto;display:flex;align-items:center;gap:2px}
.se-shell .navbar{flex:0 0 40px;height:40px;display:flex;align-items:center;gap:2px;padding:0 10px; border-bottom:1px solid var(--sm-border-soft);}
.se-shell .nbtn{width:30px;height:30px;display:grid;place-items:center;border-radius:4px;color:var(--sm-text-2);background:transparent;border:0;cursor:pointer}
.se-shell .nbtn:hover{background:color-mix(in oklab, var(--sm-text) 8%, transparent);color:var(--sm-text)}
.se-shell .nbtn:disabled{opacity:.3;pointer-events:none}
.se-shell .crumbs{flex:1;min-width:0;height:30px;display:flex;align-items:center;gap:1px;padding:0 8px;margin:0 6px; border-radius:4px;overflow:hidden; /* 地址栏气泡常驻：不再只在 hover 时出现 */ border:1px solid var(--sm-border-soft); background:color-mix(in oklab, var(--sm-text) 4.5%, transparent);}
.se-shell .crumbs:hover{border-color:var(--sm-border);background:color-mix(in oklab, var(--sm-text) 7%, transparent)}
.se-shell .crumb{padding:2px 6px;border-radius:3px;font-size:12.5px;color:var(--sm-text-2);white-space:nowrap;cursor:pointer; overflow:hidden;text-overflow:ellipsis;max-width:220px;}
.se-shell .crumb:hover{background:color-mix(in oklab, var(--sm-text) 10%, transparent);color:var(--sm-text)}
.se-shell .crumb.cur{color:var(--sm-text);font-weight:600}
.se-shell .crumb-sep{color:var(--sm-text-3);font-size:11px;padding:0 1px;display:grid;place-items:center}
.se-shell .search{width:220px;height:30px;display:flex;align-items:center;gap:6px;padding:0 8px; border-radius:4px;border:1px solid var(--sm-border); background:color-mix(in oklab, var(--sm-text) 4%, transparent);}
.se-shell .search:focus-within{border-color:var(--sm-accent)}
.se-shell .search input{flex:1;min-width:0;border:0;background:transparent;color:var(--sm-text);font:inherit;font-size:12.5px;outline:none;}
.se-shell .search input::placeholder{color:var(--sm-text-3)}
.se-shell .body{flex:1;min-height:0;display:flex;position:relative}
.se-shell .pane-tree{flex:0 0 260px;width:260px;min-width:200px;max-width:360px; display:flex;flex-direction:column;overflow:auto;padding:6px 6px 10px; border-right:1px solid var(--sm-border-soft);}
.se-shell .pane-list{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.se-shell .pane-detail{flex:0 0 320px;width:320px;display:flex;flex-direction:column;overflow:auto; border-left:1px solid var(--sm-border-soft); background:color-mix(in oklab, var(--sm-text) 2.5%, transparent);}
.se-shell .rsz{flex:0 0 4px;width:4px;cursor:col-resize;background:transparent;position:relative;z-index:3}
.se-shell .rsz:hover{background:color-mix(in oklab, var(--sm-accent) 45%, transparent)}
.se-shell .tsec{padding:9px 10px 3px;font-size:10.5px;color:var(--sm-text-3);letter-spacing:.3px;font-weight:600}
.se-shell .tsep{height:1px;margin:5px 10px;background:var(--sm-border-soft)}
.se-shell .tcap{font-size:10.5px;color:var(--sm-text-3);padding:4px 12px 2px;letter-spacing:.02em;user-select:none}
.se-shell .trow{display:flex;align-items:center;gap:8px;height:26px;padding:0 8px 0 6px;border-radius:4px; cursor:default;user-select:none;position:relative;color:var(--sm-text);margin:0 0 1px;}
.se-shell .trow:hover{background:color-mix(in oklab, var(--sm-text) 7%, transparent)}
.se-shell .trow.sel{background:color-mix(in oklab, var(--sm-accent) 16%, transparent)}
.se-shell .trow.sel::before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:3px;border-radius:2px;background:var(--sm-accent)}
.se-shell .trow.drop{background:color-mix(in oklab, var(--sm-accent) 24%, transparent);outline:1px dashed var(--sm-accent);outline-offset:-2px}
.se-shell .trow.bad{opacity:.4}
/* Refused drop target in the list: a container row that cannot take this
   payload greys out and shows a 🚫 cursor instead of accepting and failing. */
.se-shell .row[data-drop="bad"]{opacity:.45;outline:1px dashed var(--sm-danger);outline-offset:-2px}
.se-shell .row[data-drop="1"]{background:color-mix(in oklab, var(--sm-accent) 18%, transparent);outline:1px dashed var(--sm-accent);outline-offset:-2px}
.se-shell .trow.drag{opacity:.5}
.se-shell .trow.flash-hl{animation:hl 1.4s ease-out}
@keyframes hl{0%,40%{background:color-mix(in oklab, var(--sm-accent) 40%, transparent)} 100%{background:transparent}}
.se-shell .trow .ic{flex:0 0 16px;color:var(--sm-text-2)}
.se-shell .trow.ws .ic{color:var(--sm-accent)}
/* Workspace entries in the tree follow the same rule as workspace rows in the
   list: accent colour on the icon and the label only, no tinted surface. */
.se-shell .trow.ws .lbl{color:var(--sm-accent);font-weight:600}
.se-shell .trow.ws.sel .lbl{color:var(--sm-accent)}
.se-shell .trow .lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.se-shell .trow .cnt{font-size:10.5px;color:var(--sm-text-3);font-variant-numeric:tabular-nums;opacity:0;transition:opacity .1s}
.se-shell .trow:hover .cnt,.se-shell .trow.sel .cnt{opacity:1}
.se-shell .trow .pin{width:18px;height:18px;display:grid;place-items:center;border-radius:3px;color:var(--sm-text-3);opacity:0;transition:opacity .1s}
.se-shell .trow .pin.on{opacity:1;color:var(--sm-accent)}
.se-shell .trow:hover .pin{opacity:1}
.se-shell .trow .pin:hover{background:color-mix(in oklab, var(--sm-text) 14%, transparent)}
.se-shell .trow .caret{width:14px;height:14px;display:grid;place-items:center;color:var(--sm-text-3);flex:0 0 14px}
.se-shell .trow .caret.hidden{visibility:hidden}
.se-shell .tsub{display:none}
/* The detached page has a native frame, so it draws no window controls of its
   own — the OS already owns minimise / maximise / close. */

.se-shell .listhead{display:flex;align-items:center;height:28px;padding:0 12px 0 0;border-bottom:1px solid var(--sm-border-soft); font-size:10.5px;color:var(--sm-text-3);user-select:none;flex:0 0 28px;}
/* The sort affordance is a small caret, not a word: a full-width label with a
   "▼" glued to it read as two columns and made the header feel heavy. */
.se-shell .lh{padding:0 6px;display:flex;align-items:center;gap:3px;cursor:pointer;white-space:nowrap;overflow:hidden;letter-spacing:.02em}
.se-shell .lh:hover{color:var(--sm-text-2)}
.se-shell .lh .sortdot{opacity:0;font-size:7px;line-height:1;transition:opacity .12s ease}
.se-shell .lh.sorted{color:var(--sm-text);font-weight:600}
.se-shell .lh.sorted .sortdot{opacity:.75}
.se-shell .lh .lhlabel{overflow:hidden;text-overflow:ellipsis}
.se-shell .pane-list{--w-check:32px; --w-name:260px; --w-tags:116px; --w-note:150px; --w-date:104px; --w-size:74px; --w-status:78px;}
.se-shell .col-check{flex:0 0 var(--w-check);width:var(--w-check);padding-left:12px}
.se-shell .col-name{flex:0 0 var(--w-name);width:var(--w-name);min-width:110px}
.se-shell .col-fill{flex:1 1 auto;min-width:0}
.se-shell .col-tags{flex:0 0 var(--w-tags);width:var(--w-tags)}
.se-shell .col-note{flex:0 0 var(--w-note);width:var(--w-note)}
.se-shell .col-date{flex:0 0 var(--w-date);width:var(--w-date)}
.se-shell .col-size{flex:0 0 var(--w-size);width:var(--w-size);justify-content:flex-end}
.se-shell .col-status{flex:0 0 var(--w-status);width:var(--w-status)}
.se-shell .lh{position:relative}
.se-shell .lh[data-col]{cursor:grab}
.se-shell .lh.dragging{opacity:.45}
.se-shell .lh.dropbefore{box-shadow:inset 2px 0 0 var(--sm-accent)}
.se-shell .lh.dropafter{box-shadow:inset -2px 0 0 var(--sm-accent)}
.se-shell .colrsz{position:absolute;top:6px;bottom:6px;right:-3px;width:7px;cursor:col-resize;z-index:4; border-radius:2px;background:transparent;}
.se-shell .colrsz:hover,.se-shell .colrsz.on{background:color-mix(in oklab, var(--sm-accent) 70%, transparent)}
.se-shell .colrsz::after{content:"";position:absolute;left:3px;top:0;bottom:0;width:1px;background:var(--sm-border-soft)}
.se-shell .colrsz:hover::after{background:transparent}
.se-shell .pane-list[data-cw="slim"] .col-tags,.se-shell .pane-list[data-cw="slim"] .col-status,.se-shell .pane-list[data-cw="slim"] .col-size,.se-shell .pane-list[data-cw="mid"] .col-status{display:none}
.se-shell .listbody{flex:1;overflow:auto;min-height:0;padding-bottom:8px}
.se-shell .grp{display:flex;align-items:center;gap:6px;height:30px;padding:0 12px;margin-top:6px; font-size:11.5px;color:var(--sm-text-2);font-weight:600;position:sticky;top:0; background:color-mix(in oklab, var(--sm-tint) 55%, transparent); backdrop-filter:blur(8px);z-index:2;}
.se-shell .grp .gcount{font-weight:400;color:var(--sm-text-3)}
.se-shell .row{display:flex;align-items:center;height:32px;padding-right:12px;border-radius:4px;cursor:default; position:relative;user-select:none;}
.se-shell .row:hover{background:color-mix(in oklab, var(--sm-text) 6%, transparent)}
.se-shell .row.sel{background:color-mix(in oklab, var(--sm-accent) 15%, transparent)}
.se-shell .row.sel::before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:3px;border-radius:2px;background:var(--sm-accent)}
.se-shell .row.drag{opacity:.45}
.se-shell .row .cell{padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--sm-text)}
.se-shell .row .cell.dim{color:var(--sm-text-2)}
.se-shell .row .cell.num{font-variant-numeric:tabular-nums;text-align:right;justify-content:flex-end}
.se-shell .row .namecell{display:flex;align-items:center;gap:8px;min-width:0}
.se-shell .row .namecell .ic{flex:0 0 16px;color:var(--sm-text-2)}
.se-shell .row .namecell .ic.wsic{color:var(--sm-accent)}
.se-shell .row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Inline rename: the selected row swaps its label for an input (m02120). */
.se-shell .nm-edit{flex:1 1 auto;min-width:0;width:auto;height:20px;padding:0 5px;border:1px solid var(--sm-accent);border-radius:3px; background:color-mix(in oklab, var(--sm-text) 8%, transparent);color:var(--sm-text);font:inherit;font-size:12.5px;line-height:18px;outline:none;}
.se-shell .trow .lbl-edit{flex:1 1 auto;min-width:0;height:20px;padding:0 5px;border:1px solid var(--sm-accent);border-radius:3px; background:color-mix(in oklab, var(--sm-text) 8%, transparent);color:var(--sm-text);font:inherit;font-size:12px;line-height:18px;outline:none;}
.se-shell[data-view="icons"] .row .namecell .nm-edit{width:100%;flex:0 0 auto}
/* The pencil is a hover affordance, never a permanent column: it appears on
   the row the pointer is over and on the selected row (m02120). */
.se-shell .nm-editbtn{flex:0 0 16px;width:16px;height:16px;display:none;place-items:center;border-radius:3px;color:var(--sm-text-3);cursor:pointer}
.se-shell .row:hover .nm-editbtn,.se-shell .row.sel .nm-editbtn,.se-shell .trow:hover .nm-editbtn,.se-shell .trow.sel .nm-editbtn{display:grid}
.se-shell .nm-editbtn:hover{background:color-mix(in oklab, var(--sm-text) 14%, transparent);color:var(--sm-text)}
.se-shell .row .tag{display:inline-block;padding:1px 6px;margin-right:4px;border-radius:10px;font-size:10.5px; background:color-mix(in oklab, var(--sm-accent) 18%, transparent); color:color-mix(in oklab, var(--sm-accent) 70%, var(--sm-text)); max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;}
.se-shell .chk{width:15px;height:15px;border-radius:3px;border:1px solid var(--sm-text-3);display:grid;place-items:center; opacity:0;transition:opacity .1s;}
.se-shell .row:hover .chk,.se-shell .row.sel .chk,.se-shell .listbody.has-sel .chk{opacity:1}
.se-shell .chk.on{background:var(--sm-accent);border-color:var(--sm-accent);color:#04283a}
.se-shell .chk .ic{width:11px;height:11px}
.se-shell .st{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--sm-text-2)}
.se-shell .dot{width:7px;height:7px;border-radius:50%;background:var(--sm-text-3)}
.se-shell .dot.run{background:#3ecf8e;box-shadow:0 0 0 3px rgba(62,207,142,.16)}
.se-shell .dot.err{background:var(--sm-danger)}
.se-shell .row.frow .col-date,.se-shell .row.frow .col-status{display:none}
.se-shell .frow .fl-ic{display:inline-flex;color:var(--sm-accent)}
.se-shell .pinbadge{display:inline-grid;place-items:center;width:14px;height:14px;flex:0 0 14px;color:var(--sm-text-3)}
.se-shell .pinbadge .ic{width:10px;height:10px}
.se-shell .wstag{font-size:10px;padding:0 5px;border-radius:3px;background:color-mix(in oklab, var(--sm-accent) 18%, transparent);color:var(--sm-accent);line-height:15px}
.se-shell .row.wsrow .nm{font-weight:600}
.se-shell .row.arch .cell,.se-shell .row.arch .namecell .ic,.se-shell .row.arch .tag{opacity:.45}
.se-shell .row.arch:hover .cell,.se-shell .row.arch:hover .namecell .ic{opacity:.72}
.se-shell .row.arch .arcbadge{display:inline-grid;place-items:center;width:14px;height:14px;border-radius:3px;margin-left:2px; border:1px solid var(--sm-text-3);color:var(--sm-text-3);flex:0 0 14px;}
.se-shell .row.arch .arcbadge .ic{width:9px;height:9px}
.se-shell .trow.archrow .lbl{opacity:.45}
.se-shell .row.pinned-row .nm::after{content:"";}
.se-shell .row.cut{opacity:.45}
.se-shell .row.cut .nm{text-decoration:line-through;text-decoration-thickness:1px}
.se-shell .empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px; color:var(--sm-text-3);padding:40px;}
.se-shell .empty .big{font-size:34px;opacity:.5}
.se-shell .empty .t{font-size:13.5px;color:var(--sm-text-2)}
.se-shell .empty .s{font-size:12px}
.se-shell .det-head{padding:14px 14px 10px;display:flex;align-items:flex-start;gap:10px;border-bottom:1px solid var(--sm-border-soft)}
.se-shell .det-ic{width:34px;height:34px;border-radius:6px;display:grid;place-items:center;flex:0 0 34px; background:color-mix(in oklab, var(--sm-accent) 16%, transparent);color:var(--sm-accent)}
.se-shell .det-title{font-size:14px;font-weight:600;line-height:1.3;word-break:break-word}
.se-shell .det-sub{font-size:11.5px;color:var(--sm-text-3);margin-top:2px}
.se-shell .dclose{width:26px;height:26px;flex:0 0 26px;display:grid;place-items:center;border-radius:4px; border:0;background:transparent;color:var(--sm-text-3);cursor:pointer;}
.se-shell .dclose:hover{background:color-mix(in oklab, var(--sm-text) 10%, transparent);color:var(--sm-text)}
.se-shell[data-bp="wide"] .dclose{display:none}
.se-shell .det-body{padding:10px 14px;display:flex;flex-direction:column;gap:2px}
.se-shell .kv{display:flex;gap:10px;padding:4px 0;font-size:12.5px;align-items:baseline}
.se-shell .kv .k{flex:0 0 62px;color:var(--sm-text-3);font-size:11.5px}
.se-shell .kv .v{flex:1;min-width:0;color:var(--sm-text);word-break:break-word}
.se-shell .det-sec{padding:10px 14px 6px;border-top:1px solid var(--sm-border-soft)}
.se-shell .det-sec h4{margin:0 0 8px;font-size:11px;color:var(--sm-text-3);font-weight:600;letter-spacing:.3px}
.se-shell .note{width:100%;min-height:168px;resize:vertical;border-radius:4px;padding:8px 9px;font:inherit;font-size:12.5px; line-height:1.5; background:color-mix(in oklab, var(--sm-text) 5%, transparent);border:1px solid var(--sm-border); color:var(--sm-text);outline:none;}
.se-shell .note:focus{border-color:var(--sm-accent)}
.se-shell .taglist{display:flex;flex-wrap:wrap;gap:5px}
.se-shell .tagchip{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:10px;font-size:11px; background:color-mix(in oklab, var(--sm-accent) 16%, transparent); color:color-mix(in oklab, var(--sm-accent) 72%, var(--sm-text));}
.se-shell .tagchip .x{cursor:pointer;opacity:.6}
.se-shell .tagchip .x:hover{opacity:1}
.se-shell .tagadd{padding:2px 8px;border-radius:10px;font-size:11px;border:1px dashed var(--sm-border); color:var(--sm-text-3);background:transparent;cursor:pointer;font-family:inherit;}
.se-shell .tagadd:hover{border-color:var(--sm-accent);color:var(--sm-accent)}
.se-shell .tagpanel{margin-top:8px;padding:8px;border-radius:6px;display:flex;flex-wrap:wrap;gap:5px; background:color-mix(in oklab, var(--sm-text) 4%, transparent); border:1px solid var(--sm-border-soft);}
.se-shell .tagopt{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:10px;font:inherit;font-size:11px; background:transparent;border:1px solid var(--sm-border);color:var(--sm-text-2);cursor:pointer;}
.se-shell .tagopt:hover{border-color:var(--sm-accent);color:var(--sm-text)}
.se-shell .tagopt.on{background:color-mix(in oklab, var(--sm-accent) 20%, transparent); border-color:color-mix(in oklab, var(--sm-accent) 50%, transparent); color:color-mix(in oklab, var(--sm-accent) 70%, var(--sm-text));}
.se-shell .tagopt svg{width:11px;height:11px}
.se-shell .row.frow .nm{font-weight:500}
.se-shell .row.frow{cursor:default}
.se-shell .row.krow .nm{font-style:italic}
.se-shell .row.krow .arcbadge{opacity:.55}
.se-shell .row.krow{cursor:pointer}
.se-shell .row.droptarget{outline:2px dashed var(--sm-accent);outline-offset:-2px;background:color-mix(in oklab, var(--sm-accent) 14%, transparent)}
.se-shell .msel{font:inherit;font-size:11.5px;padding:3px 6px;border-radius:4px;cursor:pointer; background:color-mix(in oklab, var(--sm-text) 7%, transparent); border:1px solid var(--sm-border);color:var(--sm-text);}
.se-shell .msel option{background:#1f1f1f;color:#fff}
.se-shell .mdesc{font-size:10.5px;color:var(--sm-text-3);line-height:1.35}
.se-shell .fmodal{position:fixed;inset:0;z-index:9600;display:none;place-items:center; background:color-mix(in oklab,#000 26%,transparent); backdrop-filter:blur(3px) brightness(.96);}
.se-shell .fmodal.open{display:grid}
.se-shell .fdlg{width:min(480px,92vw);max-height:min(640px,88vh);display:flex;flex-direction:column; border-radius:10px;border:1px solid var(--sm-border); background:color-mix(in oklab, var(--sm-tint) 96%, transparent); box-shadow:0 24px 64px rgba(0,0,0,.5);overflow:hidden;}
/* The settings dialog is a page, not a prompt: it gets the height the filter
   dialog does not need, and its body owns the scroll. */
.se-shell .fdlg.se-setdlg{width:min(560px,94vw);max-height:min(760px,90vh)}
.se-shell .se-setdlg .fbody{padding:0}
.se-shell .fhead{display:flex;align-items:center;gap:8px;height:44px;padding:0 10px 0 14px;border-bottom:1px solid var(--sm-border-soft)}
.se-shell .fhead .ftitle{font-size:13px;font-weight:600;color:var(--sm-text)}
.se-shell .fbody{padding:14px;display:flex;flex-direction:column;gap:12px;overflow:auto}
.se-shell .frow{display:flex;align-items:center;gap:10px}
.se-shell .flb{flex:0 0 88px;font-size:12px;color:var(--sm-text-2);display:flex;flex-direction:column;gap:2px}
.se-shell .fsub{font-size:10px;color:var(--sm-text-3)}
.se-shell .fseg{display:flex;flex:1;min-width:0;gap:0;border:1px solid var(--sm-border);border-radius:5px;overflow:hidden}
.se-shell .fseg button{flex:1 1 0;min-width:0;font:inherit;font-size:11.5px;padding:5px 8px;background:transparent;border:0;color:var(--sm-text-2);cursor:pointer; border-right:1px solid var(--sm-border-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .12s ease,color .12s ease}
.se-shell .fseg button:last-child{border-right:0}
.se-shell .fseg button:hover{background:color-mix(in oklab, var(--sm-text) 7%, transparent);color:var(--sm-text)}
.se-shell .fseg button.on{background:color-mix(in oklab, var(--sm-accent) 26%, transparent);color:var(--sm-text);font-weight:600}

.se-shell .ftags{flex:1;display:flex;flex-wrap:wrap;gap:5px}
.se-shell .ffoot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--sm-border-soft)}
.se-shell .ffoot .spacer{flex:1}
.se-shell .cmd{gap:6px;padding:0 10px}
.se-shell .det-actions{margin-top:auto;padding:12px 14px;display:flex;flex-wrap:wrap;gap:6px;border-top:1px solid var(--sm-border-soft)}
.se-shell .act{display:flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:4px;font:inherit;font-size:12px; background:color-mix(in oklab, var(--sm-text) 7%, transparent);border:1px solid var(--sm-border); color:var(--sm-text);cursor:pointer;}
.se-shell .act:hover{background:color-mix(in oklab, var(--sm-text) 12%, transparent)}
.se-shell .act.primary{background:var(--sm-accent);border-color:transparent;color:#04283a;font-weight:600}
.se-shell .act.danger{color:var(--sm-danger)}
.se-shell .act:disabled{opacity:.4;cursor:default;pointer-events:none}
/* Dialog bodies: the native Modal supplies the frame, these only style content. */
.se-shell .se-dlg-msg{margin:0 0 10px;font-size:13px;line-height:1.55;color:var(--sm-text-2);white-space:pre-wrap}
.se-shell .se-dlg-input{box-sizing:border-box;width:100%;height:32px;padding:0 9px;border-radius:5px;font:inherit;font-size:13px;
  border:1px solid var(--sm-border);background:color-mix(in oklab,var(--sm-text) 4%,transparent);color:var(--sm-text);outline:none}
.se-shell .se-dlg-input:focus{border-color:var(--sm-accent)}
.se-shell .se-dlg-err{margin:8px 0 0;font-size:12px;color:var(--sm-danger)}
.se-shell .se-dlg-ack{display:flex;align-items:flex-start;gap:8px;margin-top:12px;font-size:12.5px;color:var(--sm-text-2);cursor:pointer}
/* ── dialog layer ─────────────────────────────────────────────────────────
   Dialogs are drawn by the plugin and must sit ABOVE the panel and above every
   popover the panel opens (menus are at 9000 inside this same stacking
   context). 9600 keeps a confirmation on top of the window that asked for it,
   which is exactly what the retired "DSH native dialog" path got wrong: the
   app's dialog tier is below this panel, so those confirmations appeared
   underneath it.

   .fmodal is a full-viewport layer with its own scrim, so a dialog also dims
   the panel behind it instead of looking like another pane. */
.se-shell .status{flex:0 0 28px;height:28px;display:flex;align-items:center;gap:12px;padding:0 10px 0 14px; position:relative;z-index:9; border-top:1px solid var(--sm-border);font-size:11.5px;color:var(--sm-text-2); background:color-mix(in oklab, var(--sm-tint) 94%, transparent);}
.se-shell .status .s-item{display:flex;align-items:center;gap:5px}
.se-shell .status .s-item.clickable{cursor:pointer;border-radius:3px;padding:2px 5px;margin:-2px -5px}
.se-shell .status .s-item.clickable:hover{background:color-mix(in oklab, var(--sm-text) 8%, transparent);color:var(--sm-text-2)}
.se-shell .status .s-item.clickable.on{background:color-mix(in oklab, var(--sm-accent) 22%, transparent);color:var(--sm-text)}
.se-shell .viewswitch{margin-left:auto;display:flex;align-items:center;gap:1px}
.se-shell .vsw{width:26px;height:22px;display:grid;place-items:center;border-radius:3px;color:var(--sm-text-3);background:transparent;border:0;cursor:pointer}
.se-shell .vsw:hover{background:color-mix(in oklab, var(--sm-text) 9%, transparent);color:var(--sm-text)}
.se-shell .vsw.on{color:var(--sm-accent);background:color-mix(in oklab, var(--sm-accent) 14%, transparent)}
.se-shell .rz{display:none}
.se-shell .ctxmenu{position:fixed;z-index:9000;min-width:190px;padding:4px;border-radius:8px; background:color-mix(in oklab, var(--sm-tint) 88%, transparent); backdrop-filter:blur(30px) saturate(1.5); border:1px solid var(--sm-border); box-shadow:0 16px 40px rgba(0,0,0,.42); display:none;}
.se-shell .ctxmenu.open{display:block;animation:pop .12s ease-out}
@keyframes pop{from{opacity:0;transform:scale(.97) translateY(-2px)}to{opacity:1;transform:none}}
.se-shell .mi{display:flex;align-items:center;gap:9px;height:30px;padding:0 9px;border-radius:4px;font-size:12.5px; cursor:default;color:var(--sm-text);}
.se-shell .mi:hover{background:color-mix(in oklab, var(--sm-text) 9%, transparent)}
.se-shell .mi .ic{color:var(--sm-text-2);flex:0 0 16px}
.se-shell .mi .k{margin-left:auto;font-size:11px;color:var(--sm-text-3)}
.se-shell .mi.danger{color:var(--sm-danger)}
.se-shell .mi.danger .ic{color:var(--sm-danger)}
.se-shell .mi.disabled{opacity:.45;cursor:default}
.se-shell .mi.disabled:hover{background:transparent}
.se-shell .misep{height:1px;margin:4px 6px;background:var(--sm-border-soft)}
.se-shell .ctxmenu.sub{min-width:180px}
.se-shell .mi.has-sub .k{display:grid;place-items:center;width:14px;height:14px;margin-left:auto;color:var(--sm-text-3)}
.se-shell .mi.has-sub .k .ic{width:11px;height:11px}
.se-shell[data-bp="mid"] .pane-detail{position:absolute;right:0;top:0;bottom:0;width:330px;z-index:8; box-shadow:-14px 0 34px rgba(0,0,0,.32); background:color-mix(in oklab, var(--sm-tint) 92%, transparent); backdrop-filter:blur(28px) saturate(1.4); transform:translateX(100%);transition:transform .18s ease;}
.se-shell[data-bp="mid"] .pane-detail.open{transform:none}
.se-shell[data-bp="mid"] .rsz-detail{display:none}
.se-shell[data-bp="mid"] .col-tags{display:none}
.se-shell[data-bp="narrow"] .pane-tree{flex:0 0 196px;width:196px;min-width:196px;padding:6px 6px 10px;}
.se-shell[data-bp="narrow"] .pane-detail{position:absolute;left:0;right:0;bottom:0;top:auto;height:52%;width:auto;z-index:8; transform:translateY(100%);transition:transform .18s ease; box-shadow:0 -14px 34px rgba(0,0,0,.32); background:color-mix(in oklab, var(--sm-tint) 94%, transparent);}
.se-shell[data-bp="narrow"] .pane-detail.open{transform:none}
.se-shell[data-bp="narrow"] .col-tags,.se-shell[data-bp="narrow"] .col-note,.se-shell[data-bp="narrow"] .col-date{display:none}
.se-shell[data-bp="narrow"] .cmdbar .cmd{font-size:0;gap:0;padding:0 8px}
.se-shell[data-bp="narrow"] .cmdbar .cmd>span[data-i]{display:block}
.se-shell[data-bp="narrow"] .cmdbar .sep{margin:0 3px}
/* ── 图标视图 ──────────────────────────────────────────────────────────────
   横向排列，不是瀑布流：每一项是一张横放的小卡片（图标在左、文字在右），
   卡片按行从左到右铺开，窗口变窄时自动换行。此前的实现把卡片做成竖排，
   于是图标浮在文字上方、行高被撑开、顺序看起来是纵向的。 */
.se-shell[data-view="icons"] .listhead{display:none}
.se-shell[data-view="icons"] .listbody{display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;padding:10px 12px;align-content:flex-start;}
/* Each group is wrapped in its own <div>, so *that* wrapper is the flex
   container the cards must flow in. Without this rule the cards are block-level
   children of a block wrapper and stack vertically — which is exactly what the
   icon view used to look like. */
.se-shell[data-view="icons"] .listbody>div{display:flex;flex-direction:row;flex-wrap:wrap;gap:8px;flex:1 1 100%;min-width:0;align-content:flex-start}
/* A group caption is a full-width band that always starts a new row, so the
   cards inside it keep a left-to-right order instead of flowing around it. */
.se-shell[data-view="icons"] .grp{flex:0 0 100%;width:100%;position:static;margin:8px 0 0;background:transparent;backdrop-filter:none}
.se-shell[data-view="icons"] .grp+.row{margin-top:0}
.se-shell[data-view="icons"] .row{
  flex:0 0 232px;width:232px;height:auto;min-height:52px;
  /* A card is a column: a top line (icon + name) and the preview lines under
     it. The row stays left-aligned so the icon column lines up across cards. */
  flex-direction:column;align-items:stretch;justify-content:flex-start;
  padding:8px 10px;border:1px solid var(--sm-border-soft);border-radius:6px;gap:2px;
}
.se-shell[data-view="icons"] .row:hover{border-color:var(--sm-border)}
/* Every cell starts hidden: a card shows only the name line plus the preview
   rows re-enabled below. The .cell rule is more specific than .col-tags, so the
   preview rules have to come after it (they do). */
.se-shell[data-view="icons"] .row .cell{display:none}
.se-shell[data-view="icons"] .row .col-name{display:block;padding:0;flex:1 1 auto;width:auto;min-width:0}
/* The card carries a preview of the tags and the note: that is the point of a
   card view — you pick a session by glancing at it, not by scanning a column. */
.se-shell[data-view="icons"] .row .col-tags{display:flex;flex:0 0 auto;width:100%;padding:0;margin-top:2px;gap:3px;overflow:hidden}
.se-shell[data-view="icons"] .row .col-tags .tag{max-width:88px;margin-right:0}
.se-shell[data-view="icons"] .row .col-note{display:block;flex:0 0 auto;width:100%;padding:0;margin-top:2px;
  font-size:10.5px;line-height:1.3;color:var(--sm-text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.se-shell[data-view="icons"] .row .col-note:empty{display:none}
.se-shell[data-view="icons"] .row .col-date{display:none}
.se-shell[data-view="icons"] .row .namecell{flex-direction:row;align-items:center;flex-wrap:wrap;gap:6px;width:100%}
.se-shell[data-view="icons"] .row .namecell .ic{flex:0 0 24px;width:24px;height:24px}
.se-shell[data-view="icons"] .row .nm{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:12px;line-height:1.35;text-align:left}
/* The resize handles and the column header do not exist in this view, so the
   row must not keep the list's right padding for them. */
.se-shell[data-view="icons"] .row{padding-right:10px}
.se-shell[data-view="icons"] .row .col-check{display:none}
/* A container card has no tags and no note, so it collapses to just the name
   line instead of reserving empty preview rows. */
.se-shell[data-view="icons"] .row.frow{min-height:44px}
.se-shell[data-view="icons"] .row.frow .col-tags,.se-shell[data-view="icons"] .row.frow .col-note{display:none}
.se-shell[data-view="icons"] .row .col-fill{display:none}
.se-shell[data-view="icons"] .row .twist{margin-left:0}
.se-shell[data-view="icons"] .row .wstag,.se-shell[data-view="icons"] .row .subtag{margin-left:0}
.se-shell[data-view="icons"] .row.sel::before{display:none}
.se-shell[data-view="icons"] .row.sel{border-color:var(--sm-accent);background:color-mix(in oklab, var(--sm-accent) 12%, transparent)}
.se-shell ::-webkit-scrollbar-thumb{background:color-mix(in oklab, var(--sm-text) 22%, transparent); border:4px solid transparent;background-clip:content-box;border-radius:8px;}
.se-shell ::-webkit-scrollbar-thumb:hover{background:color-mix(in oklab, var(--sm-text) 34%, transparent);background-clip:content-box}
.se-shell ::-webkit-scrollbar-track{background:transparent}
.se-shell::-webkit-scrollbar,.se-shell *::-webkit-scrollbar{width:12px;height:12px}
.se-shell::-webkit-scrollbar-thumb,.se-shell *::-webkit-scrollbar-thumb{background:color-mix(in oklab,var(--sm-text) 22%,transparent);border:4px solid transparent;background-clip:content-box;border-radius:8px}
.se-shell::-webkit-scrollbar-thumb:hover,.se-shell *::-webkit-scrollbar-thumb:hover{background:color-mix(in oklab,var(--sm-text) 34%,transparent);background-clip:content-box}
.se-shell::-webkit-scrollbar-track,.se-shell *::-webkit-scrollbar-track{background:transparent}

/* ── subagent nesting (P1.5 addition) ───────────────────────────────────────
   A subagent session is a real session, but showing it flat next to its parent
   makes a delegation look like a sibling conversation. Rows indent one level
   and pick up a guide rail so the parent/child relation survives at a glance. */
.se-shell .row.sub-row{padding-left:14px}
.se-shell .row.sub-row::after{content:"";position:absolute;left:5px;top:4px;bottom:4px;width:1px;background:var(--sm-border);border-radius:1px}
.se-shell .row.sub-row .namecell .ic{opacity:.72}
.se-shell .row.sub-row .col-name{padding-left:0}
.se-shell .subtag{font-size:10px;line-height:1;padding:1px 4px;border-radius:3px;background:color-mix(in oklab,var(--sm-accent) 18%,transparent);color:var(--sm-accent);margin-left:5px;flex:0 0 auto}
.se-shell .row.child-hidden{display:none}
.se-shell .row .twist{width:14px;height:14px;flex:0 0 14px;margin-left:-4px;opacity:.55;cursor:pointer}
.se-shell .row .twist:hover{opacity:1}
.se-shell .detail-parent{display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer}
.se-shell .detail-parent:hover{color:var(--sm-text)}
.se-shell .detail-parent .nm{text-decoration:underline;text-underline-offset:2px}

/* ── P2 write affordances ──────────────────────────────────────────────── */
/* The tag panel shows how many sessions already carry each tag, so the same
   vocabulary gets reused instead of a dozen near-duplicate tags appearing. */
.se-shell .tagopt .tagcount{font-size:10px;opacity:.6;font-variant-numeric:tabular-nums}
/* A row or tree entry that accepts a drop lights up while dragging over it. */
.se-shell .row.drop{background:color-mix(in oklab, var(--sm-accent) 12%, transparent);outline:1px dashed color-mix(in oklab, var(--sm-accent) 60%, transparent);outline-offset:-2px}
.se-shell .row[draggable="true"]{cursor:default}
.se-shell .trow[draggable="true"] .lbl{cursor:grab}
.se-shell .note{width:100%;min-height:96px;resize:vertical;padding:8px 9px;border-radius:6px;
  border:1px solid var(--sm-border-soft);background:color-mix(in oklab, var(--sm-text) 3%, transparent);
  color:var(--sm-text);font:inherit;font-size:12.5px;line-height:1.5}
.se-shell .note::placeholder{color:var(--sm-text-3)}
.se-shell .note:focus{outline:none;border-color:color-mix(in oklab, var(--sm-accent) 55%, transparent)}
.se-shell .act.on{background:color-mix(in oklab, var(--sm-accent) 16%, transparent);color:var(--sm-accent)}

/* ── detail pane: inline rename + tag library (P3) ─────────────────────── */
/* The title row is the only place a name is edited (m01340); the pencil is
   dimmed until the header is hovered so it never competes with the title. */
.se-shell .det-title-row{display:flex;align-items:flex-start;gap:6px;min-width:0}
.se-shell .det-title-row .det-title{min-width:0}
.se-shell .det-title-edit{flex:0 0 18px;width:18px;height:18px;display:grid;place-items:center;margin-top:1px;
  border:0;border-radius:3px;background:transparent;color:var(--sm-text-3);cursor:pointer;opacity:.55;transition:opacity .12s}
.se-shell .det-head:hover .det-title-edit{opacity:1}
.se-shell .det-title-edit:hover{background:color-mix(in oklab,var(--sm-text) 12%,transparent);color:var(--sm-text)}
.se-shell .det-rename{width:100%;font:inherit;font-size:14px;font-weight:600;line-height:1.3;padding:2px 6px;border-radius:4px;
  background:color-mix(in oklab,var(--sm-text) 8%,transparent);border:1px solid var(--sm-accent);color:var(--sm-text);outline:none}
.se-shell .det-fork{display:flex;align-items:center;gap:5px;margin-top:4px;font-size:11px;color:var(--sm-text-3)}
.se-shell .det-link{cursor:pointer;color:var(--sm-accent);text-decoration:underline;text-underline-offset:2px}
.se-shell .det-link:hover{color:var(--sm-text)}
.se-shell .det-sep{color:var(--sm-text-3);margin:0 2px}
.se-shell .tagadd.on{border-style:solid;border-color:var(--sm-accent);color:var(--sm-accent)}
.se-shell .tagempty{flex:0 0 100%;font-size:11px;color:var(--sm-text-3);padding:2px 2px 4px}
.se-shell .taglib-del{display:grid;place-items:center;width:12px;height:12px;margin-left:1px;border-radius:50%;opacity:.45;cursor:pointer}
.se-shell .taglib-del:hover{opacity:1;background:color-mix(in oklab,var(--sm-danger) 26%,transparent);color:var(--sm-danger)}
.se-shell .tagnewrow{flex:0 0 100%;display:flex;align-items:center;gap:5px;margin-top:2px;padding-top:7px;
  border-top:1px dashed var(--sm-border-soft)}
.se-shell .tagnew{flex:1;min-width:0;font:inherit;font-size:11.5px;padding:4px 8px;border-radius:10px;
  background:color-mix(in oklab,var(--sm-text) 6%,transparent);border:1px solid var(--sm-border);color:var(--sm-text);outline:none}
.se-shell .tagnew:focus{border-color:var(--sm-accent)}
.se-shell .tagnew-go{flex:0 0 22px;width:22px;height:22px;display:grid;place-items:center;border-radius:50%;
  border:1px solid var(--sm-border);background:transparent;color:var(--sm-text-2);cursor:pointer}
.se-shell .tagnew-go:hover{border-color:var(--sm-accent);color:var(--sm-accent)}

/* ── overlay placement (must follow the ported sheet) ──────────────────── */
.se-shell{
  position: fixed;
  inset: 0;
  margin: auto;
  width: min(1120px, 92vw);
  height: min(720px, 86vh);
  z-index: 1050;
  pointer-events: auto;
}
.se-shell *{box-sizing: border-box;}
.se-shell[data-detail="off"] .pane-detail,
.se-shell[data-detail="off"] .rsz-detail{display:none}
.se-shell .rsz-detail{flex:0 0 4px;width:4px;cursor:col-resize;background:transparent;position:relative;z-index:3}
.se-shell .rsz-detail:hover{background:color-mix(in oklab, var(--sm-accent) 45%, transparent)}

/* sidebar entry — the only element that lives outside the shell, so it uses
   the host's tokens directly instead of the shell's --sm-* bridge. */
.se-footerBtn{
  display:flex;align-items:center;gap:8px;width:100%;
  padding:5px 8px;border:0;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary, #cfd3d6);
  font:inherit;font-size:12.5px;line-height:1.4;text-align:left;cursor:pointer;
}
.se-footerBtn:hover{
  background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08));
  color:var(--dsw-alias-label-primary, #f5f6f7);
}

/* ── row alignment / workspace emphasis (P1.5 fixes) ─────────────────────
   The prototype's .frow rule (gap:10px) also matched .row.frow and pushed the
   folder/workspace columns 10px right of every session row. Rows are a single
   flex grid, so gap must stay 0 and indentation lives on the name cell only. */
.se-shell .row.frow{gap:0}
.se-shell .row.sub-row{padding-left:0}
.se-shell .row.sub-row::after{left:calc(var(--indent,0px) + 5px)}
.se-shell .row.sub-row .namecell{padding-left:var(--indent,0px)}
/* Workspace rows are distinguished by colour alone: the icon and the label
   pick up the accent, the row keeps the same hover/selection surface as every
   other row so the list stays visually uniform. */
.se-shell .row.wsrow .nm{color:var(--sm-accent);font-weight:600}
.se-shell .row.wsrow .fl-ic .ic{color:var(--sm-accent)}
.se-shell .row.wsrow .wstag{background:color-mix(in oklab, var(--sm-accent) 18%, transparent);color:var(--sm-accent)}
/* A user folder is a container like a workspace, but it is the plugin's own
   node rather than a DSH record, so it keeps the neutral label colour and gets
   a muted type tag: two containers, two provenances, one row shape. */
.se-shell .row.folderrow .nm{font-weight:600}
.se-shell .row.folderrow .fl-ic .ic{color:var(--sm-text-2)}
.se-shell .row.folderrow .wstag.ftag{background:color-mix(in oklab, var(--sm-text) 10%, transparent);color:var(--sm-text-2)}
.se-shell .row.folderrow.sel .fl-ic .ic{color:var(--sm-text)}
/* 特殊文件夹 (根目录 / 未分组 / 收藏 / 待办) are fixed views, not the user's objects:
   they read as navigation, so they are dimmer than a real container and their
   type tag is a quiet outline rather than a filled chip. */
.se-shell .row.specialrow .nm{font-weight:500;color:var(--sm-text-2)}
.se-shell .row.specialrow .fl-ic .ic{color:var(--sm-text-3)}
.se-shell .row.specialrow.sel .nm{color:var(--sm-text)}
.se-shell .row.specialrow .wstag.stag{background:transparent;border:1px solid var(--sm-border);color:var(--sm-text-3)}

/* command bar split: the write commands may scroll, the view cluster must not */
/* ── command bar layout ────────────────────────────────────────────────────
   两个区域，一条实心分隔线：
     .cmdscroll 写操作，放不下时横向滚动
     .cmdfixed  排序/查看/更多/详细信息，永远钉在右边缘

   以前的实现让右区压在滚动区上（透明渐变背景 + 负向视觉叠加），滚动到最后
   一个按钮时图标被右区盖住一半。现在右区有不透明底色和独立边框，滚动区在它
   左侧结束，两者不可能重叠；按钮本身也不再被压缩（flex:0 0 auto）。 */
.se-shell .cmdbar{overflow:hidden;gap:0;padding:0 8px;align-items:center}
.se-shell .cmdscroll{
  display:flex;align-items:center;gap:2px;flex:1 1 auto;min-width:0;
  overflow-x:auto;overflow-y:hidden;scrollbar-width:none;
  /* keep the last button's focus ring / hover surface visible at the edge */
  padding:0 2px;scroll-padding-inline:2px;
}
.se-shell .cmdscroll::-webkit-scrollbar{display:none}
.se-shell .cmdfixed{
  display:flex;align-items:center;gap:2px;flex:0 0 auto;
  padding-left:8px;margin-left:8px;
  border-left:1px solid var(--sm-border-soft);
  /* Opaque, not a gradient: a translucent overlay is what let the scrolled
     buttons show through and look "covered". */
  background:color-mix(in oklab, var(--sm-tint) 96%, transparent);
  align-self:stretch;
}
.se-shell .cmdbar .cmd{flex:0 0 auto;min-width:0}
.se-shell .cmdbar .cmd .ic{flex:0 0 16px;width:16px;height:16px;display:grid;place-items:center}
.se-shell .cmdbar .cmd .ic svg{width:14px;height:14px}
.se-shell .cmdbar .cmd>span:not([data-i]){overflow:hidden;text-overflow:ellipsis}
.se-shell .cmdbar .cmsep{flex:0 0 1px;margin:0 4px}
.se-shell .cmd.on{background:color-mix(in oklab, var(--sm-accent) 14%, transparent);color:var(--sm-accent)}

.se-footerBtn-rail{justify-content:center;padding:5px 0}

/* A panel that failed to render must still leave the entry usable, so the
   message is a small inline card rather than a full-screen takeover. */
.se-crash{
  position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:1051;
  display:flex;flex-direction:column;gap:8px;width:min(420px,92vw);padding:14px 16px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
  background:var(--dsw-alias-bg-layer-1,#232324);color:var(--dsw-alias-label-primary,#f5f6f7);
  box-shadow:0 24px 64px rgba(0,0,0,.4);font-size:13px;
}
.se-crash .t{font-weight:600}
.se-crash .s{font-size:12px;color:var(--dsw-alias-label-tertiary,#979da6);word-break:break-word;max-height:120px;overflow:auto}
.se-crash .row-btns{display:flex;gap:8px;margin-top:2px}
.se-crash .act{height:28px;padding:0 12px;border-radius:5px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
  background:transparent;color:inherit;font:inherit;font-size:12px}
.se-crash .act:hover{background:color-mix(in oklab,currentColor 10%,transparent)}
.se-footerBtn-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* ── settings page ────────────────────────────────────────────────────────
   This page mounts inside the DSH settings window, not inside .se-shell, so
   it carries its own copy of the token bridge and none of the shell rules.
   Every colour still comes from a --dsw-alias-* token (hard constraint 8). */
.se-set{
  --sm-tint: var(--dsw-alias-bg-layer-1, #232324);
  --sm-text: var(--dsw-alias-label-primary, #f5f6f7);
  --sm-text-2: var(--dsw-alias-label-secondary, #cfd3d6);
  --sm-text-3: var(--dsw-alias-label-tertiary, #979da6);
  --sm-border: var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  --sm-border-soft: var(--dsw-alias-border-l1, rgba(255,255,255,.06));
  --sm-accent: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #4176e6));
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--sm-text);
}
.se-set-grp{border:1px solid var(--sm-border-soft);border-radius:8px;overflow:hidden;background:color-mix(in oklab, var(--sm-text) 2%, transparent)}
.se-set-h{padding:10px 14px;font-size:12.5px;font-weight:600;border-bottom:1px solid var(--sm-border-soft);background:color-mix(in oklab, var(--sm-text) 3%, transparent)}
.se-set-row{display:flex;align-items:center;gap:14px;padding:10px 14px;border-bottom:1px solid var(--sm-border-soft)}
.se-set-row:last-child{border-bottom:0}
.se-set-main{flex:1 1 auto;min-width:0}
.se-set-lbl{font-size:12.5px}
.se-set-hint{font-size:11.5px;color:var(--sm-text-3);margin-top:2px}
.se-set-choices{display:flex;gap:6px;flex:0 0 auto}
.se-set-chip{height:26px;padding:0 10px;border-radius:5px;border:1px solid var(--sm-border);background:transparent;color:var(--sm-text-2);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.se-set-chip:hover:not(:disabled){background:color-mix(in oklab, var(--sm-text) 8%, transparent);color:var(--sm-text)}
.se-set-chip.on{background:color-mix(in oklab, var(--sm-accent) 16%, transparent);border-color:color-mix(in oklab, var(--sm-accent) 42%, transparent);color:var(--sm-accent)}
.se-set-chip:disabled{opacity:.4;cursor:default}
.se-set-range{width:170px;flex:0 0 auto;accent-color:var(--sm-accent)}
.se-set-val{width:44px;flex:0 0 auto;text-align:right;font-variant-numeric:tabular-nums;color:var(--sm-text-2)}
.se-set-switch{width:34px;height:20px;flex:0 0 auto;border-radius:10px;border:1px solid var(--sm-border);background:color-mix(in oklab, var(--sm-text) 10%, transparent);position:relative;cursor:pointer;transition:background .15s}
.se-set-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--sm-text-2);transition:transform .15s,background .15s}
.se-set-switch.on{background:color-mix(in oklab, var(--sm-accent) 55%, transparent)}
.se-set-switch.on::after{transform:translateX(14px);background:#fff}
.se-set-switch:disabled{opacity:.4;cursor:default}
.se-set-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--sm-text-2);word-break:break-all}
.se-set-note{font-size:12px;color:var(--sm-text-3)}
.se-set-err{font-size:12px;color:var(--sm-danger, var(--dsw-alias-state-error-primary, #f25a5a))}
.se-set-foot{display:flex;align-items:center;gap:10px;min-height:18px}
`;

    // ── Style installation ─────────────────────────────────────────────────
    function installStyle() {
      if (typeof document === "undefined") return;
      let element = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`);
      if (!element) {
        element = document.createElement("style");
        element.setAttribute("data-plugin-css", CSS_ID);
        document.head.appendChild(element);
      }
      if (element.textContent !== CSS) element.textContent = CSS;
    }

    // ── HTTP ───────────────────────────────────────────────────────────────
    async function apiGet(path, init) {
      const response = await fetch(API + path, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        ...init,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!payload || payload.ok !== true) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      return payload.result;
    }

    /**
     * A mutating request. The envelope is unwrapped the same way, but a failure
     * carries the host's error code, so the panel can tell "conflict, reload"
     * apart from "bad input, tell the user".
     */
    async function apiSend(method, path, body) {
      const response = await fetch(API + path, {
        method,
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!payload || payload.ok !== true) {
        const error = new Error(payload?.error ?? `HTTP ${response.status}`);
        error.code = payload?.code ?? "bad-request";
        throw error;
      }
      return payload.result;
    }

    // ── Formatting ─────────────────────────────────────────────────────────
    const RELATIVE = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
    const DATE_SHORT = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const DATE_FULL = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const NUMBER = new Intl.NumberFormat("zh-CN");

    function padTwo(value) {
      return String(value).padStart(2, "0");
    }

    /** `1.2 MB` — empty string when the size is unknown (cache-only rows). */
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return "";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
    }

    /** `10-18 06:55`, or `2025-10-18 06:55` outside the current year. */
    function formatDate(epochMs, now) {
      if (!Number.isFinite(epochMs) || epochMs <= 0) return "";
      const date = new Date(epochMs);
      const sameYear = new Date(now).getFullYear() === date.getFullYear();
      const text = sameYear ? DATE_SHORT.format(date) : DATE_FULL.format(date);
      return text.replace(/\//g, "-");
    }

    function formatRelative(epochMs, now) {
      if (!Number.isFinite(epochMs) || epochMs <= 0) return "";
      const delta = epochMs - now;
      const minutes = Math.round(delta / 60000);
      if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
      const hours = Math.round(minutes / 60);
      if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
      const days = Math.round(hours / 24);
      if (Math.abs(days) < 30) return RELATIVE.format(days, "day");
      return DATE_FULL.format(new Date(epochMs)).replace(/\//g, "-");
    }

    function formatCount(value) {
      return Number.isFinite(value) ? NUMBER.format(value) : "0";
    }

    function formatCompact(value) {
      if (!Number.isFinite(value) || value <= 0) return "—";
      if (value < 1000) return String(value);
      if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
      return `${(value / 1_000_000).toFixed(1)}M`;
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      if (ms < 1000) return `${Math.round(ms)} ms`;
      if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
      const minutes = Math.floor(ms / 60_000);
      const seconds = Math.round((ms % 60_000) / 1000);
      return `${minutes}m ${padTwo(seconds)}s`;
    }

    // ── Icons ──────────────────────────────────────────────────────────────
    // Lifted verbatim from the prototype's icon table: 16x16, 1.3px stroke,
    // round caps. Markup is static local data, never user input.
    const ICONS = {
      back: '<path d="M10 3L5 8l5 5"/>',
      fwd: '<path d="M6 3l5 5-5 5"/>',
      up: '<path d="M8 12.5V4M4 7.5l4-4 4 4"/>',
      refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.6V5.4h-2.8"/>',
      search: '<circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4L13.6 13.6"/>',
      home: '<path d="M2.5 7.6L8 3l5.5 4.6V13h-4v-3h-3v3h-4z"/>',
      star: '<path d="M8 2.4l1.75 3.55 3.85.56-2.8 2.72.66 3.83L8 11.2l-3.46 1.86.66-3.83L2.4 6.51l3.85-.56z"/>',
      todo: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M5.2 8l1.8 1.8 3.8-3.8"/>',
      folder: '<path d="M2 4.4h4l1.2 1.6H14V13H2z"/>',
      folderplus: '<path d="M2 4.4h4l1.2 1.6H14V13H2z"/><path d="M8 7.6v3.2M6.4 9.2h3.2"/>',
      monitor: '<rect x="2" y="3.4" width="12" height="7.2" rx="1"/><path d="M6 13h4M8 10.6V13"/>',
      chat: '<path d="M2.6 3.6h10.8v6.9H7.1L4.2 13v-2.5H2.6z"/>',
      trash: '<path d="M3 4.6h10M6.5 4.6V2.9h3v1.7M4.6 4.6l.7 8.9h5.4l.7-8.9"/>',
      archive: '<rect x="2.5" y="3.4" width="11" height="2.8" rx=".6"/><path d="M3.6 6.2V13h8.8V6.2M6.4 8.6h3.2"/>',
      restore: '<path d="M8 3.6a4.6 4.6 0 1 1-4.4 6.2M3 3.9v3.2h3.2"/>',
      pin: '<path d="M6.1 2.6h3.8l-.4 3.9 2 1.9v1H4.5v-1l2-1.9zM8 9.4V13.4"/>',
      plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
      pencil: '<path d="M11.2 2.6l2.2 2.2-7.6 7.6-3 .8.8-3z"/>',
      cut: '<circle cx="4.4" cy="11.6" r="1.9"/><circle cx="11.6" cy="11.6" r="1.9"/><path d="M5.7 10.3L11 2.8M10.3 10.3L5 2.8"/>',
      copy: '<rect x="5.4" y="5.4" width="8" height="8" rx="1"/><path d="M10.6 5.4V3.2a.6.6 0 0 0-.6-.6H3.2a.6.6 0 0 0-.6.6v6.8c0 .33.27.6.6.6h2.2"/>',
      paste: '<rect x="3.4" y="3.4" width="9.2" height="10.2" rx="1"/><path d="M6.2 3.4V2.4h3.6v1"/><path d="M6 7.4h4M6 10h4"/>',
      sort: '<path d="M4.4 3v10M2.4 11l2 2 2-2M11.6 13V3M9.6 5l2-2 2 2"/>',
      grid: '<rect x="2.4" y="2.4" width="4.6" height="4.6" rx=".6"/><rect x="9" y="2.4" width="4.6" height="4.6" rx=".6"/><rect x="2.4" y="9" width="4.6" height="4.6" rx=".6"/><rect x="9" y="9" width="4.6" height="4.6" rx=".6"/>',
      list: '<path d="M3 4h10M3 8h10M3 12h10"/>',
      details: '<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1"/><path d="M9.6 3.4v9.2"/>',
      more: '<circle cx="3.6" cy="8" r="1.05" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.05" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8" r="1.05" fill="currentColor" stroke="none"/>',
      check: '<path d="M3.2 8.4l3.1 3.1 6.5-6.6"/>',
      x: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
      minus: '<path d="M4 8h8"/>',
      square: '<rect x="3.6" y="3.6" width="8.8" height="8.8" rx=".8"/>',
      window: '<rect x="2" y="3.4" width="12" height="9.2" rx="1"/><path d="M2 6.2h12"/>',
      chevdown: '<path d="M4.5 6.2L8 9.7l3.5-3.5"/>',
      chevright: '<path d="M6.2 4.5L9.7 8l-3.5 3.5"/>',
      external: '<path d="M9.2 3h3.8v3.8M13 3L7.6 8.4"/><path d="M11.4 9.6V13H3V4.6h3.4"/>',
      tag: '<path d="M2.6 8.2V3.2h5l5.8 5.8-5 5z"/><circle cx="5.2" cy="5.6" r=".9"/>',
      save: '<path d="M3 3h8l2 2v8H3z"/><path d="M5.5 3v3.5h4V3M5.5 10.5h5"/>',
      settings: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.7M8 12.4v1.7M14.1 8h-1.7M3.6 8H1.9M12.3 3.7l-1.2 1.2M4.9 11.1l-1.2 1.2M12.3 12.3l-1.2-1.2M4.9 4.9L3.7 3.7"/>',
      // 分叉 is not 复制: a copy is a second identical file, a fork is a branch
      // that continues from a point. The git-branch glyph says that in one
      // glance, where reusing the copy icon made the two commands look alike.
      branch: '<circle cx="4.6" cy="3.6" r="1.5"/><circle cx="4.6" cy="12.4" r="1.5"/><circle cx="11.4" cy="6.2" r="1.5"/><path d="M4.6 5.1v5.8M11.4 7.7c0 2.3-1.9 3.3-3.6 3.9"/>',
    };

    function Icon({ name, size = 16, className }) {
      const markup = ICONS[name];
      if (!markup) return null;
      return h("svg", {
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.3,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        "aria-hidden": "true",
        dangerouslySetInnerHTML: { __html: markup },
      });
    }

    // ── Fixed-node presentation ────────────────────────────────────────────
    // The host names its fixed nodes for the API; the window chrome labels them
    // the way the prototype does, because these five entries are the app's own
    // navigation, not data.
    const FIXED_META = {
      [FIXED.root]: { label: "根目录", icon: "folder", tone: "default" },
      [FIXED.ungrouped]: { label: "未分组", icon: "chat", tone: "default" },
      [FIXED.trash]: { label: "回收站", icon: "trash", tone: "default" },
      [FIXED.todos]: { label: "待办", icon: "todo", tone: "default" },
      [FIXED.favorites]: { label: "收藏", icon: "star", tone: "default" },
    };

    /**
     * Kinds that are *views* rather than containers: 未分组 / 待办 / 收藏 / 回收站
     * mirror a set of sessions and must never be listed as if they were
     * directories (they sit in the fixed rail instead).
     *
     * Module scope, not a local in TreePane: the list pane filters containers
     * with the same rule, and a second copy of the set is a second thing to
     * forget to update.
     */
    const VIEW_KINDS = new Set(["ungrouped", "todos", "favorites", "trash"]);

    /** Icon per node `kind`, mirroring the prototype's tree glyphs. */
    const KIND_ICON = {
      root: "folder",
      "default-workspace": "home",
      workspace: "monitor",
      ungrouped: "chat",
      favorites: "star",
      todos: "todo",
      trash: "trash",
    };

    /**
     * What a node shows, derived from the tree the host built.
     *
     * The prototype's root is a real folder: every live session hangs somewhere
     * under it, 收藏/待办 are shortcuts to sessions that still live in their
     * workspace, and only 回收站 sits outside. So the root counts every live
     * session while the fixed shortcut nodes count their own membership without
     * ever double-counting a container.
     */
    function nodeSessions(node, sessions, tree) {
      if (!node) return [];
      if (node.id === FIXED.trash) return sessions.filter((session) => session.trashed);
      const live = sessions.filter((session) => !session.trashed);
      if (node.id === FIXED.favorites) return live.filter((session) => session.favorite);
      if (node.id === FIXED.todos) return live.filter((session) => session.todo);
      if (node.kind === "ungrouped") return live.filter((session) => !session.workspaceId);
      if (node.workspaceId) return live.filter((session) => session.workspaceId === node.workspaceId);
      if (node.id === FIXED.root) return live;
      return live;
    }

    /** Node id → icon name, so the tree and breadcrumbs agree. */
    function iconOfNode(node) {
      if (!node) return "folder";
      return KIND_ICON[node.kind] ?? (node.type === "workspace" ? "monitor" : "folder");
    }

    const COLUMNS = {
      name: { label: "名称", cls: "col-name" },
      tags: { label: "标签", cls: "col-tags" },
      note: { label: "备注", cls: "col-note" },
      updated: { label: "上次对话", cls: "col-date" },
      size: { label: "大小", cls: "col-size" },
      status: { label: "状态", cls: "col-status" },
    };
    const COL_ORDER = ["name", "tags", "note", "updated", "size", "status"];

    /**
     * CSS size for the panel, mirroring `modalSizeOf` in lib/domain/settings.js.
     *
     * The client cannot import a host module (the bundle is a single file with
     * no build step), so the two implementations are kept in step by the test
     * suite rather than by a shared import. Keeping the numbers here instead of
     * only in CSS is what lets the native Modal frame receive an exact size.
     *
     * @param {{ sizing?: string, size?: string, percent?: string } | null} modal
     * @returns {{ width: string, height: string }}
     */
    function frameSizeOf(modal) {
      const FIXED = { sm: [860, 560], md: [1100, 720], lg: [1320, 820], xl: [1600, 960] };
      const SHARE = { p50: 50, p70: 70, p85: 85, p100: 100 };
      if (modal?.sizing === "percent") {
        const share = SHARE[modal?.percent] ?? SHARE.p70;
        return { width: `${share}vw`, height: `${share}vh` };
      }
      const [width, height] = FIXED[modal?.size] ?? FIXED.md;
      return { width: `min(${width}px, 94vw)`, height: `min(${height}px, 90vh)` };
    }

    function statusOf(session) {
      // A trashed session cannot be running: its process was stopped before the
      // payload moved. Saying 空闲 would imply it is ready to open.
      if (session.trashed) return { cls: "", text: "已删除" };
      if (session.running) return { cls: "run", text: "运行中" };
      if (session.formatVersion && session.formatVersion !== 4) return { cls: "err", text: "异常" };
      return { cls: "", text: "空闲" };
    }

    /**
     * The three sortable fields, in the order the menu lists them.
     *
     * Only these are sortable. Tags and notes are free text with no natural
     * order, and status is a three-valued label that users read as a filter
     * rather than a sort — offering them produced headers that did nothing.
     */
    const SORT_FIELDS = Object.freeze([
      { key: "name", label: "名称" },
      { key: "updated", label: "会话日期" },
      { key: "size", label: "大小" },
    ]);

    /** Default direction per field: names read A→Z, dates and sizes newest/biggest first. */
    const SORT_DEFAULT_DIR = Object.freeze({ name: "asc", updated: "desc", size: "desc" });

    function sortValue(session, key) {
      if (key === "name") return session.displayTitle ?? "";
      if (key === "updated") return session.activityAt ?? 0;
      if (key === "size") return session.sizeBytes ?? 0;
      return 0;
    }

    function compareBy(key, dir) {
      return (a, b) => {
        const left = sortValue(a, key);
        const right = sortValue(b, key);
        let result;
        if (typeof left === "string" || typeof right === "string") {
          result = String(left).localeCompare(String(right), "zh-CN");
        } else {
          result = left - right;
        }
        // A stable tiebreak keeps equal rows from swapping on every re-render.
        if (result === 0) result = String(a.id).localeCompare(String(b.id));
        return result * dir;
      };
    }

    // ── Small building blocks ──────────────────────────────────────────────
    function Btn({ className, title, onClick, disabled, children, icon, iconOnly }) {
      return h(
        "button",
        {
          type: "button",
          className: className + (iconOnly ? " icon-only" : ""),
          title,
          disabled: disabled === true,
          onClick,
        },
        icon ? h("span", { className: "ic", "data-i": icon }, h(Icon, { name: icon })) : null,
        iconOnly ? null : h("span", null, children),
      );
    }

    /**
     * Inline editor for a row's name (m02120).
     *
     * The row keeps its geometry and swaps only the label for an input, so a
     * rename never opens a dialog and never moves the list under the pointer.
     * Enter commits, Escape cancels, and leaving the field commits — the same
     * contract Explorer uses. `done` guards the commit against running twice:
     * committing unmounts the input, and the unmount fires `blur` in some
     * browsers right after Enter already committed.
     */
    function RenameInput({ className, value, onChange, onCommit, onCancel }) {
      const ref = useRef(null);
      const done = useRef(false);
      useEffect(() => {
        const element = ref.current;
        if (!element) return;
        element.focus();
        if (typeof element.select === "function") element.select();
      }, []);
      const finish = (run) => {
        if (done.current) return;
        done.current = true;
        run();
      };
      return h("input", {
        ref,
        className,
        value,
        spellCheck: false,
        autoComplete: "off",
        onClick: (event) => event.stopPropagation(),
        onMouseDown: (event) => event.stopPropagation(),
        onDoubleClick: (event) => event.stopPropagation(),
        onChange: (event) => onChange(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            finish(onCommit);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(onCancel);
          }
        },
        onBlur: () => finish(onCommit),
      });
    }

    function Trow({ scope, icon, label, count, active, tone, depth = 0, hasKids = false, expanded = false, onToggle, onSelect, draggable, onDragStart, onDrop, onDropNode, canDropNode, dropActive, rename, onBeginRename, onContextMenu }) {
      // Native drag feedback: "ok" paints the accent drop outline, "bad" greys
      // the row and refuses the drop. The browser has no notion of our tree
      // rules, so the row has to say "this target is illegal" itself — that is
      // what makes an impossible move visible *before* the pointer is released.
      const [dropState, setDropState] = useState(null);
      const acceptsDrag = typeof onDrop === "function" || typeof onDropNode === "function";
      return h(
        "div",
        {
          className:
            "trow" +
            (tone === "ws" ? " ws" : "") +
            (active ? " sel" : "") +
            (dropState === "ok" || dropActive ? " drop" : "") +
            (dropState === "bad" ? " bad" : ""),
          "data-scope": scope,
          "data-drop": dropState ?? undefined,
          style: { paddingLeft: 6 + depth * 14 },
          // A row that is being renamed must not start a drag: the pointer is
          // in the input, and a stray drag would move the very node the user
          // is renaming.
          draggable: draggable === true && !rename,
          onDragStart: draggable && !rename ? onDragStart : undefined,
          onDragEnd: () => {
            // The drag source owns the shared payload; clearing it here covers
            // both "dropped" and "aborted" without a window-level listener.
            setDropState(null);
            dragPayload = null;
          },
          onDragOver: acceptsDrag
            ? (event) => {
                // Two payloads arrive here: a bare tree node id ("text/plain")
                // from a container drag, and the JSON id list on
                // SESSION_DRAG_TYPE from a session drag. The validator decides
                // per payload; anything it refuses is a greyed "no drop".
                const types = Array.from(event.dataTransfer?.types ?? []);
                const sessionDrag = types.includes(SESSION_DRAG_TYPE);
                if (!sessionDrag && !types.includes("text/plain")) return;
                // Reading data during dragover is forbidden for custom types in
                // most browsers, so the source id comes from the shared drag
                // state the row set when the drag began.
                const verdict = canDropNode ? canDropNode(scope, sessionDrag ? "session" : "node") : true;
                if (verdict) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (dropState !== "ok") setDropState("ok");
                } else {
                  // Refusing the default is what makes the browser show 🚫 and
                  // the row grey out instead of pretending the drop will work.
                  event.dataTransfer.dropEffect = "none";
                  if (dropState !== "bad") setDropState("bad");
                }
              }
            : undefined,
          onDragLeave: acceptsDrag ? () => setDropState(null) : undefined,
          onDrop: acceptsDrag
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                setDropState(null);
                const types = Array.from(event.dataTransfer?.types ?? []);
                const sessionDrag = types.includes(SESSION_DRAG_TYPE);
                const verdict = canDropNode ? canDropNode(scope, sessionDrag ? "session" : "node") : true;
                if (!verdict) return;
                if (sessionDrag && typeof onDrop === "function") onDrop(scope, event);
                else if (typeof onDropNode === "function") onDropNode(scope, event);
              }
            : undefined,
          onClick: (event) => {
            event.stopPropagation();
            if (!rename) onSelect(scope);
          },
          // A double click on a tree row enters it, the same as a single click:
          // without this the browser selected the label text instead, which is
          // what "双击打不开工作区" looked like.
          onDoubleClick: (event) => {
            event.stopPropagation();
            if (!rename) onSelect(scope);
          },
          onContextMenu,
        },
        h(
          "span",
          {
            className: "caret" + (hasKids ? "" : " hidden"),
            onClick: (event) => {
              if (!hasKids) return;
              event.stopPropagation();
              onToggle(scope);
            },
          },
          hasKids ? h(Icon, { name: expanded ? "chevdown" : "chevright", size: 14 }) : null,
        ),
        h("span", { className: "ic" }, h(Icon, { name: icon, size: 14 })),
        rename
          ? h(RenameInput, {
              className: "lbl-edit",
              value: rename.value,
              onChange: rename.onChange,
              onCommit: rename.onCommit,
              onCancel: rename.onCancel,
            })
          : h("span", { className: "lbl" }, label),
        // Same affordance as a list row: the pencil appears on hover/selection
        // only, so the tree does not sprout a control on every line.
        !rename && onBeginRename
          ? h(
              "span",
              {
                className: "nm-editbtn",
                title: "重命名",
                onClick: (event) => {
                  event.stopPropagation();
                  onBeginRename();
                },
              },
              h(Icon, { name: "pencil", size: 10 }),
            )
          : null,
        Number.isFinite(count) ? h("span", { className: "cnt" }, formatCount(count)) : null,
      );
    }

    function Empty({ icon, title, hint }) {
      return h(
        "div",
        { className: "empty" },
        h("div", { className: "big" }, h(Icon, { name: icon, size: 34 })),
        h("div", { className: "t" }, title),
        hint ? h("div", { className: "s" }, hint) : null,
      );
    }

    // ── Tree pane ──────────────────────────────────────────────────────────
    function TreePane({ tree, scope, onSelect, expanded, onToggle, width, onMove, onDropSessions, rename, onBeginRename, onNodeContextMenu }) {
      const counts = tree?.counts ?? {};
      const nodes = tree?.nodes ?? {};
      const children = tree?.children ?? {};

      // Three groups, exactly as the prototype renders them:
      //
      //   1. 固定入口 — 默认工作区, 未分组, 回收站, 待办, 收藏 (always visible)
      //   2. 快速访问 — user-pinned entries (P2 fills it; hidden while empty)
      //   3. 目录     — the real hierarchy, 根目录 first
      //
      // The fixed band and 目录 are NOT duplicates: the band is a shortcut rail
      // that stays reachable from anywhere, while 目录 shows where things really
      // live. 根目录 keeps its own children (默认工作区 included) so the folder
      // metaphor holds when it is expanded.
      const rows = [];
      const trashCount = counts[FIXED.trash] ?? 0;
      // 默认工作区 is the real default-workspace workspace (a child of 根目录),
      // not an alias for the root: the root has its own row under 目录.
      const defaultNode = Object.values(nodes).find((node) => node.kind === "default-workspace") ?? null;
      const fixedEntries = [
        { id: defaultNode?.id ?? FIXED.root, icon: "home", label: "默认工作区", count: defaultNode ? counts[defaultNode.id] ?? 0 : counts[FIXED.root] ?? 0 },
        { id: FIXED.ungrouped, icon: "chat", label: "未分组", count: counts[FIXED.ungrouped] ?? 0 },
        { id: FIXED.trash, icon: "trash", label: "回收站", count: trashCount },
        { id: FIXED.todos, icon: "todo", label: "待办", count: counts[FIXED.todos] ?? 0 },
        { id: FIXED.favorites, icon: "star", label: "收藏", count: counts[FIXED.favorites] ?? 0 },
      ];

      for (const entry of fixedEntries) {
        rows.push(
          h(Trow, {
            key: "fixed-" + entry.id,
            scope: entry.id,
            icon: entry.icon,
            label: entry.label,
            count: entry.count,
            active: scope === entry.id,
            onSelect,
          }),
        );
      }

      // 快速访问 — no pinned entries exist before P2, so the caption is omitted
      // rather than shown empty (the prototype does the same).
      const quickAccess = tree?.quickAccess ?? [];
      if (quickAccess.length > 0) {
        rows.push(h("div", { key: "sep-quick", className: "tsep" }));
        rows.push(h("div", { key: "cap-quick", className: "tcap" }, "快速访问"));
        for (const entry of quickAccess) {
          const node = nodes[entry.id];
          if (!node) continue;
          rows.push(
            h(Trow, {
              key: "quick-" + entry.id,
              scope: entry.id,
              icon: iconOfNode(node),
              label: node.name ?? node.path ?? entry.id,
              count: counts[entry.id] ?? 0,
              active: scope === entry.id,
              tone: node.type === "workspace" ? "ws" : "default",
              onSelect,
            }),
          );
        }
      }

      rows.push(h("div", { key: "sep-dir", className: "tsep" }));
      rows.push(h("div", { key: "cap-dir", className: "tcap" }, "目录"));

      const walk = (id, depth) => {
        const node = nodes[id];
        if (!node) return;
        // 未分组/待办/收藏 are views, not directories: listing them under
        // 根目录 would repeat the rail above and show sessions twice.
        const kids = (children[id] ?? [])
          .map((child) => nodes[child])
          .filter((child) => child && !VIEW_KINDS.has(child.kind))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const isOpen = expanded.has(id);
        // A workspace row renames the *native* workspace record, a folder row
        // renames the sidecar node: the two id spaces never mix.
        const renameKind = node.type === "workspace" ? "workspace" : "folder";
        const effectiveId = node.type === "workspace" ? node.workspaceId ?? id : id;
        // Every real container is a drop target; the validator decides whether
        // *this* payload may land here, so an illegal target greys out instead
        // of silently accepting and failing at the host.
        const acceptsDrop = node.id === FIXED.root || node.type === "folder" || node.type === "workspace";
        rows.push(
          h(Trow, {
            key: "dir-" + id,
            scope: id,
            icon: iconOfNode(node),
            label: node.id === FIXED.root ? "根目录" : node.name ?? node.path ?? id,
            count: counts[id] ?? 0,
            active: scope === id,
            tone: node.type === "workspace" ? "ws" : "default",
            depth,
            hasKids: kids.length > 0,
            expanded: isOpen,
            onToggle,
            onSelect,
            rename:
              rename && rename.id === effectiveId && rename.kind === renameKind ? rename : null,
            // Fixed containers (根目录/收藏/待办/未分组/回收站) are not the user's
            // to rename, so they get no editor at all. A workspace is addressed
            // by its native workspaceId — handing the tree id (w-<uuid>) to the
            // folder route would rename nothing and answer bad-request instead.
            // 默认工作区 is a real workspace whose label is synthetic (the host
            // always calls it 默认工作区), so editing it would be a no-op round
            // trip; every other workspace is fair game.
            // Fixed containers get no context menu: every item on it would be
            // disabled, which is worse than not offering one.
            onContextMenu:
              onNodeContextMenu && !node.fixed
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelect(id);
                    onNodeContextMenu(event, { kind: renameKind, id: effectiveId, nodeId: id, node });
                  }
                : undefined,
            onBeginRename:
              onBeginRename && !node.fixed && node.kind !== "default-workspace"
                ? () => onBeginRename(renameKind, effectiveId)
                : undefined,
            draggable: node.type === "folder" ? !node.fixed : true,
            onDragStart: (event) => {
              dragPayload = { kind: "node", id };
              event.dataTransfer.setData("text/plain", id);
              event.dataTransfer.effectAllowed = "move";
            },
            // Every container is offered as a target; `canDropNode` below
            // decides whether this row greys out for the payload in flight.
            onDropNode: acceptsDrop
              ? (targetId) => {
                  const source = dragPayload?.kind === "node" ? dragPayload.id : null;
                  if (!source || source === targetId) return;
                  if (!canDropInTree(source, targetId, nodes, children)) {
                    setHint("这里放不下：工作区不能放进工作区，含工作区的文件夹也不能再放一个工作区");
                    return;
                  }
                  onMove(source, targetId);
                }
              : undefined,
            // Dropping *sessions* on a tree row moves them into that workspace.
            // Only a workspace accepts them, which the validator above reports
            // so every other row greys out while a session is in flight.
            onDrop:
              acceptsDrop && onDropSessions
                ? (targetId, event) => {
                    const ids = parseDragIds(event.dataTransfer.getData(SESSION_DRAG_TYPE));
                    const workspaceId = nodes[targetId]?.workspaceId;
                    if (ids.length > 0 && workspaceId) onDropSessions(ids, workspaceId, event.ctrlKey || event.metaKey);
                  }
                : undefined,
            canDropNode: acceptsDrop
              ? (targetId, draggedKind) => {
                  if (draggedKind === "session") return nodes[targetId]?.type === "workspace";
                  const source = dragPayload?.kind === "node" ? dragPayload.id : null;
                  return Boolean(source) && canDropInTree(source, targetId, nodes, children);
                }
              : undefined,
          }),
        );
        if (isOpen) for (const child of kids) walk(child.id, depth + 1);
      };

      // 目录 starts at 根目录 only: 回收站 is the one node outside the root and
      // the fixed band already offers a direct entry to it.
      walk(FIXED.root, 0);

      return h("aside", { className: "pane-tree", id: "se-tree", style: { flexBasis: width + "px", width: width + "px" } }, rows);
    }

    // ── Breadcrumbs ────────────────────────────────────────────────────────
    function crumbsFor(tree, scope) {
      const nodes = tree?.nodes ?? {};
      const trail = [];
      let current = nodes[scope];
      const guard = new Set();
      while (current && !guard.has(current.id)) {
        guard.add(current.id);
        const meta = FIXED_META[current.id];
        trail.unshift({
          id: current.id,
          label: current.id === FIXED.root ? "根目录" : meta?.label ?? current.name ?? current.path ?? current.id,
          icon: meta?.icon ?? iconOfNode(current),
        });
        current = current.parent ? nodes[current.parent] : null;
      }
      if (trail.length === 0) trail.push({ id: FIXED.root, label: "根目录", icon: "folder" });
      return trail;
    }

    // ── Row renderers ──────────────────────────────────────────────────────

    /**
     * The drag channel for session rows.
     *
     * A node drag (tree → tree) already uses "text/plain" with a bare node id.
     * Session drags carry a prefixed, JSON payload on a private type instead, so
     * the two gestures can never be mistaken for one another — dropping a
     * folder onto a workspace is a *virtual* move, dropping sessions is a real
     * file move, and the difference is not recoverable from a bare id.
     */
    const SESSION_DRAG_TYPE = "application/x-dsh-session-ids";

    /**
     * The node currently being dragged, as a module-level value.
     *
     * `dataTransfer.getData` returns nothing during `dragover` for custom
     * types (browsers only expose the type list until the drop), so a drop
     * target cannot learn *what* it would receive in time to grey itself out.
     * The drag source therefore records its payload here when the drag starts
     * and clears it when it ends; the target reads this instead of the
     * DataTransfer.
     */
    let dragPayload = null;

    /**
     * The client mirror of `canMove` in lib/domain/tree.js.
     *
     * Kept as a separate copy on purpose: the host is the authority (it
     * re-validates every write), but a drop target must answer *before* a
     * network round trip, and blocking a drag on a fetch would make the UI feel
     * broken. The two are pinned together by test/tree.test.mjs plus the
     * mirror cases in test/move.test.mjs, so a rule cannot change in one place
     * only.
     *
     * @param {string} nodeId the node being dragged
     * @param {string} parentId the row it would land on
     * @param {Record<string, any>} nodes
     * @param {Record<string, string[]>} children
     * @returns {boolean}
     */
    function canDropInTree(nodeId, parentId, nodes, children) {
      const node = nodes[nodeId];
      const parent = nodes[parentId];
      if (!node || !parent) return false;
      if (node.fixed) return false;
      if (parent.fixed && parentId !== FIXED.root) return false;

      // The one structural rule: a workspace may not nest inside a workspace.
      // "Inside" is transitive, so the target's ancestor chain decides — and the
      // dragged subtree is checked too, because a folder carrying a workspace
      // would introduce the same nesting.
      const underWorkspace = (() => {
        const seen = new Set();
        let cursor = parentId;
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor);
          if (nodes[cursor]?.type === "workspace") return true;
          cursor = nodes[cursor]?.parent ?? null;
        }
        return false;
      })();
      if (underWorkspace && containsWorkspace(nodeId, nodes, children)) return false;

      // A node may never land inside its own subtree.
      const seen = new Set();
      const stack = [nodeId];
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === parentId) return false;
        if (!current || seen.has(current)) continue;
        seen.add(current);
        for (const child of children[current] ?? []) stack.push(child);
      }
      return true;
    }

    /**
     * @param {string} start
     * @param {Record<string, any>} nodes
     * @param {Record<string, string[]>} children
     * @returns {boolean} whether the subtree rooted at `start` holds a workspace
     */
    function containsWorkspace(start, nodes, children) {
      const seen = new Set();
      const stack = [start];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        if (nodes[current]?.type === "workspace") return true;
        for (const child of children[current] ?? []) stack.push(child);
      }
      return false;
    }

    /**
     * @param {string} raw
     * @returns {string[]}
     */
    function parseDragIds(raw) {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
      } catch {
        return [];
      }
    }

    /**
     * Flatten the session list into parent/child rows.
     *
     * A subagent session is a real session with `parentSession` set, but showing
     * it as a sibling of its parent makes one delegation read like two
     * conversations. Children therefore follow their parent, indented, and the
     * parent gains a disclosure caret. Orphans (a parent that is filtered out or
     * missing) stay at depth 0 so nothing can disappear from the list.
     */
    function nestSessions(sessions, collapsed) {
      const byId = new Map(sessions.map((session) => [session.id, session]));
      /** @type {Map<string, object[]>} */
      const kids = new Map();
      const roots = [];
      for (const session of sessions) {
        // Only real subagents nest. A fork also carries parentSession, but it is
        // an independent conversation and must stay a sibling of its source.
        const parentId = session.isSubagent ? session.parentSession : null;
        if (parentId && parentId !== session.id && byId.has(parentId)) {
          const bucket = kids.get(parentId);
          if (bucket) bucket.push(session);
          else kids.set(parentId, [session]);
        } else {
          roots.push(session);
        }
      }

      const rows = [];
      const walk = (session, depth) => {
        const children = kids.get(session.id) ?? [];
        rows.push({ session, depth, childCount: children.length, collapsed: collapsed.has(session.id) });
        if (children.length === 0 || collapsed.has(session.id)) return;
        for (const child of children) walk(child, depth + 1);
      };
      for (const session of roots) walk(session, 0);
      return rows;
    }

    function SessionRow({ session, selected, now, onSelect, checked, onCheck, depth = 0, childCount = 0, collapsed = false, onToggleChildren, rename, onBeginRename, onRowContextMenu, clipboard, dragIds }) {
      const status = statusOf(session);
      const isChild = Boolean(session.isSubagent);
      return h(
        "div",
        {
          onContextMenu: onRowContextMenu
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                // Right-clicking an unselected row selects it first, so the
                // menu always acts on what the pointer is over (Explorer rule).
                if (!selected) onSelect(session.id, event);
                onRowContextMenu(event, session);
              }
            : undefined,
          className:
            "row" +
            (selected ? " sel" : "") +
            (session.archived ? " arch" : "") +
            (session.pinned ? " pinned-row" : "") +
            // A cut row stays visible but reads as "about to leave": Explorer
            // and Finder both do this, and it is the only feedback a cut has
            // until the paste happens.
            (clipboard?.mode === "cut" && clipboard.ids?.includes(session.id) ? " cut" : "") +
            (depth > 0 ? " sub-row" : ""),
          "data-id": session.id,
          style: depth > 0 ? { "--indent": `${(depth) * 16}px` } : undefined,
          onClick: (event) => onSelect(session.id, event),
          // A session row can be dragged onto a workspace row. The payload is
          // the whole checked set when the dragged row is part of it, so a
          // multi-selection moves as one gesture.
          draggable: session.trashed !== true && !rename,
          onDragStart: (event) => {
            const ids = dragIds?.length ? dragIds : [session.id];
            dragPayload = { kind: "session", ids };
            event.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify(ids));
            event.dataTransfer.effectAllowed = "copyMove";
          },
        },
        h(
          "div",
          { className: "cell col-check col-check-cell" },
          h(
            "span",
            {
              className: "chk" + (checked ? " on" : ""),
              onClick: (event) => {
                event.stopPropagation();
                onCheck(session.id);
              },
            },
            checked ? h(Icon, { name: "check", size: 10 }) : null,
          ),
        ),
        h(
          "div",
          { className: "cell col-name" },
          h(
            "div",
            { className: "namecell" },
            childCount > 0
              ? h("span", {
                  className: "twist",
                  title: collapsed ? "展开子智能体会话" : "收起子智能体会话",
                  onClick: (event) => {
                    event.stopPropagation();
                    onToggleChildren(session.id);
                  },
                }, h(Icon, { name: collapsed ? "chevright" : "chevdown", size: 12 }))
              : null,
            h(Icon, { name: isChild ? "external" : "chat", className: "ic" }),
            rename
              ? h(RenameInput, {
                  className: "nm-edit",
                  value: rename.value,
                  onChange: rename.onChange,
                  onCommit: rename.onCommit,
                  onCancel: rename.onCancel,
                })
              // Renaming is a command, never a double click: a double click on a
              // row means "open", and overloading it made the first click select
              // and the second start editing (m0xxxx).
              : h("span", { className: "nm", title: session.id }, session.displayTitle ?? session.id),
            // The pencil only exists while the row is selected or hovered: the
            // list must not sprout a control on every line (m02120).
            !rename && onBeginRename
              ? h(
                  "span",
                  {
                    className: "nm-editbtn",
                    title: "重命名",
                    onClick: (event) => {
                      event.stopPropagation();
                      onBeginRename(session.id);
                    },
                  },
                  h(Icon, { name: "pencil", size: 11 }),
                )
              : null,
            isChild ? h("span", { className: "subtag", title: `子智能体 · 深度 ${session.delegationDepth ?? 1}` }, "子") : null,
            childCount > 0 && !isChild ? h("span", { className: "subtag", title: "包含子智能体会话" }, `${childCount} 子`) : null,
            session.isSeeded && !isChild ? h("span", { className: "subtag fork", title: "分叉自另一个会话，是独立会话" }, "分叉") : null,
            session.pinned ? h("span", { style: { color: "var(--sm-accent)", opacity: 0.85 } }, h(Icon, { name: "pin", size: 12 })) : null,
            session.archived ? h("span", { className: "arcbadge", title: "已归档" }, h(Icon, { name: "archive", size: 9 })) : null,
          ),
        ),
        h(
          "div",
          { className: "cell col-tags" },
          (session.tags ?? []).slice(0, 2).map((tag) =>
            h("span", { className: "tag", key: tag, title: tag }, tag),
          ),
        ),
        h(
          "div",
          { className: "cell col-note" + (session.note ? "" : " dim"), title: session.note || undefined },
          session.note || "",
        ),
        h("div", { className: "cell col-date dim" }, formatDate(session.activityAt, now)),
        h("div", { className: "cell col-size num dim" }, formatSize(session.sizeBytes)),
        h(
          "div",
          { className: "cell col-status" },
          h(
            "span",
            { className: "st" },
            h("span", { className: "dot " + status.cls }),
            status.text,
          ),
        ),
        h("div", { className: "cell col-fill" }),
      );
    }

    /**
     * A container row in the list: a workspace, a user folder, or one of the
     * fixed special folders.
     *
     * All three are things the user navigates *into*, so they share one row
     * shape — glyph, name, type tag, session count, checkbox — and differ in
     * what may be done to them:
     *
     *   workspace — DSH's own record; rename through the native controller.
     *   folder    — the plugin's node; rename and delete through the sidecar.
     *   special   — 未分组 / 收藏 / 待办 / 根目录: views over the session set. They
     *               cannot be renamed or deleted, because they are not the
     *               user's — deleting 收藏 would not delete anything, it would
     *               just make the shortcut disappear.
     */
    function ContainerRow({ node, count, selected, checked, onCheck, onOpen, onSelect, rename, onBeginRename, onNodeContextMenu, dropTarget, canAcceptNode, onDropNode }) {
      // Native HTML5 drag state. Two payloads may arrive: a session id list
      // (SESSION_DRAG_TYPE) and a container node id (text/plain). `over` is
      // tri-state — null (idle), "ok" (legal target), "bad" (refused) — because
      // a target that silently accepts and then fails at the host is exactly
      // the bug this validation exists to prevent.
      const [over, setOver] = useState(null);
      const accepts = typeof dropTarget === "function" || typeof onDropNode === "function";
      // `canAcceptNode` answers "may the container currently being dragged land
      // here?"; the list rows are the same targets as the tree rows, so they
      // share one validator instead of re-deriving the rules.
      const isWorkspace = node.type === "workspace";
      const isFolder = node.type === "folder" && node.kind === "folder";
      const kind = isWorkspace ? "workspace" : "folder";
      const label = node.name ?? node.path ?? node.id;
      // A folder is addressed by its own node id; a workspace by its native
      // workspaceId, because DSH owns that record and the tree id (w-<uuid>) is
      // only this panel's alias.
      const actionId = isWorkspace ? node.workspaceId ?? node.id : node.id;
      // Fixed containers are not the user's to rename or delete. The default
      // workspace is included: the host always renders that label as
      // 默认工作区, so an edit would be a silent no-op round trip.
      const editable = isWorkspace ? node.kind !== "default-workspace" : isFolder;
      const icon = isWorkspace ? "monitor" : isFolder ? "folder" : iconOfNode(node);
      const tag = isWorkspace ? "工作区" : isFolder ? "文件夹" : "特殊文件夹";
      // A workspace and a user folder are the user's own containers, so they can
      // be dragged like session rows can; a 特殊文件夹 is a view and cannot.
      const draggable = editable;
      return h(
        "div",
        {
          className:
            "row frow " +
            (isWorkspace ? "wsrow" : isFolder ? "folderrow" : "specialrow") +
            (selected ? " sel" : ""),
          "data-id": node.id,
          "data-drop": accepts && over ? (over === "bad" ? "bad" : "1") : undefined,
          onClick: (event) => onSelect(node.id, event),
          // Double-click enters it, the same as a file manager. The tree row and
          // this row must agree, so both go through onOpen (navigate) rather
          // than one of them calling a different path.
          onDoubleClick: (event) => {
            event.stopPropagation();
            onOpen(node.id);
          },
          // Dropping sessions on a workspace row moves them into it. Ctrl (or
          // Cmd) held at drop time asks for a copy, exactly like Explorer.
          // Only a workspace accepts sessions (one session, one workspace); a
          // folder or 特殊文件夹 greys out, which is the whole point of
          // validating here rather than letting the host refuse the write.
          draggable,
          onDragStart: draggable
            ? (event) => {
                dragPayload = { kind: "node", id: node.id };
                event.dataTransfer.setData("text/plain", node.id);
                event.dataTransfer.effectAllowed = "move";
              }
            : undefined,
          onDragEnd: () => {
            dragPayload = null;
            setOver(null);
          },
          onDragOver: accepts
            ? (event) => {
                const types = Array.from(event.dataTransfer?.types ?? []);
                const sessionDrag = types.includes(SESSION_DRAG_TYPE);
                const nodeDrag = !sessionDrag && types.includes("text/plain");
                if (!sessionDrag && !nodeDrag) return;
                // Sessions: only a workspace. Containers: the same rules the
                // tree uses, so an illegal combination greys out here too.
                const legal = sessionDrag ? isWorkspace : canAcceptNode?.() === true;
                if (!legal) {
                  event.dataTransfer.dropEffect = "none";
                  if (over !== "bad") setOver("bad");
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = sessionDrag && (event.ctrlKey || event.metaKey) ? "copy" : "move";
                if (over !== "ok") setOver("ok");
              }
            : undefined,
          onDragLeave: accepts ? () => setOver(null) : undefined,
          onDrop: accepts
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                setOver(null);
                const types = Array.from(event.dataTransfer?.types ?? []);
                const sessionDrag = types.includes(SESSION_DRAG_TYPE);
                const source = dragPayload?.kind === "node" ? dragPayload.id : null;
                if (sessionDrag) {
                  if (!isWorkspace) return;
                  const ids = parseDragIds(event.dataTransfer.getData(SESSION_DRAG_TYPE));
                  if (ids.length > 0) dropTarget(ids, event.ctrlKey || event.metaKey);
                  return;
                }
                if (source && source !== node.id && onDropNode) onDropNode(node.id, source);
              }
            : undefined,
          onContextMenu:
            onNodeContextMenu && editable
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!selected) onSelect(node.id, event);
                  onNodeContextMenu(event, { kind, id: actionId, nodeId: node.id, node });
                }
              : undefined,
        },
        // A checkbox, like every other row: a folder or a workspace is a real
        // container that can be deleted or moved as a group. A 特殊文件夹 gets no
        // box at all — it cannot be deleted or renamed, so offering a selection
        // that no command can act on would only inflate 已选 N 项.
        editable
          ? h(
              "div",
              { className: "cell col-check col-check-cell" },
              h(
                "span",
                {
                  className: "chk" + (checked ? " on" : ""),
                  title: "选择",
                  onClick: (event) => {
                    event.stopPropagation();
                    onCheck(node.id);
                  },
                },
                checked ? h(Icon, { name: "check", size: 10 }) : null,
              ),
            )
          : h("div", { className: "cell col-check col-check-cell" }),
        h(
          "div",
          { className: "cell col-name" },
          h(
            "div",
            { className: "namecell" },
            h("span", { className: "fl-ic" }, h(Icon, { name: icon, className: "ic " + (isWorkspace ? "wsic" : isFolder ? "folderic" : "specialic") })),
            rename && editable
              ? h(RenameInput, {
                  className: "nm-edit",
                  value: rename.value,
                  onChange: rename.onChange,
                  onCommit: rename.onCommit,
                  onCancel: rename.onCancel,
                })
              : h("span", { className: "nm", title: node.path || node.id }, label),
            !rename && editable && onBeginRename
              ? h(
                  "span",
                  {
                    className: "nm-editbtn",
                    title: "重命名",
                    onClick: (event) => {
                      event.stopPropagation();
                      onBeginRename(actionId);
                    },
                  },
                  h(Icon, { name: "pencil", size: 11 }),
                )
              : null,
            h("span", { className: "wstag" + (isWorkspace ? "" : isFolder ? " ftag" : " stag") }, tag),
          ),
        ),
        h("div", { className: "cell col-tags dim" }),
        h("div", { className: "cell col-note dim" }),
        h("div", { className: "cell col-date dim" }, count ? `${formatCount(count)} 个会话` : ""),
        h("div", { className: "cell col-size num dim" }),
        h("div", { className: "cell col-status" }),
        h("div", { className: "cell col-fill" }),
      );
    }

    // ── List pane ──────────────────────────────────────────────────────────
    function ListPane(props) {
      const {
        sessions,
        tree,
        scope,
        selected,
        onSelect,
        onCheck,
        checked,
        query,
        onQuery,
        sortKey,
        sortDir,
        onSort,
        showArchived,
        now,
        view,
        onOpenWorkspace,
        colWidths,
        onResizeColumn,
        listRef,
        collapsed,
        onToggleChildren,
        rename,
        onBeginRename,
        onRowContextMenu,
        onNodeContextMenu,
        clipboard,
        onDropSessions,
        onDropNode,
        onCanAcceptNode,
      } = props;

      const bodyRef = useRef(null);
      const paneRef = useRef(null);
      const [colMode, setColMode] = useState("full");
      const hasSelection = checked.size > 0;

      // The prototype picks column density from the *list pane's* width, not
      // the window's: the tree and detail panes are resizable, so the same
      // viewport can need any of the three densities.
      useEffect(() => {
        const element = paneRef.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
          const width = element.getBoundingClientRect().width;
          setColMode(width >= 660 ? "full" : width >= 480 ? "mid" : "slim");
        });
        observer.observe(element);
        return () => observer.disconnect();
      }, []);

      // The search box looks at what the panel itself shows and owns: the title,
      // the user's note and the user's tags. It deliberately does not open the
      // session log — a full-text search over 4.8 MB zstd frames per session is
      // a different product, and the metadata is what people actually search.
      const needle = query.trim().toLowerCase();
      const filtered = useMemo(() => {
        if (!needle) return sessions;
        return sessions.filter((session) => {
          const fields = [
            session.displayTitle,
            session.title,
            session.note,
            ...(session.tags ?? []),
            session.cwd,
            session.id,
            session.workspaceTitle,
          ];
          return fields.some(
            (value) => typeof value === "string" && value.toLowerCase().includes(needle),
          );
        });
      }, [needle, sessions]);

      const sorted = useMemo(
        () => filtered.slice().sort(compareBy(sortKey, sortDir === "asc" ? 1 : -1)),
        [filtered, sortKey, sortDir],
      );

      const pinned = sorted.filter((session) => session.pinned && !session.archived);
      const normal = sorted.filter((session) => !session.pinned && !session.archived);
      // 显示已归档的会话 is a view preference, not a deletion: with it off the
      // rows are simply not rendered, and the status bar still counts them so
      // the user can see that something is being hidden.
      const archived = showArchived === false ? EMPTY_LIST : sorted.filter((session) => session.archived);

      // Containers shown above the sessions, split into two groups because they
      // are two different things:
      //
      //   特殊文件夹 — 根目录 / 未分组 / 收藏 / 待办: views over the session set.
      //                Fixed: no rename, no delete.
      //   工作区与文件夹 — DSH workspaces and the user's own folders: real
      //                containers that can be renamed, checked and moved.
      //
      // While searching, the net widens to the whole tree: a search box that
      // cannot find a folder by name is a search box that lies, and a folder
      // three levels down is exactly the one a user is looking for.
      const matchesNeedle = (node) =>
        !needle ||
        String(node.name ?? "").toLowerCase().includes(needle) ||
        String(node.path ?? "").toLowerCase().includes(needle);

      // 特殊文件夹 hang inside 根目录 and nowhere else: they are views over the
      // whole session set, so repeating them inside every folder would be noise.
      //
      // 根目录 itself is *not* in the list — you are already standing in it, and a
      // row that navigates to where you are is a no-op that reads like a bug.
      // The bin lists trashed sessions only: no container to navigate out of.
      const specialNodes =
        scope !== FIXED.root || needle
          ? []
          : [FIXED.ungrouped, FIXED.favorites, FIXED.todos]
              .map((id) => tree?.nodes?.[id])
              .filter(Boolean);

      const isRealContainer = (node) =>
        node &&
        (node.type === "workspace" ||
          (node.type === "folder" && node.kind === "folder" && !node.fixed));
      const containerNodes = scope === FIXED.trash
        ? []
        : needle
          ? Object.values(tree?.nodes ?? {}).filter((node) => isRealContainer(node) && matchesNeedle(node))
          : (tree?.children?.[scope] ?? []).map((id) => tree.nodes[id]).filter(isRealContainer);

      // Subagent sessions follow their parent instead of sitting beside it.
      const rowsOf = (list) =>
        nestSessions(list, collapsed).map((entry) =>
          h(SessionRow, {
            key: entry.session.id,
            session: entry.session,
            selected: selected === entry.session.id,
            checked: checked.has(entry.session.id),
            onCheck,
            onSelect,
            now,
            depth: entry.depth,
            childCount: entry.childCount,
            collapsed: entry.collapsed,
            onToggleChildren,
            rename: rename?.kind === "session" && rename.id === entry.session.id ? rename : null,
            onBeginRename: onBeginRename ? (id) => onBeginRename("session", id) : undefined,
            onRowContextMenu: onRowContextMenu
              ? (event, session) => onRowContextMenu(event, "session", session.id, session)
              : undefined,
            clipboard,
            dragIds: checked.has(entry.session.id) && checked.size > 1 ? [...checked] : [entry.session.id],
          }),
        );

      /**
       * Rows for a list of container nodes, wired to the right id space.
       *
       * A workspace row is also a drop target: dragging session rows onto it is
       * the pointer gesture for 跨工作区移动, and it goes through the same
       * `onDropSessions` the clipboard paste uses. `highlight` is the native
       * drag-and-drop cue browsers already implement, so no custom overlay is
       * needed.
       */
      const containerRows = (nodes) =>
        nodes.map((node) => {
          const isWorkspace = node.type === "workspace";
          const kind = isWorkspace ? "workspace" : "folder";
          const entityId = isWorkspace ? node.workspaceId ?? node.id : node.id;
          const editable = isWorkspace ? node.kind !== "default-workspace" : node.kind === "folder";
          return h(ContainerRow, {
            key: node.id,
            node,
            count: tree?.counts?.[node.id] ?? 0,
            // Selected means "picked in this list", which is what makes the
            // detail pane describe this container; the scope is only where the
            // user currently stands (they may have selected without entering).
            selected: selected === node.id || scope === node.id,
            checked: checked.has(node.id),
            onCheck,
            onSelect,
            onOpen: onOpenWorkspace,
            rename: editable && rename?.id === entityId && rename.kind === kind ? rename : null,
            onBeginRename: onBeginRename && editable ? (id) => onBeginRename(kind, id) : undefined,
            onNodeContextMenu: onNodeContextMenu && editable ? onNodeContextMenu : undefined,
            dropTarget:
              isWorkspace && onDropSessions && node.workspaceId
                ? (ids, copy) => onDropSessions(ids, node.workspaceId, copy)
                : null,
            // Containers are drop targets too: a folder or workspace dragged
            // from the tree (or from this very list) lands here through the same
            // `moveNodeTo` the tree uses, so both surfaces share one rule set.
            canAcceptNode: onCanAcceptNode ? () => onCanAcceptNode(node.id) : undefined,
            onDropNode: onDropNode ? (targetId, sourceId) => onDropNode(targetId, sourceId) : undefined,
          });
        });

      // Group order: 置顶, 特殊文件夹, 文件夹, 工作区, 会话, then 已归档 sinks last.
      // Workspaces and folders are separate groups on purpose — they are
      // different objects with different owners, and mixing them made a folder
      // look like a workspace with the wrong icon. Folders come first because
      // they are the user's own containers (and the thing 新建文件夹 just made).
      const groups = [];
      if (pinned.length > 0) {
        groups.push({
          key: "pinned",
          title: "置顶",
          icon: "pin",
          count: pinned.length,
          rows: rowsOf(pinned),
        });
      }
      if (specialNodes.length > 0) {
        groups.push({
          key: "special",
          title: "特殊文件夹",
          icon: "star",
          count: specialNodes.length,
          rows: containerRows(specialNodes),
        });
      }
      // While searching, workspaces and folders are listed together under one
      // 搜索结果 caption: a query is about finding a thing, not about which kind
      // of thing it turned out to be.
      const workspaces = containerNodes.filter((node) => node.type === "workspace");
      const folders = containerNodes.filter((node) => node.type === "folder");
      if (needle && containerNodes.length > 0) {
        groups.push({
          key: "found",
          title: "搜索到的目录",
          icon: "search",
          count: containerNodes.length,
          rows: containerRows(containerNodes),
        });
      } else {
        // 文件夹 first, then 工作区: folders are the user's own containers and the
        // thing they just created, so they belong where the eye lands first.
        // Workspaces are DSH's registry and read as a reference list below them.
        if (folders.length > 0) {
          groups.push({
            key: "folders",
            title: "文件夹",
            icon: "folder",
            count: folders.length,
            rows: containerRows(folders),
          });
        }
        if (workspaces.length > 0) {
          groups.push({
            key: "workspaces",
            title: "工作区",
            icon: "monitor",
            count: workspaces.length,
            rows: containerRows(workspaces),
          });
        }
      }
      if (normal.length > 0) {
        groups.push({
          key: "normal",
          title: "会话",
          icon: null,
          count: normal.length,
          rows: rowsOf(normal),
        });
      }
      if (archived.length > 0) {
        groups.push({
          key: "archived",
          title: "已归档（沉底）",
          icon: "archive",
          count: archived.length,
          rows: rowsOf(archived),
        });
      }
      const style = {
        "--w-name": `${colWidths.name}px`,
        "--w-tags": `${colWidths.tags}px`,
        "--w-note": `${colWidths.note}px`,
        "--w-date": `${colWidths.updated}px`,
        "--w-size": `${colWidths.size}px`,
        "--w-status": `${colWidths.status}px`,
      };

      return h(
        "main",
        { className: "pane-list", id: "se-listpane", style, ref: paneRef, "data-cw": colMode },
        h(
          "div",
          { className: "listhead", ref: listRef },
          h(
            "div",
            { className: "lh col-check" },
            h(
              "span",
              {
                className: "chk" + (filtered.length > 0 && filtered.every((s) => checked.has(s.id)) ? " on" : ""),
                onClick: () => {
                  const all = filtered.length > 0 && filtered.every((s) => checked.has(s.id));
                  onCheck(all ? null : "all");
                },
              },
              filtered.length > 0 && filtered.every((s) => checked.has(s.id)) ? h(Icon, { name: "check", size: 10 }) : null,
            ),
          ),
          COL_ORDER.map((key) => {
            const column = COLUMNS[key];
            const sortedCol = sortKey === key;
            return h(
              "div",
              {
                key,
                className: "lh " + column.cls + (sortedCol ? " sorted" : ""),
                "data-col": key,
                onClick: () => onSort(key),
              },
              h("span", { className: "lhlabel" }, column.label),
              h("span", { className: "sortdot", "aria-hidden": "true" }, "▼"),
              h("span", {
                className: "colrsz",
                "data-cw": key,
                title: "拖动调整列宽",
                onMouseDown: (event) => onResizeColumn(event, key),
              }),
            );
          }),
          h("div", { className: "lh col-fill" }),
        ),
        h(
          "div",
          { className: "listbody" + (hasSelection ? " has-sel" : ""), ref: bodyRef },
          groups.length === 0
            ? h(Empty, {
                icon: scope === FIXED.trash ? "trash" : "folder",
                title: query.trim() ? "没有匹配的项目" : scope === FIXED.trash ? "回收站是空的" : "这里还是空的",
                hint: query.trim() ? "试试别的关键词，或清空搜索框" : "可以用「新建文件夹」把会话分组，或把工作区拖进来",
              })
            : groups.map((group) =>
                h(
                  "div",
                  { key: group.key },
                  h(
                    "div",
                    { className: "grp" },
                    group.icon ? h(Icon, { name: group.icon, size: 12 }) : null,
                    group.title,
                    h("span", { className: "gcount" }, formatCount(group.count)),
                  ),
                  group.rows,
                ),
              ),
        ),
      );
    }

    // ── Detail pane ────────────────────────────────────────────────────────
    const paneStyle = { flexBasis: "var(--detail-width)", width: "var(--detail-width)" };

    /**
     * Detail pane.
     *
     * Everything that names something is renamed from here (m01340): the title
     * row carries an inline editor, and the same control renames a workspace or
     * a folder when one of those is selected instead of a session.
     *
     * Tags are picked from the shared library rather than retyped, so the
     * vocabulary stays small and one tag is never spelled two ways.
     *
     * A fork and a subagent both carry parentSession, but only a subagent is a
     * child. The two relations therefore get separate rows: 子智能体 / 子会话 for
     * a real delegation, 分叉自 / 分叉出去 for an independent copy.
     */
    function DetailPane({
      session,
      node,
      now,
      onClose,
      onHint,
      width,
      parent,
      children = EMPTY_LIST,
      forks = EMPTY_LIST,
      forkSource,
      onOpen,
      onEnterNode,
      onOpenSession,
      tagLibrary,
      onAddTag,
      onRemoveTag,
      onNewTag,
      onDropTag,
      onSetNote,
      onToggleFlag,
      onArchive,
      onFork,
      onRename,
      onRestore,
      onDelete,
    }) {
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState("");
      const [tagOpen, setTagOpen] = useState(false);
      const [newTag, setNewTag] = useState("");
      // Escape closes the editor and the blur that follows must not commit the
      // abandoned text; a ref survives the re-render that the keydown causes.
      const cancelled = useRef(false);

      // Switching rows must not carry a half-typed name or an open picker over.
      const targetId = session?.id ?? node?.id ?? null;
      useEffect(() => {
        setEditing(false);
        setDraft("");
        setTagOpen(false);
        setNewTag("");
      }, [targetId]);

      // A container is a workspace or a folder, and the two are told apart by
      // `node.type` alone. Reading anything else (an icon, a fixed flag) made a
      // workspace show up as 文件夹 in the detail pane.
      const nodeKind = !node ? null : node.type === "workspace" ? "workspace" : "folder";
      const kind = session ? "session" : nodeKind;
      const label = session ? session.displayTitle ?? session.id : node?.name ?? node?.id ?? "";
      // The root, the trash and the other built-in containers are not ours to
      // rename, so they get no editor at all rather than a failing round trip.
      // 默认工作区 is a real workspace whose label the host always renders as
      // 默认工作区, so renaming it would be a silent no-op.
      const canRename = session
        ? true
        : Boolean(node && !node.fixed && node.kind !== "default-workspace");
      const library = Array.isArray(tagLibrary) ? tagLibrary : [];
      const tags = session?.tags ?? [];

      const beginRename = () => {
        setDraft(label);
        cancelled.current = false;
        setEditing(true);
      };

      const commitRename = () => {
        if (cancelled.current) {
          cancelled.current = false;
          setEditing(false);
          return;
        }
        const value = draft.trim();
        setEditing(false);
        setDraft("");
        if (!value || value === label) return;
        // A workspace node is addressed by its native id, not by the tree id.
        const id = kind === "workspace" ? node?.workspaceId : session?.id ?? node?.id;
        if (!id) return;
        onRename(kind, id, value);
      };

      const submitNewTag = () => {
        const value = newTag.trim();
        if (!value || !session) return;
        onNewTag(session.id, value);
        setNewTag("");
      };

      if (!session && !node) {
        return h(
          "aside",
          { className: "pane-detail", style: paneStyle },
          h(Empty, { icon: "details", title: "选中一项查看详情", hint: "可多选后批量操作" }),
        );
      }

      const status = session ? statusOf(session) : null;
      const stats = session?.stats ?? {};
      const tokens = session?.tokenUsage ?? {};
      const pressure = session?.contextPressure ?? {};

      const kv = (key, value) =>
        h("div", { className: "kv", key }, h("span", { className: "k" }, key), h("span", { className: "v" }, value));

      const head = h(
        "div",
        { className: "det-head" },
        h(
          "div",
          { className: "det-ic" },
          h(Icon, { name: kind === "workspace" ? "monitor" : kind === "folder" ? iconOfNode(node) : "chat", size: 18 }),
        ),
        h(
          "div",
          { style: { minWidth: 0, flex: 1 } },
          editing && canRename
            ? h("input", {
                className: "det-rename",
                value: draft,
                autoFocus: true,
                spellCheck: false,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter") commitRename();
                  else if (event.key === "Escape") {
                    cancelled.current = true;
                    setEditing(false);
                    setDraft("");
                  }
                },
                onBlur: commitRename,
              })
            : h(
                "div",
                { className: "det-title-row" },
                h("div", { className: "det-title", title: label }, label),
                canRename
                  ? h(
                      "button",
                      { type: "button", className: "det-title-edit", title: "重命名", onClick: beginRename },
                      h(Icon, { name: "pencil", size: 11 }),
                    )
                  : null,
              ),
          h(
            "div",
            { className: "det-sub" },
            session
              ? (session.trashed ? "回收站 · 已删除" : (session.workspaceTitle ?? "未分组") + " · " + (session.agentPreset ?? "默认预设"))
              : kind === "workspace"
                ? node?.path ?? ""
                : node?.id === FIXED.root
                  ? "全部会话"
                  : "自建文件夹",
          ),
          forkSource
            ? h(
                "div",
                { className: "det-fork" },
                h(Icon, { name: "copy", size: 10 }),
                h("span", null, "分叉自"),
                h(
                  "span",
                  { className: "det-link", onClick: () => onOpen(forkSource.id) },
                  forkSource.displayTitle ?? forkSource.id,
                ),
              )
            : null,
        ),
        h("button", { className: "dclose", title: "关闭", onClick: onClose }, h(Icon, { name: "x", size: 13 })),
      );

      // A node can be in scope with no session selected (the root, a workspace),
      // so every session-only branch is built conditionally. Building it first
      // and hiding it later would dereference a null session during render and
      // take the whole slot down with it.
      const sessionBody = !session ? null : h(
        "div",
        { className: "det-body" },
        kv("大小", formatSize(session.sizeBytes) || "—"),
        kv("上次对话", formatDate(session.activityAt, now) || "—"),
        kv("创建", formatDate(session.createdAt, now) || "—"),
        kv("状态", status.text),
        kv("轮次", formatCount(stats.turns ?? 0)),
        kv("路径", session.cwd ?? "—"),
        // Only a real subagent has a parent conversation; a fork is a sibling.
        session.isSubagent && session.parentSession
          ? h(
              "div",
              { className: "kv" },
              h("span", { className: "k" }, "子智能体"),
              h(
                "span",
                { className: "v" },
                h(
                  "span",
                  { className: "detail-parent", onClick: () => onOpen(parent?.id ?? session.parentSession) },
                  h(Icon, { name: "external", size: 11 }),
                  h("span", { className: "nm" }, parent?.displayTitle ?? session.parentSession),
                ),
                h("span", { className: "subtag" }, "深度 " + (session.delegationDepth ?? 1)),
              ),
            )
          : null,
        children.length > 0
          ? h(
              "div",
              { className: "kv" },
              h("span", { className: "k" }, "子会话"),
              h("span", { className: "v" }, formatCount(children.length) + " 个"),
            )
          : null,
        forks.length > 0
          ? h(
              "div",
              { className: "kv" },
              h("span", { className: "k" }, "分叉出去"),
              h(
                "span",
                { className: "v" },
                forks.map((fork, index) =>
                  h(
                    React.Fragment,
                    { key: fork.id },
                    index > 0 ? h("span", { className: "det-sep" }, "、") : null,
                    h(
                      "span",
                      { className: "det-link", onClick: () => onOpen(fork.id) },
                      fork.displayTitle ?? fork.id,
                    ),
                  ),
                ),
              ),
            )
          : null,
        kv("会话 id", session.id),
      );

      const nodeBody = h(
        "div",
        { className: "det-body" },
        kv(
          "类型",
          kind === "workspace"
            ? node?.kind === "default-workspace"
              ? "工作区（默认）"
              : "工作区"
            : node?.kind === "root"
              ? "根目录"
              : node?.kind === "ungrouped"
                ? "视图"
                : node?.kind === "todos" || node?.kind === "favorites"
                  ? "视图"
                  : node?.kind === "trash"
                    ? "回收站"
                    : "文件夹",
        ),
        kind === "workspace" ? kv("路径", node?.path ?? "—") : null,
        kv("编号", node?.id ?? "—"),
      );

      const tagSection = session
        ? h(
            "div",
            { className: "det-sec" },
            h("h4", null, "标签"),
            h(
              "div",
              { className: "det-body", style: { padding: 0 } },
              h(
                "div",
                { className: "taglist" },
                tags.map((tag) =>
                  h(
                    "span",
                    { className: "tagchip", key: tag },
                    tag,
                    h(
                      "span",
                      { className: "x", title: "移除标签", onClick: () => onRemoveTag(session.id, tag) },
                      h(Icon, { name: "x", size: 9 }),
                    ),
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "tagadd" + (tagOpen ? " on" : ""),
                    onClick: () => setTagOpen((previous) => !previous),
                  },
                  h(Icon, { name: tagOpen ? "x" : "plus", size: 11 }),
                  tagOpen ? "收起" : "添加标签",
                ),
              ),
              tagOpen
                ? h(
                    "div",
                    { className: "tagpanel" },
                    library.length === 0
                      ? h("div", { className: "tagempty" }, "标签库是空的，在下面输入一个就会存进来")
                      : null,
                    library.map((entry) =>
                      h(
                        "button",
                        {
                          type: "button",
                          key: entry.tag,
                          className: "tagopt" + (tags.includes(entry.tag) ? " on" : ""),
                          title: entry.preset ? "已在标签库中" : "仅被会话使用，点击后不会加入库",
                          onClick: () =>
                            tags.includes(entry.tag)
                              ? onRemoveTag(session.id, entry.tag)
                              : onAddTag(session.id, entry.tag),
                        },
                        tags.includes(entry.tag) ? h(Icon, { name: "check", size: 10 }) : null,
                        entry.tag,
                        h("span", { className: "tagcount" }, formatCount(entry.count ?? 0)),
                        entry.preset
                          ? h(
                              "span",
                              {
                                className: "taglib-del",
                                title: "从标签库移除（已打上的会话保留）",
                                onClick: (event) => {
                                  event.stopPropagation();
                                  onDropTag(entry.tag);
                                },
                              },
                              h(Icon, { name: "x", size: 8 }),
                            )
                          : null,
                      ),
                    ),
                    h(
                      "div",
                      { className: "tagnewrow" },
                      h("input", {
                        className: "tagnew",
                        value: newTag,
                        placeholder: "新建标签并加入库",
                        spellCheck: false,
                        onChange: (event) => setNewTag(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === "Enter") submitNewTag();
                        },
                      }),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "tagnew-go",
                          title: "加入标签库并打到这条会话上",
                          onClick: submitNewTag,
                        },
                        h(Icon, { name: "plus", size: 10 }),
                      ),
                    ),
                  )
                : null,
            ),
          )
        : null;

      const sessionActions = !session ? null : h(
        "div",
        { className: "det-actions" },
        // 打开 hands the session to DSH's own navigation: the plugin is a
        // browser over the real store, never a second chat surface.
        h(Btn, { className: "act primary", icon: "external", disabled: session.trashed, onClick: () => onOpenSession?.(session.id) }, "打开"),
        h(Btn, {
          className: "act",
          icon: "copy",
          onClick: () => {
            if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(session.id).catch(() => {});
            onHint("已复制会话 id");
          },
        }, "复制 id"),
        h(Btn, { className: "act" + (session.favorite ? " on" : ""), icon: "star", onClick: () => onToggleFlag("favorite") }, session.favorite ? "取消收藏" : "收藏"),
        h(Btn, { className: "act" + (session.todo ? " on" : ""), icon: "todo", onClick: () => onToggleFlag("todo") }, session.todo ? "取消待办" : "待办"),
        // 导出 needs the full L3 event stream, which is the P6 work: a session
        // log is a zstd-compressed JSONL of every event, and reconstructing the
        // conversation from it is a different job from browsing metadata.
        session.trashed
          ? null
          : h(Btn, { className: "act", icon: "save", onClick: () => onHint("导出会话需要 P6 的全量事件流（L3）") }, "导出"),
        // A trashed session has left DSH's own store, so the native operations
        // do not apply to it any more; only 还原 and 永久删除 make sense.
        session.trashed ? null : h(Btn, { className: "act", icon: "branch", onClick: onFork }, "分叉"),
        session.trashed
          ? h(Btn, { className: "act", icon: "restore", onClick: onRestore }, "还原")
          : h(Btn, { className: "act" + (session.archived ? " on" : ""), icon: "archive", onClick: onArchive }, session.archived ? "取消归档" : "归档"),
        h(Btn, { className: "act danger", icon: "trash", onClick: onDelete }, session.trashed ? "永久删除" : "删除"),
      );

      const nodeActions = h(
        "div",
        { className: "det-actions" },
        // A node has nothing for DSH to open; 打开 means "go into it", which is
        // the only meaningful interpretation for a folder or a workspace.
        h(Btn, { className: "act primary", icon: "external", onClick: () => onEnterNode?.(node?.id) }, "打开"),
        h(Btn, {
          className: "act",
          icon: "copy",
          onClick: () => {
            if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(node?.id ?? "").catch(() => {});
            onHint("已复制编号");
          },
        }, "复制编号"),
      );

      return h(
        "aside",
        { className: "pane-detail", style: paneStyle },
        head,
        session ? sessionBody : nodeBody,
        tagSection,
        session
          ? h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "det-sec" },
                h("h4", null, "备注"),
                h(
                  "div",
                  { className: "det-body", style: { padding: 0 } },
                  h("textarea", {
                    className: "note",
                    key: session.id,
                    defaultValue: session.note ?? "",
                    placeholder: "写点只属于这条会话的备注…",
                    onBlur: (event) => {
                      const value = event.target.value.trim();
                      if (value !== (session.note ?? "")) onSetNote(session.id, value);
                    },
                  }),
                ),
              ),
              h(
                "div",
                { className: "det-sec" },
                h("h4", null, "执行统计"),
                h(
                  "div",
                  { className: "det-body", style: { padding: 0 } },
                  kv("步数", formatCount(stats.steps ?? 0)),
                  kv("模型耗时", formatDuration(stats.llmMs)),
                  kv("首字", formatDuration(stats.ttftMs)),
                  kv("工具耗时", formatDuration(stats.toolMs)),
                ),
              ),
              h(
                "div",
                { className: "det-sec" },
                h("h4", null, "Token 用量"),
                h(
                  "div",
                  { className: "det-body", style: { padding: 0 } },
                  kv("输入", formatCompact(tokens.uncachedInputTokens)),
                  kv("输出", formatCompact(tokens.outputTokens)),
                  kv("缓存读", formatCompact(tokens.cacheReadTokens)),
                  kv("缓存写", formatCompact(tokens.cacheWriteTokens)),
                ),
              ),
              h(
                "div",
                { className: "det-sec" },
                h("h4", null, "上下文"),
                h(
                  "div",
                  { className: "det-body", style: { padding: 0 } },
                  kv("压力", formatCompact(pressure.pressureTokens)),
                  kv("面量", formatCompact(pressure.surfaceTokens)),
                  kv("窗口", formatCompact(pressure.contextWindow)),
                ),
              ),
              sessionActions,
            )
          : nodeActions,
      );
    }

    /**
     * 筛选 dialog (P4).
     *
     * A filter is a *view*: it narrows what the current scope lists and never
     * moves, hides or rewrites a session. That is why it can be cleared with one
     * click and why the bin ignores it — a bin you cannot see into is a bin you
     * cannot empty.
     *
     * Tags intersect (every chosen tag must be present); the three selects are
     * tri-state (all / yes / no) so "未收藏" is expressible without a separate
     * control.
     */
    function FilterDialog({ open, value, library, onApply, onClose }) {
      const [draft, setDraft] = useState(value);
      useEffect(() => {
        if (open) setDraft(value);
      }, [open, value]);
      // Escape closes the dialog, like every other modal in DSH. Registered only
      // while it is open, so it cannot swallow the panel's own Escape handling.
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [open, onClose]);

      if (!open) return null;
      const tags = (library ?? []).map((entry) => entry.tag).filter(Boolean);
      const toggleTag = (tag) =>
        setDraft((previous) => ({
          ...previous,
          tags: previous.tags.includes(tag)
            ? previous.tags.filter((entry) => entry !== tag)
            : [...previous.tags, tag],
        }));

      return h(
        "div",
        { className: "fmodal open", role: "dialog", "aria-label": "筛选", onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h(
          "div",
          { className: "fdlg" },
          h(
            "div",
            { className: "fhead" },
            h("span", { className: "fic" }, h(Icon, { name: "tag", size: 13 })),
            h("span", { className: "ftitle" }, "筛选"),
            h("span", { className: "spacer" }),
            h("button", { type: "button", className: "wbtn", title: "关闭", onClick: onClose }, h(Icon, { name: "x", size: 13 })),
          ),
          h(
            "div",
            { className: "fbody" },
            selectRow("范围", draft.scope, [["scope", "当前目录"], ["all", "全部会话"]], (next) => setDraft((previous) => ({ ...previous, scope: next }))),
            selectRow("收藏", draft.favorite, [["all", "所有"], ["yes", "已收藏"], ["no", "未收藏"]], (next) => setDraft((previous) => ({ ...previous, favorite: next }))),
            selectRow("归档", draft.archived, [["all", "所有"], ["yes", "已归档"], ["no", "未归档"]], (next) => setDraft((previous) => ({ ...previous, archived: next }))),
            selectRow("待办", draft.todo, [["all", "所有"], ["yes", "待办中"], ["no", "非待办"]], (next) => setDraft((previous) => ({ ...previous, todo: next }))),
            h(
              "div",
              { className: "frow", style: { alignItems: "flex-start" } },
              h("label", { className: "flb" }, "标签", h("span", { className: "fsub" }, "可多选")),
              tags.length === 0
                ? h("div", { className: "se-set-note" }, "标签库是空的")
                : h(
                    "div",
                    { className: "ftags" },
                    tags.map((tag) =>
                      h(
                        "button",
                        {
                          type: "button",
                          key: tag,
                          className: "tagopt" + (draft.tags.includes(tag) ? " on" : ""),
                          onClick: () => toggleTag(tag),
                        },
                        draft.tags.includes(tag) ? h(Icon, { name: "check", size: 10 }) : null,
                        tag,
                      ),
                    ),
                  ),
            ),
          ),
          h(
            "div",
            { className: "ffoot" },
            h("button", { type: "button", className: "act", onClick: () => setDraft({ scope: "scope", favorite: "all", archived: "all", todo: "all", tags: [] }) }, "清除全部"),
            h("span", { className: "spacer" }),
            h("button", { type: "button", className: "act primary", onClick: () => onApply(draft) }, "应用筛选"),
          ),
        ),
      );
    }

    /**
     * One tri-state filter row, as a segmented button group.
     *
     * It was a `<select>`: a native dropdown inside a modal that is itself
     * floating over the app reads as a second, unrelated window, and its
     * options were invisible until opened. Three short labels fit inline, and a
     * segmented control shows the current choice at a glance — which is the
     * whole job of a filter panel.
     */
    function selectRow(label, value, options, onChange) {
      return h(
        "div",
        { className: "frow" },
        h("label", { className: "flb" }, label),
        h(
          "div",
          { className: "fseg", role: "radiogroup", "aria-label": label },
          options.map(([optionValue, text]) =>
            h(
              "button",
              {
                key: optionValue,
                type: "button",
                role: "radio",
                "aria-checked": value === optionValue,
                className: value === optionValue ? "on" : "",
                onClick: () => onChange(optionValue),
              },
              text,
            ),
          ),
        ),
      );
    }

    /**
     * A small command menu anchored to a button.
     *
     * The prototype has a full context-menu component; the panel only needs one
     * menu (更多), so this is the smallest thing that behaves: it opens next to
     * the button, closes on outside click, Escape or after running an item, and
     * never leaves a listener behind.
     */
    function CommandMenu({ anchor, items, onClose }) {
      const ref = useRef(null);
      useEffect(() => {
        if (!anchor) return undefined;
        const onDown = (event) => {
          // A press on the trigger belongs to the trigger (it toggles the menu);
          // closing here as well would close and immediately re-open it.
          if (anchor.element && anchor.element.contains?.(event.target)) return;
          if (ref.current && !ref.current.contains(event.target)) onClose();
        };
        const onKey = (event) => {
          if (event.key === "Escape") onClose();
        };
        window.addEventListener("mousedown", onDown);
        window.addEventListener("keydown", onKey);
        return () => {
          window.removeEventListener("mousedown", onDown);
          window.removeEventListener("keydown", onKey);
        };
      }, [anchor, onClose]);
      if (!anchor) return null;
      // `top` wins when the caller is anchoring to a pointer (a context menu);
      // otherwise the menu hangs below the button that opened it.
      const top = Number.isFinite(anchor.top) ? anchor.top : (anchor.bottom ?? 0) + 4;
      const style = {
        left: Math.max(6, Math.min(anchor.left ?? 0, (window.innerWidth || 1280) - 216)),
        top: Math.max(6, Math.min(top, (window.innerHeight || 800) - 40 - items.length * 31)),
      };
      // Rendered where it is mounted (inside the shell), not portaled: the
      // popover needs the shell's --sm-* token scope to pick up the theme, and
      // `position: fixed` already lifts it out of the shell's own layout.
      return h(
        "div",
        { className: "ctxmenu open", style, ref },
        items.map((item, index) =>
          item.sep
            ? h("div", { key: "sep-" + index, className: "misep" })
            : h(
                "div",
                {
                  key: item.label,
                  className: "mi" + (item.danger ? " danger" : "") + (item.disabled ? " disabled" : ""),
                  "aria-disabled": item.disabled === true,
                  onClick: () => {
                    // A disabled item states why it cannot run instead of
                    // closing on a no-op the user cannot explain.
                    if (item.disabled) {
                      if (typeof item.onDisabled === "function") {
                        onClose();
                        item.onDisabled();
                      }
                      return;
                    }
                    onClose();
                    item.run();
                  },
                },
                item.icon ? h("span", { className: "ic" }, h(Icon, { name: item.icon, size: 13 })) : null,
                h("span", null, item.label),
                item.key ? h("span", { className: "k" }, item.key) : null,
              ),
        ),
      );
    }

    // ── Dialogs ────────────────────────────────────────────────────────────
    // Confirmations and text prompts used to be window.confirm / window.prompt.
    // window.prompt does not exist in Electron at all (it is disabled in the
    // renderer and returns null), which is why 新建文件夹 silently did nothing;
    // window.confirm works but it is a browser box that ignores the DSH theme
    // and blocks the renderer while it is open.
    //
    // Every dialog now goes through `useDialogs`, which resolves a promise and
    // renders one local component. It is deliberately *not* DSH's Modal: that
    // primitive paints at the app's dialog tier, which is below this panel, so
    // a confirmation opened from here would land underneath the window that
    // opened it. The local layer sits above the panel and above the context
    // menu instead (see .fmodal in the stylesheet).

    /** A tiny imperative queue owner: one dialog at a time, promise-based. */
    function useDialogs() {
      const [dialog, setDialog] = useState(null);
      const promptRef = useRef(null);

      const settle = useCallback((value) => {
        setDialog((previous) => {
          previous?.resolve?.(value);
          return null;
        });
      }, []);

      const confirm = useCallback(
        (options) =>
          new Promise((resolve) => {
            setDialog({
              kind: "confirm",
              title: options?.title ?? "确认",
              message: options?.message ?? "",
              confirmLabel: options?.confirmLabel ?? "确定",
              cancelLabel: options?.cancelLabel ?? "取消",
              danger: options?.danger === true,
              // `acknowledge` turns a destructive confirm into DSH's
              // RiskConfirmation, which requires ticking a box first. That is
              // what the official UI does for "this cannot be undone".
              acknowledge:
                options?.acknowledge === true
                  ? options.acknowledgeLabel ?? "我明白此操作不可撤销"
                  : null,
              message2: options?.message ?? "",
              resolve,
            });
          }),
        [],
      );

      const ask = useCallback(
        (options) =>
          new Promise((resolve) => {
            setDialog({
              kind: "prompt",
              title: options?.title ?? "输入",
              message: options?.message ?? "",
              placeholder: options?.placeholder ?? "",
              value: options?.value ?? "",
              confirmLabel: options?.confirmLabel ?? "确定",
              cancelLabel: options?.cancelLabel ?? "取消",
              maxLength: Number.isFinite(options?.maxLength) ? options.maxLength : 64,
              validate: typeof options?.validate === "function" ? options.validate : null,
              resolve,
            });
          }),
        [],
      );

      const host = h(DialogHost, { dialog, promptRef, onSettle: settle });
      // `open` lets the panel stand its own shortcuts down while a dialog owns
      // the keyboard.
      return { confirm, ask, host, open: dialog !== null };
    }

    /**
     * The dialog itself.
     *
     * Three shapes, in order of preference:
     *   1. destructive with a native RiskConfirmation — a typed acknowledgement
     *      in the app's own warning layout;
     *   2. native Modal — the app's mask, focus trap, Escape and stacking;
     *   3. the local fallback, for a host that exposes no primitives.
     */
    function DialogHost({ dialog, promptRef, onSettle }) {
      const [acknowledged, setAcknowledged] = useState(false);
      const [value, setValue] = useState("");
      const [error, setError] = useState("");

      useEffect(() => {
        // A new dialog always starts clean: a stale acknowledgement or a
        // half-typed name must never leak from the previous one.
        setAcknowledged(false);
        setValue(dialog?.kind === "prompt" ? dialog.value ?? "" : "");
        setError("");
      }, [dialog]);

      if (!dialog) return null;

      const close = () => onSettle(dialog.kind === "prompt" ? null : false);
      const submit = () => {
        if (dialog.kind === "prompt") {
          const text = value.trim();
          if (dialog.validate) {
            const verdict = dialog.validate(text);
            if (verdict !== true) {
              setError(typeof verdict === "string" ? verdict : "输入不合法");
              return;
            }
          }
          onSettle(text);
          return;
        }
        onSettle(true);
      };

      // Every confirmation and prompt is drawn here, by the plugin, on the
      // dialog layer of the stylesheet — never by DSH's Modal primitive. That
      // primitive lives at the app's dialog tier, which this panel sits above,
      // so a "higher" dialog rendered through it ends up *under* the panel that
      // opened it. One local implementation means one predictable layer, and
      // destructive actions get the same 我明白此操作不可撤销 acknowledgement.
      return h(
        "div",
        {
          className: "fmodal open",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": dialog.title,
          onMouseDown: (event) => {
            // Only a press that starts on the backdrop dismisses: a drag that
            // ends outside the card (selecting text, moving the pointer) must
            // not throw the dialog away.
            if (event.target === event.currentTarget) close();
          },
        },
        h(
          "div",
          { className: "fdlg" },
          h(
            "div",
            { className: "fhead" },
            h("span", { className: "ftitle" }, dialog.title),
            h("span", { className: "spacer" }),
            h("button", { type: "button", className: "wbtn", title: "关闭", onClick: close }, h(Icon, { name: "x", size: 13 })),
          ),
          h(
            "div",
            { className: "fbody" },
            dialog.message ? h("p", { className: "se-dlg-msg" }, dialog.message) : null,
            dialog.kind === "prompt"
              ? h("input", {
                  ref: promptRef,
                  className: "se-dlg-input",
                  value,
                  placeholder: dialog.placeholder,
                  maxLength: dialog.maxLength,
                  autoFocus: true,
                  spellCheck: false,
                  onChange: (event) => {
                    setValue(event.target.value);
                    setError("");
                  },
                  onKeyDown: (event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submit();
                    }
                  },
                })
              : null,
            error ? h("p", { className: "se-dlg-err" }, error) : null,
            dialog.acknowledge
              ? h(
                  "label",
                  { className: "se-dlg-ack" },
                  h("input", {
                    type: "checkbox",
                    checked: acknowledged,
                    onChange: (event) => setAcknowledged(event.target.checked),
                  }),
                  h("span", null, dialog.acknowledge),
                )
              : null,
          ),
          h(
            "div",
            { className: "ffoot" },
            h("span", { className: "spacer" }),
            h("button", { type: "button", className: "act", onClick: close }, dialog.cancelLabel),
            h(
              "button",
              {
                type: "button",
                className: "act primary",
                disabled: dialog.acknowledge ? !acknowledged : false,
                onClick: submit,
              },
              dialog.confirmLabel,
            ),
          ),
        ),
      );
    }

    // ── Panel ──────────────────────────────────────────────────────────────
    function Panel({ t }) {
      const [boot, setBoot] = useState({ phase: "loading", data: null, error: null });
      const stored = useRef(readLayout()).current;
      const initialScope = typeof stored.scope === "string" ? stored.scope : FIXED.root;
      /**
       * Tabs.
       *
       * A tab is { id, scope, history, cursor, checked }: everything a tab is
       * *for* is the ability to stand in two places at once without losing the
       * other one's selection. Sort/view/filter stay panel-wide — they describe
       * how a list is drawn, not which list is open, and duplicating them per
       * tab would make the toolbar disagree with itself.
       *
       * The tab list is persisted with the rest of the layout, so reopening the
       * panel restores the same tabs; a stale tab whose scope no longer exists
       * degrades to 根目录 instead of failing the whole restore.
       */
      const initialTabs = Array.isArray(stored.tabs) && stored.tabs.length > 0
        ? stored.tabs
            .filter((tab) => tab && typeof tab.scope === "string")
            .map((tab, index) => ({
              id: typeof tab.id === "string" && tab.id ? tab.id : "t" + index + "-" + Date.now().toString(36),
              scope: tab.scope,
              history: Array.isArray(tab.history) && tab.history.length > 0 ? tab.history : [tab.scope],
              cursor: Number.isInteger(tab.cursor) ? tab.cursor : 0,
              checked: Array.isArray(tab.checked) ? tab.checked : [],
            }))
        : null;
      const [tabs, setTabs] = useState(() => initialTabs ?? [{ id: "t0", scope: initialScope, history: [initialScope], cursor: 0, checked: [] }]);
      const initialTabIndex = (() => {
        const index = Number(stored.activeTab);
        return Number.isInteger(index) && index >= 0 && index < (initialTabs?.length ?? 1) ? index : 0;
      })();
      const [activeTab, setActiveTab] = useState(initialTabIndex);
      const [scope, setScope] = useState(() => initialTabs?.[initialTabIndex]?.scope ?? initialScope);
      const [history, setHistory] = useState(() => initialTabs?.[initialTabIndex]?.history ?? [initialScope]);
      const [cursor, setCursor] = useState(() => initialTabs?.[initialTabIndex]?.cursor ?? 0);
      // Whether the browser component is ready; refreshed by /bootstrap and by
      // the settings page. Drives the 独立窗口 button and the mode chip.
      const [componentReady, setComponentReady] = useState(
        (stored.componentPhase ?? "absent") === "ready",
      );

      /**
       * Open (or focus) the detached window.
       *
       * The button and Ctrl+Shift+D both land here. When the component is not
       * installed the click is not a silent no-op: it says what is missing and
       * where to get it, because "nothing happened" is the worst possible answer
       * for a button that looks available.
       */
      const openDetachedWindow = useCallback(async () => {
        if (!componentReady) {
          setHint("独立窗口需要先下载浏览器组件：设置 → 会话资源管理器 → 浏览器组件");
          return;
        }
        try {
          await apiSend("POST", "/detached/open", {});
          // The window is outside this page; leaving the in-app panel on top
          // would just be a second copy of what the user asked to move out.
          panelStore.set(false);
        } catch (error) {
          setHint(String(error?.message ?? error));
        }
      }, [componentReady]);


      const openDetachedWindowRef = useRef(openDetachedWindow);
      openDetachedWindowRef.current = openDetachedWindow;
      const [selected, setSelected] = useState(null);
      const [checked, setChecked] = useState(() => new Set());
      const [query, setQuery] = useState("");
      // Sort state is a field plus a direction, not a cycle: the toolbar shows
      // both, and a click on a column header only changes the field (keeping
      // the direction the user chose).
      const [sortKey, setSortKey] = useState(
        SORT_FIELDS.some((field) => field.key === stored.sortKey) ? stored.sortKey : "updated",
      );
      const [sortDir, setSortDir] = useState(stored.sortDir === "asc" ? "asc" : "desc");
      const [view, setView] = useState(stored.view ?? "details");
      const [showDetail, setShowDetail] = useState(stored.showDetail !== false);
      // 根目录 starts open: it is the app's home, and a collapsed root would
      // show an empty 目录 section on first launch.
      const [expanded, setExpanded] = useState(
        () => new Set(Array.isArray(stored.expanded) ? stored.expanded : [FIXED.root]),
      );
      // Collapsed parents in the session list (subagent disclosure), kept apart
      // from `expanded` because the tree and the list collapse independently.
      const [collapsed, setCollapsed] = useState(() => new Set());
      const [navWidth, setNavWidth] = useState(Number(stored.navWidth) || 260);
      const [detailWidth, setDetailWidth] = useState(Number(stored.detailWidth) || 320);
      const [colWidths, setColWidths] = useState(() => ({
        name: 260, tags: 116, note: 150, updated: 104, size: 74, status: 78,
        ...(stored.colWidths && typeof stored.colWidths === "object" ? stored.colWidths : {}),
      }));
      const [hint, setHint] = useState("");
      // List filter (筛选). A view state, so it persists with the rest of the
      // layout instead of being re-picked on every open.
      const [filter, setFilter] = useState(() => ({
        favorite: stored.filter?.favorite ?? "all",
        archived: stored.filter?.archived ?? "all",
        todo: stored.filter?.todo ?? "all",
        tags: Array.isArray(stored.filter?.tags) ? stored.filter.tags : [],
        // 范围: "scope" narrows the current container, "all" applies the same
        // predicates to every session the panel can see. It is part of the
        // filter (not a separate switch) because "收藏 but only here" and
        // "收藏 everywhere" are two readings of the same question.
        scope: stored.filter?.scope === "all" ? "all" : "scope",
      }));
      const [filterOpen, setFilterOpen] = useState(false);
      // The 更多 menu is the only popover in the panel; null means closed.
      const [more, setMore] = useState(null);
      const [sortOpen, setSortOpen] = useState(null);
      const [createOpen, setCreateOpen] = useState(null);
      const newSessionRef = useRef(null);
      const selectionTargetRef = useRef(null);
      // The row context menu, anchored to the pointer.
      const [contextMenu, setContextMenu] = useState(null);
      // F2 is registered once, above the callbacks it calls; the ref keeps the
      // listener stable while still reaching the current implementation.
      const renameCurrentRef = useRef(null);
      const dialogOpenRef = useRef(false);
      // The row being renamed: { kind, id, value, original }. One at a time —
      // two open editors would race on the same list (m02120).
      const [renaming, setRenaming] = useState(null);
      // Undo is deliberately shallow: it remembers the inverse of the last few
      // destructive actions, not a full history (S6 asks for "one step back",
      // not time travel). Entries are closures, so each one captures exactly
      // the ids it touched.
      const undoStack = useRef([]);
      const [now, setNow] = useState(() => Date.now());
      const [bp, setBp] = useState("wide");
      const shellRef = useRef(null);
      const searchRef = useRef(null);

      const load = useCallback(async (refresh) => {
        setBoot((previous) => ({ ...previous, phase: previous.data ? "refreshing" : "loading", error: null }));
        try {
          const data = await apiGet("/bootstrap" + (refresh ? "?refresh=1" : ""));
          // The component phase is what enables 独立窗口, and it can change while
          // the panel is open (the settings page installs it), so every reload
          // folds the host's answer in instead of trusting the remembered one.
          setComponentReady((data?.capabilities?.component ?? "absent") === "ready");
          setBoot({ phase: "ready", data, error: null });
        } catch (error) {
          setBoot({ phase: "error", data: null, error: String(error?.message ?? error) });
        }
      }, []);

      useEffect(() => {
        load(false);
      }, [load]);

      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
      }, []);

      // Layout memory: writing on each change keeps the persisted snapshot in
      // sync without a debounce, because every value here changes at human speed.
      useEffect(() => {
        mergeLayout({
          scope,
          view,
          sortKey,
          sortDir,
          showDetail,
          navWidth,
          detailWidth,
          colWidths,
          expanded: [...expanded],
          filter,
          // The tabs as they should be remembered: the active tab carries the
          // live editing state, every other tab what it had when it was left.
          tabs: tabs.map((tab, index) =>
            index === activeTab ? { ...tab, scope, history, cursor, checked: [...checked] } : tab,
          ),
          activeTab,
          componentPhase: componentReady ? "ready" : "absent",
        });
      }, [scope, history, cursor, checked, view, sortKey, sortDir, showDetail, navWidth, detailWidth, colWidths, expanded, filter, tabs, activeTab, componentReady]);

      useEffect(() => {
        const onKey = (event) => {
          // While a dialog or an inline editor owns the keyboard, the panel's
          // own shortcuts must not also fire (Escape would close the panel
          // behind the dialog that is being dismissed).
          const typing =
            event.target &&
            (event.target.tagName === "INPUT" ||
              event.target.tagName === "TEXTAREA" ||
              event.target.isContentEditable);
          if (event.key === "Escape") {
            if (typing) return;
            if (query) {
              setQuery("");
              return;
            }
            panelStore.set(false);
          }
          if (typing) return;
          if (event.key === "F2") {
            // A dialog is open: F2 belongs to it, not to the list behind it.
            if (dialogOpenRef.current) return;
            event.preventDefault();
            renameCurrentRef.current?.();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "e") {
            event.preventDefault();
            searchRef.current?.focus();
            return;
          }
          // Ctrl+N is the one shortcut the 新建 menu advertises, so it has to
          // exist. It is claimed here rather than left to the browser, which
          // would open a new DSH window instead of a draft.
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
            event.preventDefault();
            newSessionRef.current?.();
          }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [query]);

      // Ctrl+Z undoes the last destructive write (S6). It is registered apart
      // from the Escape handler so a rename in progress can swallow the key
      // first: while an inline editor is open, Ctrl+Z belongs to the browser's
      // own text undo, not to the session list.
      const undo = useCallback(async () => {
        const entry = undoStack.current.pop();
        if (!entry) {
          setHint("没有可撤销的操作");
          return;
        }
        try {
          await entry.run();
          await load(true);
          setHint(entry.label);
        } catch (error) {
          setHint(String(error?.message ?? error));
          undoStack.current.push(entry);
        }
      }, [load]);

      useEffect(() => {
        const onUndo = (event) => {
          if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
          const element = event.target;
          const typing =
            element &&
            (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable);
          if (typing) return;
          event.preventDefault();
          undo();
        };
        window.addEventListener("keydown", onUndo);
        return () => window.removeEventListener("keydown", onUndo);
      }, [undo]);

      // The prototype switches layout by measured width, not by media query,
      // because the panel is a floating window whose width is independent of
      // the window size.
      useEffect(() => {
        const element = shellRef.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
          const width = element.getBoundingClientRect().width;
          setBp(width >= 1000 ? "wide" : width >= 760 ? "mid" : "narrow");
        });
        observer.observe(element);
        return () => observer.disconnect();
      }, []);

      const data = boot.data;
      const tree = data?.tree;
      // Trashed sessions are not in `sessions` any more: their payload has left
      // DSH's sessions tree, so the host can only describe them from the bin
      // index. They still have to be listed here, because 回收站 is a view over
      // this very array (and the detail pane edits them the same way).
      const allSessions = useMemo(
        () => [...(data?.sessions ?? []), ...(data?.trashed ?? [])],
        [data],
      );

      // Settings live on the host so they follow the user across browsers; the
      // shape is normalised there, so these fallbacks only matter for the first
      // paint before /bootstrap lands.
      const settings = data?.settings ?? null;
      // The list switches (自动折叠 / 显示已归档) are panel-wide preferences that
      // the 更多 menu toggles. They live in the settings document, so the
      // settings page and this menu always agree — the menu is a shortcut, not
      // a second source of truth.
      const listSettings = {
        autoCollapse: settings?.list?.autoCollapse === true,
        showArchived: settings?.list?.showArchived !== false,
      };
      /**
       * Write one list preference and fold the answer back into the bootstrap
       * document, so the toggle reflects the host's normalised value instead of
       * the optimistic guess.
       */
      const saveListSettings = useCallback(async (patch) => {
        try {
          const result = await apiSend("PUT", "/settings", { list: patch });
          setBoot((previous) =>
            previous.data
              ? { ...previous, data: { ...previous.data, settings: result.settings } }
              : previous,
          );
        } catch (error) {
          setHint(String(error?.message ?? error));
        }
      }, []);
      /**
       * 更多设置… opens DSH's own settings window on this plugin's section.
       *
       * `openSettingsSection` is captured from the shell's onboarding roster
       * (see apply()) — it is the only public path into the settings modal's
       * navigation. The panel does not draw its own settings surface: DSH has
       * one settings UI, and this button goes to it.
       *
       * When the host provides no such slot the button says so instead of
       * silently doing nothing.
       */
      const openSettingsPage = useCallback(() => {
        // Only one layer at a time: a command menu left open behind the
        // settings window would still answer the pointer when it closes.
        setMore(null);
        if (typeof openSettingsSection !== "function") {
          setHint("当前 DSH 版本没有开放设置页跳转，请从侧边栏打开 设置");
          return;
        }
        try {
          openSettingsSection("session-explorer");
          // The panel is an overlay over the app; the settings window wants
          // the screen, so step out of the way.
          panelStore.set(false);
        } catch (error) {
          setHint(String(error?.message ?? error));
        }
      }, []);
      const sizing = settings?.shell?.modal?.sizing === "percent" ? "percent" : "fixed";
      // One attribute carries the size: the fixed presets and the percentage
      // presets never overlap, so the CSS can key off data-size alone once
      // data-sizing says which vocabulary it belongs to.
      const modalSize = sizing === "percent"
        ? settings?.shell?.modal?.percent ?? "p70"
        : settings?.shell?.modal?.size ?? "md";
      const modalDim = Number(settings?.shell?.modal?.dim) || 0;
      const closeOnBackdrop = settings?.shell?.modal?.closeOnBackdrop !== false;

      /**
       * 自动折叠: entering a container folds its siblings.
       *
       * "Siblings" means the other children of the same parent, not the whole
       * tree — collapsing everything on every navigation made the tree jump
       * back to a single row, which is the opposite of a navigator. The node
       * just entered is expanded; its parent stays open so the path is visible.
       */
      const autoCollapseTo = useCallback(
        (id) => {
          const nodes = tree?.nodes ?? {};
          const parent = nodes[id]?.parent ?? null;
          if (!parent) return;
          const siblings = tree?.children?.[parent] ?? [];
          setExpanded((previous) => {
            const next = new Set(previous);
            next.add(parent);
            next.add(id);
            for (const sibling of siblings) if (sibling !== id) next.delete(sibling);
            return next;
          });
        },
        [tree],
      );

      const navigate = useCallback(
        (next) => {
          if (!next) return;
          if (listSettings.autoCollapse) autoCollapseTo(next);
          setScope(next);
          setChecked(new Set());
          setSelected(null);
          setHistory((previous) => {
            const trimmed = previous.slice(0, cursor + 1);
            if (trimmed[trimmed.length - 1] === next) return previous;
            const merged = [...trimmed, next];
            setCursor(merged.length - 1);
            return merged;
          });
        },
        [autoCollapseTo, cursor, listSettings.autoCollapse],
      );

      const goBack = useCallback(() => {
        setCursor((index) => {
          const next = Math.max(0, index - 1);
          setScope(history[next] ?? FIXED.root);
          return next;
        });
      }, [history]);

      const goForward = useCallback(() => {
        setCursor((index) => {
          const next = Math.min(history.length - 1, index + 1);
          setScope(history[next] ?? FIXED.root);
          return next;
        });
      }, [history]);

      // ── tabs ─────────────────────────────────────────────────────────────
      // The tab strip is the panel's own, not the browser's: each tab keeps its
      // own scope, back/forward history and checked set, and switching tabs is
      // the only operation that writes one into the other. The live editing
      // state (scope/history/cursor/checked) stays in the same four state
      // variables the rest of the panel already uses, so nothing downstream has
      // to know a tab exists.
      const snapshotActiveTab = useCallback(
        () => ({ scope, history, cursor, checked: [...checked] }),
        [checked, cursor, history, scope],
      );

      const applyTab = useCallback((tab) => {
        setScope(tab.scope);
        setHistory(tab.history);
        setCursor(tab.cursor);
        setChecked(new Set(tab.checked));
        setSelected(null);
      }, []);

      const switchTab = useCallback(
        (index) => {
          if (index === activeTab || !tabs[index]) return;
          const next = tabs.map((tab, position) =>
            position === activeTab ? { ...tab, ...snapshotActiveTab() } : tab,
          );
          setTabs(next);
          setActiveTab(index);
          applyTab(next[index]);
        },
        [activeTab, applyTab, snapshotActiveTab, tabs],
      );

      const addTab = useCallback(() => {
        const nextTabs = tabs.map((tab, position) =>
          position === activeTab ? { ...tab, ...snapshotActiveTab() } : tab,
        );
        // A new tab opens where the user is standing: duplicating the scope is
        // more useful than always landing on 根目录, and both tabs keep separate
        // histories from there.
        const tab = {
          id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          scope,
          history: [scope],
          cursor: 0,
          checked: [],
        };
        nextTabs.push(tab);
        setTabs(nextTabs);
        setActiveTab(nextTabs.length - 1);
        applyTab(tab);
        setHint("已新建标签页");
      }, [activeTab, applyTab, scope, snapshotActiveTab, tabs]);

      const closeTab = useCallback(
        (index) => {
          if (tabs.length <= 1) {
            setHint("至少保留一个标签页");
            return;
          }
          const nextTabs = tabs
            .map((tab, position) => (position === activeTab ? { ...tab, ...snapshotActiveTab() } : tab))
            .filter((_, position) => position !== index);
          const nextActive = index < activeTab ? activeTab - 1 : index > activeTab ? activeTab : Math.min(activeTab, nextTabs.length - 1);
          setTabs(nextTabs);
          setActiveTab(nextActive);
          applyTab(nextTabs[nextActive]);
        },
        [activeTab, applyTab, snapshotActiveTab, tabs],
      );

      /** Drag a tab onto another to reorder the strip. */
      const moveTab = useCallback(
        (from, to) => {
          if (from === to || from < 0 || to < 0 || from >= tabs.length || to >= tabs.length) return;
          const nextTabs = tabs.map((tab, position) =>
            position === activeTab ? { ...tab, ...snapshotActiveTab() } : tab,
          );
          const [moved] = nextTabs.splice(from, 1);
          nextTabs.splice(to, 0, moved);
          setTabs(nextTabs);
          setActiveTab(to);
        },
        [activeTab, snapshotActiveTab, tabs],
      );

      /** A tab's label: the same words the breadcrumb's last crumb uses. */
      const titleOfScope = useCallback(
        (id) => {
          const node = tree?.nodes?.[id];
          return FIXED_META[id]?.label ?? node?.name ?? node?.path ?? "会话";
        },
        [tree],
      );

      /** A tab's glyph, following the same node-kind table as the tree. */
      const iconOfScope = useCallback(
        (id) => {
          const meta = FIXED_META[id];
          if (meta) return meta.icon;
          return iconOfNode(tree?.nodes?.[id]);
        },
        [tree],
      );

      // Tab and window shortcuts, registered apart from Escape/F2 so this
      // effect's dependency list stays about tabs and the chrome key.
      // Ctrl+T / Ctrl+W are the browser's own pair, so a panel that draws tabs
      // has to claim them while focused; Ctrl+Tab cycles and Ctrl+1…9 jumps.
      useEffect(() => {
        const onKey = (event) => {
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
          const element = event.target;
          const typing =
            element &&
            (element.tagName === "INPUT" ||
              element.tagName === "TEXTAREA" ||
              element.isContentEditable);
          if (typing || dialogOpenRef.current) return;
          // Shift+D is 在独立窗口中打开; everything below is shift-free.
          if (event.shiftKey) {
            if (event.key.toLowerCase() === "d") {
              event.preventDefault();
              openDetachedWindowRef.current?.();
              return;
            }
            if (event.key === "Tab" && tabs.length > 1) {
              event.preventDefault();
              switchTab((activeTab - 1 + tabs.length) % tabs.length);
            }
            return;
          }
          const key = event.key.toLowerCase();
          if (key === "t") {
            event.preventDefault();
            addTab();
            return;
          }
          if (key === "w") {
            event.preventDefault();
            closeTab(activeTab);
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            if (tabs.length > 1) switchTab((activeTab + 1) % tabs.length);
            return;
          }
          if (/^[1-9]$/.test(event.key)) {
            const index = Number(event.key) - 1;
            if (index < tabs.length) {
              event.preventDefault();
              switchTab(index);
            }
          }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [activeTab, addTab, closeTab, switchTab, tabs]);


      const sessionsInScope = useMemo(() => {
        if (!data) return [];
        if (scope === FIXED.trash) return allSessions.filter((session) => session.trashed);
        // Everything outside the bin sees live sessions only: a trashed session
        // keeps its flags in the annotations sidecar, but it must not reappear
        // under 收藏 or 根目录 while its payload sits in the bin.
        const live = allSessions.filter((session) => !session.trashed);
        if (scope === FIXED.favorites) return live.filter((session) => session.favorite);
        if (scope === FIXED.ungrouped) return live.filter((session) => !session.workspaceId);
        if (scope === FIXED.todos) return live.filter((session) => session.todo);

        // Everything below 根目录 collects the workspace ids of every descendant
        // node, so a user folder (P2) shows its whole subtree.
        const nodes = tree?.nodes ?? {};
        const childMap = tree?.children ?? {};
        const workspaceIds = new Set();
        const seen = new Set();
        const stack = [scope];
        while (stack.length > 0) {
          const id = stack.pop();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const workspaceId = nodes[id]?.workspaceId ?? (id.startsWith("w-") ? id.slice(2) : null);
          if (workspaceId) workspaceIds.add(workspaceId);
          for (const child of childMap[id] ?? []) stack.push(child);
        }

        if (scope === FIXED.root) return live;
        if (workspaceIds.size === 0) return [];
        return live.filter((session) => session.workspaceId && workspaceIds.has(session.workspaceId));
      }, [allSessions, data, scope, tree]);

      // ── filter ───────────────────────────────────────────────────────────
      // The prototype's 筛选 dialog: a set of predicates applied on top of the
      // scope. It is a view, never a write: clearing it restores exactly the
      // scope's own listing. 回收站 ignores it, because a bin that hides its
      // contents is a bin you cannot empty.
      const filteredInScope = useMemo(() => {
        // 回收站 ignores the filter: a bin that hides its contents is a bin you
        // cannot empty. 全局 scope applies the predicates to the whole library
        // instead of the current container, which is what "find every 收藏"
        // means when you are standing three folders deep.
        if (scope === FIXED.trash) return sessionsInScope;
        const base = filter.scope === "all" ? allSessions.filter((session) => !session.trashed) : sessionsInScope;
        return base.filter((session) => {
          if (filter.favorite !== "all" && session.favorite !== (filter.favorite === "yes")) return false;
          if (filter.archived !== "all" && session.archived !== (filter.archived === "yes")) return false;
          if (filter.todo !== "all" && session.todo !== (filter.todo === "yes")) return false;
          if (filter.tags.length > 0) {
            const tags = new Set(session.tags ?? []);
            // Every selected tag must be present: tags intersect, they do not
            // union, or picking two would widen the result instead of narrowing.
            if (!filter.tags.every((tag) => tags.has(tag))) return false;
          }
          return true;
        });
      }, [allSessions, filter, scope, sessionsInScope]);

      const current = useMemo(() => allSessions.find((session) => session.id === selected) ?? null, [allSessions, selected]);

      /**
       * The container the detail pane describes when no session is selected.
       *
       * It follows the *selection* first and the scope second. Reading only the
       * scope was a real bug: selecting a workspace row in the list left the
       * scope on 根目录, so the detail pane showed the root — a folder — and a
       * workspace was reported as 文件夹.
       */
      const focusNode = useMemo(() => {
        if (current) return null;
        const picked = selected ? tree?.nodes?.[selected] ?? null : null;
        return picked ?? tree?.nodes?.[scope] ?? null;
      }, [current, scope, selected, tree]);

      // Subagent relations, both directions: the detail pane shows where a child
      // came from and how many children a parent has. Forks are deliberately
      // excluded — a fork is an independent session, not a child (m01340).
      const sessionsById = useMemo(() => new Map(allSessions.map((session) => [session.id, session])), [allSessions]);
      const parent = useMemo(
        () => (current?.isSubagent && current.parentSession ? sessionsById.get(current.parentSession) ?? null : null),
        [current, sessionsById],
      );
      const currentChildren = useMemo(
        () => (current ? allSessions.filter((session) => session.isSubagent && session.parentSession === current.id) : []),
        [allSessions, current],
      );
      const forkSource = useMemo(
        () => (current && !current.isSubagent && current.parentSession ? sessionsById.get(current.parentSession) ?? null : null),
        [current, sessionsById],
      );
      const currentForks = useMemo(
        () => (current ? allSessions.filter((session) => !session.isSubagent && session.parentSession === current.id) : []),
        [allSessions, current],
      );

      // Selecting a child from the detail pane must also reveal it in the list,
      // which means un-collapsing its ancestors first.
      const selectAndReveal = useCallback(
        (id) => {
          if (!id) return;
          setCollapsed((previous) => {
            let next = previous;
            const self = sessionsById.get(id);
            let cursorId = self?.isSubagent ? self.parentSession ?? null : null;
            let guard = 0;
            while (cursorId && guard < 32) {
              if (next.has(cursorId)) {
                if (next === previous) next = new Set(previous);
                next.delete(cursorId);
              }
              const ancestor = sessionsById.get(cursorId);
              cursorId = ancestor?.isSubagent ? ancestor.parentSession ?? null : null;
              guard += 1;
            }
            return next;
          });
          setSelected(id);
        },
        [sessionsById],
      );

      /**
       * 打开 — the detail pane's primary action.
       *
       * DSH owns session navigation: ctx.uiWorkspace.openSession(id) swaps the
       * main view. The plugin must not invent its own route into the chat, or a
       * session opened from here would be a second, divergent main view. A
       * trashed session has no payload left for DSH to open, so it is refused
       * with a readable hint instead of a silent no-op.
       */
      const openInDsh = useCallback(
        (sessionId) => {
          if (!sessionId) return;
          const session = sessionsById.get(sessionId) ?? null;
          if (session?.trashed) {
            setHint("会话在回收站里，先还原才能在 DSH 中打开");
            return;
          }
          const uiWorkspace = serviceOf("uiWorkspace");
          if (!uiWorkspace || typeof uiWorkspace.openSession !== "function") {
            setHint("当前 DSH 版本没有开放会话导航接口");
            return;
          }
          try {
            uiWorkspace.openSession(sessionId);
            // The panel is an overlay: leaving it open would cover the main view
            // the user just asked for.
            panelStore.set(false);
          } catch (error) {
            setHint(String(error?.message ?? error));
          }
        },
        [sessionsById],
      );

      const counts = tree?.counts ?? {};
      const scopeCount = counts[scope] ?? sessionsInScope.length;
      const archivedInScope = filteredInScope.filter((session) => session.archived).length;
      const totalSize = filteredInScope.reduce((sum, session) => sum + (session.sizeBytes ?? 0), 0);
      const filterActive =
        filter.scope === "all" ||
        filter.favorite !== "all" ||
        filter.archived !== "all" ||
        filter.todo !== "all" ||
        filter.tags.length > 0;

      const crumbs = useMemo(() => crumbsFor(tree, scope), [tree, scope]);

      const toggleExpanded = useCallback((id) => {
        setExpanded((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, []);


      const toggleChildren = useCallback((id) => {
        setCollapsed((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, []);

      const selectRow = useCallback((id, event) => {
        setSelected(id);
        // A container row is not a session: clicking it selects the container
        // (so the detail pane describes it) without touching the session
        // check-set. Checking is the checkbox's own gesture.
        if (tree?.nodes?.[id]) {
          setChecked(new Set());
          return;
        }
        setChecked((previous) => {
          if (event && (event.ctrlKey || event.metaKey)) {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }
          return new Set([id]);
        });
      }, [tree]);

      const checkRow = useCallback((id) => {
        setChecked((previous) => {
          if (id === null) return new Set();
          if (id === "all") {
            if (previous.size > 0) return new Set();
            return new Set(filteredInScope.map((session) => session.id));
          }
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, [filteredInScope]);

      /** A column header picks the field; clicking the active one flips direction. */
      const cycleSort = useCallback((key) => {
        setSortKey((previous) => {
          if (previous === key) {
            setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
            return previous;
          }
          setSortDir(SORT_DEFAULT_DIR[key] ?? "desc");
          return key;
        });
      }, []);

      const resizeColumn = useCallback((event, key) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startWidth = colWidths[key] ?? 100;
        const move = (moveEvent) => {
          const raw = startWidth + (moveEvent.clientX - startX);
          const width = Math.max(key === "size" ? 54 : 64, Math.min(480, raw));
          setColWidths((previous) => ({ ...previous, [key]: width }));
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }, [colWidths]);

      // 独立窗口 is a separate browser window (P6). Until it ships, 窗口模式 is
      // the plugin's own floating surface with remembered bounds — and there is
      // deliberately no in-page drag: a titlebar that slides the panel around
      // inside DSH is not the detached window the setting promises.


      const resizePane = useCallback((event, side) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = side === "tree" ? navWidth : detailWidth;
        const move = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          if (side === "tree") setNavWidth(Math.max(180, Math.min(420, startWidth + delta)));
          else setDetailWidth(Math.max(240, Math.min(520, startWidth - delta)));
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }, [navWidth, detailWidth]);

      // Every confirmation and prompt is a DSH dialog, rendered by one host at
      // the end of the shell. `dialogs.confirm()` resolves false when the user
      // dismisses it, so callers read like the old window.confirm.
      const dialogs = useDialogs();
      // True while a dialog is on screen, so global shortcuts can stand down.
      dialogOpenRef.current = Boolean(dialogs.open);

      // ── mutations ────────────────────────────────────────────────────────
      // Every write goes through `mutate`, which reloads the snapshot on
      // success and surfaces the host's error text on failure. The panel never
      // guesses at the new state locally: the host owns the tree and the
      // annotations, and a stale local copy is exactly the bug this avoids.
      const mutate = useCallback(
        async (run, successHint) => {
          try {
            await run();
            await load(true);
            if (successHint) setHint(successHint);
            return true;
          } catch (error) {
            setHint(String(error?.message ?? error));
            if (error?.code === "revision-conflict") await load(true);
            return false;
          }
        },
        [load],
      );

      /**
       * Make DSH's own sidebar converge after a cross-workspace move.
       *
       * The plugin edits `workspace.json` and relocates the artifact behind
       * DSH's back, but DSH does not re-read either on its own: the sidebar is
       * driven by a *snapshot* of `session.list` plus a workspace registry
       * snapshot, and it only republishes on mutations DSH itself performed.
       * Without this the moved session exists on disk, is listed by our host
       * (which scans the filesystem), and still shows up in **neither** the old
       * workspace group nor the new one — the exact "移动后会话在 DSH 不显示"
       * report — until the app restarts.
       *
       * `sessions.refresh()` re-pulls that baseline; the Host re-reads
       * persistence and the workspace registry, so a foreign file change is
       * picked up. `workspaces.refresh()` re-pulls the grouping. Both are
       * driven twice more after a delay because the projection checkpoint is
       * written asynchronously and a baseline taken too early can still carry
       * the pre-move cwd.
       */
      const refreshDshViews = useCallback(async () => {
        const pull = async () => {
          const sessions = serviceOf("sessions");
          const workspaces = serviceOf("workspaces");
          await Promise.allSettled([
            typeof sessions?.refresh === "function" ? sessions.refresh() : Promise.resolve(),
            typeof workspaces?.refresh === "function" ? workspaces.refresh() : Promise.resolve(),
          ]);
        };
        await pull();
        setTimeout(() => { void pull(); }, 250);
        setTimeout(() => { void pull(); }, 900);
      }, []);

      const newFolder = useCallback(async (parentId) => {
        // window.prompt is disabled in Electron and returns null, so the old
        // version silently created nothing. The name now comes from a dialog.
        const name = await dialogs.ask({
          title: "新建文件夹",
          message: "文件夹建在当前所在的目录里，取消则不创建。",
          placeholder: "新建文件夹",
          value: "新建文件夹",
          confirmLabel: "创建",
          maxLength: 64,
          validate: (text) => (text ? true : "文件夹名称不能为空"),
        });
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        // A folder is created where the user is looking: an explicit parent
        // (the container that was right-clicked), the current folder when one
        // is selected, otherwise the root. The explicit parent wins because the
        // caller has already navigated and `scope` has not re-rendered yet.
        const explicit = typeof parentId === "string" && parentId ? parentId : null;
        const parent = explicit
          ?? (tree?.nodes?.[scope]?.type === "folder" && !tree.nodes[scope].fixed ? scope : FIXED.root);
        try {
          const result = await apiSend("POST", "/folders", { name: trimmed, parent });
          await load(true);
          // Reveal it: expand the parent in the tree and step into the new
          // folder. Creating something that is then invisible is the bug this
          // whole path exists to avoid, and "visible" means "selected".
          setExpanded((previous) => {
            const next = new Set(previous);
            next.add(parent);
            if (result?.id) next.add(result.id);
            return next;
          });
          if (result?.id) navigate(result.id);
          setHint(`已新建文件夹「${trimmed}」`);
        } catch (error) {
          setHint(String(error?.message ?? error));
          if (error?.code === "revision-conflict") await load(true);
        }
      }, [dialogs, load, navigate, scope, tree]);

      const removeFolder = useCallback(
        async (targetId) => {
          // `targetId` comes from the context menu; without it the command acts
          // on the folder the user is standing in.
          const id = typeof targetId === "string" && targetId ? targetId : scope;
          const node = tree?.nodes?.[id];
          if (!node || node.type !== "folder" || node.fixed) {
            setHint("只有自建文件夹可以删除");
            return;
          }
          const confirmed = await dialogs.confirm({
            title: "删除文件夹",
            message: `删除「${node.name}」？其中的内容会移动到上一级，不会丢失。`,
            confirmLabel: "删除",
            danger: true,
          });
          if (!confirmed) return;
          mutate(() => apiSend("DELETE", `/folders/${encodeURIComponent(id)}?lift=1`), "已删除文件夹");
        },
        [dialogs, mutate, scope, tree],
      );

      /**
       * What the user has selected, resolved to one of two kinds.
       *
       * `selected` holds *either* a session id *or* a tree node id, and the two
       * id spaces are different: a workspace node is `w-<uuid>` while DSH's own
       * record is `<uuid>`, and a folder is `d-<…>`. Every command used to
       * re-derive which kind it had, and two of them got it wrong — which is
       * why a selected workspace could not be renamed or moved. Resolving once,
       * here, is what stops that from happening again.
       */
      const selectionTarget = useMemo(() => {
        if (!selected) return null;
        const node = tree?.nodes?.[selected] ?? null;
        if (node) {
          const isWorkspace = node.type === "workspace";
          return {
            kind: isWorkspace ? "workspace" : "folder",
            node,
            // The id a command must send: DSH's own for a workspace, ours for a
            // folder. `nodeId` stays the tree id for navigation and placement.
            actionId: isWorkspace ? node.workspaceId ?? node.id : node.id,
            nodeId: node.id,
            editable: isWorkspace ? node.kind !== "default-workspace" : node.kind === "folder",
          };
        }
        const session = sessionsById.get(selected) ?? null;
        return session ? { kind: "session", session, actionId: session.id, nodeId: null, editable: true } : null;
      }, [selected, sessionsById, tree]);

      // The list rows the user can act on: the checked set, or the selected row.
      // Containers are included: a workspace or a folder is a thing you move and
      // rename, not only a place you stand in.
      const targets = useMemo(() => {
        const ids = checked.size > 0 ? [...checked] : selected ? [selected] : [];
        return ids.filter((id) => sessionsById.has(id) || Boolean(tree?.nodes?.[id]));
      }, [checked, selected, sessionsById, tree]);

      // ── the bin (S4) ─────────────────────────────────────────────────────
      // 删除 is a real move: the payload leaves DSH's sessions tree, so the
      // session disappears from the official sidebar too. That is what a bin
      // means, and it is why every bin write is paired with an undo entry
      // (S6) — the user can always take the last step back.
      const idsToActOn = useCallback(
        () => (checked.size > 0 ? [...checked] : selected ? [selected] : []).filter((id) => sessionsById.has(id)),
        [checked, selected, sessionsById],
      );

      /** The same set, but only the container nodes in it. */
      const nodeIdsToActOn = useCallback(
        () => (checked.size > 0 ? [...checked] : selected ? [selected] : []).filter((id) => {
          const node = tree?.nodes?.[id];
          return Boolean(node) && !node.fixed && node.kind !== "default-workspace";
        }),
        [checked, selected, tree],
      );

      /**
       * Ids of the checked containers that can actually be deleted.
       *
       * 特殊文件夹 (根目录/未分组/收藏/待办) are excluded here as well as in the
       * row: they have no checkbox, and a programmatic call must not be able to
       * smuggle one in either. A workspace is DSH's own record, so it is not
       * deleted from here — only folders are the plugin's to remove.
       */
      const folderTargets = useCallback(() => {
        // Checked rows first; when nothing is checked, the selected row counts
        // too, so 删除 on a selected folder does what the button says instead of
        // silently deleting the folder the user happens to be standing in.
        const ids = checked.size > 0 ? [...checked] : selected ? [selected] : [];
        return ids.filter((id) => {
          const node = tree?.nodes?.[id];
          return Boolean(node && node.type === "folder" && node.kind === "folder" && !node.fixed);
        });
      }, [checked, selected, tree]);

      const deleteSelection = useCallback(async () => {
        const ids = idsToActOn();
        const folders = folderTargets();
        if (ids.length === 0 && folders.length === 0) {
          // Nothing is checked and no session is selected: 删除 applies to the
          // folder the user is standing in, which is what the button did before
          // the bin existed.
          removeFolder();
          return;
        }
        if (scope === FIXED.trash) {
          // Purging is the one operation with no undo, so it asks for a typed
          // acknowledgement instead of a plain yes/no.
          const confirmed = await dialogs.confirm({
            title: "永久删除",
            message: `永久删除 ${ids.length} 个会话？日志和全部历史都会从磁盘移除。`,
            confirmLabel: "永久删除",
            danger: true,
            acknowledge: true,
            acknowledgeLabel: "我明白此操作不可撤销",
          });
          if (!confirmed) return;
          mutate(() => apiSend("POST", "/purge", { ids }), `已永久删除 ${ids.length} 个会话`);
          return;
        }
        const parts = [];
        if (folders.length > 0) parts.push(`${folders.length} 个文件夹（其中内容会移到上一级）`);
        if (ids.length > 0) parts.push(`${ids.length} 个会话（移入回收站）`);
        const confirmed = await dialogs.confirm({
          title: "删除",
          message: `删除 ${parts.join("，以及 ")}？`,
          confirmLabel: "删除",
          danger: true,
        });
        if (!confirmed) return;
        mutate(async () => {
          // Folders first: deleting a folder lifts its contents to the parent,
          // so the sessions are still there and any session ids in the same
          // batch are unaffected by the order.
          for (const folderId of folders) {
            await apiSend("DELETE", `/folders/${encodeURIComponent(folderId)}?lift=1`);
          }
          if (folders.length > 0) setChecked(new Set());
          if (ids.length === 0) return;
          await apiSend("POST", "/trash", { ids });
          undoStack.current.push({
            label: `已还原 ${ids.length} 个会话`,
            run: () => apiSend("POST", "/restore", { ids }),
          });
        }, folders.length > 0 ? `已删除 ${folders.length} 个文件夹` : `已删除 ${ids.length} 个会话`);
      }, [dialogs, folderTargets, idsToActOn, mutate, removeFolder, scope]);

      const restoreSelection = useCallback(() => {
        const ids = idsToActOn();
        if (ids.length === 0) {
          setHint("先选择要还原的会话");
          return;
        }
        mutate(async () => {
          await apiSend("POST", "/restore", { ids });
          undoStack.current.push({
            label: `已重新删除 ${ids.length} 个会话`,
            run: () => apiSend("POST", "/trash", { ids }),
          });
        }, `已还原 ${ids.length} 个会话`);
      }, [idsToActOn, mutate]);

      const emptyTrashNow = useCallback(async () => {
        const count = allSessions.filter((session) => session.trashed).length;
        if (count === 0) {
          setHint("回收站已经是空的");
          return;
        }
        const confirmed = await dialogs.confirm({
          title: "清空回收站",
          message: `清空回收站？${count} 个会话会被永久删除，日志和历史都不会保留。`,
          confirmLabel: "清空",
          danger: true,
          acknowledge: true,
          acknowledgeLabel: "我明白此操作不可撤销",
        });
        if (!confirmed) return;
        mutate(() => apiSend("POST", "/trash/empty", {}), "已清空回收站");
      }, [allSessions, dialogs, mutate]);

      const toggleFlag = useCallback(
        (flag) => {
          if (targets.length === 0) {
            setHint("先选择要操作的会话");
            return;
          }
          const currentValue = sessionsById.get(targets[0])?.[flag] === true;
          const next = !currentValue;
          mutate(async () => {
            for (const id of targets) {
              await apiSend("PATCH", `/annotations/${encodeURIComponent(id)}`, { [flag]: next });
            }
          }, next ? (flag === "favorite" ? "已加入收藏" : "已加入待办") : flag === "favorite" ? "已取消收藏" : "已取消待办");
        },
        [mutate, sessionsById, targets],
      );

      const setNote = useCallback(
        (id, note) => {
          if (!id) return;
          mutate(() => apiSend("PATCH", `/annotations/${encodeURIComponent(id)}`, { note }));
        },
        [mutate],
      );

      const addTag = useCallback(
        (id, tag) => {
          const session = sessionsById.get(id);
          if (!session) return;
          const tags = [...(session.tags ?? []), tag];
          mutate(() => apiSend("PATCH", `/annotations/${encodeURIComponent(id)}`, { tags }));
        },
        [mutate, sessionsById],
      );

      const removeTag = useCallback(
        (id, tag) => {
          const session = sessionsById.get(id);
          if (!session) return;
          const tags = (session.tags ?? []).filter((entry) => entry !== tag);
          mutate(() => apiSend("PATCH", `/annotations/${encodeURIComponent(id)}`, { tags }));
        },
        [mutate, sessionsById],
      );

      // The tag library is a vocabulary, not a constraint: adding a tag to the
      // library does not tag anything, and dropping one leaves every session
      // that already carries it alone (lib/domain/annotations.js).
      const newTag = useCallback(
        (id, tag) => {
          const session = sessionsById.get(id);
          if (!session || !tag) return;
          const tags = session.tags ?? [];
          mutate(async () => {
            await apiSend("POST", "/tags", { tag });
            if (!tags.includes(tag)) {
              await apiSend("PATCH", `/annotations/${encodeURIComponent(id)}`, { tags: [...tags, tag] });
            }
          }, `已把「${tag}」加入标签库`);
        },
        [mutate, sessionsById],
      );

      const dropTag = useCallback(
        (tag) => {
          if (!tag) return;
          mutate(() => apiSend("DELETE", `/tags/${encodeURIComponent(tag)}`), `已从标签库移除「${tag}」`);
        },
        [mutate],
      );

      const moveNodeTo = useCallback(
        (nodeId, parentId) => {
          mutate(() => apiSend("POST", `/nodes/${encodeURIComponent(nodeId)}/move`, { parent: parentId }), "已移动");
        },
        [mutate],
      );

      /** May the container currently being dragged land on `targetId`? */
      const canDropHere = useCallback(
        (targetId) => {
          const source = dragPayload?.kind === "node" ? dragPayload.id : null;
          if (!source) return false;
          return canDropInTree(source, targetId, tree?.nodes ?? {}, tree?.children ?? {});
        },
        [tree],
      );

      /** Drop a dragged container onto another one (list surface). */
      const moveNodeHere = useCallback(
        (targetId, sourceId) => {
          if (!sourceId || sourceId === targetId) return;
          if (!canDropHere(targetId)) {
            setHint("这里放不下：工作区不能放进工作区，含工作区的文件夹也不能再放一个工作区");
            return;
          }
          moveNodeTo(sourceId, targetId);
        },
        [canDropHere, moveNodeTo],
      );

      // ── native operations ────────────────────────────────────────────────
      // Rename, fork, archive and pin all exist in DSH itself. These callbacks
      // only forward to the host routes that wrap the native services; the
      // plugin stores none of them, so the official UI and this panel always
      // agree (hard constraint 2 / S8).

      // One rename entry point for all three surfaces (detail title row, list
      // row, tree row). `kind` says which store owns the name — a session and a
      // workspace are DSH's own (native calls, nothing stored here), a folder is
      // the plugin's own node.
      const renameEntity = useCallback(
        (kind, id, value) => {
          if (!id || !value) return;
          if (kind === "session") {
            mutate(
              () => apiSend("POST", `/sessions/${encodeURIComponent(id)}/rename`, { title: value }),
              `会话已重命名为「${value}」`,
            );
            return;
          }
          if (kind === "workspace") {
            mutate(
              () => apiSend("POST", `/workspaces/${encodeURIComponent(id)}/rename`, { title: value }),
              `工作区已重命名为「${value}」`,
            );
            return;
          }
          mutate(() => apiSend("PATCH", `/folders/${encodeURIComponent(id)}`, { name: value }), "已重命名");
        },
        [mutate],
      );

      // ── inline rename (m02120) ───────────────────────────────────────────
      // Selecting a row is enough to rename it: the name turns into an input in
      // place, so the list never loses its context the way a dialog would.
      // A workspace is addressed by its native workspaceId, a folder by its own
      // node id — the two id spaces never mix.
      const nodeOfEntity = useCallback(
        (kind, id) => {
          if (kind === "folder") return tree?.nodes?.[id] ?? null;
          if (kind === "workspace") {
            return Object.values(tree?.nodes ?? {}).find((node) => node.workspaceId === id) ?? null;
          }
          return null;
        },
        [tree],
      );

      /**
       * Translate whatever the caller has into the id the owning store expects.
       *
       * The list row hands over a *tree node id* for a workspace (`w-<uuid>`),
       * but DSH's rename takes its own id. Normalising here — not at every call
       * site — is what fixed "重命名工作区没反应": the request used to go out
       * with `w-…` and the host answered workspace/not-found.
       */
      const resolveRenameTarget = useCallback(
        (kind, id) => {
          if (kind === "folder") return id;
          if (kind !== "workspace") return id;
          const node = tree?.nodes?.[id] ?? null;
          if (node?.workspaceId) return node.workspaceId;
          // Already a native id (the context menu and the detail pane pass one).
          return id.startsWith("w-") ? id.slice(2) : id;
        },
        [tree],
      );

      const beginRename = useCallback(
        (kind, id) => {
          if (!id) return;
          id = resolveRenameTarget(kind, id);
          let initial = "";
          if (kind === "session") {
            const session = sessionsById.get(id);
            // A trashed session has no log for DSH to append a title event to;
            // renaming it would fail at the host. Say so instead of opening an
            // editor that cannot commit.
            if (session?.trashed) {
              setHint("回收站里的会话不能重命名，先还原它");
              return;
            }
            // The displayed name, not the raw title: an untitled session shows
            // its cwd folder name, and the user should edit what they see.
            initial = session?.displayTitle ?? session?.title ?? "";
          } else {
            const node = nodeOfEntity(kind, id);
            initial = node?.name ?? "";
          }
          setRenaming({ kind, id, value: initial, original: initial });
        },
        [nodeOfEntity, resolveRenameTarget, sessionsById],
      );

      const cancelRename = useCallback(() => setRenaming(null), []);

      const commitRename = useCallback(() => {
        const draft = renaming;
        setRenaming(null);
        if (!draft) return;
        const value = String(draft.value ?? "").trim();
        // An unchanged or emptied name is a cancel, not a write: a blank title
        // would make the session fall back to its cwd and look like a bug.
        if (!value || value === draft.original) return;
        renameEntity(draft.kind, draft.id, value);
      }, [renaming, renameEntity]);

      const renameProps = useMemo(
        () =>
          renaming
            ? {
                kind: renaming.kind,
                id: renaming.id,
                value: renaming.value,
                onChange: (next) => setRenaming((previous) => (previous ? { ...previous, value: next } : previous)),
                onCommit: commitRename,
                onCancel: cancelRename,
              }
            : null,
        [cancelRename, commitRename, renaming],
      );

      /** Run one native operation over every target session. */
      const forEachTarget = useCallback(
        async (path, body, successHint) => {
          // Only sessions: 归档/置顶/分叉 are DSH's own session lifecycle, and a
          // container can sit in the check-set (folders and workspaces have a
          // checkbox), so it must not be sent to a route that would answer
          // session/not-found.
          const ids = targets.filter((id) => sessionsById.has(id));
          if (ids.length === 0) {
            setHint("先选择要操作的会话");
            return;
          }
          await mutate(async () => {
            for (const id of ids) {
              await apiSend("POST", `/sessions/${encodeURIComponent(id)}${path}`, body ?? {});
            }
          }, successHint);
        },
        [mutate, sessionsById, targets],
      );

      const togglePin = useCallback(() => {
        if (targets.length === 0) {
          setHint("先选择要置顶的会话");
          return;
        }
        if (!sessionsById.has(targets[0])) {
          setHint("置顶只对会话有效");
          return;
        }
        // 最新置顶在最前, so "all pinned" means "the first target is pinned".
        const pinned = sessionsById.get(targets[0])?.pinned === true;
        forEachTarget(pinned ? "/unpin" : "/pin", {}, pinned ? "已取消置顶" : "已置顶");
      }, [forEachTarget, sessionsById, targets]);

      /**
       * 归档 / 取消归档.
       *
       * `value` makes the direction explicit so the 更多 menu can offer both
       * without guessing: the toolbar button toggles (undefined), the menu items
       * ask for a specific direction. Archiving keeps the log and the position,
       * it only de-emphasises the row (hard constraint 3).
       */
      const setArchive = useCallback(async (value) => {
        if (targets.length === 0) {
          setHint("先选择要归档的会话");
          return;
        }
        if (!targets.some((id) => sessionsById.has(id))) {
          setHint("归档只对会话有效");
          return;
        }
        // true = archive, false = unarchive, undefined = toggle off the first row.
        const wantArchive = value === undefined
          ? sessionsById.get(targets[0])?.archived !== true
          : value === true;
        if (!wantArchive) {
          forEachTarget("/unarchive", {}, "已取消归档");
          return;
        }
        // Archiving keeps the log and the position; it only de-emphasises the
        // row (hard constraint 3). A session with running work is refused by the
        // host with workspace/session-active, so the user gets a confirmation
        // instead of a silent failure.
        const running = targets.some((id) => sessionsById.get(id)?.running === true);
        if (running) {
          const confirmed = await dialogs.confirm({
            title: "会话正在运行",
            message: "其中有会话正在运行。停止运行并归档？未完成的回合会被中断。",
            confirmLabel: "停止并归档",
            danger: true,
          });
          if (!confirmed) return;
          forEachTarget("/archive", { stopActivity: true }, "已停止运行并归档");
          return;
        }
        forEachTarget("/archive", {}, "已归档");
      }, [dialogs, forEachTarget, sessionsById, targets]);
      const toggleArchive = useCallback(() => setArchive(undefined), [setArchive]);

      const forkSession = useCallback(() => {
        const session = selected ? sessionsById.get(selected) : null;
        if (!session) {
          setHint("先选择一个会话再分叉");
          return;
        }
        mutate(async () => {
          const result = await apiSend("POST", `/sessions/${encodeURIComponent(session.id)}/fork`, {});
          if (result?.sessionId) setSelected(result.sessionId);
        }, "已分叉出一个新会话");
      }, [mutate, selected, sessionsById]);

      // ── commands that are still placeholders ─────────────────────────────
      // Toggle, not open: the outside-mousedown handler cannot close a menu the
      // same pointer press is about to re-open, so the button owns the switch.
      const moreMenu = useCallback((event) => {
        const element = event?.currentTarget ?? null;
        const rect = element?.getBoundingClientRect?.();
        setMore((previous) =>
          previous
            ? null
            : { element, left: rect?.left ?? 200, bottom: rect?.bottom ?? 100 },
        );
      }, []);

      // ── clipboard (剪切 / 复制 / 粘贴) ────────────────────────────────────
      // The host route is a real cross-workspace move (artifact re-homed + the
      // header cwd rewritten + registry accounting swapped; lib/host/move.js).
      // The clipboard itself is client state: it names the ids and the mode, and
      // it never stores a file — a cut that was never pasted leaves everything
      // exactly where it was, which is what users expect from Explorer.
      const [clipboard, setClipboard] = useState({ mode: null, ids: [], nodes: [] });

      const cutOrCopy = useCallback(
        (mode) => {
          const sessions = idsToActOn();
          const nodes = nodeIdsToActOn();
          if (sessions.length === 0 && nodes.length === 0) {
            setHint("先选择要操作的会话或目录");
            return;
          }
          const blocked = sessions.find((id) => sessionsById.get(id)?.trashed);
          if (blocked) {
            setHint("回收站里的会话不能移动；先还原它");
            return;
          }
          // A container is not pasted into a workspace: it moves to another
          // *folder*. The clipboard carries both kinds so one 剪切/复制 button
          // works on whichever row is selected.
          setClipboard({ mode, ids: sessions, nodes });
          const total = sessions.length + nodes.length;
          const noun = nodes.length > 0 && sessions.length === 0 ? "目录" : "会话";
          setHint(
            mode === "cut"
              ? `已剪切 ${total} 个${noun}，转到目标位置后粘贴`
              : `已复制 ${total} 个${noun}，转到目标位置后粘贴`,
          );
        },
        [idsToActOn, nodeIdsToActOn, sessionsById],
      );

      /**
       * Where a paste would land, as a native workspace id.
       *
       * The clipboard needs a *workspace*, not a tree node: a folder is the
       * plugin's own grouping, and moving a session into it is a virtual
       * placement, not a file move. Reading the nearest workspace from the tree
       * is the same rule the rest of the panel uses (nearestWorkspace on the
       * host, the parent chain here).
       */
      const pasteTarget = useMemo(() => {
        const nodes = tree?.nodes ?? {};
        let cursor = nodes[scope] ?? null;
        const guard = new Set();
        while (cursor && !guard.has(cursor.id)) {
          guard.add(cursor.id);
          if (cursor.workspaceId) return { workspaceId: cursor.workspaceId, name: cursor.name ?? cursor.id };
          cursor = cursor.parent ? nodes[cursor.parent] ?? null : null;
        }
        return null;
      }, [scope, tree]);

      /**
       * Where a *container* paste would land: the node the user is standing in.
       *
       * Sessions need a workspace (that is where a session lives); folders and
       * workspaces need a container, and the current scope already is one. The
       * two targets are separate because "paste a session" and "paste a folder"
       * are different operations with different validity rules.
       */
      const nodePasteTarget = useMemo(() => {
        const node = tree?.nodes?.[scope] ?? null;
        if (!node) return null;
        // A fixed view (收藏 / 待办 / 未分组 / 回收站) is not a directory.
        if (node.fixed && node.id !== FIXED.root) return null;
        return { nodeId: node.id, name: node.name ?? node.id };
      }, [scope, tree]);

      const pasteClipboard = useCallback(async () => {
        if (clipboard.ids.length === 0 && (clipboard.nodes?.length ?? 0) === 0) {
          setHint("剪贴板是空的：先剪切或复制");
          return;
        }
        // Containers first: they are the operation the user can see in the tree,
        // and a session paste below still needs its own workspace target.
        if ((clipboard.nodes?.length ?? 0) > 0) {
          if (!nodePasteTarget) {
            setHint("当前位置不能放目录，先进入一个文件夹或根目录再粘贴");
            return;
          }
          if (clipboard.mode === "copy") {
            setHint("目录不支持复制粘贴；请用拖拽移动");
            return;
          }
          const moving = clipboard.nodes;
          const ok = await mutate(async () => {
            for (const nodeId of moving) {
              if (nodeId === nodePasteTarget.nodeId) continue;
              await apiSend("POST", `/nodes/${encodeURIComponent(nodeId)}/move`, { parent: nodePasteTarget.nodeId });
            }
          }, `已移动 ${moving.length} 个目录到「${nodePasteTarget.name}」`);
          if (!ok) return;
          setClipboard({ mode: null, ids: [], nodes: [] });
          setHint(`已移动 ${moving.length} 个目录到「${nodePasteTarget.name}」`);
          return;
        }
        if (!pasteTarget) {
          setHint("当前位置不属于任何工作区，先进入一个工作区再粘贴");
          return;
        }
        const ids = clipboard.ids;
        const copy = clipboard.mode !== "cut";
        const previous = ids.map((id) => sessionsById.get(id)).filter(Boolean);
        const ok = await mutate(
          () => apiSend("POST", "/move", { ids, target: { workspaceId: pasteTarget.workspaceId }, copy }),
          copy ? `已复制 ${ids.length} 个会话到「${pasteTarget.name}」` : `已移动 ${ids.length} 个会话到「${pasteTarget.name}」`,
        );
        if (!ok) return;
        // A cut is consumed by a successful paste; a copy stays on the
        // clipboard so the user can paste it into several workspaces.
        // DSH's sidebar does not know the file moved until it re-pulls its
        // baseline; do that before the undo entry so the user sees the row in
        // its new workspace while the toast is still on screen.
        await refreshDshViews();
        if (!copy) {
          setClipboard({ mode: null, ids: [], nodes: [] });
          // Undo (S6) sends the sessions back to the workspace they came from,
          // which is itself a move. It is registered only for a cut: undoing a
          // copy would mean deleting the copy, a far more dangerous operation
          // than the one the user asked to take back.
          const groups = new Map();
          for (const session of previous) {
            if (!session.workspaceId || session.workspaceId === pasteTarget.workspaceId) continue;
            const bucket = groups.get(session.workspaceId) ?? [];
            bucket.push(session.id);
            groups.set(session.workspaceId, bucket);
          }
          if (groups.size > 0) {
            undoStack.current.push({
              label: `已把 ${ids.length} 个会话移回原来的工作区`,
              run: async () => {
                for (const [workspaceId, movedIds] of groups) {
                  await apiSend("POST", "/move", { ids: movedIds, target: { workspaceId } });
                }
              },
            });
          }
        }
      }, [clipboard, idsToActOn, mutate, nodePasteTarget, pasteTarget, refreshDshViews, sessionsById]);

      /**
       * Drag a session row onto a workspace row: the same transaction as paste,
       * with the target taken from the row that was dropped on.
       */
      const moveSessionsTo = useCallback(
        async (ids, workspaceId, copy) => {
          const target = Object.values(tree?.nodes ?? {}).find((node) => node.workspaceId === workspaceId);
          const name = target?.name ?? workspaceId;
          const previous = ids.map((id) => sessionsById.get(id)).filter(Boolean);
          const ok = await mutate(
            () => apiSend("POST", "/move", { ids, target: { workspaceId }, copy }),
            copy ? `已复制 ${ids.length} 个会话到「${name}」` : `已移动 ${ids.length} 个会话到「${name}」`,
          );
          if (ok) await refreshDshViews();
          if (ok && !copy) setClipboard({ mode: null, ids: [] });
          if (ok && !copy) {
            // Same undo entry as a paste: a drag-move is a move, and S6 asks
            // for every destructive write to be reversible.
            const groups = new Map();
            for (const session of previous) {
              if (!session.workspaceId || session.workspaceId === workspaceId) continue;
              const bucket = groups.get(session.workspaceId) ?? [];
              bucket.push(session.id);
              groups.set(session.workspaceId, bucket);
            }
            if (groups.size > 0) {
              undoStack.current.push({
                label: `已把 ${ids.length} 个会话移回原来的工作区`,
                run: async () => {
                  for (const [fromId, movedIds] of groups) {
                    await apiSend("POST", "/move", { ids: movedIds, target: { workspaceId: fromId } });
                  }
                },
              });
            }
          }
          return ok;
        },
        [mutate, refreshDshViews, sessionsById, tree],
      );

      // Ctrl+X / Ctrl+C / Ctrl+V belong to the list, not to the browser: the
      // panel has its own clipboard and the OS one would carry text instead.
      // A field or an open editor keeps the native shortcuts, and a dialog
      // stands them down entirely (the dialog layer owns the keyboard).
      useEffect(() => {
        const onClipboardKey = (event) => {
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
          const element = event.target;
          const typing =
            element &&
            (element.tagName === "INPUT" ||
              element.tagName === "TEXTAREA" ||
              element.isContentEditable);
          if (typing || dialogOpenRef.current) return;
          const key = event.key.toLowerCase();
          if (key === "x") {
            event.preventDefault();
            cutOrCopy("cut");
          } else if (key === "c") {
            event.preventDefault();
            cutOrCopy("copy");
          } else if (key === "v") {
            event.preventDefault();
            pasteClipboard();
          }
        };
        window.addEventListener("keydown", onClipboardKey);
        return () => window.removeEventListener("keydown", onClipboardKey);
      }, [cutOrCopy, pasteClipboard]);

      /**
       * 新建会话.
       *
       * DSH owns session creation: uiWorkspace.startSession(workspaceId) opens a
       * draft bound to that workspace, and a draft only becomes a real session
       * once the user sends something. Creating one any other way would produce
       * a session DSH's own sidebar does not know about, so the plugin asks the
       * host instead of writing anything.
       */
      const newSession = useCallback((targetWorkspaceId) => {
        const uiWorkspace = serviceOf("uiWorkspace");
        if (!uiWorkspace || typeof uiWorkspace.startSession !== "function") {
          setHint("当前 DSH 版本没有开放新建会话接口");
          return;
        }
        // The draft belongs where the user is standing: an explicit workspace
        // (context menu), the scope's nearest workspace, or the default one.
        const workspaceId =
          (typeof targetWorkspaceId === "string" && targetWorkspaceId ? targetWorkspaceId : null) ??
          tree?.nodes?.[scope]?.workspaceId ??
          null;
        try {
          uiWorkspace.startSession(workspaceId ?? undefined);
          panelStore.set(false);
        } catch (error) {
          setHint(String(error?.message ?? error));
        }
      }, [scope, tree]);

      useEffect(() => {
        if (!hint) return;
        const timer = setTimeout(() => setHint(""), 2600);
        return () => clearTimeout(timer);
      }, [hint]);

      const body = () => {
        if (boot.phase === "loading") {
          return h("div", { className: "se-searching" }, h("div", { className: "empty" }, h("div", { className: "t" }, "正在读取会话…")));
        }
        if (boot.phase === "error") {
          return h(
            "div",
            { className: "empty", style: { flex: 1 } },
            h("div", { className: "big" }, h(Icon, { name: "x", size: 30 })),
            h("div", { className: "t" }, "加载失败"),
            h("div", { className: "s" }, boot.error ?? ""),
            h("button", { className: "act", onClick: () => load(true) }, "重试"),
          );
        }
        return h(
          React.Fragment,
          null,
          h(TreePane, {
            tree,
            scope,
            onSelect: navigate,
            expanded,
            onToggle: toggleExpanded,
            width: navWidth,
            onMove: moveNodeTo,
            onDropSessions: moveSessionsTo,
            rename: renameProps,
            onBeginRename: beginRename,
            onNodeContextMenu: openContextMenu,
          }),
          h("div", { className: "rsz", onMouseDown: (event) => resizePane(event, "tree") }),
          h(ListPane, {
            sessions: filteredInScope,
            tree,
            scope,
            selected,
            onSelect: selectRow,
            onCheck: checkRow,
            checked,
            query,
            onQuery: setQuery,
            sortKey,
            onSort: cycleSort,
            sortDir,
            showArchived: listSettings.showArchived,
            now,
            view,
            onOpenWorkspace: navigate,
            colWidths,
            onResizeColumn: resizeColumn,
            listRef: null,
            collapsed,
            onToggleChildren: toggleChildren,
            rename: renameProps,
            onBeginRename: beginRename,
            onRowContextMenu: openContextMenu,
            onNodeContextMenu: openContextMenu,
            clipboard,
            onDropSessions: moveSessionsTo,
            onCanAcceptNode: canDropHere,
            onDropNode: moveNodeHere,
          }),
          h("div", { className: "rsz rsz-detail", onMouseDown: (event) => resizePane(event, "detail") }),
          h(DetailPane, {
            session: current,
            // With no session selected, the detail pane describes the container
            // the user picked (or, failing that, the one they are standing in),
            // so a workspace or folder can be renamed from the same title row
            // (m01340) and is labelled by its real type.
            node: focusNode,
            now,
            parent,
            children: currentChildren,
            forks: currentForks,
            forkSource,
            onOpen: selectAndReveal,
            onEnterNode: navigate,
            onOpenSession: openInDsh,
            onClose: () => setShowDetail(false),
            onHint: setHint,
            tagLibrary: data?.tagLibrary ?? [],
            onAddTag: addTag,
            onRemoveTag: removeTag,
            onNewTag: newTag,
            onDropTag: dropTag,
            onSetNote: setNote,
            onToggleFlag: toggleFlag,
            onArchive: toggleArchive,
            onFork: forkSession,
            onRename: renameEntity,
            onRestore: restoreSelection,
            onDelete: deleteSelection,
          }),
        );
      };

      // The scrim and the shell are siblings: the scrim paints behind the shell
      // and only exists when settings.shell.modal.dim is above zero. With the
      // default settings (dim = 0) it renders nothing at all, so a wallpaper is
      // never darkened (hard constraint 10).
      const scrim = h("div", {
        className: "se-scrim",
        "data-clickable": closeOnBackdrop && modalDim > 0 ? "1" : "0",
        style: { "--se-dim": String(modalDim) },
        onClick: closeOnBackdrop && modalDim > 0 ? () => panelStore.set(false) : undefined,
      });

      /**
       * The 排序 menu: a field section and a direction section.
       *
       * Direction is shown as its own two rows rather than a toggle, because a
       * check mark on the current state is easier to read than a button whose
       * label is the *next* state.
       */
      const sortItems = [
        ...SORT_FIELDS.map((field) => ({
          label: field.label,
          icon: sortKey === field.key ? "check" : "minus",
          run: () => {
            setSortKey(field.key);
            if (sortKey !== field.key) setSortDir(SORT_DEFAULT_DIR[field.key] ?? "desc");
          },
        })),
        { sep: true },
        {
          label: "递增",
          icon: sortDir === "asc" ? "check" : "minus",
          run: () => setSortDir("asc"),
        },
        {
          label: "递减",
          icon: sortDir === "desc" ? "check" : "minus",
          run: () => setSortDir("desc"),
        },
      ];

      /**
       * The 新建 menu.
       *
       * 新建会话 asks DSH to open its own draft (the panel is a browser, not a
       * chat surface), 新建文件夹 is the plugin's own virtual folder. Both land
       * where the user is standing, which is what the toolbar button always
       * meant.
       */
      newSessionRef.current = newSession;

      const createItems = [
        { label: "新建会话", icon: "plus", key: "Ctrl+N", run: () => newSession() },
        { label: "新建文件夹", icon: "folderplus", run: () => newFolder() },
      ];

      // 更多 is a short list of things that have nowhere else to live. Every
      // command that already has a toolbar button (新建 / 重命名 / 归档 / 全选 /
      // 新建标签页) was removed from here: a menu that repeats the toolbar is
      // just a slower toolbar, and it buried the three entries that matter.
      const moreItems = [
        // Undo belongs here as well as on Ctrl+Z: a mouse-only user has no
        // other way to reach it (S6).
        { label: "撤回", icon: "refresh", key: "Ctrl+Z", run: () => undo() },
        { label: "刷新", icon: "refresh", key: "F5", run: () => load(true) },
        { sep: true },
        {
          label: listSettings.autoCollapse ? "自动折叠：开" : "自动折叠：关",
          icon: listSettings.autoCollapse ? "check" : "minus",
          run: () => saveListSettings({ autoCollapse: !listSettings.autoCollapse }),
        },
        {
          label: listSettings.showArchived ? "显示已归档的会话" : "隐藏已归档的会话",
          icon: listSettings.showArchived ? "check" : "minus",
          run: () => saveListSettings({ showArchived: !listSettings.showArchived }),
        },
        { sep: true },
        { label: "更多设置…", icon: "settings", run: () => openSettingsPage() },
      ];

      /**
       * 打开 from the context menu. A session goes to DSH's own main view; a
       * node is entered in this panel, because a workspace has no chat to open.
       */
      const openContextTarget = useCallback(
        (kind, target) => {
          if (kind === "session") {
            openInDsh(target.id);
            return;
          }
          // A workspace node is navigated by its tree id, never by the native
          // workspace id (w-<uuid> vs <uuid>).
          navigate(target.nodeId);
        },
        [navigate, openInDsh],
      );

      /**
       * 重命名 as a command (toolbar button, context menu, F2).
       *
       * It applies to whatever the detail pane is describing: the selected
       * session, or the node the user is standing in.
       */
      const renameCurrent = useCallback(() => {
        // One target, resolved once: a selected session, a selected container,
        // or — when nothing is selected — the container the user is standing in.
        // The old version read `focusNode` and then re-derived the id space, and
        // passing the tree id of a workspace to the native rename is what made
        // the button look broken.
        if (selectionTarget) {
          if (selectionTarget.kind === "session") {
            beginRename("session", selectionTarget.actionId);
            return;
          }
          if (!selectionTarget.editable) {
            setHint(
              selectionTarget.node?.kind === "default-workspace"
                ? "默认工作区的名字由 DSH 决定，不能重命名"
                : "这一项不能重命名",
            );
            return;
          }
          beginRename(selectionTarget.kind, selectionTarget.actionId);
          return;
        }
        const node = focusNode;
        if (!node || node.fixed) {
          setHint("这里没有可重命名的项目");
          return;
        }
        if (node.kind === "default-workspace") {
          setHint("默认工作区的名字由 DSH 决定，不能重命名");
          return;
        }
        if (node.type === "workspace") beginRename("workspace", node.workspaceId ?? node.id);
        else beginRename("folder", node.id);
      }, [beginRename, current, focusNode, selectionTarget]);
      renameCurrentRef.current = renameCurrent;
      selectionTargetRef.current = selectionTarget;

      /**
       * Context menu for one row.
       *
       * The item set is derived from what the row *is*, not from a single
       * generic list: a session can be opened/renamed/trashed, a workspace can
       * be entered/renamed, a folder can be renamed and deleted. Offering
       * disabled items would be noise, so each row type gets its own list.
       */
      const openContextMenu = useCallback(
        // Two call shapes by design: tree/workspace rows pass a descriptor
        // ({kind,id,nodeId,node}), list rows pass positional arguments, because
        // that is what each component naturally has.
        (event, kindOrDescriptor, maybeId, maybeSession) => {
          const descriptor =
            kindOrDescriptor && typeof kindOrDescriptor === "object"
              ? kindOrDescriptor
              : {
                  kind: kindOrDescriptor,
                  id: maybeId,
                  nodeId: maybeId,
                  node: maybeSession ?? null,
                };
          const kind = descriptor.kind;
          // Everything below reads from the descriptor, so both call shapes
          // behave identically.
          const id = descriptor.id;
          const payload = descriptor.node ?? null;
          const rect = event?.currentTarget?.getBoundingClientRect?.();
          const x = Number.isFinite(event?.clientX) && event.clientX > 0 ? event.clientX : (rect?.left ?? 200) + 20;
          const y = Number.isFinite(event?.clientY) && event.clientY > 0 ? event.clientY : (rect?.top ?? 100) + 20;
          /** @type {any[]} */
          const items = [];
          // The tree id and the native workspace id are different things: the
          // menu acts on the native id but navigation needs the tree node.
          const nodeId = kind === "workspace" ? descriptor.nodeId ?? null : id;
          const target = kind === "session" ? { id } : { id, nodeId };
          items.push({ label: kind === "session" ? "打开会话" : "打开", icon: "external", run: () => openContextTarget(kind, target) });
          // 新建 lives on the container rows, next to "open": creating a folder
          // inside the folder you right-clicked is the one action a file manager
          // puts here, and it saves a trip to the toolbar.
          if (kind !== "session") {
            items.push({
              label: "在此新建会话",
              icon: "plus",
              run: () => {
                navigate(nodeId);
                newSession(kind === "workspace" ? id : undefined);
              },
            });
            items.push({
              label: "在此新建文件夹",
              icon: "folderplus",
              run: () => newFolder(nodeId),
            });
          }
          items.push({ sep: true });
          if (kind === "session") {
            const session = sessionsById.get(id) ?? payload;
            items.push({ label: "重命名", icon: "pencil", key: "F2", run: () => beginRename("session", id) });
            if (session?.trashed) {
              items.push({ label: "还原", icon: "restore", run: () => restoreSelection() });
              items.push({ sep: true });
              items.push({ label: "永久删除", icon: "trash", danger: true, run: () => deleteSelection() });
            } else {
              items.push({
                label: session?.favorite ? "取消收藏" : "收藏",
                icon: "star",
                run: () => toggleFlag("favorite"),
              });
              items.push({ label: "待办", icon: "todo", run: () => toggleFlag("todo") });
              items.push({ label: session?.archived ? "取消归档" : "归档", icon: "archive", run: () => toggleArchive() });
              items.push({ label: "分叉", icon: "branch", run: () => forkSession() });
              items.push({ sep: true });
              items.push({ label: "剪切", icon: "cut", key: "Ctrl+X", run: () => cutOrCopy("cut") });
              items.push({ label: "复制", icon: "copy", key: "Ctrl+C", run: () => cutOrCopy("copy") });
              items.push({
                label: pasteTarget ? `粘贴到「${pasteTarget.name}」` : "粘贴（先进入工作区）",
                icon: "paste",
                key: "Ctrl+V",
                disabled: clipboard.ids.length === 0 || !pasteTarget,
                onDisabled: () => {
                  if (clipboard.ids.length === 0 && (clipboard.nodes?.length ?? 0) === 0) {
                    setHint("剪贴板是空的：先剪切或复制");
                  } else if ((clipboard.nodes?.length ?? 0) > 0) {
                    setHint("剪贴板里是目录：进入一个文件夹或根目录再粘贴");
                  } else setHint("当前位置不属于任何工作区，先进入一个工作区再粘贴");
                },
                run: () => pasteClipboard(),
              });
              items.push({ sep: true });
              items.push({ label: "删除（进回收站）", icon: "trash", danger: true, run: () => deleteSelection() });
            }
          } else if (kind === "workspace") {
            items.push({ label: "重命名工作区", icon: "pencil", key: "F2", run: () => beginRename("workspace", id) });
            items.push({ sep: true });
            items.push({
              label: "剪切",
              icon: "cut",
              key: "Ctrl+X",
              run: () => cutOrCopy("cut"),
            });
          } else {
            items.push({ label: "重命名文件夹", icon: "pencil", key: "F2", run: () => beginRename("folder", id) });
            items.push({ sep: true });
            items.push({
              label: "剪切",
              icon: "cut",
              key: "Ctrl+X",
              run: () => cutOrCopy("cut"),
            });
            // Deleting a folder acts on the scope, so the scope has to be the
            // folder the menu was opened on, not wherever the user stood before.
            items.push({
              label: "删除文件夹",
              icon: "trash",
              danger: true,
              run: () => {
                navigate(nodeId);
                removeFolder(nodeId);
              },
            });
          }
          setContextMenu({ left: x, top: y, items });
        },
        // The menu closes over the current selection state on purpose: the
        // items act on "what is selected now", not on what it was when the
        // menu was opened.
        [
          beginRename,
          cutOrCopy,
          deleteSelection,
          forkSession,
          navigate,
          newFolder,
          newSession,
          removeFolder,
          restoreSelection,
          sessionsById,
          toggleArchive,
          toggleFlag,
        ],
      );


      // ── how the panel is mounted ─────────────────────────────────────────
      // One surface: the 浮窗 card, centred over the optional scrim and sized by
      // the fixed/percent preset. 独立窗口 is a separate browser window (P6), not
      // another way to paint this card, so there is nothing to branch on here.
      const modalFrame = frameSizeOf(settings?.shell?.modal ?? null);
      // The size always comes from settings. There is no maximise mode: a
      // full-screen panel with no visible way back was a trap, so it is gone.
      const shellStyle = {
        "--nav-width": `${navWidth}px`,
        "--detail-width": `${detailWidth}px`,
        width: modalFrame.width,
        height: modalFrame.height,
      };

      const shell = h(
          "div",
          {
            className: "se-shell",
            ref: shellRef,
            "data-bp": bp,
            "data-view": view,
            "data-detail": showDetail ? "on" : "off",
            "data-material": "auto",
            "data-size": modalSize,
            "data-sizing": sizing,
            style: shellStyle,
          },
          // titlebar
          h(
            "div",
            { className: "titlebar" },
            h(
              "div",
              { className: "tabs", role: "tablist" },
              tabs.map((tab, index) =>
                h(
                  "div",
                  {
                    key: tab.id,
                    role: "tab",
                    "aria-selected": index === activeTab,
                    className: "tab" + (index === activeTab ? " active" : ""),
                    draggable: true,
                    title: titleOfScope(tab.scope) + (index === activeTab ? "" : "（点按切换）"),
                    onClick: () => switchTab(index),
                    // Middle click closes a tab, as in every browser.
                    onAuxClick: (event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        closeTab(index);
                      }
                    },
                    onDragStart: (event) => {
                      event.dataTransfer.setData("text/plain", "tab:" + index);
                      event.dataTransfer.effectAllowed = "move";
                    },
                    onDragOver: (event) => {
                      if (!String(event.dataTransfer?.types ?? "").includes("text")) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    },
                    onDrop: (event) => {
                      event.preventDefault();
                      const raw = event.dataTransfer.getData("text/plain");
                      if (!raw.startsWith("tab:")) return;
                      moveTab(Number(raw.slice(4)), index);
                    },
                  },
                  h("span", { className: "t-ic" }, h(Icon, { name: iconOfScope(tab.scope), size: 13 })),
                  h("span", { className: "tname" }, titleOfScope(tab.scope)),
                  tabs.length > 1
                    ? h(
                        "span",
                        {
                          className: "x",
                          title: "关闭标签页",
                          onClick: (event) => {
                            event.stopPropagation();
                            closeTab(index);
                          },
                        },
                        h(Icon, { name: "x", size: 11 }),
                      )
                    : null,
                ),
              ),
              h("button", { type: "button", className: "tab-add", title: "新建标签页（Ctrl+T）", onClick: addTab }, h(Icon, { name: "plus", size: 13 })),
            ),
            h(
              "div",
              { className: "wbtns" },
              // Two window actions, and only two: 独立窗口 and close.
              // Minimum/maximum were removed because a maximised panel had no
              // obvious way back. The panel's size is a setting now, and the
              // detached window is the way to go bigger.
              h(
                "button",
                {
                  key: "detach",
                  type: "button",
                  className: "wbtn wide",
                  title: componentReady
                    ? "在独立窗口中打开（Ctrl+Shift+D）"
                    : "独立窗口需要先下载浏览器组件（设置 → 会话资源管理器）",
                  "aria-disabled": !componentReady,
                  onClick: openDetachedWindow,
                },
                h(Icon, { name: "external", size: 12 }),
              ),
              h(
                "button",
                {
                  key: "close",
                  type: "button",
                  className: "wbtn close",
                  title: "关闭",
                  onClick: () => panelStore.set(false),
                },
                h(Icon, { name: "x", size: 13 }),
              ),
            ),
          ),
          // navbar
          h(
            "div",
            { className: "navbar" },
            h("button", { type: "button", className: "nbtn", title: "后退", disabled: cursor <= 0, onClick: goBack }, h(Icon, { name: "back" })),
            h("button", { type: "button", className: "nbtn", title: "前进", disabled: cursor >= history.length - 1, onClick: goForward }, h(Icon, { name: "fwd" })),
            h("button", { type: "button", className: "nbtn", title: "上一级", onClick: () => navigate(tree?.nodes?.[scope]?.parent ?? FIXED.root) }, h(Icon, { name: "up" })),
            h("button", { type: "button", className: "nbtn", title: "重新扫描", onClick: () => load(true) }, h(Icon, { name: "refresh" })),
            h(
              "div",
              { className: "crumbs" },
              crumbs.map((crumb, index) =>
                h(
                  React.Fragment,
                  { key: crumb.id },
                  index > 0 ? h("span", { className: "crumb-sep" }, h(Icon, { name: "chevright", size: 9 })) : null,
                  h("span", { className: "crumb" + (index === crumbs.length - 1 ? " cur" : ""), onClick: () => navigate(crumb.id) }, crumb.label),
                ),
              ),
            ),
            h(
              "label",
              { className: "search" },
              h(Icon, { name: "search", size: 13 }),
              h("input", {
                ref: searchRef,
                value: query,
                placeholder: "搜索标题 / 备注 / 标签（Ctrl+E）",
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
          ),
          // command bar — the write commands scroll, but the sort/view/details
          // cluster is pinned to the right edge so 详细信息 stays reachable at
          // any pane width (the prototype scrolls the whole bar and loses it).
          h(
            "div",
            { className: "cmdbar" },
            h(
              "div",
              { className: "cmdscroll" },
              // One 新建 entry with a menu: two adjacent buttons that both start
              // with "新建" made the bar read as one long verb. The menu names
              // both actions and leaves room for a third without another button.
              h(
                "button",
                {
                  type: "button",
                  className: "cmd" + (createOpen ? " on" : ""),
                  title: "新建",
                  onClick: (event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setCreateOpen((previous) =>
                      previous ? null : { element: event.currentTarget, left: rect.left, bottom: rect.bottom },
                    );
                  },
                },
                h("span", { className: "ic", "data-i": "plus" }, h(Icon, { name: "plus", size: 14 })),
                h("span", null, "新建"),
                h("span", { className: "ic", "data-i": "chevdown" }, h(Icon, { name: "chevdown", size: 11 })),
              ),
              h("span", { className: "cmsep" }),
              // The file-manager cluster reads left to right in the order a
              // user works: take it (cut/copy), put it down (paste), then name
              // it and — only at the end — throw it away. 重命名 used to sit
              // with the 新建 buttons and 删除 sat behind the flags, which made
              // both harder to find than the thing they act on.
              h(Btn, { className: "cmd", icon: "cut", iconOnly: true, title: "剪切（Ctrl+X）", disabled: targets.length === 0, onClick: () => cutOrCopy("cut") }),
              // 复制 is for sessions only: a container cannot be duplicated —
              // its children would have to be duplicated too, and the registry
              // has no notion of a copied workspace. 剪切 covers both.
              h(Btn, {
                className: "cmd",
                icon: "copy",
                iconOnly: true,
                title: "复制会话（Ctrl+C）",
                disabled: !targets.some((id) => sessionsById.has(id)),
                onClick: () => cutOrCopy("copy"),
              }),
              h(Btn, {
                className: "cmd" + (clipboard.ids.length > 0 || (clipboard.nodes?.length ?? 0) > 0 ? " on" : ""),
                icon: "paste",
                iconOnly: true,
                title: (() => {
                  if ((clipboard.nodes?.length ?? 0) > 0) {
                    return nodePasteTarget
                      ? `粘贴 ${clipboard.nodes.length} 个目录到「${nodePasteTarget.name}」（Ctrl+V）`
                      : "粘贴目录（先进入一个文件夹或根目录）";
                  }
                  return clipboard.ids.length > 0
                    ? `粘贴 ${clipboard.ids.length} 个会话到「${pasteTarget?.name ?? "当前工作区"}」（Ctrl+V）`
                    : "粘贴（Ctrl+V）";
                })(),
                disabled:
                  (clipboard.nodes?.length ?? 0) > 0
                    ? !nodePasteTarget
                    : clipboard.ids.length === 0 || !pasteTarget,
                onClick: pasteClipboard,
              }),
              // 重命名 is a command, not a double click: a double click on a row
              // means "open", and overloading it made the first click select and
              // the second silently start editing.
              h(Btn, { className: "cmd", icon: "pencil", iconOnly: true, onClick: renameCurrent, title: "重命名（F2）" }),
              // 删除 means "move to the bin" for a session and "delete the
              // folder" for a folder: the selected rows decide which. It comes
              // last in this cluster so it is never adjacent to 粘贴.
              h(Btn, { className: "cmd danger", icon: "trash", iconOnly: true, title: "删除", onClick: deleteSelection }),
              scope === FIXED.trash
                ? h(Btn, { className: "cmd", icon: "restore", onClick: restoreSelection }, "还原")
                : null,
              scope === FIXED.trash
                ? h(Btn, { className: "cmd danger", icon: "trash", onClick: emptyTrashNow }, "清空回收站")
                : null,
              h("span", { className: "cmsep" }),
              h(Btn, { className: "cmd", icon: "star", onClick: () => toggleFlag("favorite") }, "收藏"),
              h(Btn, { className: "cmd", icon: "todo", onClick: () => toggleFlag("todo") }, "待办"),
              h(Btn, { className: "cmd", icon: "pin", onClick: togglePin }, "置顶"),
              h(Btn, { className: "cmd", icon: "archive", onClick: toggleArchive }, "归档"),
              h(Btn, { className: "cmd", icon: "branch", title: "分叉会话（从当前位置另起一支）", onClick: forkSession }, "分叉"),
              h("span", { className: "cmsep" }),
              h(
                Btn,
                { className: "cmd" + (filterActive ? " on" : ""), icon: "tag", onClick: () => setFilterOpen(true) },
                "筛选",
              ),
            ),
            h(
              "div",
              { className: "cmdfixed" },
              // The fixed cluster is icon+label like the scrolling one; the
              // separator before it is a real border (see CSS), not an overlay,
              // so nothing is ever painted over these buttons.
              // 排序 is a menu, not a cycle: three fields and two directions are
              // six states, and a button that silently walked through them made
              // the user guess what the next click would do.
              h(
                "button",
                {
                  type: "button",
                  className: "cmd" + (sortOpen ? " on" : ""),
                  title: "排序方式",
                  onClick: (event) => {
                    const element = event.currentTarget;
                    const rect = element.getBoundingClientRect();
                    setSortOpen((previous) =>
                      previous ? null : { element, left: rect.left, bottom: rect.bottom },
                    );
                  },
                },
                h("span", { className: "ic", "data-i": "sort" }, h(Icon, { name: "sort", size: 14 })),
                h("span", null, "排序"),
                h("span", { className: "ic", "data-i": "chevdown" }, h(Icon, { name: "chevdown", size: 11 })),
              ),
              h(Btn, {
                className: "cmd",
                icon: "grid",
                title: "切换视图（详细信息 / 列表 / 图标）",
                onClick: () => setView((previous) => (previous === "details" ? "icons" : "details")),
              }, "查看"),
              h(Btn, { className: "cmd", icon: "more", iconOnly: true, title: "更多", onClick: moreMenu }),
              h("span", { className: "cmsep" }),
              h(Btn, { className: "cmd" + (showDetail ? " on" : ""), icon: "details", onClick: () => setShowDetail((previous) => !previous) }, "详细信息"),
            ),
          ),
          // body
          h("div", { className: "body" }, body()),
          // status bar
          h(
            "div",
            { className: "status" },
            h("div", { className: "s-item" }, `${formatCount(filteredInScope.length)} 个项目`),
            filterActive
              ? h(
                  "div",
                  {
                    className: "s-item clickable on",
                    title: "清除筛选",
                    onClick: () => setFilter({ scope: "scope", favorite: "all", archived: "all", todo: "all", tags: [] }),
                  },
                  `筛选中 · 点击清除`,
                )
              : null,
            filterActive && filter.scope === "all"
              ? h("div", { className: "s-item" }, "全部会话范围")
              : null,
            archivedInScope > 0 ? h("div", { className: "s-item" }, `${formatCount(archivedInScope)} 个已归档`) : null,
            h("div", { className: "s-item" }, checked.size > 0 ? `已选 ${formatCount(checked.size)} 项` : "未选择"),
            h("div", { className: "s-item" }, `共 ${formatSize(totalSize) || "0 B"}`),
            hint ? h("div", { className: "s-item clickable on" }, hint) : null,
            h(
              "div",
              { className: "viewswitch" },
              h("button", { type: "button", className: "vsw" + (view === "details" ? " on" : ""), title: "详细信息", onClick: () => setView("details") }, h(Icon, { name: "details", size: 13 })),
              h("button", { type: "button", className: "vsw" + (view === "icons" ? " on" : ""), title: "图标", onClick: () => setView("icons") }, h(Icon, { name: "grid", size: 13 })),
            ),
          ),
          // Popovers live *inside* the shell so the --sm-* token bridge and
          // the theme apply to them; the CSS positioning is viewport-fixed,
          // so being a descendant costs nothing.
          h(CommandMenu, { anchor: more, items: moreItems, onClose: () => setMore(null) }),
          h(CommandMenu, { anchor: sortOpen, items: sortItems, onClose: () => setSortOpen(null) }),
          h(CommandMenu, { anchor: createOpen, items: createItems, onClose: () => setCreateOpen(null) }),
          h(CommandMenu, {
            anchor: contextMenu,
            items: contextMenu?.items ?? [],
            onClose: () => setContextMenu(null),
          }),
          // One dialog host for the whole panel: confirm()/ask() both resolve
          // through it, so two dialogs can never stack on each other.
          // The dialog host and the filter dialog live inside the shell so they
          // inherit its token scope; both position themselves fixed, so being a
          // descendant costs nothing.
          dialogs.host,
          h(FilterDialog, {
            open: filterOpen,
            value: filter,
            library: data?.tagLibrary ?? [],
            onApply: (next) => {
              setFilter(next);
              setFilterOpen(false);
              setHint("已应用筛选");
            },
            onClose: () => setFilterOpen(false),
          }),
      );

      // One surface: the scrim (invisible at the default dim=0) behind the card.
      return portalFragment([scrim, shell]);
    }

    /**
     * Keeps a failed panel from taking the sidebar entry down with it.
     *
     * A plugin slot is one React subtree: if `Panel` throws during render (a
     * host shape we did not anticipate), React unmounts the nearest boundary —
     * and without one that is the whole slot, so the sidebar button itself
     * disappears. That is exactly the "点了入口，闪退之后入口也没了" report: the
     * crash and the missing entry are the same event.
     *
     * The boundary catches the error, drops back to the closed state and shows a
     * readable message, so the entry survives and can be clicked again.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        // Do NOT close the store here: closing unmounts the boundary together
        // with the panel, so the message flashes and the user is left with a
        // button that seems to do nothing. The card stays until 重试 or 关闭.
        try {
          console.error("[session-explorer] panel render failed", error);
        } catch {
          /* logging must never mask the original error */
        }
      }

      render() {
        if (this.state.error) {
          // Portaled like the panel: the sidebar clips its own subtree, and a
          // fixed element inside a transformed ancestor is clipped too.
          return portalFragment([h(
            "div",
            { className: "se-crash", role: "alert" },
            h("div", { className: "t" }, "面板渲染失败"),
            h("div", { className: "s" }, String(this.state.error?.message ?? this.state.error)),
            h(
              "div",
              { className: "row-btns" },
              h(
                "button",
                {
                  type: "button",
                  className: "act",
                  onClick: () => this.setState({ error: null }),
                },
                "重试",
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "act",
                  onClick: () => panelStore.set(false),
                },
                "关闭",
              ),
            ),
          )]);
        }
        return this.props.children;
      }
    }

    // ── Sidebar footer entry ───────────────────────────────────────────────
    function FooterAction(props) {
      const t = typeof props.t === "function" ? props.t : (key) => key;
      const open = useSyncExternalStore(
        panelStore.subscribe,
        panelStore.getSnapshot,
        panelStore.getSnapshot,
      );
      const wide = props.wide !== false;
      return h(React.Fragment, null,
        h("button", {
          type: "button",
          className: "se-footerBtn" + (wide ? "" : " se-footerBtn-rail"),
          title: wide ? undefined : t("footerLabel"),
          "aria-label": t("footerLabel"),
          "aria-expanded": open,
          onClick: () => panelStore.toggle(),
        },
          h("svg", {
            viewBox: "0 0 16 16",
            width: wide ? 14 : 18,
            height: wide ? 14 : 18,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.4,
            "aria-hidden": "true",
            style: { flex: "0 0 auto", display: "block" },
          },
            h("path", { d: "M2.5 3.5h11M2.5 8h11M2.5 12.5h6", strokeLinecap: "round" }),
          ),
          wide ? h("span", { className: "se-footerBtn-label" }, t("footerLabel")) : null,
        ),
        open ? h(PanelBoundary, null, h(Panel, { t })) : null,
      );
    }

    // ── Settings page ──────────────────────────────────────────────────────
    // Registered on the `settings.section` list slot. The label is a thunk so a
    // language switch re-renders the nav entry without re-registering the slot;
    // that is what DSH's own sections do (packages/client/ui-agent-preset).
    //
    // The page reads its own copy of the settings document instead of sharing
    // the panel's /bootstrap: it mounts in the settings window, which may be open
    // while the panel is closed, and it must not pay for a session scan.

    // Client-side service lookup. DSH exposes services both as `ctx.get(name)`
    // and as `ctx[name]`; the settings page needs `uiWorkspace` for the native
    // directory picker, and it must degrade to a message (not a crash) on a build
    // that does not provide it.
    let hostCtx = null;

    function serviceOf(name) {
      if (!hostCtx) return null;
      try {
        const viaGet = typeof hostCtx.get === "function" ? hostCtx.get(name) : null;
        if (viaGet) return viaGet;
      } catch {
        /* `ctx.get` is not universal; fall through to the property accessor */
      }
      try {
        return hostCtx[name] ?? null;
      } catch {
        // A service that is declared but not yet activated throws on access.
        return null;
      }
    }

    function SetRow({ label, hint, children }) {
      return h(
        "div",
        { className: "se-set-row" },
        h(
          "div",
          { className: "se-set-main" },
          h("div", { className: "se-set-lbl" }, label),
          hint ? h("div", { className: "se-set-hint" }, hint) : null,
        ),
        children,
      );
    }

    function SetChips({ options, value, onPick, disabled }) {
      return h(
        "div",
        { className: "se-set-choices" },
        options.map((option) =>
          h(
            "button",
            {
              key: option.value,
              type: "button",
              className: "se-set-chip" + (option.value === value ? " on" : ""),
              title: option.title,
              disabled: disabled === true || option.disabled === true,
              onClick: () => onPick(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    function SetSwitch({ on, onToggle, disabled, title }) {
      return h("button", {
        type: "button",
        className: "se-set-switch" + (on ? " on" : ""),
        title,
        "aria-pressed": on === true,
        disabled: disabled === true,
        onClick: () => onToggle(!on),
      });
    }

    // The data-directory group owns its own request cycle: a migration is a
    // long operation with a pre-flight the rest of the page has no business
    // knowing about, and a failure here must not blank the other settings.
    function DataDirGroup({ t, current, onMigrated }) {
      const [state, setState] = useState({ phase: "loading", data: null, error: "" });
      const [plan, setPlan] = useState(null);
      const [busy, setBusy] = useState("");
      const [error, setError] = useState("");
      const [note, setNote] = useState("");

      const load = useCallback(async () => {
        try {
          const data = await apiGet("/datadir");
          setState({ phase: "ready", data, error: "" });
        } catch (failure) {
          setState({ phase: "error", data: null, error: String(failure?.message ?? failure) });
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      // The picker is a Host primitive on `uiWorkspace`; the desktop build routes
      // it to the native dialog through `__DSH_DIRECTORY_PICKER__`. Resolved at
      // click time so a plugin loaded before that service still works.
      const choose = useCallback(async () => {
        const workspace = serviceOf("uiWorkspace");
        if (!workspace || typeof workspace.pickDirectory !== "function") {
          setError(t("setPickUnavailable"));
          return;
        }
        setError("");
        setNote("");
        let target;
        try {
          target = await workspace.pickDirectory();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          return;
        }
        // A dismissed dialog is a no-op, not an error.
        if (typeof target !== "string" || target === "") return;
        setBusy("inspect");
        try {
          setPlan(await apiSend("POST", "/datadir/inspect", { target }));
        } catch (failure) {
          setPlan(null);
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy("");
        }
      }, [t]);

      const migrate = useCallback(async () => {
        if (!plan) return;
        setBusy("migrate");
        setError("");
        setNote("");
        try {
          const result = await apiSend("POST", "/datadir/migrate", { target: plan.target, mode: plan.mode });
          setPlan(null);
          setNote(t(result.mode === "move" ? "setDataDirMoved" : "setDataDirCopied"));
          await load();
          onMigrated?.();
        } catch (failure) {
          // The host rolls back on its own; the message says what was kept.
          setError(t("setDataDirFailed") + " " + String(failure?.message ?? failure));
        } finally {
          setBusy("");
        }
      }, [plan, load, onMigrated, t]);

      const data = state.data;
      const sizeText = data ? formatSize(data.sizeBytes) : "";

      return h(
        "div",
        { className: "se-set-grp" },
        h("div", { className: "se-set-h" }, t("setGroupData")),
        h(
          SetRow,
          { label: t("setDataDir"), hint: t("setDataDirHint") },
          h("span", { className: "se-set-path" }, current || t("setDataDirDefault")),
          h(
            "button",
            {
              type: "button",
              className: "se-set-chip",
              disabled: busy !== "" || state.phase === "loading",
              onClick: choose,
            },
            busy === "inspect" ? t("setDataDirInspecting") : t("setDataDirChange"),
          ),
        ),
        data
          ? h(
              SetRow,
              { label: t("setDataDirSize") },
              h("span", { className: "se-set-path" }, sizeText || "-"),
              data.fromEnv ? h("span", { className: "se-set-hint" }, t("setEnvOverride")) : null,
            )
          : null,
        plan
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                h("div", { className: "se-set-lbl" }, t("setDataDirConfirm")),
                h("div", { className: "se-set-path" }, plan.target),
                h(
                  "div",
                  { className: "se-set-hint" },
                  t(plan.mode === "move" ? "setDataDirPlanMove" : "setDataDirPlanCopy"),
                ),
              ),
              h(
                "div",
                { className: "se-set-choices" },
                h(
                  "button",
                  { type: "button", className: "se-set-chip", disabled: busy !== "", onClick: () => setPlan(null) },
                  t("setCancel"),
                ),
                h(
                  "button",
                  { type: "button", className: "se-set-chip on", disabled: busy !== "", onClick: migrate },
                  busy === "migrate" ? t("setDataDirMoving") : t("setDataDirGo"),
                ),
              ),
            )
          : null,
        error ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-err" }, error)) : null,
        state.error ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-err" }, state.error)) : null,
        note ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-note" }, note)) : null,
      );
    }


    // ── 浏览器组件 (P6) ────────────────────────────────────────────────────
    // The detached window needs an optional Electron runtime. It is installed
    // explicitly — the plugin itself is a few dozen KB and most users never
    // need a separate window — so the section leads with size and consequence
    // rather than a download button that appears out of nowhere.
    function ComponentGroup({ t, component, onChanged }) {
      const [status, setStatus] = useState(component ?? null);
      const [busy, setBusy] = useState("");
      const [note, setNote] = useState("");
      const [error, setError] = useState("");

      const apply = useCallback((next) => {
        if (!next) return;
        setStatus(next);
        onChanged?.(next);
      }, [onChanged]);

      const load = useCallback(async () => {
        try {
          apply(await apiGet("/component/status"));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      }, [apply]);

      useEffect(() => {
        load();
      }, [load]);

      // Poll while a phase can still change; SSE is optional and a background
      // tab throttles it, so polling is the source of truth for the final state.
      const phase = status?.phase ?? "absent";
      const settling = phase === "downloading" || phase === "verifying" || phase === "extracting";
      useEffect(() => {
        if (!settling) return undefined;
        const timer = setInterval(() => { void load(); }, 500);
        return () => clearInterval(timer);
      }, [settling, load]);

      const act = useCallback(async (kind) => {
        setBusy(kind);
        setError("");
        setNote("");
        try {
          const path = kind === "install" ? "/component/install" : `/component/${kind}`;
          const result = await apiSend("POST", path, {});
          apply(result);
          // A remove can succeed as an uninstall while a locked file survives on
          // disk — DSH itself keeps `default_app.asar` open from the runtime it
          // was pointed at. That is not an error: the leftovers are swept on the
          // next start, and a reinstall reuses them instead of downloading
          // again. Say so, rather than sending the user to run a script.
          if (kind === "remove" && result?.leftover) {
            setNote(t("setCompLeftover"));
            return;
          }
          setNote(kind === "install" ? t("setCompInstalled") : kind === "remove" ? t("setCompRemoved") : t("setCompCancelled"));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          await load();
        } finally {
          setBusy("");
        }
      }, [apply, load, t]);

      const openDetached = useCallback(async () => {
        setBusy("open");
        setError("");
        try {
          await apiSend("POST", "/detached/open", {});
          setNote(t("setCompOpened"));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy("");
        }
      }, [t]);

      const bytes = (value) => {
        if (!Number.isFinite(value) || value <= 0) return "—";
        const units = ["B", "KB", "MB", "GB"];
        let size = value;
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
          size /= 1024;
          unit += 1;
        }
        return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
      };

      const received = Number(status?.receivedBytes) || 0;
      const total = Number(status?.totalBytes) || 0;
      const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;

      return h(
        "div",
        { className: "se-set-grp" },
        h(
          "div",
          { className: "se-set-h" },
          t("setGroupComponent"),
          h("span", { className: "se-set-note", style: { marginLeft: "8px", fontWeight: 400 } }, t("setComponentFor")),
        ),
        h(
          "div",
          { className: "se-set-row" },
          h(
            "div",
            { className: "se-set-main" },
            h("div", { className: "se-set-lbl" }, `${t("setCompStatus")} · ${
              phase === "ready" ? t("setCompReady") : phase === "error" ? t("setCompError") : phase === "absent" ? t("setCompAbsent") : t("setCompWorking")
            }`),
            h("div", { className: "se-set-hint" }, t("setCompSize", {
              download: bytes(status?.approxDownloadBytes),
              disk: bytes(status?.approxDiskBytes),
            })),
            phase === "ready" && status?.sizeBytes
              ? h("div", { className: "se-set-hint" }, `${t("setCompInstalledSize")} ${bytes(status.sizeBytes)}`)
              : null,
            status?.error ? h("div", { className: "se-set-err" }, status.error) : null,
          ),
          h(
            "div",
            { className: "se-set-choices" },
            phase === "ready"
              ? [
                  h("button", { key: "open", type: "button", className: "se-set-chip on", disabled: Boolean(busy), onClick: openDetached }, t("setCompOpen")),
                  h("button", { key: "remove", type: "button", className: "se-set-chip", disabled: Boolean(busy), onClick: () => act("remove") }, t("setCompRemove")),
                ]
              : phase === "downloading"
                ? [h("button", { key: "cancel", type: "button", className: "se-set-chip", disabled: Boolean(busy), onClick: () => act("cancel") }, t("setCompCancel"))]
                : [
                    h("button", { key: "install", type: "button", className: "se-set-chip on", disabled: Boolean(busy), onClick: () => act("install") }, phase === "error" ? t("setCompRetry") : t("setCompDownload")),
                  ],
          ),
        ),
        settling || phase === "error"
          ? h(
              "div",
              { className: "se-set-row" },
              h(
                "div",
                { className: "se-set-main" },
                phase === "downloading"
                  ? h("progress", { className: "se-set-progress", max: 100, value: percent ?? undefined, "aria-valuenow": percent ?? undefined })
                  : null,
                h(
                  "div",
                  { className: "se-set-hint" },
                  phase === "downloading"
                    ? total > 0
                      ? t("setCompDownloading", { percent: String(percent ?? 0), done: bytes(received), total: bytes(total) })
                      : t("setCompDownloadingUnknown", { done: bytes(received) })
                    : phase === "verifying"
                      ? t("setCompVerifying")
                      : phase === "extracting"
                        ? t("setCompExtracting")
                        : status?.error ?? "",
                ),
              ),
            )
          : null,
        note ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-note" }, note)) : null,
        error ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-err" }, error)) : null,
      );
    }

    /**
     * The scrim slider.
     *
     * It used to write on every `input` event *and* disable itself while the
     * write was in flight, so dragging it felt like the handle was fighting the
     * pointer: each pixel produced a PUT, the control went disabled, and the
     * next move landed on a disabled element.
     *
     * Now the handle is owned locally (so the drag is immediate and smooth) and
     * the value is written once the user stops moving — a trailing debounce of
     * 250 ms. The commit also fires on `change` so a click on the track is not
     * lost, and the local value is resynced whenever the stored one changes
     * from elsewhere (the menu, another window, a migration).
     */
    function DimSlider({ value, onCommit }) {
      const [draft, setDraft] = useState(value);
      const timer = useRef(null);
      const lastSent = useRef(value);

      // An external change (another surface wrote it) wins over a stale draft.
      useEffect(() => {
        if (Math.abs(value - lastSent.current) > 1e-9 || timer.current === null) {
          lastSent.current = value;
          setDraft(value);
        }
      }, [value]);

      const flush = useCallback(
        (next) => {
          if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
          }
          if (Math.abs(next - lastSent.current) < 1e-9) return;
          lastSent.current = next;
          onCommit(next);
        },
        [onCommit],
      );

      useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current);
      }, []);

      return h(
        React.Fragment,
        null,
        h("input", {
          type: "range",
          className: "se-set-range",
          min: 0,
          max: 0.8,
          step: 0.05,
          value: draft,
          "aria-label": "遮罩黑度",
          onChange: (event) => {
            const next = Number(event.target.value);
            setDraft(next);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => flush(next), 250);
          },
          onPointerUp: () => flush(draft),
          onKeyUp: () => flush(draft),
          onBlur: () => flush(draft),
        }),
        h("span", { className: "se-set-val" }, Math.round(draft * 100) + "%"),
      );
    }

    function SettingsSection(props) {
      const t = typeof props.t === "function" ? props.t : (key) => key;
      const [boot, setBoot] = useState({ phase: "loading", data: null, error: null });
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState("");
      const [note, setNote] = useState("");

      const load = useCallback(async () => {
        try {
          const data = await apiGet("/settings");
          setBoot({ phase: "ready", data, error: null });
        } catch (failure) {
          setBoot({ phase: "error", data: null, error: String(failure?.message ?? failure) });
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      // Every control writes immediately: there is no OK button, so a setting
      // never sits in a half-applied state the user cannot see.
      const save = useCallback(
        async (patch) => {
          setSaving(true);
          setError("");
          setNote("");
          try {
            const result = await apiSend("PUT", "/settings", patch);
            setBoot((previous) =>
              previous.data
                ? { ...previous, data: { ...previous.data, settings: result.settings, revision: result.revision } }
                : previous,
            );
            setNote(t("setSaved"));
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          } finally {
            setSaving(false);
          }
        },
        [t],
      );

      const settings = boot.data?.settings ?? null;
      const actualDir = boot.data?.dataDir ?? "";
      // Whether 独立窗口 is selectable; refreshed by the component group below.
      const componentReady = (boot.data?.capabilities?.component ?? "absent") === "ready";

      if (!settings) {
        return h(
          "div",
          { className: "se-set" },
          h(
            "div",
            { className: "se-set-grp" },
            h("div", { className: "se-set-h" }, boot.phase === "error" ? t("setFailed") : t("setLoading")),
            boot.error ? h("div", { className: "se-set-row" }, h("div", { className: "se-set-err" }, boot.error)) : null,
          ),
        );
      }

      const shell = settings.shell;
      const modal = shell.modal;

      return h(
        "div",
        { className: "se-set" },
        h("div", { className: "se-set-note" }, t("setIntro")),

        // 列表 — the two switches the 更多 menu also toggles. They live here as
        // the full explanation; the menu is a shortcut to the same document.
        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupList")),
          h(
            SetRow,
            { label: t("setAutoCollapse"), hint: t("setAutoCollapseHint") },
            h(SetSwitch, {
              on: settings.list.autoCollapse,
              disabled: saving,
              title: t("setAutoCollapse"),
              onToggle: (autoCollapse) => save({ list: { autoCollapse } }),
            }),
          ),
          h(
            SetRow,
            { label: t("setShowArchived"), hint: t("setShowArchivedHint") },
            h(SetSwitch, {
              on: settings.list.showArchived,
              disabled: saving,
              title: t("setShowArchived"),
              onToggle: (showArchived) => save({ list: { showArchived } }),
            }),
          ),
        ),

        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupModal")),
          h(
            SetRow,
            { label: t("setSizing"), hint: t("setSizingHint") },
            h(SetChips, {
              value: modal.sizing,
              disabled: saving,
              options: [
                { value: "fixed", label: t("setSizingFixed"), title: t("setSizingFixedHint") },
                { value: "percent", label: t("setSizingPercent"), title: t("setSizingPercentHint") },
              ],
              onPick: (sizing) => save({ shell: { modal: { sizing } } }),
            }),
          ),
          h(
            SetRow,
            { label: t("setSize"), hint: modal.sizing === "percent" ? t("setSizePercentHint") : t("setSizeHint") },
            h(SetChips, {
              value: modal.sizing === "percent" ? modal.percent : modal.size,
              disabled: saving,
              options: modal.sizing === "percent"
                ? [
                    { value: "p50", label: t("setSizeP50") },
                    { value: "p70", label: t("setSizeP70") },
                    { value: "p85", label: t("setSizeP85") },
                    { value: "p100", label: t("setSizeP100") },
                  ]
                : [
                    { value: "sm", label: t("setSizeSm") },
                    { value: "md", label: t("setSizeMd") },
                    { value: "lg", label: t("setSizeLg") },
                    { value: "xl", label: t("setSizeXl") },
                  ],
              onPick: (value) =>
                save({ shell: { modal: modal.sizing === "percent" ? { percent: value } : { size: value } } }),
            }),
          ),
          h(
            SetRow,
            { label: t("setDim"), hint: t("setDimHint") },
            h(DimSlider, {
              value: modal.dim,
              onCommit: (dim) => save({ shell: { modal: { dim } } }),
            }),
          ),
          h(
            SetRow,
            { label: t("setCloseOnBackdrop") },
            h(SetSwitch, {
              on: modal.closeOnBackdrop,
              disabled: saving,
              title: t("setCloseOnBackdrop"),
              onToggle: (closeOnBackdrop) => save({ shell: { modal: { closeOnBackdrop } } }),
            }),
          ),
        ),

        // 浏览器组件 — the optional Electron runtime 独立窗口 needs. Its own
        // section, because it carries weight and a progress bar that must not be
        // mixed into the presentation switches.
        h(ComponentGroup, {
          t,
          component: null,
          onChanged: (next) => {
            // The mode chips above were rendered from the first snapshot; a
            // component that just became ready must enable 独立窗口 without a
            // reload, so the readiness is folded into the same boot state.
            setBoot((previous) =>
              previous.data
                ? {
                    ...previous,
                    data: {
                      ...previous.data,
                      capabilities: { ...(previous.data.capabilities ?? {}), component: next.phase },
                    },
                  }
                : previous,
            );
          },
        }),

        h(DataDirGroup, { t, current: actualDir, onMigrated: load }),

        h(
          "div",
          { className: "se-set-foot" },
          saving ? h("span", { className: "se-set-note" }, t("setSaving")) : null,
          error ? h("span", { className: "se-set-err" }, error) : null,
          !saving && !error && note ? h("span", { className: "se-set-note" }, note) : null,
        ),
      );
    }

    // ── Locale ─────────────────────────────────────────────────────────────
    // `t(key, vars)` interpolates `{name}` placeholders. Prose only: dates,
    // numbers and relative time come from Intl, never from these tables.
    const ZH = {
      title: "会话资源管理器",
      footerLabel: "会话资源管理器",
      close: "关闭",
      loading: "正在加载…",
      error: "加载失败",
      refresh: "刷新",
      searchPlaceholder: "搜索标题 / 备注 / 标签",
      noSessions: "这里还没有会话",
      selectSession: "选中一项查看详情",
      running: "运行中",
      pinned: "已置顶",
      archived: "已归档",
      blank: "空会话",
      ungrouped: "未分组",
      statusLine: "{sessions} 个会话 · {cached} 个来自投影缓存 · {workspaces} 个工作区 · 扫描 {ms} ms",
      navLabel: "会话资源管理器",
      setTitle: "会话资源管理器",
      setIntro: "这些设置由会话资源管理器插件保存，跟随账号而非浏览器。",
      setGroupList: "列表",
      setAutoCollapse: "自动折叠",
      setAutoCollapseHint: "进入一个文件夹后，自动收起它的同级目录，让树保持窄。",
      setShowArchived: "显示已归档的会话",
      setShowArchivedHint: "关闭后，已归档的会话不再列在列表底部（归档本身不会删除任何东西）。",
      setGroupModal: "浮窗",
      setGroupData: "数据目录",
      setGroupComponent: "浏览器组件",
      setComponentFor: "独立窗口用",
      setCompStatus: "状态",
      setCompAbsent: "未安装",
      setCompReady: "已就绪",
      setCompError: "出错",
      setCompWorking: "进行中",
      setCompSize: "需要 Electron 44.0.0（约 {download} 下载 / {disk} 磁盘）",
      setCompInstalledSize: "占用磁盘",
      setCompDownload: "下载组件",
      setCompRetry: "重试",
      setCompCancel: "取消",
      setCompOpen: "打开独立窗口",
      setCompRemove: "移除组件",
      setCompDownloading: "正在下载浏览器组件 {percent}%（{done} / {total}）",
      setCompDownloadingUnknown: "正在下载浏览器组件（已下载 {done}）",
      setCompVerifying: "正在校验完整性…",
      setCompExtracting: "正在解压…",
      setCompInstalled: "浏览器组件已就绪",
      setCompRemoved: "浏览器组件已移除",
      setCompLeftover: "组件已停用。文件仍被 DSH 占用，下次启动会自动清理；期间重新安装会直接复用这些文件，不会重新下载。",
      setCompCancelled: "已取消下载",
      setCompOpened: "独立窗口已打开",

      setSizing: "尺寸方式",
      setSizingHint: "固定大小不随浏览器变化；百分比跟随窗口缩放。",
      setSizingFixed: "固定大小",
      setSizingFixedHint: "按像素给一个确定的尺寸，窗口变了面板不变。",
      setSizingPercent: "百分比大小",
      setSizingPercentHint: "按浏览器窗口的百分比铺开。",
      setSize: "弹窗尺寸",
      setSizeHint: "小 860×560 · 中 1100×720 · 大 1320×820 · 特大 1600×960；超出屏幕时自动收进可视区。",
      setSizePercentHint: "占浏览器窗口的百分比；100% 即铺满。",
      setSizeSm: "小",
      setSizeMd: "中",
      setSizeLg: "大",
      setSizeXl: "特大",
      setSizeP50: "50%",
      setSizeP70: "70%",
      setSizeP85: "85%",
      setSizeP100: "100%",
      setDim: "背景遮罩",
      setDimHint: "默认 0：壁纸不被压暗（硬约束 10），上限 80%。",
      setCloseOnBackdrop: "点击遮罩关闭",
      setDataDir: "当前目录",
      setDataDirDefault: "默认位置（未迁移）",
      setDataDirHint: "插件自己的树、标签、设置和回收站都在这里；迁移会把它们整体搬到别处。",
      setDataDirChange: "更改位置…",
      setDataDirInspecting: "正在检查…",
      setDataDirSize: "占用空间",
      setDataDirConfirm: "确认迁移到",
      setDataDirPlanMove: "同一磁盘：复制完成后删除旧目录。",
      setDataDirPlanCopy: "跨磁盘：复制完成后旧目录保留，并留下 .location 指针。",
      setDataDirGo: "开始迁移",
      setDataDirMoving: "正在迁移…",
      setDataDirMoved: "迁移完成，旧目录已删除。",
      setDataDirCopied: "迁移完成，旧目录已保留。",
      setDataDirFailed: "迁移失败，已回滚到原目录。",
      setPickUnavailable: "当前环境没有提供目录选择器。",
      setCancel: "取消",
      setEnvOverride: "当前目录由环境变量 DSH_SE_DATA_DIR 指定，迁移会被忽略。",
      setSaving: "正在保存…",
      setSaved: "已保存",
      setFailed: "保存失败",
      setLoading: "正在读取设置…",
    };
    const EN = {
      title: "Session resource manager",
      footerLabel: "Session resource manager",
      close: "Close",
      loading: "Loading…",
      error: "Failed to load",
      refresh: "Refresh",
      searchPlaceholder: "Search titles, notes and tags",
      noSessions: "No sessions here yet",
      selectSession: "Select an item to see details",
      running: "Running",
      pinned: "Pinned",
      archived: "Archived",
      blank: "Blank",
      ungrouped: "Ungrouped",
      statusLine: "{sessions} sessions · {cached} from projection cache · {workspaces} workspaces · scanned in {ms} ms",
      navLabel: "Session resource manager",
      setTitle: "Session resource manager",
      setIntro: "These settings are stored by the plugin and follow the account, not the browser.",
      setGroupList: "List",
      setAutoCollapse: "Auto-collapse",
      setAutoCollapseHint: "Fold a container's siblings once you enter it, so the tree stays narrow.",
      setShowArchived: "Show archived sessions",
      setShowArchivedHint: "When off, archived sessions are no longer listed at the bottom. Archiving itself never deletes anything.",
      setGroupModal: "Floating panel",
      setGroupData: "Data directory",
      setGroupComponent: "Browser component",
      setComponentFor: "for the detached window",
      setCompStatus: "Status",
      setCompAbsent: "not installed",
      setCompReady: "ready",
      setCompError: "error",
      setCompWorking: "working",
      setCompSize: "needs Electron 44.0.0 (~{download} download / {disk} on disk)",
      setCompInstalledSize: "On disk",
      setCompDownload: "Download",
      setCompRetry: "Retry",
      setCompCancel: "Cancel",
      setCompOpen: "Open detached window",
      setCompRemove: "Remove",
      setCompDownloading: "Downloading the browser component {percent}% ({done} / {total})",
      setCompDownloadingUnknown: "Downloading the browser component ({done} so far)",
      setCompVerifying: "Verifying the archive…",
      setCompExtracting: "Extracting…",
      setCompInstalled: "Browser component is ready",
      setCompRemoved: "Browser component removed",
      setCompLeftover: "The component is disabled. DSH still holds the files open; they are cleaned up automatically on the next start, and reinstalling reuses them instead of downloading again.",
      setCompCancelled: "Download cancelled",
      setCompOpened: "Detached window opened",

      setSizing: "Sizing",
      setSizingHint: "Fixed keeps its pixel size; percentage follows the browser window.",
      setSizingFixed: "Fixed",
      setSizingFixedHint: "A deterministic pixel size that does not change with the window.",
      setSizingPercent: "Percentage",
      setSizingPercentHint: "A share of the browser viewport.",
      setSize: "Modal size",
      setSizeHint: "Small 860×560 · Medium 1100×720 · Large 1320×820 · XL 1600×960; clamped to the viewport.",
      setSizePercentHint: "A share of the browser viewport; 100% fills it.",
      setSizeSm: "S",
      setSizeMd: "M",
      setSizeLg: "L",
      setSizeXl: "XL",
      setSizeP50: "50%",
      setSizeP70: "70%",
      setSizeP85: "85%",
      setSizeP100: "100%",
      setDim: "Backdrop dim",
      setDimHint: "Defaults to 0 so a wallpaper is never darkened (hard constraint 10); capped at 80%.",
      setCloseOnBackdrop: "Close on backdrop click",
      setDataDir: "Current directory",
      setDataDirDefault: "Default location (never migrated)",
      setDataDirHint: "The plugin's tree, tags, settings and trash live here; migrating moves all of them.",
      setDataDirChange: "Change location…",
      setDataDirInspecting: "Checking…",
      setDataDirSize: "Size on disk",
      setDataDirConfirm: "Migrate to",
      setDataDirPlanMove: "Same disk: the old directory is deleted once the copy is complete.",
      setDataDirPlanCopy: "Different disk: the old directory is kept with a .location pointer.",
      setDataDirGo: "Start migration",
      setDataDirMoving: "Migrating…",
      setDataDirMoved: "Migration complete; the old directory was removed.",
      setDataDirCopied: "Migration complete; the old directory was kept.",
      setDataDirFailed: "Migration failed and was rolled back to the original directory.",
      setPickUnavailable: "This environment provides no directory picker.",
      setCancel: "Cancel",
      setEnvOverride: "DSH_SE_DATA_DIR overrides the stored directory, so migration is ignored.",
      setSaving: "Saving…",
      setSaved: "Saved",
      setFailed: "Save failed",
      setLoading: "Loading settings…",
    };

    // ── Entry point ────────────────────────────────────────────────────────
    function apply(ctx) {
      hostCtx = ctx;
      installStyle();
      ctx.effect?.(() => ctx.locale.register(NS, { zh: ZH, en: EN }), "session-explorer: dictionaries");

      // The panel entry lives in the sidebar footer.
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({
          name: "sidebar.footer.action",
          id: "session-explorer-footer",
          order: 40,
          locale: NS,
        }, FooterAction),
      );

      // The settings page lives in the settings window's own nav. `label` is a
      // thunk so the entry follows a language switch without re-registering the
      // slot, exactly as DSH's own sections do. `order: 510` puts it after the
      // built-in sections.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({
          name: "settings.section",
          id: "session-explorer",
          order: 510,
          label: () => ctx.locale.bind(NS)("navLabel"),
          locale: NS,
        }, SettingsSection),
      );

      /**
       * Capture the shell's `openSection` without showing anything.
       *
       * The onboarding roster mounts one step at a time and waits for each to
       * either render or call `complete()`. This step does both — it takes the
       * function it was handed and completes on the spot — so it costs one
       * render and leaves no UI behind.
       */
      ctx.slots.inject("settings.onboarding", () =>
        ctx.slots.register({
          name: "settings.onboarding",
          id: "session-explorer-opener",
          // Late: any real onboarding step should paint first.
          order: 900,
          locale: NS,
        }, (props) => {
          if (typeof props?.openSection === "function") openSettingsSection = props.openSection;
          // Completing during render would warn; a layout effect is one tick.
          React.useEffect(() => { props?.complete?.(); }, [props]);
          return null;
        }),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "uiWorkspace"];
    exports.panelStore = panelStore;
    exports.SettingsSection = SettingsSection;
    return module.exports;
  },
});
