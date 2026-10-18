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
      if (!alive) {
        let element = document.getElementById("dsh-session-explorer-overlay-root");
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
      }
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

   data-size comes from settings.shell.modal.size; data-mode from
   settings.shell.openMode. Both are set by Panel, so the CSS never has to
   guess which presentation is active.

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
.se-shell[data-size="sm"]{width:min(900px,92vw);height:min(600px,88vh)}
.se-shell[data-size="md"]{width:min(1100px,92vw);height:min(720px,88vh)}
.se-shell[data-size="lg"]{width:min(1280px,92vw);height:min(800px,88vh)}
.se-shell[data-size="full"]{width:96vw;height:92vh}

/* Material presets stay available, but every one of them is opaque enough to
   read text over: transparency without a blur is just a wallpaper showing
   through, so the weakest is 88%. */
.se-shell[data-material="strong"]{--panel-alpha:88%}
.se-shell[data-material="weak"]{--panel-alpha:96%}
.se-shell[data-material="solid"]{--panel-alpha:100%}

/* Window mode is positioned by Panel (remembered bounds) and can be dragged;
   modal mode is centred by the rule above and hides the min/max buttons. */
.se-shell[data-mode="window"]{margin:0}

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
.se-shell .tab-add{width:28px;height:28px;display:grid;place-items:center;border-radius:4px;color:var(--sm-text-2);margin-bottom:1px;flex:0 0 28px}
.se-shell .tab-add:hover{background:color-mix(in oklab, var(--sm-text) 8%, transparent)}
.se-shell .tab.dragging{opacity:.4}
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
.se-shell[data-mode="modal"] .wbtn.min,.se-shell[data-mode="modal"] .wbtn.max{display:none}
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
.se-shell .listhead{display:flex;align-items:center;height:32px;padding:0 12px 0 0;border-bottom:1px solid var(--sm-border-soft); font-size:11.5px;color:var(--sm-text-3);user-select:none;flex:0 0 32px;}
.se-shell .lh{padding:0 8px;display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;overflow:hidden}
.se-shell .lh:hover{color:var(--sm-text-2)}
.se-shell .lh .sortdot{opacity:0;font-size:9px}
.se-shell .lh.sorted{color:var(--sm-text);font-weight:600}
.se-shell .lh.sorted .sortdot{opacity:.8}
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
.se-shell .fhead{display:flex;align-items:center;gap:8px;height:44px;padding:0 10px 0 14px;border-bottom:1px solid var(--sm-border-soft)}
.se-shell .fhead .ftitle{font-size:13px;font-weight:600;color:var(--sm-text)}
.se-shell .fbody{padding:14px;display:flex;flex-direction:column;gap:12px;overflow:auto}
.se-shell .frow{display:flex;align-items:center;gap:10px}
.se-shell .flb{flex:0 0 88px;font-size:12px;color:var(--sm-text-2);display:flex;flex-direction:column;gap:2px}
.se-shell .fsub{font-size:10px;color:var(--sm-text-3)}
.se-shell .fseg{display:flex;gap:0;border:1px solid var(--sm-border);border-radius:5px;overflow:hidden}
.se-shell .fseg button{font:inherit;font-size:11.5px;padding:5px 11px;background:transparent;border:0;color:var(--sm-text-2);cursor:pointer; border-right:1px solid var(--sm-border-soft);}
.se-shell .fseg button:last-child{border-right:0}
.se-shell .fseg button:hover{background:color-mix(in oklab, var(--sm-text) 7%, transparent)}
.se-shell .fseg button.on{background:color-mix(in oklab, var(--sm-accent) 24%, transparent);color:var(--sm-text)}
.se-shell .fsel{flex:1;min-width:0;font:inherit;font-size:11.5px;padding:5px 8px;border-radius:5px; background:color-mix(in oklab, var(--sm-text) 6%, transparent); border:1px solid var(--sm-border);color:var(--sm-text);cursor:pointer;}
.se-shell .fsel option{background:#1f1f1f;color:#fff}
.se-shell .ftags{flex:1;display:flex;flex-wrap:wrap;gap:5px}
.se-shell .ffoot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--sm-border-soft)}
.se-shell .ffoot .spacer{flex:1}
.se-shell .cmd{gap:6px;padding:0 10px}
.se-shell .det-actions{margin-top:auto;padding:12px 14px;display:flex;flex-wrap:wrap;gap:6px;border-top:1px solid var(--sm-border-soft)}
.se-shell .act{display:flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:4px;font:inherit;font-size:12px; background:color-mix(in oklab, var(--sm-text) 7%, transparent);border:1px solid var(--sm-border); color:var(--sm-text);cursor:pointer;}
.se-shell .act:hover{background:color-mix(in oklab, var(--sm-text) 12%, transparent)}
.se-shell .act.primary{background:var(--sm-accent);border-color:transparent;color:#04283a;font-weight:600}
.se-shell .act.danger{color:var(--sm-danger)}
.se-shell .status{flex:0 0 28px;height:28px;display:flex;align-items:center;gap:12px;padding:0 10px 0 14px; position:relative;z-index:9; border-top:1px solid var(--sm-border);font-size:11.5px;color:var(--sm-text-2); background:color-mix(in oklab, var(--sm-tint) 94%, transparent);}
.se-shell .status .s-item{display:flex;align-items:center;gap:5px}
.se-shell .status .s-item.clickable{cursor:pointer;border-radius:3px;padding:2px 5px;margin:-2px -5px}
.se-shell .status .s-item.clickable:hover{background:color-mix(in oklab, var(--sm-text) 8%, transparent);color:var(--sm-text-2)}
.se-shell .status .s-item.clickable.on{background:color-mix(in oklab, var(--sm-accent) 22%, transparent);color:var(--sm-text)}
.se-shell .viewswitch{margin-left:auto;display:flex;align-items:center;gap:1px}
.se-shell .vsw{width:26px;height:22px;display:grid;place-items:center;border-radius:3px;color:var(--sm-text-3);background:transparent;border:0;cursor:pointer}
.se-shell .vsw:hover{background:color-mix(in oklab, var(--sm-text) 9%, transparent);color:var(--sm-text)}
.se-shell .vsw.on{color:var(--sm-accent);background:color-mix(in oklab, var(--sm-accent) 14%, transparent)}
.se-shell[data-mode="modal"] .rz{display:none}
.se-shell .ctxmenu{position:fixed;z-index:9000;min-width:190px;padding:4px;border-radius:8px; background:color-mix(in oklab, var(--sm-tint) 88%, transparent); backdrop-filter:blur(30px) saturate(1.5); border:1px solid var(--sm-border); box-shadow:0 16px 40px rgba(0,0,0,.42); display:none;}
.se-shell .ctxmenu.open{display:block;animation:pop .12s ease-out}
@keyframes pop{from{opacity:0;transform:scale(.97) translateY(-2px)}to{opacity:1;transform:none}}
.se-shell .mi{display:flex;align-items:center;gap:9px;height:30px;padding:0 9px;border-radius:4px;font-size:12.5px; cursor:default;color:var(--sm-text);}
.se-shell .mi:hover{background:color-mix(in oklab, var(--sm-text) 9%, transparent)}
.se-shell .mi .ic{color:var(--sm-text-2);flex:0 0 16px}
.se-shell .mi .k{margin-left:auto;font-size:11px;color:var(--sm-text-3)}
.se-shell .mi.danger{color:var(--sm-danger)}
.se-shell .mi.danger .ic{color:var(--sm-danger)}
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
.se-shell[data-view="list"] .col-size,.se-shell[data-view="list"] .col-status{display:none}
.se-shell[data-view="icons"] .listhead{display:none}
.se-shell[data-view="icons"] .listbody{display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px;align-content:flex-start;}
.se-shell[data-view="icons"] .grp{flex:0 0 100%;position:static;margin:6px 0 0;background:transparent;backdrop-filter:none}
.se-shell[data-view="icons"] .row{flex:0 0 176px;width:176px;height:auto;min-height:118px;flex-direction:column;align-items:stretch; justify-content:flex-start;padding:10px;border:1px solid var(--sm-border-soft);border-radius:6px;gap:3px;}
.se-shell[data-view="icons"] .row:hover{border-color:var(--sm-border)}
.se-shell[data-view="icons"] .row .cell{display:none}
.se-shell[data-view="icons"] .row .col-name{display:block;padding:0;flex:0 0 auto;width:100%;min-width:0}
.se-shell[data-view="icons"] .row .col-tags,.se-shell[data-view="icons"] .row .col-note,.se-shell[data-view="icons"] .row .col-date{display:block;flex:0 0 auto;width:100%;padding:0;font-size:10.5px;line-height:1.3; white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.se-shell[data-view="icons"] .row .namecell{flex-direction:column;align-items:flex-start;gap:6px;width:100%}
.se-shell[data-view="icons"] .row .namecell .ic{width:26px;height:26px}
.se-shell[data-view="icons"] .row .nm{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:12px;line-height:1.35}
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

/* command bar split: the write commands may scroll, the view cluster must not */
.se-shell .cmdbar{overflow:hidden;gap:0;padding:0 10px}
.se-shell .cmdscroll{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}
.se-shell .cmdscroll::-webkit-scrollbar{display:none}
.se-shell .cmdfixed{display:flex;align-items:center;gap:4px;flex:0 0 auto;padding-left:8px;margin-left:4px;background:linear-gradient(to right, transparent, color-mix(in oklab, var(--sm-text) 3%, transparent) 14px)}
.se-shell .cmd.on{background:color-mix(in oklab, var(--sm-accent) 14%, transparent);color:var(--sm-accent)}

.se-footerBtn-rail{justify-content:center;padding:5px 0}
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

    function statusOf(session) {
      if (session.running) return { cls: "run", text: "运行中" };
      if (session.formatVersion && session.formatVersion !== 4) return { cls: "err", text: "异常" };
      return { cls: "", text: "空闲" };
    }

    function sortValue(session, key) {
      if (key === "name") return session.displayTitle ?? "";
      if (key === "updated") return session.activityAt ?? 0;
      if (key === "size") return session.sizeBytes ?? 0;
      if (key === "status") return statusOf(session).text;
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
        return result * dir;
      };
    }

    const SORT_CYCLE = ["updated", "name", "size", "status"];

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

    function Trow({ scope, icon, label, count, active, tone, depth = 0, hasKids = false, expanded = false, onToggle, onSelect, draggable, onDragStart, onDrop, dropActive }) {
      return h(
        "div",
        {
          className:
            "trow" +
            (tone === "ws" ? " ws" : "") +
            (active ? " sel" : "") +
            (dropActive ? " drop" : ""),
          "data-scope": scope,
          style: { paddingLeft: 6 + depth * 14 },
          draggable: draggable === true,
          onDragStart: draggable ? onDragStart : undefined,
          onDragOver: onDrop
            ? (event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            : undefined,
          onDrop: onDrop
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onDrop(scope, event);
              }
            : undefined,
          onClick: (event) => {
            event.stopPropagation();
            onSelect(scope);
          },
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
        h("span", { className: "lbl" }, label),
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
    function TreePane({ tree, scope, onSelect, expanded, onToggle, width, onMove }) {
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
      const VIEW_KINDS = new Set(["ungrouped", "todos", "favorites", "trash"]);

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
        // Only folders and the root accept a drop: a workspace is a leaf that
        // mirrors DSH's own registry, and moving into it would invent a
        // containment DSH does not have (R1).
        const acceptsDrop = node.id === FIXED.root || (node.type === "folder" && !node.fixed);
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
            draggable: node.type === "folder" ? !node.fixed : true,
            onDragStart: (event) => {
              event.dataTransfer.setData("text/plain", id);
              event.dataTransfer.effectAllowed = "move";
            },
            onDrop: acceptsDrop
              ? (targetId, event) => {
                  const sourceId = event.dataTransfer.getData("text/plain");
                  if (sourceId && sourceId !== targetId) onMove(sourceId, targetId);
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

    function SessionRow({ session, selected, now, onSelect, checked, onCheck, depth = 0, childCount = 0, collapsed = false, onToggleChildren }) {
      const status = statusOf(session);
      const isChild = Boolean(session.isSubagent);
      return h(
        "div",
        {
          className:
            "row" +
            (selected ? " sel" : "") +
            (session.archived ? " arch" : "") +
            (session.pinned ? " pinned-row" : "") +
            (depth > 0 ? " sub-row" : ""),
          "data-id": session.id,
          style: depth > 0 ? { "--indent": `${(depth) * 16}px` } : undefined,
          onClick: (event) => onSelect(session.id, event),
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
            h("span", { className: "nm", title: session.id }, session.displayTitle ?? session.id),
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

    function WorkspaceRow({ node, count, selected, onOpen, checked, onCheck, onSelect }) {
      const label = node.name ?? node.path ?? node.id;
      return h(
        "div",
        { className: "row frow wsrow" + (selected ? " sel" : ""), "data-id": node.id, onClick: (event) => onSelect(node.id, event), onDoubleClick: () => onOpen(node.id) },
        h(
          "div",
          { className: "cell col-check col-check-cell" },
          h(
            "span",
            {
              className: "chk" + (checked ? " on" : ""),
              onClick: (event) => {
                event.stopPropagation();
                onCheck(node.id);
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
            h("span", { className: "fl-ic" }, h(Icon, { name: "monitor", className: "ic wsic" })),
            h("span", { className: "nm", title: node.path ?? "" }, label),
            h("span", { className: "wstag" }, "工作区"),
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
        onSort,
        now,
        view,
        onOpenWorkspace,
        colWidths,
        onResizeColumn,
        listRef,
        collapsed,
        onToggleChildren,
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

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return sessions;
        return sessions.filter((session) =>
          [session.displayTitle, session.title, session.cwd, session.id, session.workspaceTitle]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(needle)),
        );
      }, [sessions, query]);

      const sorted = useMemo(() => filtered.slice().sort(compareBy(sortKey, -1)), [filtered, sortKey]);

      const pinned = sorted.filter((session) => session.pinned && !session.archived);
      const normal = sorted.filter((session) => !session.pinned && !session.archived);
      const archived = sorted.filter((session) => session.archived);

      const showWorkspaces = scope === FIXED.root;
      const workspaceNodes = showWorkspaces
        ? (tree?.children?.[FIXED.root] ?? []).filter((id) => tree.nodes[id]?.type === "workspace").map((id) => tree.nodes[id])
        : [];

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
          }),
        );

      // Group order mirrors the prototype: 置顶 first, then the containers the
      // scope holds (工作区), then plain sessions, then archived rows sink last.
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
      if (workspaceNodes.length > 0 && !query.trim()) {
        groups.push({
          key: "ws",
          title: "工作区",
          icon: "monitor",
          count: workspaceNodes.length,
          rows: workspaceNodes.map((node) =>
            h(WorkspaceRow, {
              key: node.id,
              node,
              count: tree.counts?.[node.id] ?? 0,
              selected: scope === node.id,
              checked: checked.has(node.id),
              onCheck,
              onSelect,
              onOpen: onOpenWorkspace,
            }),
          ),
        });
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
              h("span", { className: "lhlabel" }, column.label + (sortedCol ? " ▼" : "")),
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
                title: query.trim() ? "没有匹配的会话" : scope === FIXED.trash ? "回收站是空的" : "这里还是空的",
                hint: query.trim() ? "试试别的关键词，或清空搜索框" : "P2 起可以新建文件夹和拖拽会话",
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

      const kind = session ? "session" : node?.type === "workspace" ? "workspace" : "folder";
      const label = session ? session.displayTitle ?? session.id : node?.name ?? node?.id ?? "";
      // The root, the trash and the other built-in containers are not ours to
      // rename, so they get no editor at all rather than a failing round trip.
      const canRename = session ? true : Boolean(node && !node.fixed);
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
          h(Icon, { name: kind === "workspace" ? "monitor" : kind === "folder" ? "folder" : "chat", size: 18 }),
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
              ? (session.workspaceTitle ?? "未分组") + " · " + (session.agentPreset ?? "默认预设")
              : kind === "workspace"
                ? node?.path ?? ""
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
        kv("类型", kind === "workspace" ? "工作区" : "文件夹"),
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
        h(Btn, { className: "act primary", icon: "external", onClick: () => onHint("在 DSH 中打开会话需要 P3 的宿主能力") }, "打开"),
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
        h(Btn, { className: "act", icon: "save", onClick: () => onHint("导出会话在 P3 提供（需要 L3 事件流）") }, "导出"),
        h(Btn, { className: "act", icon: "copy", onClick: onFork }, "分叉"),
        h(Btn, { className: "act" + (session.archived ? " on" : ""), icon: "archive", onClick: onArchive }, session.archived ? "取消归档" : "归档"),
        h(Btn, { className: "act danger", icon: "trash", onClick: () => onHint("删除会话需要回收站，计划在 P4 接入") }, "删除"),
      );

      const nodeActions = h(
        "div",
        { className: "det-actions" },
        h(Btn, { className: "act primary", icon: "external", onClick: () => onOpen(node?.id) }, "打开"),
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

    // ── Panel ──────────────────────────────────────────────────────────────
    function Panel({ t }) {
      const [boot, setBoot] = useState({ phase: "loading", data: null, error: null });
      const stored = useRef(readLayout()).current;
      const initialScope = typeof stored.scope === "string" ? stored.scope : FIXED.root;
      const [scope, setScope] = useState(initialScope);
      const [history, setHistory] = useState([initialScope]);
      const [cursor, setCursor] = useState(0);
      const [selected, setSelected] = useState(null);
      const [checked, setChecked] = useState(() => new Set());
      const [query, setQuery] = useState("");
      const [sortKey, setSortKey] = useState(stored.sortKey ?? "updated");
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
      const [now, setNow] = useState(() => Date.now());
      const [bp, setBp] = useState("wide");
      const shellRef = useRef(null);
      const searchRef = useRef(null);

      const load = useCallback(async (refresh) => {
        setBoot((previous) => ({ ...previous, phase: previous.data ? "refreshing" : "loading", error: null }));
        try {
          const data = await apiGet("/bootstrap" + (refresh ? "?refresh=1" : ""));
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
          showDetail,
          navWidth,
          detailWidth,
          colWidths,
          expanded: [...expanded],
        });
      }, [scope, view, sortKey, showDetail, navWidth, detailWidth, colWidths, expanded]);

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") {
            if (query) {
              setQuery("");
              return;
            }
            panelStore.set(false);
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "e") {
            event.preventDefault();
            searchRef.current?.focus();
          }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [query]);

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
      const allSessions = data?.sessions ?? [];

      // Settings live on the host so they follow the user across browsers; the
      // shape is normalised there, so these fallbacks only matter for the first
      // paint before /bootstrap lands.
      const settings = data?.settings ?? null;
      const openMode = settings?.shell?.openMode === "window" ? "window" : "modal";
      const modalSize = settings?.shell?.modal?.size ?? "md";
      const modalDim = Number(settings?.shell?.modal?.dim) || 0;
      const closeOnBackdrop = settings?.shell?.modal?.closeOnBackdrop !== false;

      const navigate = useCallback(
        (next) => {
          if (!next) return;
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
        [cursor],
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

      const sessionsInScope = useMemo(() => {
        if (!data) return [];
        if (scope === FIXED.favorites) return allSessions.filter((session) => session.favorite);
        if (scope === FIXED.ungrouped) return allSessions.filter((session) => !session.workspaceId);
        if (scope === FIXED.trash) return allSessions.filter((session) => session.trashed);
        if (scope === FIXED.todos) return allSessions.filter((session) => session.todo);

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

        if (scope === FIXED.root) return allSessions;
        if (workspaceIds.size === 0) return [];
        return allSessions.filter((session) => session.workspaceId && workspaceIds.has(session.workspaceId));
      }, [allSessions, data, scope, tree]);

      const current = useMemo(() => allSessions.find((session) => session.id === selected) ?? null, [allSessions, selected]);

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

      const counts = tree?.counts ?? {};
      const scopeCount = counts[scope] ?? sessionsInScope.length;
      const archivedInScope = sessionsInScope.filter((session) => session.archived).length;
      const totalSize = sessionsInScope.reduce((sum, session) => sum + (session.sizeBytes ?? 0), 0);

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
        setChecked((previous) => {
          if (event && (event.ctrlKey || event.metaKey)) {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }
          return new Set([id]);
        });
      }, []);

      const checkRow = useCallback((id) => {
        setChecked((previous) => {
          if (id === null) return new Set();
          if (id === "all") {
            if (previous.size > 0) return new Set();
            return new Set(sessionsInScope.map((session) => session.id));
          }
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, [sessionsInScope]);

      const cycleSort = useCallback((key) => {
        setSortKey((previous) => {
          if (previous === key) return key;
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

      const newFolder = useCallback(() => {
        const name = typeof window !== "undefined" && typeof window.prompt === "function"
          ? window.prompt("新建文件夹的名称", "新建文件夹")
          : null;
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        // A folder is created where the user is looking: inside the current
        // folder when one is selected, otherwise at the root.
        const parent = tree?.nodes?.[scope]?.type === "folder" && !tree.nodes[scope].fixed
          ? scope
          : FIXED.root;
        mutate(
          () => apiSend("POST", "/folders", { name: trimmed, parent }),
          `已新建文件夹「${trimmed}」`,
        );
      }, [mutate, scope, tree]);

      const removeFolder = useCallback(() => {
        const node = tree?.nodes?.[scope];
        if (!node || node.type !== "folder" || node.fixed) {
          setHint("只有自建文件夹可以删除");
          return;
        }
        const ask = typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm(`删除文件夹「${node.name}」？其中的内容会移动到上一级。`)
          : true;
        if (!ask) return;
        mutate(() => apiSend("DELETE", `/folders/${encodeURIComponent(scope)}?lift=1`), "已删除文件夹");
      }, [mutate, scope, tree]);

      // The list rows the user can act on: the checked set, or the selected row.
      const targets = useMemo(() => {
        const ids = checked.size > 0 ? [...checked] : selected ? [selected] : [];
        return ids.filter((id) => sessionsById.has(id));
      }, [checked, selected, sessionsById]);

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

      // ── native operations ────────────────────────────────────────────────
      // Rename, fork, archive and pin all exist in DSH itself. These callbacks
      // only forward to the host routes that wrap the native services; the
      // plugin stores none of them, so the official UI and this panel always
      // agree (hard constraint 2 / S8).

      // Renaming lives in the detail pane only (m01340): the title row carries
      // the editor, so there is exactly one place a name can change. `kind` says
      // which store owns the name — a session and a workspace are DSH's own
      // (native calls, nothing stored here), a folder is the plugin's own node.
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

      /** Run one native operation over every target session. */
      const forEachTarget = useCallback(
        async (path, body, successHint) => {
          if (targets.length === 0) {
            setHint("先选择要操作的会话");
            return;
          }
          await mutate(async () => {
            for (const id of targets) {
              await apiSend("POST", `/sessions/${encodeURIComponent(id)}${path}`, body ?? {});
            }
          }, successHint);
        },
        [mutate, targets],
      );

      const togglePin = useCallback(() => {
        if (targets.length === 0) {
          setHint("先选择要置顶的会话");
          return;
        }
        // 最新置顶在最前, so "all pinned" means "the first target is pinned".
        const pinned = sessionsById.get(targets[0])?.pinned === true;
        forEachTarget(pinned ? "/unpin" : "/pin", {}, pinned ? "已取消置顶" : "已置顶");
      }, [forEachTarget, sessionsById, targets]);

      const toggleArchive = useCallback(() => {
        if (targets.length === 0) {
          setHint("先选择要归档的会话");
          return;
        }
        const archived = sessionsById.get(targets[0])?.archived === true;
        if (archived) {
          forEachTarget("/unarchive", {}, "已取消归档");
          return;
        }
        // Archiving keeps the log and the position; it only de-emphasises the
        // row (hard constraint 3). A session with running work is refused by the
        // host with workspace/session-active, so the user gets a confirmation
        // instead of a silent failure.
        const running = targets.some((id) => sessionsById.get(id)?.running === true);
        if (running) {
          const ask = typeof window !== "undefined" && typeof window.confirm === "function"
            ? window.confirm("其中有会话正在运行。停止运行并归档？")
            : true;
          if (!ask) return;
          forEachTarget("/archive", { stopActivity: true }, "已停止运行并归档");
          return;
        }
        forEachTarget("/archive", {}, "已归档");
      }, [forEachTarget, sessionsById, targets]);

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

      const command = useCallback((label) => setHint(`${label}：写操作在后续阶段接入，当前版本只读`), []);

      useEffect(() => {
        if (!hint) return;
        const timer = setTimeout(() => setHint(""), 2600);
        return () => clearTimeout(timer);
      }, [hint]);

      const scopeTitle = useMemo(() => {
        const node = tree?.nodes?.[scope];
        const meta = FIXED_META[scope];
        return meta?.label ?? node?.name ?? "会话";
      }, [tree, scope]);

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
          h(TreePane, { tree, scope, onSelect: navigate, expanded, onToggle: toggleExpanded, width: navWidth, onMove: moveNodeTo }),
          h("div", { className: "rsz", onMouseDown: (event) => resizePane(event, "tree") }),
          h(ListPane, {
            sessions: sessionsInScope,
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
            now,
            view,
            onOpenWorkspace: navigate,
            colWidths,
            onResizeColumn: resizeColumn,
            listRef: null,
            collapsed,
            onToggleChildren: toggleChildren,
          }),
          h("div", { className: "rsz rsz-detail", onMouseDown: (event) => resizePane(event, "detail") }),
          h(DetailPane, {
            session: current,
            // With no session selected, the detail pane still describes the
            // node the user is standing in, so a workspace or folder can be
            // renamed from the same title row (m01340).
            node: current ? null : tree?.nodes?.[scope] ?? null,
            now,
            parent,
            children: currentChildren,
            forks: currentForks,
            forkSource,
            onOpen: selectAndReveal,
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

      return portalFragment([
        scrim,
        h(
          "div",
          {
            className: "se-shell",
            ref: shellRef,
            "data-bp": bp,
            "data-view": view,
            "data-detail": showDetail ? "on" : "off",
            "data-material": "auto",
            "data-mode": openMode,
            "data-size": modalSize,
            style: { "--nav-width": `${navWidth}px`, "--detail-width": `${detailWidth}px` },
          },
          // titlebar
          h(
            "div",
            { className: "titlebar" },
            h(
              "div",
              { className: "tabs" },
              h(
                "div",
                { className: "tab active" },
                h("span", { className: "t-ic" }, h(Icon, { name: "chat", size: 13 })),
                h("span", { className: "tname" }, scopeTitle),
                h("span", { className: "x", onClick: () => panelStore.set(false), title: "关闭" }, h(Icon, { name: "x", size: 11 })),
              ),
              h("button", { type: "button", className: "tab-add", title: "多标签在 P5 提供", onClick: () => setHint("多标签浏览在 P5 提供") }, h(Icon, { name: "plus", size: 13 })),
            ),
            h(
              "div",
              { className: "wbtns" },
              h("button", { type: "button", className: "wbtn", title: "最小化（面板随侧栏按钮开关）", onClick: () => panelStore.set(false) }, h(Icon, { name: "minus", size: 13 })),
              h("button", { type: "button", className: "wbtn", title: "最大化", onClick: () => setHint("窗口最大化需要脱离侧栏浮层，计划在 P5") }, h(Icon, { name: "square", size: 12 })),
              h("button", { type: "button", className: "wbtn close", title: "关闭", onClick: () => panelStore.set(false) }, h(Icon, { name: "x", size: 13 })),
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
                placeholder: "搜索会话（Ctrl+E）",
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
              h(Btn, { className: "cmd", icon: "plus", onClick: () => command("新建会话") }, "新建会话"),
              h(Btn, { className: "cmd", icon: "folderplus", onClick: newFolder }, "新建文件夹"),
              h("span", { className: "cmsep" }),
              h(Btn, { className: "cmd", icon: "cut", iconOnly: true, title: "剪切", onClick: () => command("剪切") }),
              h(Btn, { className: "cmd", icon: "copy", iconOnly: true, title: "复制", onClick: () => command("复制") }),
              h(Btn, { className: "cmd", icon: "paste", iconOnly: true, title: "粘贴", onClick: () => command("粘贴") }),
              h("span", { className: "cmsep" }),
              h(Btn, { className: "cmd", icon: "star", onClick: () => toggleFlag("favorite") }, "收藏"),
              h(Btn, { className: "cmd", icon: "todo", onClick: () => toggleFlag("todo") }, "待办"),
              h(Btn, { className: "cmd", icon: "pin", onClick: togglePin }, "置顶"),
              h(Btn, { className: "cmd", icon: "archive", onClick: toggleArchive }, "归档"),
              h(Btn, { className: "cmd", icon: "copy", iconOnly: true, title: "分叉会话", onClick: forkSession }),
              h(Btn, { className: "cmd danger", icon: "trash", onClick: removeFolder }, "删除"),
              scope === FIXED.trash
                ? h(Btn, { className: "cmd danger", icon: "trash", onClick: () => command("清空回收站") }, "清空回收站")
                : null,
              h("span", { className: "cmsep" }),
              h(Btn, { className: "cmd", icon: "tag", onClick: () => command("筛选") }, "筛选"),
            ),
            h(
              "div",
              { className: "cmdfixed" },
              h(Btn, {
                className: "cmd",
                icon: "sort",
                onClick: () => {
                  const index = SORT_CYCLE.indexOf(sortKey);
                  setSortKey(SORT_CYCLE[(index + 1) % SORT_CYCLE.length]);
                },
              }, "排序"),
              h(Btn, {
                className: "cmd",
                icon: "grid",
                onClick: () => setView((previous) => (previous === "details" ? "list" : previous === "list" ? "icons" : "details")),
              }, "查看"),
              h(Btn, { className: "cmd", icon: "more", iconOnly: true, title: "更多", onClick: () => command("更多操作") }),
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
            h("div", { className: "s-item" }, `${formatCount(sessionsInScope.length)} 个项目`),
            archivedInScope > 0 ? h("div", { className: "s-item" }, `${formatCount(archivedInScope)} 个已归档`) : null,
            h("div", { className: "s-item" }, checked.size > 0 ? `已选 ${formatCount(checked.size)} 项` : "未选择"),
            h("div", { className: "s-item" }, `共 ${formatSize(totalSize) || "0 B"}`),
            hint ? h("div", { className: "s-item clickable on" }, hint) : null,
            h(
              "div",
              { className: "viewswitch" },
              h("button", { type: "button", className: "vsw" + (view === "details" ? " on" : ""), title: "详细信息", onClick: () => setView("details") }, h(Icon, { name: "details", size: 13 })),
              h("button", { type: "button", className: "vsw" + (view === "list" ? " on" : ""), title: "列表", onClick: () => setView("list") }, h(Icon, { name: "list", size: 13 })),
              h("button", { type: "button", className: "vsw" + (view === "icons" ? " on" : ""), title: "图标", onClick: () => setView("icons") }, h(Icon, { name: "grid", size: 13 })),
            ),
          ),
        ),
      ]);
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
        open ? h(Panel, { t }) : null,
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
      const windowOptions = shell.window;
      const detachedReady = false;

      return h(
        "div",
        { className: "se-set" },
        h("div", { className: "se-set-note" }, t("setIntro")),

        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupOpen")),
          h(
            SetRow,
            { label: t("setOpenMode"), hint: t("setOpenModeHint") },
            h(SetChips, {
              value: shell.openMode,
              disabled: saving,
              options: [
                { value: "modal", label: t("setModeModal") },
                { value: "window", label: t("setModeWindow") },
                {
                  value: "detached",
                  label: t("setModeDetached"),
                  title: detachedReady ? undefined : t("setModeDetachedLocked"),
                  disabled: !detachedReady,
                },
              ],
              onPick: (openMode) => save({ shell: { openMode } }),
            }),
          ),
        ),

        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupModal")),
          h(
            SetRow,
            { label: t("setSize"), hint: t("setSizeHint") },
            h(SetChips, {
              value: modal.size,
              disabled: saving,
              options: [
                { value: "sm", label: t("setSizeSm") },
                { value: "md", label: t("setSizeMd") },
                { value: "lg", label: t("setSizeLg") },
                { value: "full", label: t("setSizeFull") },
              ],
              onPick: (size) => save({ shell: { modal: { size } } }),
            }),
          ),
          h(
            SetRow,
            { label: t("setDim"), hint: t("setDimHint") },
            h("input", {
              type: "range",
              className: "se-set-range",
              min: 0,
              max: 0.8,
              step: 0.05,
              value: modal.dim,
              disabled: saving,
              onChange: (event) => save({ shell: { modal: { dim: Number(event.target.value) } } }),
            }),
            h("span", { className: "se-set-val" }, Math.round(modal.dim * 100) + "%"),
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
          h(
            SetRow,
            { label: t("setRememberBounds") },
            h(SetSwitch, {
              on: modal.rememberBounds,
              disabled: saving,
              title: t("setRememberBounds"),
              onToggle: (rememberBounds) => save({ shell: { modal: { rememberBounds } } }),
            }),
          ),
        ),

        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupWindow")),
          h(
            SetRow,
            { label: t("setAlwaysOnTop"), hint: t("setAlwaysOnTopHint") },
            h(SetSwitch, {
              on: windowOptions.alwaysOnTop,
              disabled: saving || shell.openMode !== "window",
              title: t("setAlwaysOnTop"),
              onToggle: (alwaysOnTop) => save({ shell: { window: { alwaysOnTop } } }),
            }),
          ),
        ),

        h(
          "div",
          { className: "se-set-grp" },
          h("div", { className: "se-set-h" }, t("setGroupComponent")),
          h(
            SetRow,
            { label: t("setComponentPhase"), hint: t("setComponentPhaseHint") },
            h("span", { className: "se-set-path" }, "absent"),
          ),
          h(
            SetRow,
            { label: t("setReuseOrb"), hint: t("setReuseOrbHint") },
            h(SetSwitch, {
              on: settings.component.reuseOrbRuntime,
              disabled: saving,
              title: t("setReuseOrb"),
              onToggle: (reuseOrbRuntime) => save({ component: { reuseOrbRuntime } }),
            }),
          ),
        ),

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
      title: "会话浏览器",
      footerLabel: "会话浏览器",
      close: "关闭",
      loading: "正在加载…",
      error: "加载失败",
      refresh: "刷新",
      searchPlaceholder: "搜索会话",
      noSessions: "这里还没有会话",
      selectSession: "选中一项查看详情",
      running: "运行中",
      pinned: "已置顶",
      archived: "已归档",
      blank: "空会话",
      ungrouped: "未分组",
      statusLine: "{sessions} 个会话 · {cached} 个来自投影缓存 · {workspaces} 个工作区 · 扫描 {ms} ms",
      navLabel: "会话浏览器",
      setTitle: "会话浏览器",
      setIntro: "这些设置由会话浏览器插件保存，跟随账号而非浏览器。",
      setGroupOpen: "打开方式",
      setGroupModal: "弹窗",
      setGroupWindow: "窗口",
      setGroupComponent: "浏览器组件",
      setGroupData: "数据目录",
      setOpenMode: "默认弹出方式",
      setOpenModeHint: "「独立窗口」需要先下载浏览器组件，未就绪时不可选。",
      setModeModal: "弹窗",
      setModeWindow: "窗口",
      setModeDetached: "独立窗口",
      setModeDetachedLocked: "需先下载浏览器组件",
      setSize: "弹窗尺寸",
      setSizeHint: "小 900×600 · 中 1100×720 · 大 1280×800 · 全屏 96%×92%。",
      setSizeSm: "小",
      setSizeMd: "中",
      setSizeLg: "大",
      setSizeFull: "全屏",
      setDim: "背景遮罩",
      setDimHint: "默认 0：壁纸不被压暗（硬约束 10），上限 80%。",
      setCloseOnBackdrop: "点击遮罩关闭",
      setRememberBounds: "记住窗口位置和大小",
      setAlwaysOnTop: "窗口置顶",
      setAlwaysOnTopHint: "仅窗口模式生效。",
      setComponentPhase: "组件状态",
      setComponentPhaseHint: "组件安装器在 P6 提供；此处只显示当前状态。",
      setReuseOrb: "复用 dsh-orb 的 Electron 运行时",
      setReuseOrbHint: "关闭后组件会单独下载一份运行时。",
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
      title: "Session explorer",
      footerLabel: "Session explorer",
      close: "Close",
      loading: "Loading…",
      error: "Failed to load",
      refresh: "Refresh",
      searchPlaceholder: "Search sessions",
      noSessions: "No sessions here yet",
      selectSession: "Select an item to see details",
      running: "Running",
      pinned: "Pinned",
      archived: "Archived",
      blank: "Blank",
      ungrouped: "Ungrouped",
      statusLine: "{sessions} sessions · {cached} from projection cache · {workspaces} workspaces · scanned in {ms} ms",
      navLabel: "Session explorer",
      setTitle: "Session explorer",
      setIntro: "These settings are stored by the plugin and follow the account, not the browser.",
      setGroupOpen: "Presentation",
      setGroupModal: "Modal",
      setGroupWindow: "Window",
      setGroupComponent: "Browser component",
      setGroupData: "Data directory",
      setOpenMode: "Default presentation",
      setOpenModeHint: '\"Detached window\" needs the browser component; it stays disabled until that is ready.',
      setModeModal: "Modal",
      setModeWindow: "Window",
      setModeDetached: "Detached",
      setModeDetachedLocked: "Download the browser component first",
      setSize: "Modal size",
      setSizeHint: "Small 900×600 · Medium 1100×720 · Large 1280×800 · Full 96%×92%.",
      setSizeSm: "S",
      setSizeMd: "M",
      setSizeLg: "L",
      setSizeFull: "Full",
      setDim: "Backdrop dim",
      setDimHint: "Defaults to 0 so a wallpaper is never darkened (hard constraint 10); capped at 80%.",
      setCloseOnBackdrop: "Close on backdrop click",
      setRememberBounds: "Remember window bounds",
      setAlwaysOnTop: "Always on top",
      setAlwaysOnTopHint: "Window mode only.",
      setComponentPhase: "Component state",
      setComponentPhaseHint: "The installer lands in P6; this only reports the current state.",
      setReuseOrb: "Reuse the dsh-orb Electron runtime",
      setReuseOrbHint: "When off, the component downloads its own runtime.",
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
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "uiWorkspace"];
    exports.panelStore = panelStore;
    exports.SettingsSection = SettingsSection;
    return module.exports;
  },
});
