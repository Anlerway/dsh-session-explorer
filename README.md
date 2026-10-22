# dsh-session-explorer (会话资源管理器)

A resource-manager-style session browser for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
virtual folders, tags, notes, trash and multi-workspace browsing on top of the native DSH
session store — **without ever touching the physical layout of `~/.dsh`**.

> **Status: feature-complete for both surfaces.** Sessions can be renamed, archived,
> pinned, forked, moved, tagged, noted, filtered, trashed and exported; folders nest and
> can be dragged; deleting moves the payload into a real bin from which it can be restored
> or purged; cross-workspace cut/copy/paste re-homes the artifact and swaps registry
> accounting. Workspaces, folders and sessions share one 置顶 band, 收藏 and 待办 hold
> shortcuts rather than copies, and the panel has tabs, a resizable three-pane layout,
> inline rename and a command bar.
>
> Two surfaces exist and they are deliberately different:
>
> | Surface | What it is |
> |---|---|
> | **浮窗** (`lib/client.js`) | The full explorer. Opened from the sidebar entry. |
> | **独立窗口** (`assets/detached/`) | The **same explorer UI** in its own frameless OS window: the page loads `lib/client.js` itself, so there is one implementation, not two. It does not load the DSH app — same markup, same layout, same icons, same behaviour, and only the host adapter differs. |
>
> 导出会话 writes Markdown or JSONL through `GET /export`, from the detail pane or the
> row menu. Text is the only media: attachments and binary tool output are described,
> never inlined.

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
  domain/             pure rules: tree-rules (the only copy), tree building,
                      folders, shortcuts, sessions, annotations, settings, trash, export
  sources/            read pipeline: headers, projection cache, artifacts, registry
  store/              sidecar documents with atomic writes and revisions
  host/               actions, trash, move, datadir, bridge, theme
  component/          browser-component state machine, downloader, installer
  detached/           Electron helper: launcher, main process, preload
assets/detached/      the detached window's page: index.html, window.css, shim.js
                      (no UI of its own — it loads lib/client.js)
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
  tree.v1.json         virtual folders, placements, workspace/session order,
                       shortcuts, container pins, virtual session placement
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
| `GET /session-state/:id` | One session's favorite/todo/archived/trashed, for the buttons DSH renders outside the panel |
| `POST /folders`, `PATCH /folders/:id`, `DELETE /folders/:id` | Virtual folders (`?lift=0` deletes the contents too) |
| `POST /nodes/:id/move` | Reparent a folder/workspace node |
| `POST /nodes/:id/pin` | 置顶 a folder or a workspace (DSH pins sessions; this pins containers, and both land in one band) |
| `POST /shortcuts`, `DELETE /shortcuts/:id` | 快捷方式: a reference to a folder, a workspace or a session. The target never moves, and the panel itself never unlinks one — the route exists for repair, the UI only ever prunes references when their target is purged |
| `POST /sessions/placement` | Show sessions in another container without moving them (see below) |
| `POST /workspaces/:id/delete`, `POST /workspaces/:id/reveal`, `POST /reveal-path` | Drop a workspace registration (files and sessions survive), reveal a workspace or any verified path in the OS file manager |
| `GET /export?sessionId&format=md\|jsonl` | The session as a file. Answers with the body, not an envelope |
| `GET /theme`, `POST /theme` | The 25 `--dsw-alias-*` tokens the panel can see — backgrounds, the four label steps, brand/link, borders, fills and state colours — so the detached window can paint itself |
| `GET /settings`, `PUT /settings` | Preferences; `PUT` takes a partial document and drops unknown keys |
| `POST /sessions/:id/rename` | DSH's own rename — appends a `session/title` event, no sidecar write |
| `POST /workspaces/:id/rename` | Rename a workspace through the registry |
| `POST /sessions/:id/archive`, `/unarchive`, `/pin`, `/unpin`, `/fork` | Native lifecycle operations |
| `POST /move` | Cross-workspace move or copy |
| `POST /trash`, `POST /restore`, `POST /purge`, `POST /trash/empty` | The bin: move the payload out, put it back, delete it for good, empty it |
| `GET /datadir`, `POST /datadir/inspect`, `POST /datadir/migrate` | Describe, pre-flight and perform the data-directory move |
| `GET /component/status`, `POST /component/{install,cancel,remove,retry}` | The optional browser component (progress is polled, not streamed) |
| `POST /detached/{open,close}` | The detached window |
| `POST /bridge/commands`, `GET /bridge/events` (SSE) | The panel ↔ window command bus |

