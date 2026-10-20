# dsh-session-explorer (会话资源管理器)

A resource-manager-style session browser for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
virtual folders, tags, notes, trash and multi-workspace browsing on top of the native DSH
session store — **without ever touching the physical layout of `~/.dsh`**.

> **Status: feature-complete for the floating panel.** Sessions can be renamed, archived,
> pinned, forked, moved, tagged, noted, filtered and trashed; folders nest and can be
> dragged; deleting moves the payload into a real bin from which it can be restored or
> purged; cross-workspace cut/copy/paste re-homes the artifact and swaps registry
> accounting. The panel has tabs, a resizable three-pane layout, inline rename and a
> command bar.
>
> Two surfaces exist and they are deliberately different:
>
> | Surface | What it is |
> |---|---|
> | **浮窗** (`lib/client.js`) | The full explorer. Opened from the sidebar entry. |
> | **独立窗口** (`assets/detached/`) | The **same explorer UI**, ported class-for-class from `lib/client.js`, in its own frameless OS window. It does not load the DSH app: it is plain DOM (no React, no build step) talking to the same `/session-explorer/api` through the helper preload, which is the only thing holding the token. Same markup, same layout, same icons — only the host adapter differs. |
>
> 导出会话 (export to Markdown / JSONL) is the one planned feature that is not built yet;
> the button says so instead of failing silently.

## Shape

Zero runtime dependencies. A DSH plugin is one bundle row with two halves:

| Half | Entry | Loaded by |
|---|---|---|
| Host | `lib/index.js` | Cordis, once, at application start |
| Client | `lib/client.js` | `window.__ModuleLoader__.load` in the renderer, no build step |

The Host half registers a single `/session-explorer/api` prefix route on the DSH web
server; the Client half registers one `sidebar.footer.action` slot and portals its panel
into a fixed layer on `<body>`.

```
lib/
  index.js            route table, dispatch, error mapping
  client.js           the whole panel (single file, no build)
  constants.js        API prefix, plugin id, fixed node ids
  http.js             {ok,result} / {ok,error,code} envelopes
  capabilities.js     defensive service probe
  paths.js            data-directory resolution (env → settings → .location)
  domain/             pure rules: tree, folders, sessions, annotations, settings, trash
  sources/            read pipeline: headers, projection cache, artifacts, registry
  store/              sidecar documents with atomic writes and revisions
  host/               actions, trash, move, datadir
  component/          browser-component state machine, downloader, installer
  detached/           Electron helper: launcher, main process, preload
assets/detached/      the detached window's own page: index.html, shell.css, shell.js
```

## Install (local, out-of-tree)

```bash
# 1. make the package resolvable from the desktop profile
cd ~/.dsh/profiles/desktop
#    package.json -> dependencies: { "dsh-session-explorer": "link:<absolute path>" }
#    package.json -> dsh.profile.bundles: [... "dsh-session-explorer" ...]
#    then create the node_modules entry (a junction on Windows)

# 2. restart the DSH application
```

A **Host-side** change (`lib/index.js`, HTTP routes, the store) only takes effect after a
full application restart: Cordis loads it once, and the desktop profile is composed by the
Electron app, so `dsh profile` cannot rebuild it either. A **Client-side** change
(`lib/client.js`) is picked up by the client-plugin HMR receiver, or by a page refresh.

## Data directory

All sidecar state lives in `~/.dsh-session-explorer/` — a **sibling** of `~/.dsh`, never a
child of it, so uninstalling the plugin is `rm -rf` on one directory and nothing else.

```
.dsh-session-explorer/
  tree.v1.json         virtual folders, placements, workspace/session order
  annotations.v1.json  per-session tags, note, favorite/todo flags, tag library
  settings.v1.json     panel size, scrim, current data directory
  .location            pointer left behind in a directory the user migrated away from
  .tmp/                scratch space for atomic writes, emptied on every start
  trash/               the bin: index.v1.json + one payload directory per session
  component/           the optional Electron runtime for 独立窗口
  detached/            window geometry and the helper's Chromium profile
```

The location is resolved in three steps, in this order:

