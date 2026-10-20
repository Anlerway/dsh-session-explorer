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
> | **独立窗口** | The **same panel**, in its own OS window. The window loads the real DSH app (authenticated with a one-shot token) and the plugin opens its panel full-window there, so there is one explorer with two mounts — not two explorers. Falls back to a local read-only overview when the Host cannot mint an authenticated URL. |
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
assets/detached/      the overview page loaded inside the helper window
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

In the detached window the panel is the whole page: it opens on mount, fills the
viewport, has no scrim, hides the 独立窗口 button, and its close button closes the
window. Escape does not dismiss it (there would be nothing behind it).

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
npm test        # node --test: tree, store, settings, data-directory, trash, sessions, move, component
```

The suites run against temporary directories (`mkdtemp`) and hand-written `paths` objects,
so they never touch `~/.dsh` or the real sidecars.

## License

MIT.