Mutating routes accept an expected revision through `If-Match` or a `revision` field in the
body; omitting both means last-writer-wins. A stale revision answers `409 revision-conflict`
and the client reloads instead of clobbering. The panel sends it: every write cites the
revision of the store it touches (`/settings` → settings, `/tags` + `/annotations` →
annotations, everything else → the tree) and adopts the revision the write answers with, so
two windows cannot silently overwrite each other.

### One tree, one copy of the rules

Where a node may go used to be implemented three times: `lib/domain/tree.js` for the host,
a static shell that no longer exists, and `lib/client.js` for greying out a bad drop. All of
it now lives in `lib/domain/tree-rules.js`, and the client holds no rule table at all — it
reads facts the host derives:

| Field on a tree node | Means |
|---|---|
| `accepts.session` | A session row may live here (a workspace or 未分组) |
| `accepts.folder` | Two facts in one: directories may be dropped here, and this node takes rows at all |
| `accepts.workspace` | A workspace may go here — already false for anything under another workspace |
| `accepts.shortcut` | A 快捷方式 may be filed here |
| `hasWorkspace` | Its subtree contains a workspace, so dropping one here would nest them |
| `scope` | `tree` / `all` / `favorites` / `todos` / `trash` / `none`: which sessions the view lists |
| `ref` | For a shortcut row, the node it points at |

Each session carries `home`: the node it is *shown* in (its placement override, else its
workspace, else 未分组), plus `homeOverride` for whether that was an override. The client's
whole cycle check is a subtree walk over `children`.

Because the count of a node and the rows it lists are computed by the same function
(`sessionsOfNode`), a badge cannot disagree with its list — the bug class that produced
"收藏 says 3, shows 2" is gone rather than fixed. `test/tree-mirror.test.mjs` pins the client's
drop predicate against the host's verdict for every ordered pair of nodes.

### Virtual session placement

DSH derives a session's workspace from the `cwd` in its header, so the only way to
physically re-home a session is to move its directory — which hard constraint 1 forbids.
`sessionPlacement` in `tree.v1.json` is therefore a *grouping* override:

```jsonc
{ "sessionPlacement": { "<sessionId>": "f-ungrouped" } }
```

`POST /sessions/placement` `{ ids, parent }` writes it (`parent: ""` clears it), and
`buildTree` / `sessionsOfNode` count and list a session by that node instead of its
workspace. The session keeps its DSH workspace, its log and its directory; only the row
moves — which is what makes 未分组 a real container without touching `sessions/`.
A placement naming a node that no longer exists degrades to the session's own workspace.

### Slots

| Slot | What it renders |
|---|---|
| `sidebar.footer.action` | The explorer entry and its portal panel |
| `settings.section` | The settings page: 打开方式, 列表, 面板尺寸, 遮罩, 浏览器组件, 数据目录 |
| `settings.onboarding` | One headless step that only captures the shell's `openSection` (see below); it renders nothing and completes itself |
| `conversation.session.header.actions` | 归档 · 收藏 · 待办 · 在会话资源管理器查看 · 删除, icon + word above DSH's own conversation (icon only below 1100px) |
| `sidebar.workspaces.session.menu.item` | 在会话资源管理器查看 and 删除, appended to DSH's per-session "…" menu |

Every label is a locale-bound thunk, so switching the app language re-renders them.

### 默认打开方式: 浮窗 or 独立弹窗

The sidebar entry is a launcher, and where it launches to is a setting rather than a
habit: `shell.open.mode` is `"panel"` (the floating card) or `"detached"` (the OS window),
and 设置 → 会话资源管理器 → 打开方式 is the only place to change it. 浮窗 is the default
because a launch that lands nowhere is worse than a modest one — 独立弹窗 needs the browser
component, so its chip is disabled (with the reason) until that component is installed.

Two consequences are deliberate:

- **The choice is read at launch and re-read every launch.** The footer button mounts
  outside the panel and never sees the panel's `/bootstrap`, so the launch path asks
  `GET /settings` — a light answer, no session scan — instead of trusting a cached payload.
  A change made in the settings window therefore takes effect on the next click, not on the
  next restart.
- **An entry press is a launch or a close, never a toggle to somewhere else.** Pressing it
  while the panel is open closes the panel, whatever the setting says; the setting decides
  only where a *closed* explorer opens. And if 独立弹窗 fails to open, the launch falls back
  to 浮窗 with the reason in the panel's status line — one press, one surface, no silence.
