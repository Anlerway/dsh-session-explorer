# dsh-session-explorer

A resource-manager-style session browser for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
virtual folders, tags, notes, priority, trash and multi-workspace browsing on top of the
native DSH session store — **without ever touching the physical layout of `~/.dsh`**.

> Status: **P0 complete** — the plugin loads, the sidebar entry opens a panel, and the
> sidecar data directory is created. The panes, the tree and the destructive operations
> arrive with P1…P6 (see `实现粗规划.md` one directory up).

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
Override with `DSH_SE_DATA_DIR`; a path whose root is the filesystem root is rejected and
falls back to the default.

Layout created at boot:

```
.dsh-session-explorer/
  .tmp/      scratch space for atomic writes, emptied on every start
  trash/     session artifacts moved here by "delete"
```

## API

Everything answers with one of two envelopes:

```jsonc
{ "ok": true,  "result": { /* … */ } }
{ "ok": false, "error": "human readable", "code": "stable-code" }
```

| Route | Purpose |
|---|---|
| `GET /session-explorer/api/bootstrap` | Plugin identity, schema version and a capability snapshot |

## Theming

The panel never hard-codes a colour. Every colour is a DSH alias token
(`--dsw-alias-bg-layer-1`, `--dsw-alias-border-l2`, `--dsw-alias-label-primary`, …), which
is what makes it follow the app's light/dark theme and any wallpaper tint automatically.

## License

MIT.