1. `DSH_SE_DATA_DIR`, when set — a root path is rejected and falls back to the default.
2. `dataDir.current` in the default location's `settings.v1.json`, which is what a migration
   writes after it has copied everything.
3. A `.location` pointer file (`{ "movedTo": "…" }`) left behind in a directory the user
   moved away from, followed up to eight hops.

Moving the directory is a seven-step transaction (inspect → copy → verify by byte count →
reopen → record → leave a pointer → prune or remove the source). Every write route answers
`409 migration-in-progress` while it runs, and a failure reopens the old directory and
removes the half-copied target instead of touching the original.

## API

Everything answers with one of two envelopes:

```jsonc
{ "ok": true,  "result": { /* … */ } }
{ "ok": false, "error": "human readable", "code": "stable-code" }
```

| Route | Purpose |
|---|---|
| `GET /bootstrap` | Everything the panel needs in one round trip: workspaces, sessions, trashed, tree, tags, tag library, settings, revisions, stats |
| `GET /tags`, `POST /tags`, `DELETE /tags/:tag` | The shared tag library |
| `PATCH /annotations/:id` | Tags, note, favorite, todo for one session |
| `POST /folders`, `PATCH /folders/:id`, `DELETE /folders/:id` | Virtual folders (`?lift=0` deletes the contents too) |
| `POST /nodes/:id/move`, `POST /nodes/:id/order` | Reparent or reorder a folder/workspace node |
| `GET /settings`, `PUT /settings` | Preferences; `PUT` takes a partial document and drops unknown keys |
| `POST /sessions/:id/rename` | DSH's own rename — appends a `session/title` event, no sidecar write |
| `POST /workspaces/:id/rename` | Rename a workspace through the registry |
| `POST /sessions/:id/archive`, `/unarchive`, `/pin`, `/unpin`, `/fork` | Native lifecycle operations |
| `POST /move` | Cross-workspace move or copy |
| `POST /trash`, `POST /restore`, `POST /purge`, `POST /trash/empty` | The bin: move the payload out, put it back, delete it for good, empty it |
| `GET /datadir`, `POST /datadir/inspect`, `POST /datadir/migrate` | Describe, pre-flight and perform the data-directory move |
| `GET /component/status`, `/component/events` (SSE), `POST /component/{install,cancel,remove,retry}` | The optional browser component |
| `POST /detached/{open,focus,close}` | The detached window |
| `POST /detached/reveal` | Bring the window forward and select one session in it |
| `POST /bridge/commands`, `GET /bridge/events` (SSE) | The panel ↔ window command bus |

Mutating routes accept an expected revision through `If-Match` or a `revision` field in the
body; omitting both means last-writer-wins. A stale revision answers `409 revision-conflict`
and the client reloads instead of clobbering.

### Slots

| Slot | What it renders |
|---|---|
| `sidebar.footer.action` | The explorer entry and its portal panel |
| `settings.section` | The settings page: panel size, scrim, browser component, data directory |

Both labels are locale-bound thunks, so switching the app language re-renders them.

## The browser component (独立窗口)

DSH denies `window.open` and exposes no `BrowserWindow` to plugins, so a real OS window
needs its own runtime. The plugin downloads Electron 44.0.0 explicitly — it is never
fetched implicitly, because the floating panel is fully usable without it and a silent
150 MB download that fails would read as "the plugin is broken".

The state machine is `absent → downloading → verifying → extracting → ready`, persisted in
`component/state.v1.json`. Downloads stream with `Range` resume across four mirrors, the
sha256 is checked **before** extraction, and the extracted tree is published by rename so a
failed install never destroys a working one. Removing the component deletes its marker
first: whatever survives a locked file is then provably not a usable runtime.

The window is frameless and loads `assets/detached/index.html` from disk; its tab strip is
the drag region, and the page draws its own minimise / maximise / close. The renderer has no
network access of its own — `connect-src 'none'` in its CSP — so every request goes through
`window.se.api(path, init)`, an IPC call that attaches the Host token in the main process
and only forwards paths under `/session-explorer/api`. The token never reaches the page.