- **Every way in obeys the same setting.** DSH's conversation header (在会话资源管理器查看)
  and the session row menu are the other entries, and they follow `shell.open.mode` the same
  way the sidebar button does. They are *destinations*, though, not just launches, so the
  order differs: a panel that is already on screen reveals the session in place (that is the
  surface the user is looking at, and a second one would be noise), otherwise 独立弹窗 gets
  the window — the reveal command is published *before* the window is asked for, so a window
  already open navigates at once and one that is still starting reads it back from the bus
  buffer — and if the window cannot open, the panel opens and lands on the session.

### 更多设置… and DSH's settings window

The panel's "…" menu has a 更多设置… entry that opens DSH's own settings window on this
plugin's section. The settings shell owns that modal and publishes slots for its *contents*
only — no service exposes `openSettings` — so the opener tries three doors and reports
whether one actually landed:

1. `settings.onboarding` props carry `openSection(id)`, the shell's own navigation action.
   It is the only door that opens the modal *already on our section*, but the shell mounts
   that roster only while the onboarding flow is showing (a blank session) or while a step is
   asked for by id. Relying on it alone is what made this entry stop working: on an ordinary
   session it never arrives.
2. The product command `settings.open` — the same command the sidebar Settings button and
   the Settings shortcut run. `ctx.shortcuts` publishes no `invoke`, but the registry it
   owns does, and invoking it is exactly what a native menu selection does: no keypress is
   faked and no DSH button is clicked. It is offered the same context a menu passes
   (`target` / `region` / `modal`), so a dialog in front blocks it here exactly as it would
   block the menu — and an already-open settings window is never toggled shut.
3. The modal's nav rail is a list of buttons carrying each section's label, so once (2) has
   opened the window wherever it was last left, the opener clicks the cell whose label is
   ours. The store's active-section id is unreachable from outside, so this step is
   best-effort by design.

Every step is verified against the DOM (`[data-shortcut-modal="settings"]`) before the panel
closes: a host that refuses leaves the panel, and a hint, on screen rather than an empty
desktop.

### DSH's own session surfaces

The panel is one place to manage sessions; DSH's sidebar and conversation header are
another. Rather than making the user open the panel to 收藏 a session they are reading,
the same five writes are offered where DSH already shows that session — the header strip
(all five) and the row menu (查看 + 删除).

These surfaces mount outside the panel and therefore have no `/bootstrap` snapshot: they
receive one session id, read `GET /session-state/:id` for the three flags, and re-read it
after every write. That is what keeps a refused toggle honest — the button shows the state
the host reports, not the state the click assumed. Two rules follow from it:

- **删除 is the panel's soft delete.** The log moves to this plugin's own bin (`POST /trash`),
  so DSH's list drops the row and 回收站 can restore it. A hard delete from the shell would
  leave nothing for 回收站 to put back.
- **One write at a time.** The annotations document is revision-guarded, so the strip
  disables itself while a write is in flight rather than racing two revisions.
- **删除 asks before it deletes.** One click on the red 删除 opens the plugin's confirm
  dialog (取消 / solid red 删除, worded by `hdrDeleteTitle` + `hdrDeleteMessage`); only an
  answered "yes" reaches `POST /trash`. The row menu's 删除 is red and asks the same
  question, and it closes the menu first — which is why the question is drawn by a
  channel mounted beside the sidebar entry rather than by the row that asked it:

  | Host | Where it mounts | Why |
  |---|---|---|
  | `DialogChannel` (`dialogStore`) | beside the sidebar entry, always | a question asked from a menu must outlive the menu; one host means two dialogs can never stack |
  | `useDialogs()` (`confirm` / `ask`) | the panel | the same channel, seen from inside the panel; the panel no longer renders the host |

  Every dialog in the plugin — 清空回收站, 永久删除, the row menu's 删除 — resolves through
  that one store, so the panel's own keyboard shortcuts stand down (`dialogs.open`) no
  matter which surface asked.

The strip draws its own icons (one 16×16 inline SVG per action, stroked with `currentColor`
so the red 删除 paints its own glyph) because a client slot may not require a Harness
package. It also survives a narrow window: below 1100px the words stay in the tooltip and
only the icons remain.

