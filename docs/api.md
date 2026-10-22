# HTTP API

所有端点都挂在 `/session-explorer/api` 前缀下，由 `lib/index.js:354` 的 `ROUTES` 表定义，
`lib/index.js:1182` 的 `handle()` 分发。共 **52 条**。

## 1. 信封

```jsonc
// 成功
{ "ok": true, "result": <任意 JSON> }
// 失败
{ "ok": false, "error": "给人看的消息", "code": "给机器分支的稳定码" }
```

- 只有 `code` 是契约，`error` 的文案随时可以改。
- 响应头固定 `Cache-Control: no-store`。
- 请求体上限 8 MiB，非 JSON 或超限都是 `bad-request`（`lib/http.js:57-79`）。
- 空 body 解析成 `{}`。

**四条路由不写信封**，它们自己接管响应：`GET /bridge/events`（SSE）、`GET /export`（文件）、
`GET /ui*`（静态资源）。`handle()` 在 `headersSent` 后不再追加信封（`lib/index.js:1213-1215`）。

## 2. 通用约定

### 乐观锁：revision

四份侧车文档各自带单调递增的 `revision`。写入时客户端声明"我基于哪个版本"：

| 写法 | 例子 |
|---|---|
| HTTP 头 | `If-Match: "12"`（引号可有可无，空标签 `""` 表示不表态） |
| body 字段 | `{ "revision": 12, ... }` |

两者都不给 = 最后写入者赢（单窗口用户的预期）。给了但落后 = `409 revision-conflict`，
客户端应重新拉取后重试。实现见 `lib/index.js:1057`（读期望值）与 `lib/store/sidecar.js`（比对）。

### 迁移守卫

数据目录迁移期间（`api.migration !== null`），**除 `/datadir*` 之外的所有非 GET/HEAD 请求**
一律 `409 migration-in-progress`（`lib/index.js:1205-1207`）。否则写入会落进正在被复制的旧目录。

### id 约定

| 前缀 | 含义 | 例子 |
|---|---|---|
| `f-` | 固定节点 | `f-root` / `f-all` / `f-favorites` / `f-todos` / `f-trash` / `f-ungrouped` |
| `w-` | DSH workspace 的投影节点 | `w-<workspaceId>` |
| `d-` | 用户文件夹 | `d-k3f9ab12` |
| `s-` | 快捷方式 | `s-k3f9ab34` |
| 无前缀 | 原生 id（会话 / workspace） | `01J…` |

`f-` 与 `w-` / `d-` 由 host 生成；快捷方式的 `targetId` 永远是**目标自己那套 id 空间**里的 id
（文件夹 `d-…`、workspace 去掉 `w-`、会话原样），这样解析时不用猜。

## 3. 错误码 → HTTP 状态

`lib/index.js:1247`。DSH 原生的命名空间码原样透出，不翻译。

| code | 状态 | 含义 |
|---|---|---|
| `bad-request` / `gateway/bad-request` | 400 | 参数缺失或形状不对 |
| `session/title-invalid` / `workspace/name-conflict` | 400 | DSH 拒绝的标题 / 重名 |
| `subagent-unsupported` | 400 | 该会话不能派生（子代理会话） |
| `session/not-found` / `workspace/not-found` / `trash-not-found` | 404 | 目标不存在 |
| `component-not-installed` | 404 | 浏览器组件未就绪 |
| `target-exists` / `session-active` / `session-corrupt` | 409 | 目标已存在 / 会话在跑 / 日志损坏 |
| `workspace/session-active` | 409 | workspace 里还有在跑的会话 |
| `revision-conflict` | 409 | 乐观锁失败 |
| `datadir-same` / `datadir-not-empty` / `migration-in-progress` | 409 | 数据目录迁移的三种拒绝 |
| `component-busy` / `component-in-use` | 409 | 组件正在被别的操作占用 / 窗口开着不能删 |
| `component-disk-full` | 507 | 磁盘不足 |
| `capability-missing` | 501 | 该 profile 缺这个服务 |
| 其它（含 `ui-asset-missing`） | 500 | 未预期的服务端故障 |

## 4. 路由

### 4.1 快照与设置