**The UI is a port, not a second design.** `assets/detached/shell.js` mirrors
`lib/client.js` — the same `.se-shell` / `.trow` / `.row` / `.cmdbar` / `.det-head` markup,
the same icon table, the same column model, the same context menus — and
`assets/detached/shell.css` is that panel's stylesheet with exactly two changes at the top:
the shell fills the window instead of floating as a centred card, and the page supplies the
`html/body/#root` base. Everything below those two rules is the panel's own CSS, token
bridge included, so a change to the panel's look is a change to the window's look.

What the window can do is the whole explorer minus the settings page: three panes with
draggable dividers, tabs with per-tab history, breadcrumb, sorting, search, filters, batch
selection, cut/copy/paste, drag-and-drop moves, inline rename, tags, notes, favorites, todos,
pin, archive, fork, the bin, and Ctrl+Z for the destructive ones.

### The bridge (panel ↔ window)

Two documents, two processes, one Host — and neither side can call the other directly. The
panel runs inside DSH and is the only place that holds `uiWorkspace`; the window runs on a
`file://` page whose CSP is `connect-src 'none'` and has no DSH context at all. So the Host
carries the two directions (see `lib/host/bridge.js`):

```
window  --POST /bridge/commands-->  Host  --SSE /bridge/events-->  panel
panel   --POST /detached/reveal-->  Host  --control socket-->      window
```

A command is fire-and-forget: an in-memory ring buffer (64 entries, 30 s lifetime), a cursor
per consumer, and no acknowledgement. That is deliberate — a command whose recipient is not
listening must be *dropped*, not failed, because the user can always click again, and
replaying yesterday's "open session" after a restart would move the view unasked.

| Direction | Kind | What it buys |
|---|---|---|
| window → panel | `open-session` | 打开 in the window now really opens the session in DSH: the window publishes, the panel opens itself and calls `uiWorkspace.openSession` |
| window → panel | `new-session` | 新建会话 in the window starts a draft in the current workspace |
| panel → window | `reveal` | "show me this session over there": the window switches to its workspace, selects the row, opens the detail pane and scrolls to it |
| Host → panel | `window-open` / `window-closed` | The panel knows whether 独立窗口 is on screen without polling |

The panel keeps the id-copy fallback: with no panel listening (it is closed, or an older
build), 打开 copies the session id and says so rather than pretending.

## Search

The search box matches the **title, the note and the tags** of a session — the things the
plugin itself owns. It does not read session logs: a full-text search over multi-megabyte
zstd frame streams is a different product, and DSH's own UI is the place for that.

## Theming

The panel never hard-codes a colour. Every colour is a DSH alias token
(`--dsw-alias-bg-layer-1`, `--dsw-alias-border-l2`, `--dsw-alias-label-primary`, …), which
is what makes it follow the app's light/dark theme and any wallpaper tint automatically.

## Tests

```bash
npm test              # node --test: tree, store, settings, data-directory, trash, sessions, move, component, detached window
npm run test:render   # the floating panel, rendered against a stub React
```

The suites run against temporary directories (`mkdtemp`) and hand-written `paths` objects,
so they never touch `~/.dsh` or the real sidecars.

`test/bridge.test.mjs` covers the bus on its own: cursors, the ring buffer, stale commands,
a listener that throws, and the payload normaliser that refuses an unknown kind instead of
fanning it out.

`test/detached-shell.test.mjs` is different in kind: it loads the **real** `shell.js` into a
small DOM (`test/support/dom.mjs` — a parser, event bubbling and just enough element state)
and drives it with clicks, keystrokes, context menus, checkboxes and drag events. That is the
only thing standing between a typo in a template string and a window that opens blank, and
it also pins the API surface: one test parses the Host's route table and fails if the window
calls a path that is not served.

Two rules the port has to keep, and the tests enforce: the window must never call a route the
Host does not serve, and it must never render a control the panel does not have. A selector
that matches an ancestor (the shell itself carries `data-view`) is the classic way a ported
handler ends up swallowing every click — the tests dispatch real events through the
delegated listener, so that class of bug fails here rather than in the window.

## License

MIT.