在会话资源管理器查看 opens the panel (or the detached window's panel) and navigates to the
session's home container — the workspace folder it lives in, `所有会话` when it has no home,
`回收站` when it is trashed — then selects it. A session whose home is not where the user
expected still lands where the row actually is.

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

The window is frameless and loads its page from the Host itself —
`GET /session-explorer/api/ui` — over the same loopback origin as the API. Its tab strip is
the drag region; the minimise / maximise / close buttons are the page's own DOM
(`mountCaption` in `assets/detached/shim.js`), drawn with the panel's tokens so they match
either theme, and labelled for screen readers. Electron's `titleBarOverlay` was the first
attempt and is not usable here: it is painted by Chromium above the page and cannot read CSS,
and in this window it reported itself visible while painting nothing. Because the page is
same-origin with the API, `connect-src 'self'` is the whole CSP story: no token in the page,
no IPC hop for data. The preload exposes one call, `window.se.window(action)` — the frame is
the one thing a page cannot do for itself; it returns `{ maximized }`, which is what the
middle button's label follows.

**One UI, two surfaces.** The window has no UI of its own. Its page loads `lib/client.js`,
the same module DSH loads, and `assets/detached/shim.js` supplies the platform that module
expects: `__ModuleLoader__`, `slots` (the footer button it mounts into), `services`
(`uiWorkspace` → the bridge, `sessions`/`workspaces` → the API), `locale`, and `ctx`.
`assets/detached/window.css` carries the entire visual difference: the shell fills the window
instead of floating as a centred card, the scrim and the footer button are gone, and the
title bar is the drag region. Everything else — markup, icons, columns, context menus,
tokens — is the panel's own code, so a change to the panel is a change to the window by
construction rather than by discipline.

What the window can do is the whole explorer minus the settings page: three panes with
draggable dividers, tabs with per-tab history, breadcrumb, sorting, search, filters, batch
selection, cut/copy/paste, drag-and-drop moves, inline rename, tags, notes, favorites, todos,
pin, archive, fork, shortcuts, export, the bin, and Ctrl+Z for the destructive ones.

**Theme.** The panel reads its own computed tokens (14 of them, a fixed list, not a CSS
scrape) and posts them to `/theme`; the window asks for that snapshot on boot — four
attempts over ~4.6 s, because a window can open before the panel has ever reported — and
writes it to its own `:root`, then hands the two it needs to the frame for the caption
buttons. Values are validated by `isSafeTokenValue` before they reach a style attribute.
The window's own `POST /theme` is dropped by the shim: its palette is a copy, and a copy
writing back would overwrite the original with an empty one.

### The bridge (panel ↔ window)

Two documents, two processes, one Host — and the two sides cannot call each other directly.
The panel runs inside DSH and is the only place that holds `uiWorkspace`; the window runs the
same code on a page the Host serves, where the shim's `uiWorkspace` is a stub that can only
publish. So the Host carries the one direction that needs it (see `lib/host/bridge.js`):

```
window  --POST /bridge/commands-->  Host  --SSE /bridge/events-->  panel
```

The window does not need the other direction: it *is* the panel, so selecting a row, opening
the detail pane and switching workspaces are its own local state, not something another
process has to be told about.

A command is fire-and-forget: an in-memory ring buffer (64 entries, 30 s lifetime), a cursor
per consumer, and no acknowledgement. That is deliberate — a command whose recipient is not
listening must be *dropped*, not failed, because the user can always click again, and
replaying yesterday's "open session" after a restart would move the view unasked.

| Direction | Kind | What it buys |
|---|---|---|
| window → panel | `open-session` | 打开 in the window really opens the session in DSH: the window publishes, the DSH page calls `uiWorkspace.openSession` — no panel needed, which is what 独立弹窗 mode leaves it without. The panel is raised only when it is the surface that can explain a refusal (a trashed session, a DSH build with no navigation service) |
| window → panel | `new-session` | 新建会话 in the window starts a draft in the current workspace, the same way |
| window → panel | `open-settings` | 更多设置… works from the window too: the window has no settings shell of its own, so the press travels here and the DSH page opens the window. The window's own copy of the command is its request echoing and is ignored |
| page → window | `reveal` | 在会话资源管理器查看 with 默认打开方式 = 独立弹窗: the DSH page cannot navigate a panel that is not on screen, so it publishes the session id and the window lands on it. The page ignores this kind — it is the publisher |
| Host → panel | `window-open` / `window-closed` | The panel knows whether 独立窗口 is on screen without polling |

The two window → page kinds have a second reader: the panel, but only when it is already
mounted. In 独立弹窗 mode it never is, which is exactly why the page itself does the
navigation — the panel used to be the only recipient, so a request from the window found
nobody home and disappeared without a word.

Closing the window is a user decision, not a crash: `launcher.js` records it and never
respawns on the helper's exit, so 关闭 stays closed until the user opens it again.

The same rule holds inside the page. The window *is* the panel, so the panel cannot close
itself as a side effect of anything: 打开, 新建会话, 更多设置… and 移到独立窗口 all leave it
standing. `panelStore` therefore carries a close *reason* — `set(false, "user")` for the ×
button, Escape, the scrim and the sidebar toggle, `set(false)` for the code stepping aside —
and the window closes only on `"user"`. In DSH the distinction is invisible, because a
closed overlay costs nothing.

## Navigation model

Six fixed entries, every one of them with a live count. They are views over the same
sessions, not copies of them:

| Entry | Holds | Accepts a drop |
|---|---|---|
| 根目录 | The directory of the tree — folders and workspaces. It is a *place*, not a list, so it shows no session rows of its own | Folders, workspaces |
| 所有会话 | The flat list of every live session. Each row is a **reference**: it wears the shortcut badge and its menu can jump back to where the session really lives | — |
| 未分组 | Real sessions that belong to no workspace node — including ones pulled out of a workspace by a virtual placement; folders may live here too | Sessions, folders, workspaces |
| 回收站 | Trashed sessions only. The toolbar drops cut/copy/paste/rename/收藏/待办/置顶/归档/分叉: a bin can restore and delete, nothing else | — |
| 待办 / 收藏 | **Shortcuts** to sessions, folders and workspaces. Dropping here creates a reference and never moves the target | Anything, as a shortcut |

The default workspace is an ordinary workspace node — movable, renameable, pinnable and
deletable — carrying only a `default` marker so the UI can still aim new sessions at it.
置顶 is one band for sessions *and* containers: DSH stores the session pins,
`tree.v1.json` stores the container pins, and the list shows them together.

Right-clicking a row inside a multi-selection acts on the whole selection and offers only
复制 / 剪切 / 粘贴 / 删除 — a bulk edit of tags or notes across unrelated rows would apply
one row's values to all of them.

### Shortcuts

A shortcut is a reference to something that stays where it is (hard constraint 5). It can be
created in **any real container** — a folder, a workspace, 收藏, 待办 or 未分组 — by dragging a
session or a node onto it, by 发送到 in a row menu, or by dropping onto a folder, which
takes the drop *as* a shortcut instead of moving anything. 根目录, 所有会话 and 回收站 are views,
so they refuse to hold one. Dragging works the same in the list and in the tree: a session
dropped on a folder becomes a reference in both, and dropping one on a shortcut is refused
rather than nesting a reference inside a reference.

发送到 is one flyout with the three destinations — 收藏, 待办, and *the container you are
standing in* (falling back to 收藏 from a view). The parent row is a label, not a command: it
opens on hover and carries no action of its own. A shortcut row is drawn as itself: it keeps
the **target's own kind of icon** — a referenced session looks like a session, a folder like a
folder — and is marked by a 快捷方式 **tag** beside the name rather than by a substituted
glyph. Its menu's first item is 跳转到原位置, and a session reference also lists in the list
pane under 快捷方式 instead of sinking out of every group.

**A shortcut is deletable; a reference row under 所有会话 is not.** Deleting a shortcut row — in
the tree or the list, from its menu (移除快捷方式) or with the 删除 key — removes the pointer and
nothing else; the payload stays where it lives, which is the whole point of a reference. The one
exception is 所有会话, whose rows *are* references to sessions filed elsewhere: 删除 refuses there
rather than deleting a payload the row merely names. The other half of the rule still holds:
purging a session takes every reference that pointed at it with it, and deleting a folder unlinks
the references to that folder. Trashing does not — a binned session can be restored, and a row
that vanished on 删除 but came back on 还原 would be worse than one that never moved.

## Search

The search box matches the **title, the note and the tags** of a session — the things the
plugin itself owns. It does not read session logs: a full-text search over multi-megabyte
zstd frame streams is a different product, and DSH's own UI is the place for that.

## Theming

The panel never hard-codes a colour. Every colour is a DSH alias token
(`--dsw-alias-bg-layer-1`, `--dsw-alias-border-l2`, `--dsw-alias-label-primary`, …), which
is what makes it follow the app's light/dark theme and any wallpaper tint automatically.

The detached window is a separate document, and DSH's stylesheet is not in it: none of those
tokens resolve there, so every colour would fall back to the panel's own dark defaults. The
panel therefore reports them — fourteen, the complete set the window's stylesheets can consume,
and the Host accepts exactly that list and nothing else — by reading its own computed style on
`.se-shell`, which already carries the app's theme (including a theme scoped to the app surface)
resolved into it. Values arrive as concrete colours or `color-mix(…)` expressions rather than
raw `var(…)`, and `isSafeTokenValue` refuses anything that could escape a declaration.

`mode` travels alongside as a hint for the frame: `light` only when the document carries
`data-theme="light"`, `dark` otherwise. The window reads the snapshot on boot — retrying a few
times, because it can open before the panel has ever reported — and paints the frame's caption
buttons from the same two tokens.

No `backdrop-filter` and no darkening layer anywhere: with a wallpaper behind the panel,
a blur would smear the image and a scrim would dim it (hard constraint 10). The scrim
only paints when the user raises `settings.shell.modal.dim` above zero.

## Tests

```bash
npm test              # node --test: tree, store, settings, data-directory, trash, sessions,
                      # move, component, shortcuts, export, theme, detached window, session state
npm run test:render   # the floating panel, rendered against a stub React
```

The suites run against temporary directories (`mkdtemp`) and hand-written `paths` objects,
so they never touch `~/.dsh` or the real sidecars.

`test/bridge.test.mjs` covers the bus on its own: cursors, the ring buffer, stale commands,
a listener that throws, and the payload normaliser that refuses an unknown kind instead of
fanning it out.

`test/detached-window.test.mjs` covers the seam rather than the UI, because there is no
second UI to cover. It runs the **real** `assets/detached/shim.js` against a fake window and
asserts that booting the panel's module renders its footer slot into `#root`, that closing
the panel closes the frame (once), that a click goes out as exactly one bridge command and
the window's own echo is dropped instead of looping, that `POST /theme` never leaves the
window while `GET /theme` does, and that the page loads exactly the four scripts and the one
stylesheet the Host serves — every route it names is checked against the Host's route table.

The UI itself is the panel's, so it is tested where the panel is: `npm run test:render`.
That is the point of the arrangement — the window cannot drift from the panel, because it is
the panel.

`test/row-rename.test.mjs` closes the one gap that a single-pass render cannot see: it loads the
same bundle against a stub React whose `useState` survives a re-render, clicks the pencil on a
container row and asserts the editor opens. A list row owns its editor locally and only *reports*
the new name to the panel, so a pencil click cannot be made to look broken by a stale payload or
a gate that disagrees — the two halves are tested separately on purpose.

`test/client-launch.test.mjs` covers the two entry points against stub host surfaces: that
浮窗 opens the panel and asks for no window, that 独立弹窗 posts `/detached/open` and leaves the
panel closed, that a `component-not-installed` refusal falls back to 浮窗 *with* the reason,
that the mode is re-read on every launch rather than cached forever, and that 更多设置… invokes
`settings.open` exactly once with the context a native menu passes before clicking our nav
cell — and not at all when the settings window is already open, because that command toggles.
The same file drives 在会话资源管理器查看 from both sides: 浮窗 lands in the panel, 独立弹窗
publishes the reveal and *then* opens the window, a refusal still lands in the panel, a panel
already on screen is revealed in place without even reading the setting, and a stub
`EventSource` shows the window following a reveal it did not send while the page ignores the
one it did.

`test/settings-page.test.mjs` renders the settings page itself against a React whose state
survives a re-render, because the page holds its document in state that arrives after the
first paint. It pins the 打开方式 group as the first one on the page, 浮窗 as the selected
chip, the 独立弹窗 chip as disabled (and explained) without the browser component, and the
write a chip click makes: exactly `{shell:{open:{mode}}}`, citing the revision it read, so a
launch setting can never rewrite the panel's size or scrim on the way past.

`test/session-state.test.mjs` pins the state DSH's own surfaces read: which document each flag
comes from, that only a real boolean counts, and the two ways a session can read as trashed (the
bin holds the payload; the reader reports it while a restore settles). The header strip's wording
and its disabled rule are pinned in `test/render-smoke.mjs`, where the slot is also registered.

## License

MIT.