| 路由 | body / query | 返回 |
|---|---|---|
| `GET /bootstrap` | `?refresh=1` 跳过 TTL | 见下 |
| `GET /settings` | — | `{ settings, revision, capabilities, dataDir }` |
| `PUT /settings` | 局部设置文档 | `{ settings, revision }` |
| `GET /theme` | — | `null` 或 `{ mode, tokens, at }` |
| `POST /theme` | `{ mode?, tokens? }` | 同 `GET /theme` |

`GET /bootstrap`（`lib/index.js:362`）是面板唯一的一次往返，字段：

```jsonc
{
  "hello":       { "plugin": "dsh-session-explorer", "schema": 1 },
  "capabilities":{ /* 见 lib/capabilities.js */ },
  "workspaces":  { "workspaces": [ { id, title, path, sessionIds, createdAt, updatedAt } ] },
  "sessions":    [ /* 合并视图 + home + homeOverride */ ],
  "trashed":     [ /* 回收站条目，按删除时间倒序 */ ],
  "tree":        { /* 节点表 + sessionHome + sessionPlacement + pins + revision */ },
  "tags":        { /* 使用索引：tag → 会话 id 列表 */ },
  "tagLibrary":  [ /* 共享标签库（创建序）+ 仅被使用的标签 */ ],
  "favorites":   [ /* 会话 id */ ],
  "todos":       [ /* 会话 id */ ],
  "settings":    { /* 归一化后的完整设置文档 */ },
  "revisions":   { "tree": 7, "annotations": 3, "settings": 1 },
  "stats":       { /* 扫描统计 */ },
  "scannedAt":   1730000000000
}
```

`sessions[]` 的 `home` 是它显示在哪个容器节点里，`homeOverride` 表示这是侧车的虚拟放置而非
DSH 自己的归属（`lib/index.js:1021`）。两者都由 host 算好，客户端不重放规则。

`GET /settings` 单独存在，是因为设置页挂在面板之外，不该为渲染一个表单付一次全量扫描。
`PUT /settings` 收**局部**文档（`{ shell: { modal: { dim: 0.2 } } }` 合法），未知键被
`mergeSettings` 丢掉而不是落盘。

### 4.2 标签

| 路由 | body | 返回 |
|---|---|---|
| `GET /tags` | — | `{ tags, library }` |
| `POST /tags` | `{ tag }` | `{ tag, library, revision }` |
| `DELETE /tags/:tag` | — | `{ tag, library, revision }` |

删除库里的标签**不会**把它从会话上摘掉——那些会话仍然带着它，只是不再出现在候选列表的库段。

### 4.3 会话注解

| 路由 | body | 返回 |
|---|---|---|
| `PATCH /annotations/:id` | `{ tags?, note?, favorite?, todo? }` | `{ id, annotation, revision, tags, favorites, todos }` |
| `GET /session-state/:id` | — | `{ id, favorite, todo, archived, trashed }` |

`PATCH` 的 `annotation` 在该条目已被清空时是 `null`——注解不存"空壳"，一旦没有任何信息就整条删除。

`GET /session-state/:id` 是给 DSH 自己的会话标题栏和行菜单用的：它们没有 bootstrap 快照，
只想知道三个布尔。`trashed` 有两个来源（本插件的回收站索引，或 DSH 报告的 `trashed`），
任一为真即"不在"（`lib/domain/session-state.js:32`）。

### 4.4 树：文件夹、快捷方式、置顶、放置

| 路由 | body / query | 返回 |
|---|---|---|
| `POST /folders` | `{ name, parent? }` | `{ id, folder, revision }` |
| `PATCH /folders/:id` | `{ name }` | `{ id, folder, revision }` |
| `DELETE /folders/:id` | `?lift=0` 拒绝而非上提 | `{ ...结果, revision }` |
| `POST /shortcuts` | `{ kind, targetId, parent?, label? }` | `{ id, shortcut, revision }` |
| `DELETE /shortcuts/:id` | — | `{ removed, revision }` |
| `POST /nodes/:id/pin` | `{ pinned?: boolean }` | `{ nodeId, pinned, revision }` |
| `POST /nodes/:id/move` | `{ parent }` | `{ nodeId, parent, revision }` |
| `POST /sessions/placement` | `{ ids, parent? }` | `{ ids, parent, revision, sessionPlacement }` |

