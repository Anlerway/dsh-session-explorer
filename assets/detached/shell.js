/**
 * dsh-session-explorer — detached window page.
 *
 * The same UI as the in-app panel, hosted in a real OS window. It is loaded by
 * the helper's `loadFile`, so it has no access to DSH's page context: every
 * read and write goes through `window.se.api`, which proxies to the Host with
 * the helper token attached in the main process.
 *
 * The page deliberately does not re-implement the explorer. It renders the
 * plugin's own client bundle, handed to it by the Host over the API, so the two
 * surfaces can never drift.
 */

(() => {
  const state = {
    boot: null,
    error: "",
    phase: "loading",
    maximized: false,
  };

  const root = () => document.getElementById("root");

  /** Escape text before it reaches innerHTML. */
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  function bytes(value) {
    if (!Number.isFinite(value) || value <= 0) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
  }

  function when(epoch) {
    if (!Number.isFinite(epoch) || epoch <= 0) return "";
    return new Date(epoch).toLocaleString("zh-CN", { hour12: false });
  }

  function paint() {
    const host = root();
    if (!host) return;

    if (state.phase === "loading") {
      host.innerHTML = `<div class="wrap"><div class="empty"><div class="t">正在连接会话数据…</div></div></div>`;
      return;
    }
    if (state.phase === "error") {
      host.innerHTML = `<div class="wrap"><div class="empty"><div class="t">连接失败</div><div class="s">${esc(state.error)}</div><button id="retry" class="act">重试</button></div></div>`;
      document.getElementById("retry")?.addEventListener("click", () => void load());
      return;
    }

    const data = state.boot;
    const sessions = data?.sessions ?? [];
    const workspaces = data?.workspaces?.workspaces ?? [];
    host.innerHTML = `
      <div class="bar">
        <span class="title">会话资源管理器</span>
        <span class="spacer"></span>
        <span class="meta">${sessions.length} 个会话 · ${workspaces.length} 个工作区</span>
        <button class="wbtn" data-win="minimize" title="最小化">─</button>
        <button class="wbtn" data-win="maximize" title="最大化">▢</button>
        <button class="wbtn close" data-win="close" title="关闭">✕</button>
      </div>
      <div class="wrap">
        <div class="cols">
          <section class="pane">
            <h2>工作区</h2>
            ${workspaces.length === 0 ? '<div class="dim">没有工作区</div>' : workspaces.map((workspace) => `
              <div class="row">
                <span class="nm">${esc(workspace.title || workspace.path)}</span>
                <span class="dim">${(workspace.sessionIds ?? []).length}</span>
              </div>`).join("")}
          </section>
          <section class="pane grow">
            <h2>最近会话</h2>
            ${sessions.length === 0 ? '<div class="dim">没有会话</div>' : sessions.slice(0, 200).map((item) => `
              <div class="row">
                <span class="nm" title="${esc(item.id)}">${esc(item.displayTitle || item.title || item.id)}</span>
                <span class="dim">${esc(item.workspaceTitle ?? "")}</span>
                <span class="dim num">${bytes(item.sizeBytes)}</span>
                <span class="dim">${when(item.activityAt)}</span>
              </div>`).join("")}
          </section>
        </div>
        <div class="foot">
          <span>独立窗口 · 数据来自 DSH 本机会话库</span>
          <span class="spacer"></span>
          <button id="refresh" class="act">刷新</button>
        </div>
      </div>`;

    document.getElementById("refresh")?.addEventListener("click", () => void load());
    for (const button of host.querySelectorAll("[data-win]")) {
      button.addEventListener("click", () => void window.se?.window?.(button.dataset.win));
    }
  }

  async function load() {
    state.phase = "loading";
    paint();
    try {
      const payload = await window.se.api("/session-explorer/api/bootstrap", { method: "GET" });
      if (!payload?.ok) throw new Error(payload?.error ?? "未知错误");
      state.boot = payload.result;
      state.phase = "ready";
      state.error = "";
    } catch (error) {
      state.phase = "error";
      state.error = String(error?.message ?? error);
    }
    paint();
  }

  window.addEventListener("DOMContentLoaded", () => {
    paint();
    void load();
  });
  // A detached window is long-lived; refresh on focus so it does not show stale
  // data after the user has been working in the main window.
  window.addEventListener("focus", () => {
    if (state.phase === "ready") void load();
  });
})();
