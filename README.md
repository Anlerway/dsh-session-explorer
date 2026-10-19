# dsh-session-explorer

A resource-manager-style session browser for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
virtual folders, tags, notes, priority, trash and multi-workspace browsing on top of the
native DSH session store — **without ever touching the physical layout of `~/.dsh`**.

> Status: **P0–P4 complete** — the plugin loads, the sidebar entry opens a three-pane
> explorer over the real session store, and the sidecar data directory is created.
> Sessions can be renamed (inline, in the tree, the list and the detail pane), archived,
> pinned, forked, moved, tagged, noted, filtered and trashed; deleting moves the session
> payload into a real bin under the data directory, from which it can be restored or
> purged, and every destructive step can be undone with Ctrl+Z. Detached windows and the
> browser component still arrive with P5/P6 (see `实现粗规划.md` one directory up).

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
  settings.v1.json     shell/component preferences and the current data directory
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
| `settings.section` | The settings page: open mode, modal size/dim, component phase, data directory |

Both labels are locale-bound thunks, so switching the app language re-renders them.

## Tests

```bash
npm test   # node --test: tree, store, settings, data-directory and trash suites
npm run smoke  # render every client component once against a stub React
```

The suites run against temporary directories (`mkdtemp`) and hand-written `paths` objects,
so they never touch `~/.dsh` or the real sidecars.

## Theming

The panel never hard-codes a colour. Every colour is a DSH alias token
(`--dsw-alias-bg-layer-1`, `--dsw-alias-border-l2`, `--dsw-alias-label-primary`, …), which
is what makes it follow the app's light/dark theme and any wallpaper tint automatically.

## License

MIT.
