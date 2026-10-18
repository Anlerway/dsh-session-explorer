/**
 * dsh-session-explorer — client half (browser bundle, no build step).
 *
 * Loaded through `window.__ModuleLoader__.load({ id, factory })`, exactly like
 * every other out-of-tree DSH client plugin. `factory` receives a `require`
 * that resolves the host's shared modules (`react`, the UI primitives) — the
 * plugin ships no bundler output and no runtime dependency of its own.
 *
 * P0 scope: register the sidebar-footer entry, open an overlay panel, and prove
 * the host round-trip works by fetching `/bootstrap` on open. The panes arrive
 * in the later phases.
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

    function portal(node) {
      const root = getOverlayRoot();
      if (!root) return node;
      const createPortal = React.createPortal
        ?? (typeof require === "function" ? (() => {
          try {
            return require("react-dom")?.createPortal;
          } catch {
            return undefined;
          }
        })() : undefined);
      return typeof createPortal === "function" ? createPortal(node, root) : node;
    }

    // ── Styles ─────────────────────────────────────────────────────────────
    const CSS = `
      /* DSH's own theme is the single source of colour: every rule below reads
         --dsw-alias-* tokens and none of them is redefined here, so a theme (or
         a third-party theme plugin) that republishes those tokens is picked up
         automatically. Inline colours are never written onto the panel root --
         that is what makes a plugin ignore the active theme. */
      .se-footerBtn {
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        width: 100%;
        min-height: 32px;
        padding: 6px 10px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        text-align: left;
        box-sizing: border-box;
      }
      .se-footerBtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
      .se-footerBtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #356ae6); outline-offset: 1px; }
      .se-footerBtn-rail { justify-content: center; width: 36px; height: 36px; padding: 0; }
      .se-footerBtn-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      .se-overlay {
        position: fixed;
        inset: 0;
        pointer-events: none;
      }
      .se-backdrop {
        position: absolute;
        inset: 0;
        background: transparent;
        pointer-events: auto;
      }
      /* Centred via inset:0 + margin:auto (the same anchoring DSH's own dialogs
         use) rather than a flex parent: the panel then stays centred no matter
         which layer of the overlay tree portals it in. */
      .se-panel {
        position: fixed;
        inset: 0;
        margin: auto;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        width: min(1080px, calc(100vw - 64px));
        height: min(760px, calc(100vh - 64px));
        box-sizing: border-box;
        border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
        background: var(--dsw-alias-bg-layer-1, #fff);
        color: var(--dsw-alias-label-primary, #111);
        box-shadow: 0 16px 48px rgba(0, 0, 0, .25);
        overflow: hidden;
        font-size: 13px;
        line-height: 20px;
      }
      .se-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 16px;
        min-height: 46px;
        box-sizing: border-box;
        border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
        flex: none;
      }
      .se-title {
        font-size: 14px;
        line-height: 20px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #111);
      }
      .se-spacer { flex: 1; }
      .se-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28));
        border-radius: 7px;
        background: transparent;
        color: var(--dsw-alias-label-secondary, #555);
        font: inherit;
        cursor: pointer;
        flex: none;
        box-sizing: border-box;
      }
      .se-close:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14));
        color: var(--dsw-alias-label-primary, #111);
      }
      .se-body { flex: 1 1 auto; display: flex; min-height: 0; }
      .se-placeholder {
        margin: auto;
        padding: 24px;
        max-width: 460px;
        text-align: center;
        font-size: 12px;
        line-height: 20px;
        color: var(--dsw-alias-label-tertiary, #888);
      }
      .se-status {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 16px;
        border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
        font-size: 11px;
        line-height: 18px;
        color: var(--dsw-alias-label-secondary, #666);
        flex: none;
      }
      .se-badge-err { color: var(--dsw-alias-state-error-primary, #ec1313); }
    `;

    function installStyle() {
      if (typeof document === "undefined") return;
      const selector = `style[data-plugin-css="${CSS_ID}"]`;
      let tag = document.querySelector(selector);
      if (!tag) {
        tag = document.createElement("style");
        tag.dataset.plugin = "dsh-session-explorer";
        tag.dataset.pluginCss = CSS_ID;
        document.head.appendChild(tag);
      }
      // Always rewrite: a hot reload re-executes this bundle in the same page
      // and reuses the tag, so skipping the write would keep stale rules.
      tag.textContent = CSS;
    }

    // ── Host API ───────────────────────────────────────────────────────────
    async function apiGet(path) {
      const response = await fetch(API + path, { method: "GET", credentials: "same-origin" });
      const envelope = await response.json().catch(() => null);
      if (!envelope || envelope.ok !== true) {
        const error = new Error(envelope?.error ?? `HTTP ${response.status}`);
        error.code = envelope?.code ?? "request-failed";
        throw error;
      }
      return envelope.result;
    }

    // ── Panel ──────────────────────────────────────────────────────────────
    function Panel({ t }) {
      const [boot, setBoot] = useState({ status: "loading", data: null, error: null });
      const panelRef = useRef(null);

      useEffect(() => {
        let cancelled = false;
        apiGet("/bootstrap").then(
          (data) => {
            if (!cancelled) setBoot({ status: "ready", data, error: null });
          },
          (error) => {
            if (!cancelled) setBoot({ status: "error", data: null, error });
          },
        );
        return () => {
          cancelled = true;
        };
      }, []);

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            panelStore.set(false);
          }
        };
        window.addEventListener("keydown", onKeyDown, true);
        panelRef.current?.focus?.();
        return () => window.removeEventListener("keydown", onKeyDown, true);
      }, []);

      const status = useMemo(() => {
        if (boot.status === "loading") return t("loading");
        if (boot.status === "error") return `${t("error")}: ${boot.error?.message ?? ""}`;
        const caps = boot.data?.capabilities ?? {};
        return `${t("dataDir")}: ${caps.dataDir ?? "?"}`;
      }, [boot, t]);

      return portal(
        h("div", { className: "se-overlay" },
          h("div", {
            className: "se-backdrop",
            onClick: () => panelStore.set(false),
          }),
          h("div", {
            className: "se-panel",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": t("title"),
            tabIndex: -1,
            ref: panelRef,
          },
            h("div", { className: "se-header" },
              h("span", { className: "se-title" }, t("title")),
              h("span", { className: "se-spacer" }),
              h("button", {
                type: "button",
                className: "se-close",
                "aria-label": t("close"),
                onClick: () => panelStore.set(false),
              }, "✕"),
            ),
            h("div", { className: "se-body" },
              h("div", { className: "se-placeholder" },
                boot.status === "error"
                  ? h("span", { className: "se-badge-err" }, status)
                  : status,
              ),
            ),
            h("div", { className: "se-status" },
              boot.status === "ready"
                ? `${t("sessions")}: — · ${t("workspaces")}: —`
                : t("loading"),
            ),
          ),
        ),
      );
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

    // ── Locale ─────────────────────────────────────────────────────────────
    const ZH = {
      title: "会话浏览器",
      footerLabel: "会话浏览器",
      close: "关闭",
      loading: "正在加载…",
      error: "加载失败",
      dataDir: "数据目录",
      sessions: "会话",
      workspaces: "工作区",
    };
    const EN = {
      title: "Session explorer",
      footerLabel: "Session explorer",
      close: "Close",
      loading: "Loading…",
      error: "Failed to load",
      dataDir: "Data directory",
      sessions: "Sessions",
      workspaces: "Workspaces",
    };

    // ── Entry point ────────────────────────────────────────────────────────
    function apply(ctx) {
      installStyle();
      ctx.effect?.(() => ctx.locale.register(NS, { zh: ZH, en: EN }), "session-explorer: dictionaries");
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({
          name: "sidebar.footer.action",
          id: "session-explorer-footer",
          order: 40,
          locale: NS,
        }, FooterAction),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    exports.panelStore = panelStore;
    return module.exports;
  },
});