- `DELETE /folders/:id` 默认把内容**上提到父节点**（`lift` 默认 1）；`?lift=0` 时若文件夹非空
  则拒绝。同时会连带删掉指向该文件夹的快捷方式——指向已删节点的行比没有这行更糟。
- `POST /shortcuts` 的 `kind ∈ {folder, workspace, session}`，永远是**引用**，绝不移动目标。
- `POST /nodes/:id/move` 先过 `canMove()`（`lib/domain/tree.js`），不合法直接带规则码抛错。
- `POST /sessions/placement` 只写侧车的 `sessionPlacement`，**不动文件**：DSH 从 header 的 `cwd`
  推导会话归属，改它意味着搬 payload。`parent` 省略 = 清除覆盖。

### 4.5 会话操作

| 路由 | body / query | 返回 |
|---|---|---|
| `POST /sessions/:id/rename` | `{ title }` | `{ sessionId, title, seq }` |
| `POST /sessions/:id/archive` | `{ stopActivity?: boolean }` | `{ archivedSessionIds }` |
| `POST /sessions/:id/unarchive` | — | `{ archivedSessionIds }` |
| `POST /sessions/:id/pin` | — | `{ pinnedSessionIds }` |
| `POST /sessions/:id/unpin` | — | `{ pinnedSessionIds }` |
| `POST /sessions/:id/fork` | `{ atSeq?: number }` | `{ sessionId, parentSessionId }` |
| `POST /move` | `{ ids, target: { workspaceId }, copy? }` | `{ results }` |
| `POST /trash` | `{ ids }` | `{ trashed, skipped }` |
| `POST /restore` | `{ ids }` | `{ restored, skipped }` |
| `POST /purge` | `{ ids }` | `{ purged, skipped }` |
| `POST /trash/empty` | — | `{ purged }` |
| `GET /export` | `?sessionId&format=md\|jsonl&download=1` | 文件本体 |

前六个都是**DSH 自己的概念**，走 DSH 的服务（`lib/host/actions.js`），插件不落盘：

- 改名追加一条用户署名的 `session/title` 事件并压制自动标题生成；随后显式 flush 投影缓存，
  否则新标题最多要等 5 秒（缓存默认 200 事件 / 5 秒节流）。
- 归档不搬文件，只在列表里降级；有会话在跑时需 `stopActivity: true`。
- `fork` 省略 `atSeq` 时与官方默认一致：从最后一个完成的回合继续。
- 派生失败的子代理会话返回 `subagent-unsupported`。

`POST /move`（`lib/host/move.js`）是唯一会**改会话文件**的操作：重写 header 的 `cwd` + 搬目录
+ 换 registry 登记，三件事一个事务；只有其中一件成功会导致下次启动找不到会话。
`copy: true` 写第二份独立会话（新 id）而不是移动。有会话在跑时拒绝（`session-active`）——
DSH 还握着旧路径的写句柄，从底下挪走会损坏尾部。

`POST /trash` 是真移动：会话目录离开 DSH 的 sessions 树，所以 DSH 自己的侧栏里也会消失。
恢复按 `original → workspace → ungrouped` 三级阶梯落地（见 [data-directory.md](data-directory.md)）。

`GET /export` 对回收站里的会话返回 `session/not-found`——payload 已经不在 DSH 的树里了，
回收站只留一份描述。

### 4.6 workspace

| 路由 | body | 返回 |
|---|---|---|
| `POST /workspaces/:id/rename` | `{ title }` | `{ workspaceId, title }` |
| `POST /workspaces/:id/delete` | — | `{ workspaceId, deleted }` |
| `POST /workspaces/:id/reveal` | — | `{ path, opened }` |
| `POST /reveal-path` | `{ path }` | `{ path, opened }` |

删除 workspace 只删登记：目录和所有会话日志都在，会话回落到未分组（与 DSH 原生删除语义一致）。
`reveal` 在资源管理器里定位目录；workspace 没有记录路径时 `bad-request`。

### 4.7 数据目录

