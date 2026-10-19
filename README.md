# dsh-session-explorer (会话资源管理器)

A resource-manager-style session browser for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
virtual folders, tags, notes, priority, trash and multi-workspace browsing on top of the
native DSH session store — **without ever touching the physical layout of `~/.dsh`**.

> Status: **P0–P4 complete, P4.1 polish in** — the plugin loads, the sidebar entry opens a
> three-pane explorer over the real session store, and the sidecar data directory is
> created. Sessions can be renamed (from the toolbar, F2, the row context menu or the
> detail title), archived, pinned, forked, moved, tagged, noted, filtered and trashed;
> deleting moves the payload into a real bin under the data directory, from which it can
> be restored or purged, and every destructive step can be undone with Ctrl+Z.
> Workspaces and folders are listed beside sessions, can be renamed the same three ways
> and are reachable through the search box.
>
> There is **one** panel surface: the plugin's own floating card (浮窗), sized by a fixed
> pixel preset or a percentage of the viewport. Every confirmation and prompt is drawn by
> the plugin itself on a layer *above* the panel — no `window.confirm`, no `window.prompt`
> (which Electron disables outright), and no DSH `Modal`. That last part is deliberate:
> DSH's dialog primitive paints at the app's dialog tier (z-index 1000), which is below
> this panel, so confirmations raised through it appeared *underneath* the window that
> opened them.
>
> The list separates the three kinds of container it can show: 特殊文件夹
> (未分组 / 收藏 / 待办 — fixed views, never renamed or deleted), 文件夹 (the user's own),
> and 工作区 (DSH's registry). Folders come before workspaces.
>
> 独立窗口 — a real browser window outside DSH — is **P6**, not a sliding in-app panel: it
> needs the Electron component from §5.6 of `实现粗规划.md`. The setting names it and
> states it is unavailable rather than silently falling back.
>
> The standalone Electron component (and its "reuse dsh-orb's runtime" switch) is gone for
> now: it duplicated a runtime for a window that has not shipped. This build is a pure web
> plugin with no runtime preference to configure.

## Shape

Zero runtime dependencies. A DSH plugin is one bundle row with two halves:

| Half | Entry | Loaded by |
|---|---|---|
| Host | `lib/index.js` | Cordis, once, at application start |
| Client | `lib/client.js` | `window.__ModuleLoader__.load` in the renderer, no build step |

The Host half registers a single `/session-explorer/api` prefix route on the DSH web
server; the Client half registers one `sidebar.footer.action` slot and portals its panel
into a fixed layer on `<body>`.

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

Layout created at boot:

```
.dsh-session-explorer/
  tree.v1.json         virtual folders, placements, workspace/session order
  annotations.v1.json  per-session tags, note, priority, favorite/todo, tag library
  settings.v1.json     shell preferences (window mode, size, scrim) and the current data directory
  .tmp/                scratch space for atomic writes, emptied on every start
  trash/               the bin: index.v1.json + one payload directory per session
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
| `GET /sessions`, `GET /sessions/by-node` | Sessions, optionally filtered by `q`/`tag`/`flag`, or restricted to one tree node |
| `GET /tree` | A freshly derived tree without re-reading session data |
| `GET /tags`, `POST /tags`, `DELETE /tags/:tag` | The shared tag library |
| `PATCH /annotations/:id` | Tags, note, priority, favorite, todo for one session |
| `POST /folders`, `PATCH /folders/:id`, `DELETE /folders/:id` | Virtual folders (`?lift=0` deletes the contents too) |
| `POST /nodes/:id/move`, `POST /nodes/:id/order` | Reparent or reorder a folder/workspace node |
| `GET /settings`, `PUT /settings` | Preferences; `PUT` takes a partial document and drops unknown keys |
| `POST /sessions/:id/rename` | DSH's own rename — appends a `session/title` event, no sidecar write |
| `POST /workspaces/:id/rename` | Rename a workspace through the registry |
| `POST /sessions/:id/archive`, `/unarchive`, `/pin`, `/unpin`, `/fork` | Native lifecycle operations |
| `POST /trash`, `POST /restore`, `POST /purge`, `POST /trash/empty` | The bin: move the payload out, put it back, delete it for good, empty it |
| `GET /datadir`, `POST /datadir/inspect`, `POST /datadir/migrate` | Describe, pre-flight and perform the data-directory move |

Mutating routes accept an expected revision through `If-Match` or a `revision` field in the
body; omitting both means last-writer-wins. A stale revision answers `409 revision-conflict`
and the client reloads instead of clobbering.

### Slots

| Slot | What it renders |
|---|---|
| `sidebar.footer.action` | The explorer entry and its portal panel |
| `settings.section` | The settings page: window mode, size/dim, data directory |

Both labels are locale-bound thunks, so switching the app language re-renders them.

## Tests

```bash
npm test        # node --test: tree, store, settings, data-directory, trash and session suites
npm run smoke   # render every client component against a stub React
```

The suites run against temporary directories (`mkdtemp`) and hand-written `paths` objects,
so they never touch `~/.dsh` or the real sidecars.

`npm run smoke` loads the real client bundle and renders every component once against a
stub React. Because the plugin requires nothing but `react`, the harness's `require` shim
throws on any other module: if the bundle ever starts depending on the UI primitives
again, the run fails instead of silently drifting.

The UI regressions pinned there were all invisible to the host tests:

- a folder under the current scope must appear in the *list* (not only in the tree) and
  must be findable by name from the search box;
- 特殊文件夹 must be listed as 未分组 / 收藏 / 待办 with their own group caption, must not
  include 根目录 (you are already in it), and must render neither a checkbox nor a rename
  pencil;
- 文件夹 must come before 工作区, and the two must be separate groups;
- a workspace must describe itself as 工作区 in the detail pane and never as 文件夹;
- every dialog must be the plugin's own `.fmodal` layer, never the removed native frame;
- the bundle must render no `data-hosted` / `data-mode` surface switcher.

The harness also asserts that the client's sizing helper agrees with `modalSizeOf` on the
host, since the bundle cannot import a host module.

## Theming

The panel never hard-codes a colour. Every colour is a DSH alias token
(`--dsw-alias-bg-layer-1`, `--dsw-alias-border-l2`, `--dsw-alias-label-primary`, …), which
is what makes it follow the app's light/dark theme and any wallpaper tint automatically.

## License

MIT.
