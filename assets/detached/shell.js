/**
 * dsh-session-explorer — the detached window.
 *
 * This is the floating panel's UI in a real OS window, not a second design. The
 * markup below is a faithful port of lib/client.js: same class names, same
 * column layout, same command bar, same tree rail, same detail pane, same
 * icons — so the window and the panel cannot drift apart. What changes is only
 * the host adapter underneath:
 *
 *   panel  — React, DSH's module loader, ctx.slots, fetch with cookies
 *   window — plain DOM, no build step, `window.se.api` through the preload
 *
 * The window is still *only* the explorer: no DSH sidebar, no chat surface, no
 * second copy of the app behind it.
 *
 * Two rules hold throughout, because this file rebuilds the page from state on
 * every change (there is no virtual DOM): every user-supplied string goes
 * through `esc()` before it reaches innerHTML, and every event is delegated from
 * `#root` so a rebuild never leaves a dead listener behind.
 */

(() => {
  "use strict";

  // ── constants (mirrored from lib/constants.js) ─────────────────────────
  const FIXED = {
    root: "f-root",
    favorites: "f-favorites",
    todos: "f-todos",
    trash: "f-trash",
    ungrouped: "f-ungrouped",
  };

  /** Kinds that mirror a set of sessions instead of holding a directory. */
  const VIEW_KINDS = new Set(["ungrouped", "todos", "favorites", "trash"]);

  const COLUMNS = {
    name: { label: "名称", cls: "col-name" },
    tags: { label: "标签", cls: "col-tags" },
    note: { label: "备注", cls: "col-note" },
    updated: { label: "上次对话", cls: "col-date" },
    size: { label: "大小", cls: "col-size" },
    status: { label: "状态", cls: "col-status" },
  };
  const COL_ORDER = ["name", "tags", "note", "updated", "size", "status"];

  /** The column widths the panel ships with (lib/client.js readLayout). */
  const DEFAULT_COLS = { name: 260, tags: 116, note: 150, updated: 104, size: 74, status: 78 };
  const MIN_COL = 48;

  /** Default direction per field: names read A→Z, dates and sizes newest first. */
  const SORT_DEFAULT_DIR = { name: "asc", updated: "desc", size: "desc" };

  const PREF_KEY = "se-detached.prefs.v2";

  // ── persisted preferences ──────────────────────────────────────────────
  // localStorage can throw (a locked-down profile, a file:// origin under a
  // sandbox); every access is guarded, and losing a preference must never stop
  // the window from rendering.
  const store = (() => {
    try {
      return window.localStorage ?? null;
    } catch {
      return null;
    }
  })();

  function readPrefs() {
    try {
      const raw = store ? store.getItem(PREF_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  const prefs = readPrefs();

  function normalizeFilter(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    const tri = (candidate) => (candidate === "yes" || candidate === "no" ? candidate : "all");
    return {
      scope: value.scope === "all" ? "all" : "scope",
      favorite: tri(value.favorite),
      archived: tri(value.archived),
      todo: tri(value.todo),
      tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === "string") : [],
    };
  }

  // ── state ──────────────────────────────────────────────────────────────
  const state = {
    boot: null,
    phase: "loading",
    error: "",
    query: "",
    view: prefs.view === "icons" ? "icons" : "details",
    sortKey: typeof prefs.sortKey === "string" ? prefs.sortKey : "updated",
    sortDir: prefs.sortDir === "asc" ? "asc" : "desc",
    filter: normalizeFilter(prefs.filter),
    cols: { ...DEFAULT_COLS, ...(prefs.cols && typeof prefs.cols === "object" ? prefs.cols : {}) },
    navWidth: Number.isFinite(prefs.navWidth) ? prefs.navWidth : 260,
    detailWidth: Number.isFinite(prefs.detailWidth) ? prefs.detailWidth : 320,
    showDetail: prefs.showDetail !== false,
    showArchived: prefs.showArchived !== false,
    expanded: new Set(Array.isArray(prefs.expanded) && prefs.expanded.length ? prefs.expanded : ["f-root"]),
    collapsed: new Set(Array.isArray(prefs.collapsed) ? prefs.collapsed : []),
    tabs: [],
    active: 0,
    selected: null,
    selectedNode: null,
    checked: new Set(),
    renaming: null,
    menu: null,
    dialog: null,
    createOpen: false,
    tagOpen: false,
    clipboard: { mode: null, ids: [], nodes: [] },
    undo: [],
    hint: "",
    toast: null,
    drag: null,
  };

  // ── tiny helpers ───────────────────────────────────────────────────────
  const root = () => document.getElementById("root");

  /** Escape text before it reaches innerHTML. */
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

  // ── formatting (ported from lib/client.js) ─────────────────────────────
  const RELATIVE = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  const DATE_SHORT = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const DATE_FULL = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const NUMBER = new Intl.NumberFormat("zh-CN");

  const padTwo = (value) => String(value).padStart(2, "0");

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
    return (value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
  }

  /** `10-18 06:55`, or `2025-10-18 06:55` outside the current year. */
  function formatDate(epochMs, now) {
    if (!Number.isFinite(epochMs) || epochMs <= 0) return "";
    const date = new Date(epochMs);
    const sameYear = new Date(now).getFullYear() === date.getFullYear();
    return (sameYear ? DATE_SHORT.format(date) : DATE_FULL.format(date)).replace(/\//g, "-");
  }

  function formatRelative(epochMs, now) {
    if (!Number.isFinite(epochMs) || epochMs <= 0) return "";
    const minutes = Math.round((epochMs - now) / 60000);
    if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 30) return RELATIVE.format(days, "day");
    return DATE_FULL.format(new Date(epochMs)).replace(/\//g, "-");
  }

  const formatCount = (value) => (Number.isFinite(value) ? NUMBER.format(value) : "0");

  function formatCompact(value) {
    if (!Number.isFinite(value) || value <= 0) return "—";
    if (value < 1000) return String(value);
    if (value < 1_000_000) return (value / 1000).toFixed(value < 10_000 ? 1 : 0) + "k";
    return (value / 1_000_000).toFixed(1) + "M";
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    if (ms < 1000) return Math.round(ms) + " ms";
    if (ms < 60_000) return (ms / 1000).toFixed(1) + " s";
    return Math.floor(ms / 60_000) + "m " + padTwo(Math.round((ms % 60_000) / 1000)) + "s";
  }

  // ── icons (the panel's own table, verbatim) ────────────────────────────
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

  const icon = (name, size = 16, className) =>
    '<svg viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"' +
    (className ? ' class="' + esc(className) + '"' : "") + ' aria-hidden="true">' + (ICONS[name] ?? "") + "</svg>";

  // ── icons per node kind (mirrors lib/client.js KIND_ICON) ──────────────
  const KIND_ICON = {
    root: "folder",
    "default-workspace": "home",
    workspace: "monitor",
    ungrouped: "chat",
    favorites: "star",
    todos: "todo",
    trash: "trash",
  };

  const iconOfNode = (node) => {
    if (!node) return "folder";
    return KIND_ICON[node.kind] ?? (node.type === "workspace" ? "monitor" : "folder");
  };

  const FIXED_META = {
    [FIXED.root]: { label: "根目录", icon: "folder" },
    [FIXED.ungrouped]: { label: "未分组", icon: "chat" },
    [FIXED.trash]: { label: "回收站", icon: "trash" },
    [FIXED.todos]: { label: "待办", icon: "todo" },
    [FIXED.favorites]: { label: "收藏", icon: "star" },
  };

  function statusOf(session) {
    if (session.trashed) return { cls: "", text: "已删除" };
    if (session.running) return { cls: "run", text: "运行中" };
    if (session.formatVersion && session.formatVersion !== 4) return { cls: "err", text: "异常" };
    return { cls: "", text: "空闲" };
  }

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
      if (typeof left === "string" || typeof right === "string") result = String(left).localeCompare(String(right), "zh-CN");
      else result = left - right;
      if (result === 0) result = String(a.id).localeCompare(String(b.id));
      return result * dir;
    };
  }

  // ── HTTP (through the preload; the token never reaches this file) ──────
  const API = "/session-explorer/api";

  async function call(path, init) {
    if (!window.se || typeof window.se.api !== "function") {
      throw new Error("独立窗口的 preload 没有就绪");
    }
    const payload = await window.se.api(API + path, init ?? { method: "GET" });
    if (!payload || payload.ok !== true) {
      const error = new Error(payload?.error ?? "请求失败");
      error.code = payload?.code ?? "bad-request";
      throw error;
    }
    return payload.result;
  }

  const get = (path) => call(path);
  const post = (path, body) => call(path, { method: "POST", body: body ?? {} });
  const patch = (path, body) => call(path, { method: "PATCH", body: body ?? {} });
  const del = (path) => call(path, { method: "DELETE" });

  // ── derived data ───────────────────────────────────────────────────────
  const nodes = () => state.boot?.tree?.nodes ?? {};
  const children = () => state.boot?.tree?.children ?? {};
  const counts = () => state.boot?.tree?.counts ?? {};
  const sessions = () => state.boot?.sessions ?? [];
  const trashed = () => state.boot?.trashed ?? [];
  const library = () => (state.boot?.tagLibrary ?? []).map((entry) => (typeof entry === "string" ? { tag: entry, count: 0 } : entry)).filter((entry) => entry?.tag);

  const allSessions = () => {
    const map = new Map();
    for (const session of sessions()) map.set(session.id, session);
    for (const session of trashed()) map.set(session.id, session);
    return map;
  };

  const nodeOf = (id) => nodes()[id] ?? null;

  const liveSessions = () => sessions().filter((session) => !session.trashed);

  /** Sessions under one node, following the same rules as the host tree. */
  function sessionsOf(nodeId) {
    if (nodeId === FIXED.trash) return trashed();
    const live = liveSessions();
    if (nodeId === FIXED.favorites) return live.filter((session) => session.favorite);
    if (nodeId === FIXED.todos) return live.filter((session) => session.todo);
    const node = nodeOf(nodeId);
    if (!node) return [];
    if (node.kind === "ungrouped") return live.filter((session) => !session.workspaceId);
    if (node.workspaceId) return live.filter((session) => session.workspaceId === node.workspaceId);
    if (node.id === FIXED.root) return live;
    // A folder aggregates its subtree.
    const ids = new Set();
    const stack = [nodeId];
    while (stack.length > 0) {
      const id = stack.pop();
      const current = nodeOf(id);
      if (!current) continue;
      if (current.workspaceId) ids.add(current.workspaceId);
      for (const child of children()[id] ?? []) stack.push(child);
    }
    return live.filter((session) => session.workspaceId && ids.has(session.workspaceId));
  }

  function nearestWorkspace(nodeId) {
    let cursor = nodeId;
    const guard = new Set();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      const node = nodeOf(cursor);
      if (!node) return null;
      if (node.workspaceId) return node;
      cursor = node.parent ?? null;
    }
    return null;
  }

  function canHoldContainers(nodeId) {
    const node = nodeOf(nodeId);
    if (!node) return false;
    return !(node.fixed && node.id !== FIXED.root);
  }

  function crumbsFor(nodeId) {
    const trail = [];
    const guard = new Set();
    let current = nodeOf(nodeId);
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      const meta = FIXED_META[current.id];
      trail.unshift({
        id: current.id,
        label: current.id === FIXED.root ? "根目录" : meta?.label ?? current.name ?? current.path ?? current.id,
        icon: meta?.icon ?? iconOfNode(current),
      });
      current = current.parent ? nodeOf(current.parent) : null;
    }
    if (trail.length === 0) trail.push({ id: FIXED.root, label: "根目录", icon: "folder" });
    return trail;
  }

  /** The client mirror of canMove: a workspace never nests inside a workspace. */
  function canDropInTree(nodeId, parentId) {
    const node = nodeOf(nodeId);
    const parent = nodeOf(parentId);
    if (!node || !parent) return false;
    if (node.fixed) return false;
    if (parent.fixed && parentId !== FIXED.root) return false;
    const underWorkspace = (() => {
      const seen = new Set();
      let cursor = parentId;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        if (nodeOf(cursor)?.type === "workspace") return true;
        cursor = nodeOf(cursor)?.parent ?? null;
      }
      return false;
    })();
    if (underWorkspace && containsWorkspace(nodeId)) return false;
    const seen = new Set();
    const stack = [nodeId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === parentId) return false;
      if (!current || seen.has(current)) continue;
      seen.add(current);
      for (const child of children()[current] ?? []) stack.push(child);
    }
    return true;
  }

  function containsWorkspace(start) {
    const seen = new Set();
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      if (nodeOf(current)?.type === "workspace") return true;
      for (const child of children()[current] ?? []) stack.push(child);
    }
    return false;
  }

  /**
   * Flatten the session list into parent/child rows.
   *
   * A subagent follows its parent, indented; a fork is an independent session
   * and stays a sibling. Orphans stay at depth 0 so nothing disappears.
   */
  function nestSessions(list, collapsed) {
    const byId = new Map(list.map((session) => [session.id, session]));
    const kids = new Map();
    const roots = [];
    for (const session of list) {
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
      const nested = kids.get(session.id) ?? [];
      rows.push({ session, depth, childCount: nested.length, collapsed: collapsed.has(session.id) });
      if (nested.length === 0 || collapsed.has(session.id)) return;
      for (const child of nested) walk(child, depth + 1);
    };
    for (const session of roots) walk(session, 0);
    return rows;
  }

  // ── rendering: tree ────────────────────────────────────────────────────
  function renderTrow(options) {
    const { scope, iconName, label, count, active, tone, depth = 0, hasKids = false, expanded = false, draggable = false, rename = null, canRename = false } = options;
    const cls = ["trow"];
    if (tone === "ws") cls.push("ws");
    if (active) cls.push("sel");
    const body = rename
      ? '<input class="lbl-edit" id="rename-input" data-rename-node="' + esc(scope) + '" value="' + esc(rename.value) + '" spellcheck="false" autocomplete="off">'
      : '<span class="lbl">' + esc(label) + "</span>";
    return (
      '<div class="' + cls.join(" ") + '" data-node="' + esc(scope) + '"' + (draggable ? ' draggable="true"' : "") +
      ' style="padding-left:' + (6 + depth * 14) + 'px">' +
      '<span class="caret' + (hasKids ? "" : " hidden") + '"' + (hasKids ? ' data-toggle="' + esc(scope) + '"' : "") + ">" +
      (hasKids ? icon(expanded ? "chevdown" : "chevright", 14) : "") + "</span>" +
      '<span class="ic">' + icon(iconName, 14) + "</span>" +
      body +
      (canRename && !rename ? '<span class="nm-editbtn" data-beginrename="' + esc(scope) + '" title="重命名">' + icon("pencil", 10) + "</span>" : "") +
      (Number.isFinite(count) ? '<span class="cnt">' + formatCount(count) + "</span>" : "") +
      "</div>"
    );
  }

  function renderTree() {
    const tree = state.boot?.tree;
    const nodeMap = nodes();
    const childMap = children();
    const countMap = counts();
    const rows = [];

    const defaultNode = Object.values(nodeMap).find((node) => node.kind === "default-workspace") ?? null;
    const fixedEntries = [
      { id: defaultNode?.id ?? FIXED.root, icon: "home", label: "默认工作区", count: defaultNode ? countMap[defaultNode.id] ?? 0 : countMap[FIXED.root] ?? 0 },
      { id: FIXED.ungrouped, icon: "chat", label: "未分组", count: countMap[FIXED.ungrouped] ?? 0 },
      { id: FIXED.trash, icon: "trash", label: "回收站", count: countMap[FIXED.trash] ?? 0 },
      { id: FIXED.todos, icon: "todo", label: "待办", count: countMap[FIXED.todos] ?? 0 },
      { id: FIXED.favorites, icon: "star", label: "收藏", count: countMap[FIXED.favorites] ?? 0 },
    ];
    for (const entry of fixedEntries) {
      rows.push(renderTrow({ scope: entry.id, iconName: entry.icon, label: entry.label, count: entry.count, active: scopeId() === entry.id }));
    }

    const quickAccess = Array.isArray(tree?.quickAccess) ? tree.quickAccess : [];
    if (quickAccess.length > 0) {
      rows.push('<div class="tsep"></div><div class="tcap">快速访问</div>');
      for (const entry of quickAccess) {
        const node = nodeMap[entry.id];
        if (!node) continue;
        rows.push(
          renderTrow({
            scope: entry.id,
            iconName: iconOfNode(node),
            label: node.name ?? node.path ?? entry.id,
            count: countMap[entry.id] ?? 0,
            active: scopeId() === entry.id,
            tone: node.type === "workspace" ? "ws" : "default",
          }),
        );
      }
    }

    rows.push('<div class="tsep"></div><div class="tcap">目录</div>');

    const walk = (id, depth) => {
      const node = nodeMap[id];
      if (!node) return;
      const kids = (childMap[id] ?? [])
        .map((child) => nodeMap[child])
        .filter((child) => child && !VIEW_KINDS.has(child.kind))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const open = state.expanded.has(id);
      const isWorkspace = node.type === "workspace";
      const effectiveId = isWorkspace ? node.workspaceId ?? id : id;
      const renaming =
        state.renaming && state.renaming.kind === (isWorkspace ? "workspace" : "folder") && state.renaming.id === effectiveId
          ? state.renaming
          : null;
      rows.push(
        renderTrow({
          scope: id,
          iconName: iconOfNode(node),
          label: id === FIXED.root ? "根目录" : node.name ?? node.path ?? id,
          count: countMap[id] ?? 0,
          active: scopeId() === id,
          tone: isWorkspace ? "ws" : "default",
          depth,
          hasKids: kids.length > 0,
          expanded: open,
          draggable: isWorkspace || !node.fixed,
          rename: renaming,
          canRename: !node.fixed && node.kind !== "default-workspace",
        }),
      );
      if (open) for (const child of kids) walk(child.id, depth + 1);
    };
    walk(FIXED.root, 0);

    return '<aside class="pane-tree" id="se-tree" style="flex-basis:' + state.navWidth + "px;width:" + state.navWidth + 'px">' + rows.join("") + "</aside>";
  }

  // ── rendering: list ────────────────────────────────────────────────────
  function checkedHas(id) {
    return state.checked.has(id);
  }

  function renderSessionRow(entry, now) {
    const { session, depth, childCount, collapsed } = entry;
    const status = statusOf(session);
    const isChild = Boolean(session.isSubagent);
    const renaming = state.renaming && state.renaming.kind === "session" && state.renaming.id === session.id ? state.renaming : null;
    const cls = ["row"];
    if (state.selected === session.id) cls.push("sel");
    if (session.archived) cls.push("arch");
    if (session.pinned) cls.push("pinned-row");
    if (state.clipboard.mode === "cut" && state.clipboard.ids.includes(session.id)) cls.push("cut");
    if (depth > 0) cls.push("sub-row");

    const nameCell =
      '<div class="cell col-name"><div class="namecell">' +
      (childCount > 0
        ? '<span class="twist" data-twist="' + esc(session.id) + '" title="' + (collapsed ? "展开子智能体会话" : "收起子智能体会话") + '">' +
          icon(collapsed ? "chevright" : "chevdown", 12) + "</span>"
        : "") +
      icon(isChild ? "external" : "chat", 16, "ic") +
      (renaming
        ? '<input class="nm-edit" id="rename-input" data-rename-session="' + esc(session.id) + '" value="' + esc(renaming.value) + '" spellcheck="false" autocomplete="off">'
        : '<span class="nm" title="' + esc(session.id) + '">' + esc(session.displayTitle ?? session.id) + "</span>" +
          '<span class="nm-editbtn" data-beginrename-session="' + esc(session.id) + '" title="重命名">' + icon("pencil", 11) + "</span>") +
      (isChild ? '<span class="subtag" title="子智能体 · 深度 ' + esc(session.delegationDepth ?? 1) + '">子</span>' : "") +
      (childCount > 0 && !isChild ? '<span class="subtag" title="包含子智能体会话">' + childCount + " 子</span>" : "") +
      (session.isSeeded && !isChild ? '<span class="subtag fork" title="分叉自另一个会话，是独立会话">分叉</span>' : "") +
      (session.pinned ? '<span style="color:var(--sm-accent);opacity:.85">' + icon("pin", 12) + "</span>" : "") +
      (session.archived ? '<span class="arcbadge" title="已归档">' + icon("archive", 9) + "</span>" : "") +
      "</div></div>";

    return (
      '<div class="' + cls.join(" ") + '" data-id="' + esc(session.id) + '" data-session="' + esc(session.id) + '"' +
      (depth > 0 ? ' style="--indent:' + depth * 16 + 'px"' : "") +
      ' draggable="' + (session.trashed ? "false" : "true") + '">' +
      '<div class="cell col-check col-check-cell"><span class="chk' + (checkedHas(session.id) ? " on" : "") + '" data-check="' + esc(session.id) + '">' +
      (checkedHas(session.id) ? icon("check", 10) : "") + "</span></div>" +
      nameCell +
      '<div class="cell col-tags">' +
      (session.tags ?? []).slice(0, 2).map((tag) => '<span class="tag" title="' + esc(tag) + '">' + esc(tag) + "</span>").join("") +
      "</div>" +
      '<div class="cell col-note' + (session.note ? "" : " dim") + '" title="' + esc(session.note ?? "") + '">' + esc(session.note ?? "") + "</div>" +
      '<div class="cell col-date dim">' + formatDate(session.activityAt, now) + "</div>" +
      '<div class="cell col-size num dim">' + formatSize(session.sizeBytes) + "</div>" +
      '<div class="cell col-status"><span class="st"><span class="dot ' + status.cls + '"></span>' + status.text + "</span></div>" +
      '<div class="cell col-fill"></div>' +
      "</div>"
    );
  }

  function renderContainerRow(node, now) {
    const isWorkspace = node.type === "workspace";
    const isFolder = node.type === "folder" && node.kind === "folder";
    const editable = isWorkspace ? node.kind !== "default-workspace" : isFolder;
    const effectiveId = isWorkspace ? node.workspaceId ?? node.id : node.id;
    const renaming =
      state.renaming && state.renaming.kind === (isWorkspace ? "workspace" : "folder") && state.renaming.id === effectiveId ? state.renaming : null;
    const label = node.name ?? node.path ?? node.id;
    const count = counts()[node.id] ?? 0;
    const cls = ["row", "frow", isWorkspace ? "wsrow" : isFolder ? "folderrow" : "specialrow"];
    if (state.selected === node.id || scopeId() === node.id) cls.push("sel");
    return (
      '<div class="' + cls.join(" ") + '" data-id="' + esc(node.id) + '" data-node="' + esc(node.id) + '"' +
      ' draggable="' + (editable ? "true" : "false") + '">' +
      '<div class="cell col-check col-check-cell">' +
      (editable
        ? '<span class="chk' + (checkedHas(node.id) ? " on" : "") + '" title="选择" data-check="' + esc(node.id) + '">' + (checkedHas(node.id) ? icon("check", 10) : "") + "</span>"
        : "") +
      "</div>" +
      '<div class="cell col-name"><div class="namecell">' +
      '<span class="fl-ic">' + icon(isWorkspace ? "monitor" : isFolder ? "folder" : iconOfNode(node), 16, "ic " + (isWorkspace ? "wsic" : isFolder ? "folderic" : "specialic")) + "</span>" +
      (renaming
        ? '<input class="nm-edit" id="rename-input" data-rename-node="' + esc(node.id) + '" value="' + esc(renaming.value) + '" spellcheck="false">'
        : '<span class="nm" title="' + esc(node.path || node.id) + '">' + esc(label) + "</span>" +
          (editable ? '<span class="nm-editbtn" data-beginrename="' + esc(effectiveId) + '" title="重命名">' + icon("pencil", 11) + "</span>" : "")) +
      '<span class="wstag' + (isWorkspace ? "" : isFolder ? " ftag" : " stag") + '">' + (isWorkspace ? "工作区" : isFolder ? "文件夹" : "特殊文件夹") + "</span>" +
      "</div></div>" +
      '<div class="cell col-tags dim"></div>' +
      '<div class="cell col-note dim"></div>' +
      '<div class="cell col-date dim">' + (count ? formatCount(count) + " 个会话" : "") + "</div>" +
      '<div class="cell col-size num dim"></div>' +
      '<div class="cell col-status"></div>' +
      '<div class="cell col-fill"></div>' +
      "</div>"
    );
  }

  /** The sessions the current scope lists, after search and filter. */
  function filteredInScope() {
    let list = sessionsOf(scopeId());
    const filter = state.filter;
    if (filter.scope === "all") list = scopeId() === FIXED.trash ? trashed() : liveSessions();
    if (filter.favorite !== "all") list = list.filter((session) => Boolean(session.favorite) === (filter.favorite === "yes"));
    if (filter.archived !== "all") list = list.filter((session) => Boolean(session.archived) === (filter.archived === "yes"));
    if (filter.todo !== "all") list = list.filter((session) => Boolean(session.todo) === (filter.todo === "yes"));
    if (filter.tags.length > 0) list = list.filter((session) => filter.tags.every((tag) => (session.tags ?? []).includes(tag)));
    const needle = state.query.trim().toLowerCase();
    if (needle) {
      list = list.filter((session) =>
        [session.displayTitle, session.title, session.note, ...(session.tags ?? []), session.cwd, session.id, session.workspaceTitle]
          .some((value) => typeof value === "string" && value.toLowerCase().includes(needle)),
      );
    }
    return list;
  }

  const filterActive = () =>
    state.filter.scope !== "scope" ||
    state.filter.favorite !== "all" ||
    state.filter.archived !== "all" ||
    state.filter.todo !== "all" ||
    state.filter.tags.length > 0;

  function renderList() {
    const now = Date.now();
    const scope = scopeId();
    const needle = state.query.trim().toLowerCase();
    const filtered = filteredInScope();
    const sorted = filtered.slice().sort(compareBy(state.sortKey, state.sortDir === "asc" ? 1 : -1));
    const pinned = sorted.filter((session) => session.pinned && !session.archived);
    const normal = sorted.filter((session) => !session.pinned && !session.archived);
    const archived = state.showArchived === false ? [] : sorted.filter((session) => session.archived);

    const matchesNeedle = (node) =>
      !needle || String(node.name ?? "").toLowerCase().includes(needle) || String(node.path ?? "").toLowerCase().includes(needle);

    const specialNodes =
      scope !== FIXED.root || needle ? [] : [FIXED.ungrouped, FIXED.favorites, FIXED.todos].map(nodeOf).filter(Boolean);
    const isRealContainer = (node) =>
      Boolean(node) && (node.type === "workspace" || (node.type === "folder" && node.kind === "folder" && !node.fixed));
    const containerNodes =
      scope === FIXED.trash
        ? []
        : needle
          ? Object.values(nodes()).filter((node) => isRealContainer(node) && matchesNeedle(node))
          : (children()[scope] ?? []).map(nodeOf).filter(isRealContainer);

    const rowsOf = (list) => nestSessions(list, state.collapsed).map((entry) => renderSessionRow(entry, now));
    const containerRows = (list) => list.map((node) => renderContainerRow(node, now));

    const groups = [];
    if (pinned.length > 0) groups.push({ key: "pinned", title: "置顶", icon: "pin", count: pinned.length, rows: rowsOf(pinned) });
    if (specialNodes.length > 0) groups.push({ key: "special", title: "特殊文件夹", icon: "star", count: specialNodes.length, rows: containerRows(specialNodes) });
    const workspaces = containerNodes.filter((node) => node.type === "workspace");
    const folders = containerNodes.filter((node) => node.type === "folder");
    if (needle && containerNodes.length > 0) {
      groups.push({ key: "found", title: "搜索到的目录", icon: "search", count: containerNodes.length, rows: containerRows(containerNodes) });
    } else {
      if (folders.length > 0) groups.push({ key: "folders", title: "文件夹", icon: "folder", count: folders.length, rows: containerRows(folders) });
      if (workspaces.length > 0) groups.push({ key: "workspaces", title: "工作区", icon: "monitor", count: workspaces.length, rows: containerRows(workspaces) });
    }
    if (normal.length > 0) groups.push({ key: "normal", title: "会话", icon: null, count: normal.length, rows: rowsOf(normal) });
    if (archived.length > 0) groups.push({ key: "archived", title: "已归档（沉底）", icon: "archive", count: archived.length, rows: rowsOf(archived) });

    const style =
      "--w-name:" + state.cols.name + "px;--w-tags:" + state.cols.tags + "px;--w-note:" + state.cols.note +
      "px;--w-date:" + state.cols.updated + "px;--w-size:" + state.cols.size + "px;--w-status:" + state.cols.status + "px";

    const allChecked = filtered.length > 0 && filtered.every((session) => state.checked.has(session.id));
    const head =
      '<div class="listhead">' +
      '<div class="lh col-check"><span class="chk' + (allChecked ? " on" : "") + '" data-checkall="1">' + (allChecked ? icon("check", 10) : "") + "</span></div>" +
      COL_ORDER.map((key) => {
        const column = COLUMNS[key];
        const sortedCol = state.sortKey === key;
        return (
          '<div class="lh ' + column.cls + (sortedCol ? " sorted" : "") + '" data-col="' + key + '" data-sort="' + key + '">' +
          '<span class="lhlabel">' + esc(column.label) + "</span>" +
          '<span class="sortdot" aria-hidden="true">▼</span>' +
          '<span class="colrsz" data-cw="' + key + '" title="拖动调整列宽"></span>' +
          "</div>"
        );
      }).join("") +
      '<div class="lh col-fill"></div>' +
      "</div>";

    const empty = () => {
      const isTrash = scope === FIXED.trash;
      return (
        '<div class="empty">' +
        '<div class="big">' + icon(isTrash ? "trash" : "folder", 34) + "</div>" +
        '<div class="t">' + (needle ? "没有匹配的项目" : isTrash ? "回收站是空的" : "这里还是空的") + "</div>" +
        '<div class="s">' + (needle ? "试试别的关键词，或清空搜索框" : "可以用「新建文件夹」把会话分组，或把工作区拖进来") + "</div>" +
        "</div>"
      );
    };

    const body =
      groups.length === 0
        ? empty()
        : groups
            .map(
              (group) =>
                '<div data-group="' + group.key + '">' +
                '<div class="grp">' + (group.icon ? icon(group.icon, 12) : "") + esc(group.title) +
                '<span class="gcount">' + formatCount(group.count) + "</span></div>" +
                group.rows.join("") +
                "</div>",
            )
            .join("");

    return (
      '<main class="pane-list" id="se-listpane" data-cw="full" data-view="' + state.view + '" style="' + style + '">' +
      head +
      '<div class="listbody' + (state.checked.size > 0 ? " has-sel" : "") + '">' + body + "</div></main>"
    );
  }

  // ── rendering: detail ──────────────────────────────────────────────────
  const kv = (key, value) =>
    '<div class="kv"><span class="k">' + esc(key) + '</span><span class="v">' + (value && String(value).includes("<") ? value : esc(value)) + "</span></div>";

  function renderDetail() {
    const now = Date.now();
    const session = state.selected ? allSessions().get(state.selected) : null;
    const focusId = state.selectedNode ?? (session ? null : scopeId());
    const node = focusId ? nodeOf(focusId) : null;
    if (!session && !node) {
      return '<aside class="pane-detail"><div class="empty"><div class="big">' + icon("details", 34) + '</div><div class="t">选中一项查看详情</div><div class="s">可多选后批量操作</div></div></aside>';
    }
    const isWorkspace = node?.type === "workspace";
    const kind = session ? "session" : isWorkspace ? "workspace" : "folder";
    const label = session ? session.displayTitle ?? session.id : node?.name ?? node?.id ?? "";
    const canRename = session ? true : Boolean(node && !node.fixed && node.kind !== "default-workspace");
    const renaming = state.renaming && state.renaming.kind === (session ? "session" : isWorkspace ? "workspace" : "folder") &&
      state.renaming.id === (session ? session.id : isWorkspace ? node?.workspaceId ?? node?.id : node?.id)
      ? state.renaming
      : null;
    const status = session ? statusOf(session) : null;
    const stats = session?.stats ?? {};
    const tokens = session?.tokenUsage ?? {};
    const pressure = session?.contextPressure ?? {};
    const tags = session?.tags ?? [];
    const lib = library();

    const head =
      '<div class="det-head">' +
      '<div class="det-ic">' + icon(kind === "workspace" ? "monitor" : kind === "folder" ? iconOfNode(node) : "chat", 18) + "</div>" +
      '<div style="min-width:0;flex:1">' +
      (renaming
        ? '<input class="det-rename" id="rename-input" data-rename-detail="1" value="' + esc(renaming.value) + '" spellcheck="false">'
        : '<div class="det-title-row"><div class="det-title" title="' + esc(label) + '">' + esc(label) + "</div>" +
          (canRename ? '<button type="button" class="det-title-edit" data-beginrename-detail="1" title="重命名">' + icon("pencil", 11) + "</button>" : "") +
          "</div>") +
      '<div class="det-sub">' +
      (session
        ? (session.trashed ? "回收站 · 已删除" : (session.workspaceTitle ?? "未分组") + " · " + (session.agentPreset ?? "默认预设"))
        : kind === "workspace"
          ? esc(node?.path ?? "")
          : node?.id === FIXED.root
            ? "全部会话"
            : "自建文件夹") +
      "</div></div>" +
      '<button class="dclose" data-act="hide-detail" title="关闭">' + icon("x", 13) + "</button>" +
      "</div>";

    const sessionBody = !session
      ? ""
      : '<div class="det-body">' +
        kv("大小", formatSize(session.sizeBytes) || "—") +
        kv("上次对话", formatDate(session.activityAt, now) || "—") +
        kv("创建", formatDate(session.createdAt, now) || "—") +
        kv("状态", status.text) +
        kv("轮次", formatCount(stats.turns ?? 0)) +
        kv("路径", session.cwd ?? "—") +
        (session.isSubagent && session.parentSession
          ? '<div class="kv"><span class="k">子智能体</span><span class="v">' +
            '<span class="detail-parent" data-open="' + esc(session.parentSession) + '">' + icon("external", 11) +
            '<span class="nm">' + esc(allSessions().get(session.parentSession)?.displayTitle ?? session.parentSession) + "</span></span>" +
            '<span class="subtag">深度 ' + esc(session.delegationDepth ?? 1) + "</span></span></div>"
          : "") +
        kv("会话 id", session.id) +
        "</div>";

    const nodeBody = session
      ? ""
      : '<div class="det-body">' +
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
        ) +
        (kind === "workspace" ? kv("路径", node?.path ?? "—") : "") +
        kv("编号", node?.id ?? "—") +
        "</div>";

    const tagSection = !session
      ? ""
      : '<div class="det-sec"><h4>标签</h4><div class="det-body" style="padding:0">' +
        '<div class="taglist">' +
        tags.map((tag) => '<span class="tagchip">' + esc(tag) + '<span class="x" title="移除标签" data-untag="' + esc(tag) + '">' + icon("x", 9) + "</span></span>").join("") +
        '<button type="button" class="tagadd' + (state.tagOpen ? " on" : "") + '" data-act="toggle-tags">' +
        icon(state.tagOpen ? "x" : "plus", 11) + (state.tagOpen ? "收起" : "添加标签") + "</button>" +
        "</div>" +
        (state.tagOpen
          ? '<div class="tagpanel">' +
            (lib.length === 0 ? '<div class="tagempty">标签库是空的，在下面输入一个就会存进来</div>' : "") +
            lib.map((entry) =>
              '<button type="button" class="tagopt' + (tags.includes(entry.tag) ? " on" : "") + '" data-tag="' + esc(entry.tag) + '" title="' +
              (entry.preset ? "已在标签库中" : "仅被会话使用，点击后不会加入库") + '">' +
              (tags.includes(entry.tag) ? icon("check", 10) : "") + esc(entry.tag) +
              '<span class="tagcount">' + formatCount(entry.count ?? 0) + "</span>" +
              (entry.preset ? '<span class="taglib-del" title="从标签库移除（已打上的会话保留）" data-droptag="' + esc(entry.tag) + '">' + icon("x", 8) + "</span>" : "") +
              "</button>",
            ).join("") +
            '<div class="tagnewrow"><input class="tagnew" id="tag-input" placeholder="新建标签并加入库" spellcheck="false">' +
            '<button type="button" class="tagnew-go" title="加入标签库并打到这条会话上" data-act="new-tag">' + icon("plus", 10) + "</button></div>" +
            "</div>"
          : "") +
        "</div></div>";

    const sessionActions = !session
      ? ""
      : '<div class="det-actions">' +
        '<button type="button" class="act primary" data-act="open"' + (session.trashed ? " disabled" : "") + ">" + icon("external") + "<span>打开</span></button>" +
        '<button type="button" class="act" data-act="copy-id">' + icon("copy") + "<span>复制 id</span></button>" +
        '<button type="button" class="act' + (session.favorite ? " on" : "") + '" data-act="favorite">' + icon("star") + "<span>" + (session.favorite ? "取消收藏" : "收藏") + "</span></button>" +
        '<button type="button" class="act' + (session.todo ? " on" : "") + '" data-act="todo">' + icon("todo") + "<span>" + (session.todo ? "取消待办" : "待办") + "</span></button>" +
        (session.trashed ? "" : '<button type="button" class="act" data-act="fork">' + icon("branch") + "<span>分叉</span></button>") +
        (session.trashed
          ? '<button type="button" class="act" data-act="restore">' + icon("restore") + "<span>还原</span></button>"
          : '<button type="button" class="act' + (session.archived ? " on" : "") + '" data-act="archive">' + icon("archive") + "<span>" + (session.archived ? "取消归档" : "归档") + "</span></button>") +
        '<button type="button" class="act danger" data-act="' + (session.trashed ? "purge" : "trash") + '">' + icon("trash") + "<span>" + (session.trashed ? "永久删除" : "删除") + "</span></button>" +
        "</div>";

    const nodeActions = session
      ? ""
      : '<div class="det-actions">' +
        '<button type="button" class="act primary" data-act="enter">' + icon("external") + "<span>打开</span></button>" +
        '<button type="button" class="act" data-act="copy-node-id">' + icon("copy") + "<span>复制编号</span></button>" +
        "</div>";

    return (
      '<aside class="pane-detail" style="flex-basis:' + state.detailWidth + "px;width:" + state.detailWidth + 'px">' +
      head +
      (session ? sessionBody : nodeBody) +
      tagSection +
      (session
        ? '<div class="det-sec"><h4>备注</h4><div class="det-body" style="padding:0">' +
          '<textarea class="note" id="note-input" placeholder="写点只属于这条会话的备注…">' + esc(session.note ?? "") + "</textarea>" +
          "</div></div>" +
          '<div class="det-sec"><h4>执行统计</h4><div class="det-body" style="padding:0">' +
          kv("步数", formatCount(stats.steps ?? 0)) +
          kv("模型耗时", formatDuration(stats.llmMs)) +
          kv("首字", formatDuration(stats.ttftMs)) +
          kv("工具耗时", formatDuration(stats.toolMs)) +
          "</div></div>" +
          '<div class="det-sec"><h4>Token 用量</h4><div class="det-body" style="padding:0">' +
          kv("输入", formatCompact(tokens.uncachedInputTokens)) +
          kv("输出", formatCompact(tokens.outputTokens)) +
          kv("缓存读", formatCompact(tokens.cacheReadTokens)) +
          kv("缓存写", formatCompact(tokens.cacheWriteTokens)) +
          "</div></div>" +
          '<div class="det-sec"><h4>上下文</h4><div class="det-body" style="padding:0">' +
          kv("压力", formatCompact(pressure.pressureTokens)) +
          kv("面量", formatCompact(pressure.surfaceTokens)) +
          kv("窗口", formatCompact(pressure.contextWindow)) +
          "</div></div>" +
          sessionActions
        : nodeActions) +
      "</aside>"
    );
  }

  // ── rendering: window chrome (mirrors the panel's titlebar/navbar/cmdbar) ──
  const hasWindowControls = () => Boolean(window.se && typeof window.se.window === "function");

  function renderTabs() {
    return (
      '<div class="titlebar">' +
      '<div class="tabs" role="tablist">' +
      state.tabs
        .map((tab, index) => {
          const active = index === state.active;
          const label = FIXED_META[tab.scope]?.label ?? nodeOf(tab.scope)?.name ?? nodeOf(tab.scope)?.path ?? tab.scope;
          return (
            '<div class="tab' + (active ? " active" : "") + '" data-tab="' + index + '" role="tab" aria-selected="' + active + '"' +
            ' draggable="true" title="' + esc(label) + '">' +
            '<span class="t-ic">' + icon(FIXED_META[tab.scope]?.icon ?? iconOfNode(nodeOf(tab.scope)), 13) + "</span>" +
            '<span class="tname">' + esc(label) + "</span>" +
            (state.tabs.length > 1 ? '<span class="t-x" data-closetab="' + index + '" title="关闭标签页">' + icon("x", 11) + "</span>" : "") +
            "</div>"
          );
        })
        .join("") +
      '<button type="button" class="tab-add" data-act="new-tab" title="新建标签页（Ctrl+T）">' + icon("plus", 13) + "</button>" +
      "</div>" +
      (hasWindowControls()
        ? '<div class="wbtns">' +
          '<button type="button" class="wbtn" data-win="minimize" title="最小化">' + icon("minus", 12) + "</button>" +
          '<button type="button" class="wbtn" data-win="maximize" title="最大化">' + icon("square", 12) + "</button>" +
          '<button type="button" class="wbtn close" data-win="close" title="关闭">' + icon("x", 12) + "</button>" +
          "</div>"
        : "") +
      "</div>"
    );
  }

  function renderNavbar() {
    const tab = activeTab();
    const crumbs = crumbsFor(scopeId());
    return (
      '<div class="navbar">' +
      '<button type="button" class="nbtn" data-act="back" title="后退"' + (tab && tab.cursor > 0 ? "" : " disabled") + ">" + icon("back") + "</button>" +
      '<button type="button" class="nbtn" data-act="forward" title="前进"' + (tab && tab.cursor < tab.history.length - 1 ? "" : " disabled") + ">" + icon("fwd") + "</button>" +
      '<button type="button" class="nbtn" data-act="up" title="上一级">' + icon("up") + "</button>" +
      '<button type="button" class="nbtn" data-act="refresh" title="重新扫描">' + icon("refresh") + "</button>" +
      '<div class="crumbs">' +
      crumbs
        .map((crumb, index) =>
          (index > 0 ? '<span class="crumb-sep">' + icon("chevright", 9) + "</span>" : "") +
          '<span class="crumb' + (index === crumbs.length - 1 ? " cur" : "") + '" data-crumb="' + esc(crumb.id) + '">' + esc(crumb.label) + "</span>",
        )
        .join("") +
      "</div>" +
      '<label class="search">' + icon("search", 13) +
      '<input id="q" value="' + esc(state.query) + '" placeholder="搜索标题 / 备注 / 标签（Ctrl+E）">' +
      "</label>" +
      "</div>"
    );
  }

  const cmd = (options) => {
    const { act, iconName, label, title, disabled, danger, on, iconOnly, extra } = options;
    return (
      '<button type="button" class="cmd' + (iconOnly ? " icon-only" : "") + (danger ? " danger" : "") + (on ? " on" : "") + '"' +
      ' data-act="' + esc(act) + '"' + (title ? ' title="' + esc(title) + '"' : "") + (disabled ? " disabled" : "") + (extra ?? "") + ">" +
      (iconName ? '<span class="ic" data-i="' + esc(iconName) + '">' + icon(iconName) + "</span>" : "") +
      (iconOnly ? "" : "<span>" + esc(label) + "</span>") +
      "</button>"
    );
  };

  function renderCmdbar() {
    const targets = idsToActOn();
    const scope = scopeId();
    const clip = state.clipboard;
    const canPaste = canPasteHere();
    return (
      '<div class="cmdbar">' +
      '<div class="cmdscroll">' +
      '<button type="button" class="cmd' + (state.createOpen ? " on" : "") + '" data-act="create-menu" title="新建">' +
      '<span class="ic" data-i="plus">' + icon("plus") + "</span><span>新建</span>" +
      '<span class="ic" data-i="chevdown">' + icon("chevdown", 11) + "</span></button>" +
      '<span class="cmsep"></span>' +
      cmd({ act: "cut", iconName: "cut", iconOnly: true, title: "剪切（Ctrl+X）", disabled: targets.length === 0 }) +
      cmd({ act: "copy", iconName: "copy", iconOnly: true, title: "复制会话（Ctrl+C）", disabled: !targets.some((id) => allSessions().has(id)) }) +
      cmd({
        act: "paste",
        iconName: "paste",
        iconOnly: true,
        on: clip.ids.length > 0 || clip.nodes.length > 0,
        disabled: !canPaste,
        title:
          clip.nodes.length > 0
            ? "粘贴 " + clip.nodes.length + " 个目录（Ctrl+V）"
            : clip.ids.length > 0
              ? "粘贴 " + clip.ids.length + " 个会话（Ctrl+V）"
              : "粘贴（Ctrl+V）",
      }) +
      cmd({ act: "rename", iconName: "pencil", iconOnly: true, title: "重命名（F2）" }) +
      cmd({ act: "delete", iconName: "trash", iconOnly: true, title: "删除", danger: true }) +
      (scope === FIXED.trash ? cmd({ act: "restore", iconName: "restore", label: "还原" }) : "") +
      (scope === FIXED.trash ? cmd({ act: "empty-trash", iconName: "trash", label: "清空回收站", danger: true }) : "") +
      '<span class="cmsep"></span>' +
      cmd({ act: "favorite", iconName: "star", label: "收藏" }) +
      cmd({ act: "todo", iconName: "todo", label: "待办" }) +
      cmd({ act: "pin", iconName: "pin", label: "置顶" }) +
      cmd({ act: "archive", iconName: "archive", label: "归档" }) +
      cmd({ act: "fork", iconName: "branch", label: "分叉", title: "分叉会话（从当前位置另起一支）" }) +
      '<span class="cmsep"></span>' +
      cmd({ act: "filter", iconName: "tag", label: "筛选", on: filterActive() }) +
      "</div>" +
      '<div class="cmdfixed">' +
      '<button type="button" class="cmd' + (state.sortOpen ? " on" : "") + '" data-act="sort-menu" title="排序方式">' +
      '<span class="ic" data-i="sort">' + icon("sort") + "</span><span>排序</span>" +
      '<span class="ic" data-i="chevdown">' + icon("chevdown", 11) + "</span></button>" +
      cmd({ act: "toggle-view", iconName: "grid", label: "查看", title: "切换视图（详细信息 / 图标）" }) +
      cmd({ act: "more-menu", iconName: "more", iconOnly: true, title: "更多" }) +
      '<span class="cmsep"></span>' +
      cmd({ act: "toggle-detail", iconName: "details", label: "详细信息", on: state.showDetail }) +
      "</div></div>"
    );
  }

  function renderStatus() {
    const filtered = filteredInScope();
    const archivedCount = filtered.filter((session) => session.archived).length;
    const total = filtered.reduce((sum, session) => sum + (session.sizeBytes ?? 0), 0);
    const views = [
      { key: "details", iconName: "details", title: "详细信息" },
      { key: "icons", iconName: "grid", title: "图标" },
    ];
    return (
      '<div class="status">' +
      '<div class="s-item">' + formatCount(filtered.length) + " 个项目</div>" +
      (filterActive()
        ? '<div class="s-item clickable on" data-act="clear-filter" title="清除筛选">筛选中 · 点击清除</div>'
        : "") +
      (filterActive() && state.filter.scope === "all" ? '<div class="s-item">全部会话范围</div>' : "") +
      (archivedCount > 0 ? '<div class="s-item">' + formatCount(archivedCount) + " 个已归档</div>" : "") +
      '<div class="s-item">' + (state.checked.size > 0 ? "已选 " + formatCount(state.checked.size) + " 项" : "未选择") + "</div>" +
      '<div class="s-item">共 ' + (formatSize(total) || "0 B") + "</div>" +
      (state.hint ? '<div class="s-item clickable on" data-act="clear-hint">' + esc(state.hint) + "</div>" : "") +
      '<div class="viewswitch">' +
      views
        .map(
          (view) =>
            '<button type="button" class="vsw' + (state.view === view.key ? " on" : "") + '" data-setview="' + view.key + '" title="' + view.title + '">' +
            icon(view.iconName, 13) + "</button>",
        )
        .join("") +
      "</div></div>"
    );
  }

  // ── rendering: overlays ────────────────────────────────────────────────
  function renderMenu() {
    const menu = state.menu;
    if (!menu) return "";
    const width = 200;
    const height = 40 + menu.items.length * 30;
    const x = Math.max(4, Math.min(menu.left, (Number(window.innerWidth) || 1280) - width));
    const y = Math.max(4, Math.min(menu.top, (Number(window.innerHeight) || 800) - height));
    const items = menu.items
      .map((item) => {
        if (item.sep) return '<div class="misep"></div>';
        const cls = ["mi"];
        if (item.danger) cls.push("danger");
        if (item.disabled) cls.push("disabled");
        return (
          '<div class="' + cls.join(" ") + '" data-mi="' + esc(item.id) + '"' + (item.disabled ? ' aria-disabled="true"' : "") + ">" +
          '<span class="ic">' + (item.icon ? icon(item.icon) : "") + "</span>" +
          "<span>" + esc(item.label) + "</span>" +
          (item.key ? '<span class="k">' + esc(item.key) + "</span>" : "") +
          "</div>"
        );
      })
      .join("");
    return '<div class="ctxmenu open" style="left:' + x + "px;top:" + y + 'px" data-menu="1">' + items + "</div>";
  }

  function renderDialog() {
    const dialog = state.dialog;
    if (!dialog) return "";
    if (dialog.kind === "filter") {
      const draft = dialog.draft;
      const segment = (key, label, options) =>
        '<div class="frow"><label class="flb">' + esc(label) + "</label>" +
        '<div class="fseg" role="radiogroup" aria-label="' + esc(label) + '">' +
        options
          .map(
            ([value, text]) =>
              '<button type="button" role="radio" aria-checked="' + (draft[key] === value) + '" class="' + (draft[key] === value ? "on" : "") +
              '" data-fseg="' + key + '" data-fval="' + value + '">' + esc(text) + "</button>",
          )
          .join("") +
        "</div></div>";
      const tags = library().map((entry) => entry.tag);
      return (
        '<div class="fmodal open" role="dialog" aria-label="筛选" data-scrim="1">' +
        '<div class="fdlg">' +
        '<div class="fhead"><span class="fic">' + icon("tag", 13) + '</span><span class="ftitle">筛选</span>' +
        '<span class="spacer"></span><button type="button" class="wbtn" data-dlg="cancel" title="关闭">' + icon("x", 13) + "</button></div>" +
        '<div class="fbody">' +
        segment("scope", "范围", [["scope", "当前目录"], ["all", "全部会话"]]) +
        segment("favorite", "收藏", [["all", "所有"], ["yes", "已收藏"], ["no", "未收藏"]]) +
        segment("archived", "归档", [["all", "所有"], ["yes", "已归档"], ["no", "未归档"]]) +
        segment("todo", "待办", [["all", "所有"], ["yes", "待办中"], ["no", "非待办"]]) +
        '<div class="frow" style="align-items:flex-start"><label class="flb">标签<span class="fsub">可多选</span></label>' +
        (tags.length === 0
          ? '<div class="se-set-note">标签库是空的</div>'
          : '<div class="ftags">' +
            tags
              .map(
                (tag) =>
                  '<button type="button" class="tagopt' + (draft.tags.includes(tag) ? " on" : "") + '" data-ftag="' + esc(tag) + '">' +
                  (draft.tags.includes(tag) ? icon("check", 10) : "") + esc(tag) + "</button>",
              )
              .join("") +
            "</div>") +
        "</div></div>" +
        '<div class="ffoot"><button type="button" class="act" data-dlg="clear">清除全部</button><span class="spacer"></span>' +
        '<button type="button" class="act" data-dlg="cancel">取消</button>' +
        '<button type="button" class="act primary" data-dlg="apply">应用筛选</button></div>' +
        "</div></div>"
      );
    }
    if (dialog.kind === "prompt") {
      return (
        '<div class="fmodal open" role="dialog" aria-label="' + esc(dialog.title) + '" data-scrim="1"><div class="fdlg" style="width:min(420px,92vw)">' +
        '<div class="fhead"><span class="ftitle">' + esc(dialog.title) + '</span><span class="spacer"></span>' +
        '<button type="button" class="wbtn" data-dlg="cancel" title="关闭">' + icon("x", 13) + "</button></div>" +
        '<div class="fbody"><input class="se-dlg-input" id="dlg-input" value="' + esc(dialog.value ?? "") + '" placeholder="' + esc(dialog.label ?? "") + '">' +
        (dialog.hint ? '<div class="mdesc">' + esc(dialog.hint) + "</div>" : "") +
        "</div>" +
        '<div class="ffoot"><span class="spacer"></span><button type="button" class="act" data-dlg="cancel">取消</button>' +
        '<button type="button" class="act primary" data-dlg="ok">' + esc(dialog.confirm ?? "确定") + "</button></div>" +
        "</div></div>"
      );
    }
    if (dialog.kind === "confirm") {
      return (
        '<div class="fmodal open" role="dialog" aria-label="' + esc(dialog.title) + '" data-scrim="1"><div class="fdlg" style="width:min(420px,92vw)">' +
        '<div class="fhead"><span class="ftitle">' + esc(dialog.title) + '</span><span class="spacer"></span>' +
        '<button type="button" class="wbtn" data-dlg="cancel" title="关闭">' + icon("x", 13) + "</button></div>" +
        '<div class="fbody"><p class="se-dlg-msg">' + esc(dialog.message ?? "") + "</p></div>" +
        '<div class="ffoot"><span class="spacer"></span><button type="button" class="act" data-dlg="cancel">取消</button>' +
        '<button type="button" class="act danger" data-dlg="ok">' + esc(dialog.confirm ?? "确定") + "</button></div>" +
        "</div></div>"
      );
    }
    return "";
  }

  const renderToast = () => (state.toast ? '<div class="se-toast">' + esc(state.toast) + "</div>" : "");

  // ── rendering: shell ───────────────────────────────────────────────────
  let focusBeforeRender = null;

  function captureFocus() {
    try {
      const element = document.activeElement;
      if (!element || !element.id) return null;
      return {
        id: element.id,
        start: typeof element.selectionStart === "number" ? element.selectionStart : null,
        end: typeof element.selectionEnd === "number" ? element.selectionEnd : null,
      };
    } catch {
      return null;
    }
  }

  function restoreFocus() {
    const saved = focusBeforeRender;
    focusBeforeRender = null;
    if (!saved) return;
    try {
      const element = document.getElementById(saved.id);
      if (!element || typeof element.focus !== "function") return;
      element.focus();
      if (saved.start !== null && typeof element.setSelectionRange === "function") element.setSelectionRange(saved.start, saved.end ?? saved.start);
    } catch {
      /* focus is a nicety; a missing node just means the row went away */
    }
  }

  function render() {
    const host = root();
    if (!host) return;
    if (state.phase === "loading") {
      host.innerHTML = '<div class="boot"><div class="boot-title">会话资源管理器</div><div class="boot-sub">正在读取会话…</div></div>';
      return;
    }
    if (state.phase === "error") {
      host.innerHTML =
        '<div class="boot"><div class="boot-title">加载失败</div><div class="boot-sub err">' + esc(state.error) + "</div>" +
        '<div><button type="button" class="act" data-act="retry">重试</button></div></div>';
      return;
    }

    focusBeforeRender = captureFocus();
    host.innerHTML =
      '<div class="se-shell" data-bp="wide" data-view="' + state.view + '" data-detail="' + (state.showDetail ? "on" : "off") + '" data-material="solid">' +
      renderTabs() +
      renderNavbar() +
      renderCmdbar() +
      '<div class="body">' +
      renderTree() +
      '<div class="rsz" data-rsz="tree"></div>' +
      renderList() +
      (state.showDetail ? '<div class="rsz rsz-detail" data-rsz="detail"></div>' + renderDetail() : "") +
      "</div>" +
      renderStatus() +
      renderMenu() +
      renderDialog() +
      "</div>" +
      renderToast();
    restoreFocus();
  }

  // ── events (delegated from #root, so a rebuild keeps them alive) ───────
  const closest = (target, selector) => {
    try {
      return target && typeof target.closest === "function" ? target.closest(selector) : null;
    } catch {
      return null;
    }
  };

  function bind() {
    const host = root();
    if (!host || typeof host.addEventListener !== "function") return;
    host.addEventListener("click", onClick);
    host.addEventListener("dblclick", onDoubleClick);
    host.addEventListener("contextmenu", onContextMenu);
    host.addEventListener("input", onInput);
    host.addEventListener("keydown", onKeyDown);
    host.addEventListener("mousedown", onMouseDown);
    host.addEventListener("focusout", onFocusOut);
    host.addEventListener("dragstart", onDragStart);
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("dragleave", onDragLeave);
    host.addEventListener("drop", onDrop);
    host.addEventListener("dragend", onDragEnd);
  }

  function onClick(event) {
    const target = event.target;

    // An open menu swallows the click that closes it; a click on one of its
    // items runs that item and nothing else.
    const menuItem = closest(target, "[data-mi]");
    if (menuItem) {
      event.preventDefault();
      const id = menuItem.getAttribute("data-mi");
      const disabled = menuItem.getAttribute("aria-disabled") === "true";
      closeMenu();
      if (!disabled) void runMenuAction(id);
      return;
    }
    if (state.menu && !closest(target, "[data-menu]")) closeMenu();
    if (state.createOpen && !closest(target, '[data-act="create-menu"]')) {
      state.createOpen = false;
      render();
    }
    if (state.sortOpen && !closest(target, '[data-act="sort-menu"]')) {
      state.sortOpen = false;
      render();
    }

    const dialogButton = closest(target, "[data-dlg]");
    if (dialogButton) {
      event.preventDefault();
      void dialogAction(dialogButton.getAttribute("data-dlg"));
      return;
    }
    if (target && target.getAttribute && target.getAttribute("data-scrim") === "1" && !closest(target, ".fdlg")) {
      cancelDialog();
      return;
    }

    const segButton = closest(target, "[data-fseg]");
    if (segButton) {
      event.preventDefault();
      if (state.dialog && state.dialog.kind === "filter") {
        state.dialog.draft[segButton.getAttribute("data-fseg")] = segButton.getAttribute("data-fval");
        render();
      }
      return;
    }
    const filterTag = closest(target, "[data-ftag]");
    if (filterTag) {
      event.preventDefault();
      const tag = filterTag.getAttribute("data-ftag");
      const draft = state.dialog ? state.dialog.draft : null;
      if (draft) {
        draft.tags = draft.tags.includes(tag) ? draft.tags.filter((entry) => entry !== tag) : [...draft.tags, tag];
        render();
      }
      return;
    }

    const closeTabButton = closest(target, "[data-closetab]");
    if (closeTabButton) {
      event.preventDefault();
      event.stopPropagation();
      closeTab(Number(closeTabButton.getAttribute("data-closetab")));
      return;
    }
    const tabButton = closest(target, "[data-tab]");
    if (tabButton) {
      selectTab(Number(tabButton.getAttribute("data-tab")));
      return;
    }
    const winButton = closest(target, "[data-win]");
    if (winButton) {
      event.preventDefault();
      void windowAction(winButton.getAttribute("data-win"));
      return;
    }

    const toggle = closest(target, "[data-toggle]");
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      const id = toggle.getAttribute("data-toggle");
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      savePrefs();
      render();
      return;
    }
    const twist = closest(target, "[data-twist]");
    if (twist) {
      event.preventDefault();
      event.stopPropagation();
      const id = twist.getAttribute("data-twist");
      if (state.collapsed.has(id)) state.collapsed.delete(id);
      else state.collapsed.add(id);
      savePrefs();
      render();
      return;
    }
    const beginNode = closest(target, "[data-beginrename]");
    if (beginNode) {
      event.preventDefault();
      event.stopPropagation();
      beginRenameNode(beginNode.getAttribute("data-beginrename"));
      return;
    }
    const beginSession = closest(target, "[data-beginrename-session]");
    if (beginSession) {
      event.preventDefault();
      event.stopPropagation();
      beginRenameSession(beginSession.getAttribute("data-beginrename-session"));
      return;
    }
    const beginDetail = closest(target, "[data-beginrename-detail]");
    if (beginDetail) {
      event.preventDefault();
      beginRenameDetail();
      return;
    }

    const checkbox = closest(target, "[data-check]");
    if (checkbox) {
      event.stopPropagation();
      toggleChecked(checkbox.getAttribute("data-check"));
      render();
      return;
    }
    const checkAll = closest(target, "[data-checkall]");
    if (checkAll) {
      event.stopPropagation();
      setCheckedAll();
      render();
      return;
    }

    const nodeRow = closest(target, "[data-node]");
    if (nodeRow) {
      selectNode(nodeRow.getAttribute("data-node"));
      return;
    }
    const row = closest(target, "[data-session]");
    if (row) {
      selectSession(row.getAttribute("data-session"), event);
      return;
    }
    const crumb = closest(target, "[data-crumb]");
    if (crumb) {
      selectNode(crumb.getAttribute("data-crumb"));
      return;
    }
    const sortHead = closest(target, "[data-sort]");
    if (sortHead) {
      cycleSort(sortHead.getAttribute("data-sort"));
      return;
    }
    // The shell itself carries `data-view`, so the switch has to use its own
    // attribute: a bare `[data-view]` lookup would match the root from every
    // button inside it and swallow the click.
    const viewButton = closest(target, "[data-setview]");
    if (viewButton) {
      state.view = viewButton.getAttribute("data-setview") === "icons" ? "icons" : "details";
      savePrefs();
      render();
      return;
    }

    const untag = closest(target, "[data-untag]");
    if (untag) {
      event.preventDefault();
      void removeTag(untag.getAttribute("data-untag"));
      return;
    }
    const dropTag = closest(target, "[data-droptag]");
    if (dropTag) {
      event.preventDefault();
      event.stopPropagation();
      void dropLibraryTag(dropTag.getAttribute("data-droptag"));
      return;
    }
    const tagButton = closest(target, "[data-tag]");
    if (tagButton) {
      event.preventDefault();
      void toggleTag(tagButton.getAttribute("data-tag"));
      return;
    }
    const openLink = closest(target, "[data-open]");
    if (openLink) {
      event.preventDefault();
      selectSession(openLink.getAttribute("data-open"), event);
      return;
    }

    const action = closest(target, "[data-act]");
    if (action) {
      event.preventDefault();
      void runAction(action.getAttribute("data-act"));
    }
  }

  function onDoubleClick(event) {
    const row = closest(event.target, "[data-session]");
    if (row) {
      const session = allSessions().get(row.getAttribute("data-session"));
      if (session && !session.trashed) openInDsh(session);
      return;
    }
    const nodeRow = closest(event.target, "[data-node]");
    if (nodeRow) selectNode(nodeRow.getAttribute("data-node"));
  }

  function onContextMenu(event) {
    event.preventDefault();
    const row = closest(event.target, "[data-session]");
    if (row) {
      const id = row.getAttribute("data-session");
      if (!state.checked.has(id)) {
        state.selected = id;
        state.selectedNode = null;
        render();
      }
      openMenu(event.clientX, event.clientY, sessionMenu());
      return;
    }
    const nodeRow = closest(event.target, "[data-node]");
    if (nodeRow) {
      const id = nodeRow.getAttribute("data-node");
      selectNode(id);
      const node = nodeOf(id);
      if (node && !node.fixed) openMenu(event.clientX, event.clientY, nodeMenu(node));
      else openMenu(event.clientX, event.clientY, blankMenu());
      return;
    }
    openMenu(event.clientX, event.clientY, blankMenu());
  }

  function onInput(event) {
    const target = event.target;
    if (!target) return;
    if (target.id === "q") {
      state.query = target.value;
      render();
      return;
    }
    if (state.renaming && target.id === "rename-input") state.renaming.value = target.value;
  }

  function onMouseDown(event) {
    const handle = closest(event.target, "[data-cw]");
    if (handle) {
      event.preventDefault();
      event.stopPropagation();
      resizeColumn(handle.getAttribute("data-cw"), event.clientX);
      return;
    }
    const pane = closest(event.target, "[data-rsz]");
    if (pane) {
      event.preventDefault();
      event.stopPropagation();
      resizePane(pane.getAttribute("data-rsz"), event.clientX);
    }
  }

  function onFocusOut(event) {
    const target = event.target;
    if (!target) return;
    if (state.renaming && target.id === "rename-input") void commitRename();
    if (target.id === "note-input") void saveNote(String(target.value ?? ""));
  }

  // ── resizing ───────────────────────────────────────────────────────────
  function trackDrag(onMove, onDone) {
    const move = (event) => onMove(event);
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      if (onDone) onDone();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  function resizeColumn(key, startX) {
    if (key === "name") return;
    const startWidth = state.cols[key] ?? DEFAULT_COLS[key];
    trackDrag(
      (event) => {
        state.cols[key] = Math.max(MIN_COL, Math.round(startWidth + (event.clientX - startX)));
        render();
      },
      () => savePrefs(),
    );
  }

  function resizePane(which, startX) {
    const start = which === "tree" ? state.navWidth : state.detailWidth;
    trackDrag(
      (event) => {
        const delta = event.clientX - startX;
        if (which === "tree") state.navWidth = Math.max(200, Math.min(420, Math.round(start + delta)));
        else state.detailWidth = Math.max(240, Math.min(520, Math.round(start - delta)));
        render();
      },
      () => savePrefs(),
    );
  }

  // ── drag and drop ──────────────────────────────────────────────────────
  function onDragStart(event) {
    const row = closest(event.target, "[data-session]");
    if (row) {
      const id = row.getAttribute("data-session");
      const session = allSessions().get(id);
      if (!session || session.trashed) return;
      const ids = state.checked.has(id) && state.checked.size > 1 ? [...state.checked] : [id];
      state.drag = { kind: "session", ids };
      try {
        event.dataTransfer.setData("application/x-dsh-session-ids", JSON.stringify(ids));
        event.dataTransfer.effectAllowed = "copyMove";
      } catch {
        /* the test DOM has no dataTransfer */
      }
      return;
    }
    const tab = closest(event.target, "[data-tab]");
    if (tab) {
      state.drag = { kind: "tab", from: Number(tab.getAttribute("data-tab")) };
      try {
        event.dataTransfer.setData("text/plain", "tab");
        event.dataTransfer.effectAllowed = "move";
      } catch {
        /* see above */
      }
      return;
    }
    const nodeRow = closest(event.target, "[data-node]");
    if (nodeRow) {
      const id = nodeRow.getAttribute("data-node");
      const node = nodeOf(id);
      if (!node || node.fixed) return;
      state.drag = { kind: "node", id };
      try {
        event.dataTransfer.setData("text/plain", id);
        event.dataTransfer.effectAllowed = "move";
      } catch {
        /* see above */
      }
    }
  }

  /** Whether the payload in flight may land on `nodeId`. */
  function dropVerdict(nodeId) {
    const drag = state.drag;
    const node = nodeOf(nodeId);
    if (!drag || !node) return { ok: false };
    if (drag.kind === "session") {
      if (node.type !== "workspace" || !node.workspaceId) return { ok: false, reason: "会话只能放进工作区" };
      return { ok: true, workspaceId: node.workspaceId, name: node.name ?? node.workspaceId };
    }
    if (drag.kind === "node") {
      if (drag.id === nodeId) return { ok: false };
      if (!canDropInTree(drag.id, nodeId)) return { ok: false, reason: "这里放不下：工作区不能放进工作区" };
      return { ok: true, parent: nodeId };
    }
    return { ok: false };
  }

  function onDragOver(event) {
    if (!state.drag) return;
    const target = closest(event.target, "[data-node]");
    if (!target) return;
    const verdict = dropVerdict(target.getAttribute("data-node"));
    if (!verdict.ok) return;
    event.preventDefault();
    try {
      event.dataTransfer.dropEffect = "move";
    } catch {
      /* the test DOM has no dataTransfer */
    }
    for (const el of root().querySelectorAll(".trow.drop")) el.classList.remove("drop");
    target.classList.add("drop");
  }

  function onDragLeave(event) {
    const target = closest(event.target, "[data-node]");
    if (target) target.classList.remove("drop");
  }

  function onDrop(event) {
    const drag = state.drag;
    const target = closest(event.target, "[data-node]");
    const verdict = target ? dropVerdict(target.getAttribute("data-node")) : { ok: false };
    state.drag = null;
    for (const el of root().querySelectorAll(".trow.drop")) el.classList.remove("drop");
    if (drag && drag.kind === "tab") {
      const tab = closest(event.target, "[data-tab]");
      if (!tab) return;
      event.preventDefault();
      moveTab(drag.from, Number(tab.getAttribute("data-tab")));
      return;
    }
    if (!drag || !target) return;
    if (!verdict.ok) {
      if (verdict.reason) setHint(verdict.reason);
      return;
    }
    event.preventDefault();
    const copy = event.ctrlKey || event.metaKey;
    if (drag.kind === "session") void moveSessions(drag.ids, verdict.workspaceId, copy, verdict.name);
    else if (drag.kind === "node") void moveNodeTo(drag.id, verdict.parent);
  }

  function onDragEnd() {
    state.drag = null;
    for (const el of root().querySelectorAll(".trow.drop")) el.classList.remove("drop");
  }

  // ── keyboard (mirrors the panel's shortcuts) ───────────────────────────
  function onKeyDown(event) {
    const target = event.target;
    const typing = Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"));

    if (state.renaming && target && target.id === "rename-input") {
      if (event.key === "Enter") {
        event.preventDefault();
        void commitRename();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRename();
        return;
      }
    }
    if (state.dialog) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelDialog();
        return;
      }
      if (event.key === "Enter" && target && target.id === "dlg-input") {
        event.preventDefault();
        void dialogAction("ok");
        return;
      }
    }
    if (state.menu && event.key === "Escape") {
      closeMenu();
      return;
    }
    if (target && target.id === "tag-input" && event.key === "Enter") {
      event.preventDefault();
      const value = target.value.trim();
      if (value) void addTag(value);
      return;
    }
    if (target && target.id === "note-input") {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void saveNote(String(target.value ?? ""));
      } else if (event.key === "Escape") {
        target.blur();
      }
      return;
    }
    if (typing) return;

    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key === "Tab") {
      event.preventDefault();
      cycleTab(event.shiftKey ? -1 : 1);
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "t") {
      event.preventDefault();
      newTab();
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "w") {
      event.preventDefault();
      closeTab(state.active);
      return;
    }
    if (mod && !event.shiftKey && /^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < state.tabs.length) {
        event.preventDefault();
        selectTab(index);
      }
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "e") {
      event.preventDefault();
      const input = document.getElementById("q");
      if (input) input.focus();
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void undoLast();
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      void cutOrCopy("cut");
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void cutOrCopy("copy");
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void pasteClipboard();
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setCheckedAll();
      render();
      return;
    }
    if (mod && event.key === "Backspace") {
      event.preventDefault();
      goBack();
      return;
    }
    if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      goBack();
      return;
    }
    if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      goForward();
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      renameCurrent();
      return;
    }
    if (event.key === "F5") {
      event.preventDefault();
      void reload(true);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      void runAction("delete");
      return;
    }
    if (event.key === "Escape") {
      if (state.query) {
        state.query = "";
        render();
      } else if (state.checked.size > 0) {
        state.checked.clear();
        render();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const list = filteredInScope().slice().sort(compareBy(state.sortKey, state.sortDir === "asc" ? 1 : -1));
      if (list.length === 0) return;
      event.preventDefault();
      const at = list.findIndex((session) => session.id === state.selected);
      const next = event.key === "ArrowDown" ? Math.min(list.length - 1, at + 1) : Math.max(0, at <= 0 ? 0 : at - 1);
      state.selected = list[next].id;
      state.selectedNode = null;
      render();
    }
  }

  // ── menus (the panel's context menus, item for item) ───────────────────
  function openMenu(left, top, items) {
    state.menu = { left, top, items };
    render();
  }

  function closeMenu() {
    if (!state.menu) return;
    state.menu = null;
    render();
  }

  function canPasteHere() {
    const clip = state.clipboard;
    if (clip.nodes.length > 0) return canHoldContainers(scopeId());
    if (clip.ids.length > 0) return Boolean(nearestWorkspace(scopeId()));
    return false;
  }

  function sessionMenu() {
    const session = state.selected ? allSessions().get(state.selected) : null;
    if (!session) return blankMenu();
    const total = idsToActOn().length;
    const items = [];
    if (session.trashed) {
      items.push({ id: "rename", label: "重命名", icon: "pencil", key: "F2" });
      items.push({ id: "restore", label: "还原", icon: "restore" });
      items.push({ sep: true });
      items.push({ id: "purge", label: "永久删除", icon: "trash", danger: true });
      return items;
    }
    items.push({ id: "rename", label: "重命名", icon: "pencil", key: "F2" });
    items.push({ id: "favorite", label: session.favorite ? "取消收藏" : "收藏", icon: "star" });
    items.push({ id: "todo", label: "待办", icon: "todo" });
    items.push({ id: "archive", label: session.archived ? "取消归档" : "归档", icon: "archive" });
    items.push({ id: "fork", label: "分叉", icon: "branch" });
    items.push({ sep: true });
    items.push({ id: "cut", label: "剪切", icon: "cut", key: "Ctrl+X" });
    items.push({ id: "copy", label: "复制", icon: "copy", key: "Ctrl+C" });
    items.push({ id: "paste", label: "粘贴到此处", icon: "paste", key: "Ctrl+V", disabled: !canPasteHere() });
    items.push({ sep: true });
    items.push({ id: "delete", label: total > 1 ? "删除 " + total + " 个会话（进回收站）" : "删除（进回收站）", icon: "trash", danger: true });
    return items;
  }

  function nodeMenu(node) {
    const isWorkspace = node.type === "workspace";
    const items = [];
    items.push({ id: "rename", label: isWorkspace ? "重命名工作区" : "重命名文件夹", icon: "pencil", key: "F2" });
    items.push({ sep: true });
    items.push({ id: "cut", label: "剪切", icon: "cut", key: "Ctrl+X" });
    if (canHoldContainers(node.id)) {
      items.push({ id: "new-folder", label: "在此新建文件夹", icon: "folderplus" });
      items.push({ id: "new-session", label: "在此新建会话", icon: "plus" });
      items.push({ id: "paste", label: "粘贴到此处", icon: "paste", key: "Ctrl+V", disabled: !canPasteHere() });
    }
    if (!isWorkspace) {
      items.push({ sep: true });
      items.push({ id: "delete-folder", label: "删除文件夹", icon: "trash", danger: true });
    }
    return items;
  }

  function blankMenu() {
    return [
      { id: "new-folder", label: "新建文件夹", icon: "folderplus" },
      { id: "new-session", label: "新建会话", icon: "plus" },
      { id: "paste", label: "粘贴", icon: "paste", key: "Ctrl+V", disabled: !canPasteHere() },
      { sep: true },
      { id: "select-all", label: "全选", icon: "check", key: "Ctrl+A" },
      { id: "refresh", label: "重新扫描", icon: "refresh", key: "F5" },
      { id: "filter", label: "筛选…", icon: "tag" },
    ];
  }

  function createMenu() {
    return [
      { id: "new-folder", label: "新建文件夹", icon: "folderplus" },
      { id: "new-session", label: "新建会话", icon: "plus" },
    ];
  }

  function sortMenu() {
    return SORT_FIELDS.map((field) => ({
      id: "sort:" + field.key,
      label: field.label + (state.sortKey === field.key ? (state.sortDir === "asc" ? "（递增）" : "（递减）") : ""),
      icon: state.sortKey === field.key ? "check" : null,
    })).concat([{ sep: true }, { id: "sort-dir", label: state.sortDir === "asc" ? "改为递减" : "改为递增", icon: "sort" }]);
  }

  function moreMenu() {
    return [
      { id: "toggle-archived", label: state.showArchived ? "隐藏已归档的会话" : "显示已归档的会话", icon: "archive" },
      { id: "clear-filter", label: "清除筛选", icon: "filter", disabled: !filterActive() },
      { sep: true },
      { id: "open-dsh", label: "打开独立窗口的说明", icon: "external" },
    ];
  }

  async function runMenuAction(id) {
    if (id.startsWith("sort:")) {
      cycleSort(id.slice(5));
      return;
    }
    switch (id) {
      case "sort-dir":
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        savePrefs();
        render();
        return;
      case "toggle-archived":
        state.showArchived = !state.showArchived;
        savePrefs();
        render();
        return;
      case "delete":
        return runAction("delete");
      case "select-all":
        setCheckedAll();
        render();
        return;
      case "open-dsh":
        return openInDsh(state.selected ? allSessions().get(state.selected) : null);
      default:
        return runAction(id);
    }
  }

  // ── actions ────────────────────────────────────────────────────────────
  function idsToActOn() {
    if (state.checked.size > 0) return [...state.checked];
    return state.selected ? [state.selected] : [];
  }

  function nodeIdsToActOn() {
    if (state.checked.size > 0) return [];
    const node = state.selectedNode ? nodeOf(state.selectedNode) : null;
    if (!node || node.fixed) return [];
    return [node.id];
  }

  async function runAction(action) {
    const session = state.selected ? allSessions().get(state.selected) : null;
    const node = state.selectedNode ? nodeOf(state.selectedNode) : null;
    const scope = scopeId();

    try {
      switch (action) {
        case "retry":
        case "refresh":
          return void (await reload(true));
        case "back":
          return goBack();
        case "forward":
          return goForward();
        case "up":
          return selectNode(nodeOf(scope)?.parent ?? FIXED.root);
        case "new-tab":
          return newTab();
        case "toggle-view":
          state.view = state.view === "details" ? "icons" : "details";
          savePrefs();
          return render();
        case "toggle-detail":
          state.showDetail = !state.showDetail;
          savePrefs();
          return render();
        case "hide-detail":
          state.showDetail = false;
          savePrefs();
          return render();
        case "clear-hint":
          state.hint = "";
          return render();
        case "select-all":
          setCheckedAll();
          return render();
        case "filter":
          state.dialog = { kind: "filter", draft: { ...state.filter, tags: [...state.filter.tags] } };
          return render();
        case "clear-filter":
          state.filter = normalizeFilter({});
          savePrefs();
          return render();
        case "create-menu": {
          const element = document.querySelector('[data-act="create-menu"]');
          if (!element) return undefined;
          const rect = element.getBoundingClientRect();
          state.createOpen = !state.createOpen;
          if (state.createOpen) state.menu = { left: rect.left, top: rect.bottom + 4, items: createMenu() };
          return render();
        }
        case "sort-menu": {
          const element = document.querySelector('[data-act="sort-menu"]');
          if (!element) return undefined;
          const rect = element.getBoundingClientRect();
          state.sortOpen = !state.sortOpen;
          if (state.sortOpen) state.menu = { left: rect.left, top: rect.bottom + 4, items: sortMenu() };
          return render();
        }
        case "more-menu": {
          const element = document.querySelector('[data-act="more-menu"]');
          if (!element) return undefined;
          const rect = element.getBoundingClientRect();
          state.menu = { left: Math.max(8, rect.right - 220), top: rect.bottom + 4, items: moreMenu() };
          return render();
        }
        case "toggle-tags":
          state.tagOpen = !state.tagOpen;
          return render();
        case "new-tag": {
          const input = document.getElementById("tag-input");
          if (input) return void (await addTag(input.value));
          return undefined;
        }
        case "new-session":
          return void newSession();
        case "new-folder":
          return void (await newFolder(node?.id ?? scope));
        case "rename":
          return void renameCurrent();
        case "delete":
          return void (await deleteSelection());
        case "delete-folder":
          return void (await deleteFolder(node ?? nodeOf(scope)));
        case "empty-trash":
          return void (await emptyTrash());
        case "cut":
        case "copy":
          return void (await cutOrCopy(action));
        case "paste":
          return void (await pasteClipboard());
        case "favorite":
          return void (await toggleFlag("favorite"));
        case "todo":
          return void (await toggleFlag("todo"));
        case "pin":
          return void (await toggleNative("/pin", "/unpin", "pinned", "置顶"));
        case "archive":
          return void (await toggleNative("/archive", "/unarchive", "archived", "归档"));
        case "fork":
          return void (await forkSession());
        case "open":
          return void openInDsh(session);
        case "copy-id":
          return void copyId(session ? session.id : "");
        case "copy-node-id":
          return void copyId(node ? node.id : "");
        case "restore":
          return void (await restoreSelection());
        case "purge":
          return void (await purgeSelection());
        case "enter":
          return selectNode(scope);
        default:
          return undefined;
      }
    } catch (error) {
      setHint(String(error?.message ?? error));
    }
  }

  function setHint(message) {
    state.hint = String(message ?? "");
    render();
    if (setHint.timer) clearTimeout(setHint.timer);
    setHint.timer = setTimeout(() => {
      setHint.timer = null;
      if (state.hint === String(message ?? "")) {
        state.hint = "";
        render();
      }
    }, 3200);
  }

  function copyId(id) {
    if (!id) return setHint("没有可复制的编号");
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        void navigator.clipboard.writeText(id).catch(() => {});
      }
    } catch {
      /* the clipboard is a convenience */
    }
    setHint("已复制 " + id);
  }

  function openInDsh(session) {
    if (!session) return setHint("先选择一个会话");
    // DSH owns session navigation and this window cannot switch it. Copying the
    // id and saying so is honest; a button that silently did nothing is not.
    copyId(session.id);
    setHint("已复制会话 id，粘贴到 DSH 主窗口的搜索框即可打开");
  }

  async function reload(refresh) {
    try {
      const data = await get("/bootstrap" + (refresh ? "?refresh=1" : ""));
      state.boot = data;
      state.phase = "ready";
      state.error = "";
      for (const tab of state.tabs) {
        if (!nodeOf(tab.scope)) {
          tab.scope = FIXED.root;
          tab.history = [FIXED.root];
          tab.cursor = 0;
        }
      }
      if (state.selected && !allSessions().has(state.selected)) state.selected = null;
      if (state.selectedNode && !nodeOf(state.selectedNode)) state.selectedNode = null;
      render();
    } catch (error) {
      state.phase = "error";
      state.error = String(error?.message ?? error);
      render();
    }
  }

  // ── selection / navigation ─────────────────────────────────────────────
  function selectSession(id, event) {
    state.selected = id;
    state.selectedNode = null;
    state.tagOpen = false;
    if (event && (event.ctrlKey || event.metaKey)) toggleChecked(id);
    render();
  }

  function selectNode(id) {
    navigate(id);
    state.selectedNode = nodeOf(id) && !nodeOf(id).fixed ? id : null;
    state.selected = null;
    state.tagOpen = false;
    render();
  }

  function toggleChecked(id) {
    if (state.checked.has(id)) state.checked.delete(id);
    else state.checked.add(id);
  }

  function setCheckedAll() {
    const list = filteredInScope();
    const all = list.length > 0 && list.every((session) => state.checked.has(session.id));
    state.checked.clear();
    if (!all) for (const session of list) state.checked.add(session.id);
  }

  function cycleSort(key) {
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else {
      state.sortKey = key;
      state.sortDir = SORT_DEFAULT_DIR[key] ?? "desc";
    }
    savePrefs();
    render();
  }

  // ── tabs ───────────────────────────────────────────────────────────────
  function makeTab(scope, index) {
    return { id: "t" + index, scope, history: [scope], cursor: 0 };
  }

  function initialTabs() {
    const saved = Array.isArray(prefs.tabs) ? prefs.tabs : [];
    const tabs = [];
    for (const entry of saved) {
      if (!entry || typeof entry.scope !== "string") continue;
      const history = Array.isArray(entry.history) && entry.history.length > 0 ? entry.history.slice() : [entry.scope];
      const cursor = Number.isInteger(entry.cursor) ? Math.max(0, Math.min(history.length - 1, entry.cursor)) : history.length - 1;
      tabs.push({ id: "t" + tabs.length, scope: entry.scope, history, cursor });
    }
    if (tabs.length > 0) return tabs;
    return [makeTab(FIXED.root, 0)];
  }

  state.tabs = initialTabs();
  state.active = Number.isInteger(prefs.active) ? Math.max(0, Math.min(state.tabs.length - 1, prefs.active)) : 0;

  const activeTab = () => state.tabs[state.active] ?? state.tabs[0];
  const scopeId = () => activeTab()?.scope ?? FIXED.root;

  let saveTimer = null;
  function savePrefs() {
    if (!store) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        store.setItem(
          PREF_KEY,
          JSON.stringify({
            view: state.view,
            sortKey: state.sortKey,
            sortDir: state.sortDir,
            filter: state.filter,
            cols: state.cols,
            navWidth: state.navWidth,
            detailWidth: state.detailWidth,
            showDetail: state.showDetail,
            showArchived: state.showArchived,
            expanded: [...state.expanded],
            collapsed: [...state.collapsed],
            tabs: state.tabs.map((tab) => ({ scope: tab.scope, history: tab.history, cursor: tab.cursor })),
            active: state.active,
          }),
        );
      } catch {
        /* a full or blocked storage is a convenience lost, not a failure */
      }
    }, 200);
  }

  function navigate(id) {
    const tab = activeTab();
    if (!tab) return;
    if (tab.history[tab.cursor] !== id) {
      tab.history = tab.history.slice(0, tab.cursor + 1);
      tab.history.push(id);
      tab.cursor = tab.history.length - 1;
    }
    tab.scope = id;
    state.checked.clear();
    state.renaming = null;
    // Entering a container also opens it: a folder the user just stepped into
    // that stayed collapsed would hide the very thing they asked for.
    state.expanded.add(id);
    const node = nodeOf(id);
    if (node?.parent) state.expanded.add(node.parent);
    savePrefs();
  }

  function goBack() {
    const tab = activeTab();
    if (!tab || tab.cursor <= 0) return;
    tab.cursor -= 1;
    tab.scope = tab.history[tab.cursor];
    state.checked.clear();
    state.selected = null;
    savePrefs();
    render();
  }

  function goForward() {
    const tab = activeTab();
    if (!tab || tab.cursor >= tab.history.length - 1) return;
    tab.cursor += 1;
    tab.scope = tab.history[tab.cursor];
    state.checked.clear();
    state.selected = null;
    savePrefs();
    render();
  }

  function newTab() {
    state.tabs.push(makeTab(scopeId(), state.tabs.length));
    state.active = state.tabs.length - 1;
    savePrefs();
    render();
  }

  function closeTab(index) {
    if (state.tabs.length <= 1) return;
    if (index < 0 || index >= state.tabs.length) return;
    state.tabs.splice(index, 1);
    if (state.active >= state.tabs.length) state.active = state.tabs.length - 1;
    else if (state.active > index) state.active -= 1;
    savePrefs();
    render();
  }

  function selectTab(index) {
    if (index < 0 || index >= state.tabs.length || index === state.active) return;
    state.active = index;
    state.selected = null;
    state.selectedNode = null;
    state.checked.clear();
    savePrefs();
    render();
  }

  function cycleTab(direction) {
    if (state.tabs.length < 2) return;
    state.active = (state.active + direction + state.tabs.length) % state.tabs.length;
    state.selected = null;
    state.selectedNode = null;
    state.checked.clear();
    savePrefs();
    render();
  }

  function moveTab(from, to) {
    if (from === to || from < 0 || to < 0 || from >= state.tabs.length || to >= state.tabs.length) return;
    const [moved] = state.tabs.splice(from, 1);
    state.tabs.splice(to, 0, moved);
    if (state.active === from) state.active = to;
    else if (from < state.active && to >= state.active) state.active -= 1;
    else if (from > state.active && to <= state.active) state.active += 1;
    savePrefs();
    render();
  }

  // ── rename (inline everywhere: row, tree row and detail title) ─────────
  function beginRenameSession(id) {
    const session = allSessions().get(id);
    if (!session) return;
    state.renaming = { kind: "session", id, value: session.displayTitle ?? session.id, previous: session.displayTitle ?? session.id };
    render();
    focusRenameInput();
  }

  function beginRenameNode(effectiveId) {
    const node = Object.values(nodes()).find((entry) =>
      entry.type === "workspace" ? (entry.workspaceId ?? entry.id) === effectiveId : entry.id === effectiveId,
    );
    if (!node) return;
    const kind = node.type === "workspace" ? "workspace" : "folder";
    state.renaming = { kind, id: effectiveId, value: node.name ?? "", previous: node.name ?? "" };
    render();
    focusRenameInput();
  }

  function beginRenameDetail() {
    const session = state.selected ? allSessions().get(state.selected) : null;
    if (session) return beginRenameSession(session.id);
    const node = state.selectedNode ? nodeOf(state.selectedNode) : null;
    if (!node) return undefined;
    return beginRenameNode(node.type === "workspace" ? node.workspaceId ?? node.id : node.id);
  }

  function renameCurrent() {
    const session = state.selected ? allSessions().get(state.selected) : null;
    if (session) return beginRenameSession(session.id);
    const node = state.selectedNode ? nodeOf(state.selectedNode) : null;
    if (node && !node.fixed) return beginRenameNode(node.type === "workspace" ? node.workspaceId ?? node.id : node.id);
    return setHint("先选择要重命名的会话或目录");
  }

  function focusRenameInput() {
    const input = document.getElementById("rename-input");
    if (!input) return;
    if (typeof input.focus === "function") input.focus();
    if (typeof input.select === "function") input.select();
  }

  function cancelRename() {
    state.renaming = null;
    render();
  }

  async function commitRename() {
    const renaming = state.renaming;
    if (!renaming) return;
    // The live field is the source of truth: an IME composition or a paste can
    // change it without an input event this file saw.
    const field = document.getElementById("rename-input");
    const typed = field && typeof field.value === "string" ? field.value : renaming.value;
    const value = String(typed ?? "").trim();
    state.renaming = null;
    render();
    if (!value || value === renaming.previous) return;
    try {
      if (renaming.kind === "session") {
        await post("/sessions/" + encodeURIComponent(renaming.id) + "/rename", { title: value });
        pushUndo("已重命名会话", async () => {
          await post("/sessions/" + encodeURIComponent(renaming.id) + "/rename", { title: renaming.previous });
        });
      } else if (renaming.kind === "workspace") {
        await post("/workspaces/" + encodeURIComponent(renaming.id) + "/rename", { title: value });
        pushUndo("已重命名工作区", async () => {
          await post("/workspaces/" + encodeURIComponent(renaming.id) + "/rename", { title: renaming.previous });
        });
      } else {
        await patch("/folders/" + encodeURIComponent(renaming.id), { name: value });
        pushUndo("已重命名文件夹", async () => {
          await patch("/folders/" + encodeURIComponent(renaming.id), { name: renaming.previous });
        });
      }
      await reload();
    } catch (error) {
      setHint(String(error?.message ?? error));
    }
  }

  // ── dialogs ────────────────────────────────────────────────────────────
  function prompt(title, label, initial, confirm, hint) {
    return new Promise((resolve) => {
      state.dialog = { kind: "prompt", title, label, value: initial ?? "", confirm: confirm ?? "确定", hint: hint ?? "", resolve };
      render();
      const input = document.getElementById("dlg-input");
      if (input) {
        if (typeof input.focus === "function") input.focus();
        if (typeof input.select === "function") input.select();
      }
    });
  }

  function confirmBox(title, message, confirmLabel) {
    return new Promise((resolve) => {
      state.dialog = { kind: "confirm", title, message, confirm: confirmLabel ?? "确定", resolve };
      render();
    });
  }

  function closeDialog(value) {
    const dialog = state.dialog;
    state.dialog = null;
    render();
    if (dialog && typeof dialog.resolve === "function") dialog.resolve(value);
  }

  function cancelDialog() {
    closeDialog(null);
  }

  async function dialogAction(action) {
    const dialog = state.dialog;
    if (!dialog) return;
    if (action === "cancel") return cancelDialog();
    if (dialog.kind === "filter") {
      if (action === "clear") {
        dialog.draft = normalizeFilter({});
        render();
        return;
      }
      if (action === "apply") {
        state.filter = normalizeFilter(dialog.draft);
        savePrefs();
        return closeDialog(true);
      }
      return undefined;
    }
    if (dialog.kind === "prompt") {
      if (action === "ok") {
        const input = document.getElementById("dlg-input");
        return closeDialog(String(input ? input.value : dialog.value ?? "").trim() || null);
      }
      return undefined;
    }
    if (dialog.kind === "confirm") return closeDialog(action === "ok");
    return undefined;
  }

  // ── folders / sessions ─────────────────────────────────────────────────
  async function newFolder(parentId) {
    const parent = parentId && canHoldContainers(parentId) ? parentId : FIXED.root;
    if (!canHoldContainers(parent)) return setHint("固定视图不能放文件夹，先进入根目录或某个文件夹");
    const name = await prompt("新建文件夹", "文件夹名称", "", "创建");
    if (!name) return;
    try {
      await post("/folders", { name, parent });
      await reload();
      setHint("已新建文件夹「" + name + "」");
    } catch (error) {
      setHint(String(error?.message ?? error));
    }
  }

  function newSession() {
    const workspace = nearestWorkspace(state.selectedNode ?? scopeId());
    if (!workspace) return setHint("请先进入一个工作区，再新建会话");
    // The Host owns session creation; this window has no route for it, so it
    // points at the app instead of pretending to create one.
    return setHint("请在 DSH 主窗口新建会话（独立窗口只管理已有会话）");
  }

  async function deleteSelection() {
    if (scopeId() === FIXED.trash) return purgeSelection();
    const ids = idsToActOn();
    const nodesToDelete = nodeIdsToActOn();
    if (ids.length === 0 && nodesToDelete.length === 0) return setHint("先选择要删除的会话或目录");
    for (const nodeId of nodesToDelete) await deleteFolder(nodeOf(nodeId));
    if (ids.length === 0) return undefined;
    await post("/trash", { ids });
    pushUndo("已把 " + ids.length + " 个会话移入回收站", async () => {
      await post("/restore", { ids });
    });
    state.selected = null;
    state.checked.clear();
    await reload();
    return setHint("已移入回收站（Ctrl+Z 可撤销）");
  }

  async function deleteFolder(node) {
    if (!node || node.fixed) return undefined;
    const ok = await confirmBox("删除文件夹", "删除「" + (node.name ?? node.id) + "」？里面的内容会移到上一层，不会删除会话。", "删除");
    if (!ok) return undefined;
    try {
      await del("/folders/" + encodeURIComponent(node.id) + "?lift=1");
      pushUndo("已删除文件夹「" + (node.name ?? node.id) + "」", async () => {
        await post("/folders", { name: node.name ?? "文件夹", parent: node.parent ?? FIXED.root });
      });
      await reload();
      setHint("已删除文件夹，内容已上提");
    } catch (error) {
      setHint(String(error?.message ?? error));
    }
    return undefined;
  }

  async function restoreSelection() {
    const ids = idsToActOn();
    if (ids.length === 0) return setHint("先选择要还原的会话");
    await post("/restore", { ids });
    pushUndo("已还原 " + ids.length + " 个会话", async () => {
      await post("/trash", { ids });
    });
    await reload();
    return setHint("已还原 " + ids.length + " 个会话");
  }

  async function purgeSelection() {
    const ids = idsToActOn();
    if (ids.length === 0) return setHint("先选择要删除的会话");
    const ok = await confirmBox("永久删除", "删除 " + ids.length + " 个会话？日志与全部历史都会从磁盘移除，这一步不能撤销。", "永久删除");
    if (!ok) return undefined;
    await post("/purge", { ids });
    state.selected = null;
    state.checked.clear();
    await reload();
    return setHint("已永久删除 " + ids.length + " 个会话");
  }

  async function emptyTrash() {
    const total = trashed().length;
    if (total === 0) return setHint("回收站已经是空的");
    const ok = await confirmBox("清空回收站", "永久删除回收站里的 " + total + " 个会话？这一步不能撤销。", "清空");
    if (!ok) return undefined;
    await post("/trash/empty", {});
    await reload();
    return setHint("回收站已清空");
  }

  // ── native flags ───────────────────────────────────────────────────────
  async function toggleFlag(flag) {
    const ids = idsToActOn();
    if (ids.length === 0) return setHint("先选择要操作的会话");
    const map = allSessions();
    const first = map.get(ids[0]);
    const next = !(first && first[flag]);
    for (const id of ids) await patch("/annotations/" + encodeURIComponent(id), { [flag]: next });
    await reload();
    return setHint((next ? "已标记 " : "已取消 ") + ids.length + " 个会话的" + (flag === "favorite" ? "收藏" : "待办"));
  }

  async function toggleNative(onPath, offPath, field, label) {
    const ids = idsToActOn();
    if (ids.length === 0) return setHint("先选择要操作的会话");
    const map = allSessions();
    const first = map.get(ids[0]);
    const next = !(first && first[field]);
    for (const id of ids) await post("/sessions/" + encodeURIComponent(id) + (next ? onPath : offPath), {});
    await reload();
    return setHint((next ? "已" : "已取消") + label + " " + ids.length + " 个会话");
  }

  async function forkSession() {
    const id = idsToActOn()[0];
    if (!id) return setHint("先选择一个会话");
    const result = await post("/sessions/" + encodeURIComponent(id) + "/fork", {});
    if (result?.sessionId) state.selected = result.sessionId;
    await reload();
    return setHint("已分叉");
  }

  // ── tags / notes ───────────────────────────────────────────────────────
  async function addTag(raw) {
    const tag = String(raw ?? "").trim();
    if (!tag) return undefined;
    const session = state.selected ? allSessions().get(state.selected) : null;
    if (!session) return setHint("先选择一个会话");
    const current = session.tags ?? [];
    if (current.includes(tag)) return setHint("这个标签已经在了");
    try {
      await patch("/annotations/" + encodeURIComponent(session.id), { tags: [...current, tag] });
      // A tag typed for the first time joins the shared library, so the picker
      // offers it next time instead of forgetting it.
      if (!library().some((entry) => entry.tag === tag)) await post("/tags", { tag });
      await reload();
      setHint("已添加标签「" + tag + "」");
    } catch (error) {
      setHint(String(error?.message ?? error));
    }
    return undefined;
  }

  async function removeTag(tag) {
    const session = state.selected ? allSessions().get(state.selected) : null;
    if (!session) return undefined;
    const next = (session.tags ?? []).filter((entry) => entry !== tag);
    try {
      await patch("/annotations/" + encodeURIComponent(session.id), { tags: next });
      await reload();
    } catch (error) {
      setHint(String(error?.message ?? error));
    }
    return undefined;
  }

  async function toggleTag(tag) {
    const session = state.selected ? allSessions().get(state.selected) : null;
    if (!session) return undefined;
    if ((session.tags ?? []).includes(tag)) return removeTag(tag);
    return addTag(tag);
  }

  async function dropLibraryTag(tag) {
    try {
      await del("/tags/" + encodeURIComponent(tag));
      await reload();
      setHint("已从标签库移除「" + tag + "」（已打上的会话保留）");
    } catch (error) {
      setHint(String(error?.message ?? error));
    }
    return undefined;
  }

  async function saveNote(value) {
    const session = state.selected ? allSessions().get(state.selected) : null;
    if (!session) return undefined;
    const trimmed = String(value ?? "").trim();
    if ((session.note ?? "") === trimmed) return undefined;
    try {
      await patch("/annotations/" + encodeURIComponent(session.id), { note: trimmed });
      await reload();
      setHint("备注已保存");
    } catch (error) {
      setHint(String(error?.message ?? error));
    }
    return undefined;
  }

  // ── clipboard ──────────────────────────────────────────────────────────
  async function cutOrCopy(mode) {
    const ids = idsToActOn();
    const nodesToMove = nodeIdsToActOn();
    if (ids.length === 0 && nodesToMove.length === 0) return setHint("先选择要操作的会话或目录");
    const map = allSessions();
    const blocked = ids.find((id) => map.get(id)?.trashed);
    if (blocked) return setHint("回收站里的会话不能移动；先还原它");
    state.clipboard = { mode, ids, nodes: nodesToMove };
    render();
    const total = ids.length + nodesToMove.length;
    return setHint((mode === "cut" ? "已剪切 " : "已复制 ") + total + " 项，转到目标位置后粘贴");
  }

  async function pasteClipboard() {
    const clip = state.clipboard;
    if (clip.ids.length === 0 && clip.nodes.length === 0) return setHint("剪贴板是空的：先剪切或复制");
    if (clip.nodes.length > 0) {
      const scope = scopeId();
      if (!canHoldContainers(scope)) return setHint("当前位置不能放目录，先进入一个文件夹或根目录再粘贴");
      if (clip.mode === "copy") return setHint("目录不支持复制粘贴；请用拖拽移动");
      const moving = clip.nodes.slice();
      for (const nodeId of moving) {
        if (nodeId === scope) continue;
        await post("/nodes/" + encodeURIComponent(nodeId) + "/move", { parent: scope });
      }
      state.clipboard = { mode: null, ids: [], nodes: [] };
      pushUndo("已移动 " + moving.length + " 个目录", async () => {
        for (const nodeId of moving) await post("/nodes/" + encodeURIComponent(nodeId) + "/move", { parent: FIXED.root });
      });
      await reload();
      return setHint("已移动 " + moving.length + " 个目录");
    }
    const workspace = nearestWorkspace(scopeId());
    if (!workspace) return setHint("当前位置不属于任何工作区，先进入一个工作区再粘贴");
    const copy = clip.mode !== "cut";
    await moveSessions(clip.ids, workspace.workspaceId, copy, workspace.name ?? workspace.id);
    if (!copy) state.clipboard = { mode: null, ids: [], nodes: [] };
    render();
    return undefined;
  }

  async function moveSessions(ids, workspaceId, copy, workspaceName) {
    const map = allSessions();
    const previous = ids.map((id) => map.get(id)).filter(Boolean);
    await post("/move", { ids, target: { workspaceId }, copy });
    if (!copy) {
      const groups = new Map();
      for (const session of previous) {
        if (!session.workspaceId || session.workspaceId === workspaceId) continue;
        const bucket = groups.get(session.workspaceId) ?? [];
        bucket.push(session.id);
        groups.set(session.workspaceId, bucket);
      }
      if (groups.size > 0) {
        pushUndo("已把 " + ids.length + " 个会话移回原来的工作区", async () => {
          for (const [fromId, movedIds] of groups) await post("/move", { ids: movedIds, target: { workspaceId: fromId } });
        });
      }
    }
    await reload();
    setHint((copy ? "已复制 " : "已移动 ") + ids.length + " 个会话到「" + workspaceName + "」");
  }

  async function moveNodeTo(nodeId, parentId) {
    await post("/nodes/" + encodeURIComponent(nodeId) + "/move", { parent: parentId });
    await reload();
    setHint("已移动到「" + (nodeOf(parentId)?.name ?? parentId) + "」");
  }

  // ── undo ───────────────────────────────────────────────────────────────
  function pushUndo(label, run) {
    state.undo.push({ label, run });
    if (state.undo.length > 50) state.undo.shift();
  }

  async function undoLast() {
    const entry = state.undo.pop();
    if (!entry) return setHint("没有可撤销的操作");
    try {
      await entry.run();
      await reload();
      return setHint(entry.label);
    } catch (error) {
      return setHint("撤销失败：" + String(error?.message ?? error));
    }
  }

  // ── window chrome ──────────────────────────────────────────────────────
  async function windowAction(action) {
    try {
      if (window.se && typeof window.se.window === "function") await window.se.window(action);
    } catch (error) {
      setHint(String(error?.message ?? error));
    }
  }

  // ── boot ───────────────────────────────────────────────────────────────
  function boot() {
    bind();
    // Keyboard shortcuts are window-level: they must work whether focus is on a
    // row, the search box (which keeps its own editing keys) or nothing at all.
    window.addEventListener("keydown", onKeyDown);
    render();
    void reload(false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // The window is long-lived; re-pull on focus so it never shows stale rows —
  // but never while the user is editing something, because a re-render would
  // discard the half-typed name or note they came back to finish.
  window.addEventListener("focus", () => {
    if (state.phase !== "ready" || state.dialog || state.renaming) return;
    const active = document.activeElement;
    if (active && (active.id === "note-input" || active.id === "tag-input" || active.id === "q")) return;
    void reload(false);
  });
})();