| 路由 | body | 返回 |
|---|---|---|
| `GET /datadir` | — | `{ current, recorded, fromEnv, exists, sizeBytes, contents }` |
| `POST /datadir/inspect` | `{ target }` | `{ target, current, exists, writable, sameVolume, mode, sizeBytes, currentSizeBytes }` |
| `POST /datadir/migrate` | `{ target, mode? }` | `{ target, mode, steps, revision }` |

`inspect` 是预检，不碰任何东西：目标必须是绝对路径、不是文件系统根、不是当前目录、可写、
且不含另一套安装。`mode` 由是否同卷决定（同卷 `move`，跨卷 `copy`），`move` 是唯一会删旧目录的模式。
详见 [data-directory.md](data-directory.md)。

### 4.8 浏览器组件

| 路由 | body | 返回 |
|---|---|---|
| `GET /component/status` | — | 见下 |
| `POST /component/install` | `{ mirror? }` | 同 status |
| `POST /component/cancel` | — | 同 status |
| `POST /component/remove` | — | 同 status |
| `POST /component/retry` | — | 同 status（续传已有 `.part`） |

status 的形状（`lib/component/manager.js:345`）：

```jsonc
{
  "phase": "absent | downloading | verifying | extracting | ready | error",
  "receivedBytes": 0, "sizeBytes": 0,
  "approxDownloadBytes": 157455369, "approxDiskBytes": 383650096,
  "canRemove": false, "pendingCleanup": 0,
  "error": "上一次失败的原因（phase=error 时）"
}
```

轮询而不是 SSE：唯一会变的数字是下载百分比，而看它的那个页面只开几秒。
`remove` 会先关掉独立窗口（`component-in-use` 的替代路径），并在删不掉时把路径记进
`pending-cleanup.v1.json`，下次启动 sweep。

### 4.9 桥与独立窗口

| 路由 | body / query | 返回 |
|---|---|---|
| `POST /bridge/commands` | `{ kind, payload? }` | `{ seq, kind }` |
| `GET /bridge/events` | `?since=<cursor>` | SSE 流 |
| `POST /detached/open` | — | `{ open: true, ... }` |
| `POST /detached/close` | — | `{ closed: boolean }` |

`kind ∈ {open-session, new-session, reveal, refresh, open-settings}`（`lib/host/bridge.js:133`），
payload 只接受 `sessionId` / `workspaceId` / `scope` 三个字符串字段，各自截断到 200 字符。
其它 kind 一律 `bad-request`——桥是一根窄管子，不是插件的遥控器。

`GET /bridge/events` 先发 `event: ready`（带当前 `cursor` 和允许的 kinds），再补发
`since` 之后的命令，之后是实时的 `event: command`；每 15 秒一条 `: keep-alive` 注释帧。
细节见 [bridge-and-theme.md](bridge-and-theme.md)。

`POST /detached/open` 在组件未 `ready` 时返回 404 `component-not-installed`。

### 4.10 静态资源

| 路由 | 文件 | Content-Type |
|---|---|---|
| `GET /ui` | `assets/detached/index.html` | `text/html` |
| `GET /ui/window.css` | `assets/detached/window.css` | `text/css` |
| `GET /ui/shim.js` | `assets/detached/shim.js` | `text/javascript` |
| `GET /ui/client.js` | `lib/client.js` | `text/javascript` |
| `GET /ui/react.js` | `assets/vendor/react.production.min.js` | `text/javascript` |
| `GET /ui/react-dom.js` | `assets/vendor/react-dom.production.min.js` | `text/javascript` |

路径是**常量**，不由请求决定读哪个文件，因此没有穿越面（`lib/index.js:78-85`）。
全部 `no-store`：面板和窗口必须跑同一份代码，缓存一份旧的正是这套安排要消除的漂移。
文件缺失时 `ui-asset-missing`（500）。

## 5. 客户端怎么用

`lib/client.js` 里 `storeOf(path)` / `revisionOf(path)` 负责把响应塞进订阅式 store，
所有写请求都带 `If-Match`。客户端不解析 `error` 文案，只按 `code` 分支；
`revision-conflict` 的处理是重新 `GET /bootstrap?refresh=1` 再让用户重试。
