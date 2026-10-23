# 架构

> 本文按代码实际结构写，不是按设计稿。凡是本文与代码冲突的地方，以代码为准，并请提 issue。
> 历史设计文档（交接文档、实现粗规划、规划、独立窗口复刻规格等）已归档到仓库外，见第 8 节。

## 1. 两个半体

一个 DSH 插件包 = 一个 bundle row + 两个半体。两者没有共享模块，只共享字符串常量
（`lib/constants.js`）和一套 HTTP 契约。

| 半体 | 入口 | 由谁加载 | 运行环境 |
|---|---|---|---|
| Host | `lib/index.js` | Cordis，应用启动时加载一次 | DSH 主进程（Node ESM） |
| Client | `lib/client.js` | `window.__ModuleLoader__.load({ id, factory })`，无构建步骤 | 渲染进程（浏览器环境） |

Host 半体在 DSH 的 web 服务器上注册**一个**前缀路由 `/session-explorer/api`，所有端点都在
它下面（`lib/index.js:248-252`）。Client 半体往 DSH 的 UI 插槽里注册 5 个组件，并把浮窗
portal 到 `<body>` 上的固定层。

### 加载链路

```
package.json
├─ dsh.bundle.patch = "./cordis.patch.yml"
│    └─ - insert: [{ id: session-explorer, name: 'dsh-session-explorer', config: {} }]
│         → Cordis 按包名 import，取 name / inject / apply
│           (lib/index.js:87 name, lib/index.js:92 inject, lib/index.js:101 apply)
└─ dsh.client.inject = "@deepseek-ai/dsh-client-ui-slots"
   dsh.client.platform = "web"
     → 渲染进程把 lib/client.js 当作 out-of-tree client 模块执行
```

`cordis.patch.yml` 只做**增量 insert**，不覆盖任何已发布的行（补丁会替换目标行的整个
`config`，覆盖是危险的）。

## 2. Host 半体：`apply(ctx)` 做了七件事

`lib/index.js:101-268`，顺序有意义：

1. **拿 webServer**（`:102-103`）。`inject = ["webServer"]` 是唯一硬依赖：没有 HTTP 服务器的
   profile 就没有浏览器半体，此时直接 return，让 loader 跳过这一行。
2. **开数据目录**（`:107-118`）：`resolveDataDir()` → `dataPaths()` → `openDocuments()`。
   `openAt(dir)` 让迁移完成后能在**不重启**的情况下切到新目录。
3. **四个可选件**（`:120-164`）：
   - `component`：浏览器组件状态机（Electron 运行时）；
   - `detached`：独立窗口 helper 进程控制器（懒创建）；
   - `bridge`：浮窗 ↔ 独立窗口的命令总线（内存）；
   - `theme`：浮窗上报、窗口读取的调色板。
4. **组装 `api` 对象**（`:167-227`）。这是路由处理器唯一的依赖入口：
   `ctx / dataDir / paths / documents / migration / reopen / component / detached / bridge /
   theme / capabilities / reader`。`dataDir` 与 `paths` 是 getter，迁移后自动指向新值。
5. **启动自愈**（`:232-246`）：`reconcileTrash(api)` 收尾"索引已写、payload 未搬"的中断；
   `reconcileMoves(api)` 做同一件事的移动版（payload 已搬到目标、注册表还没跟上）；
   `component.sweep()` 删除上一次卸载时被占用、删不掉的目录。三者都 best-effort、不 await。
6. **注册前缀路由**（`:248-256`），并把返回的 dispose 挂到 `ctx.effect`。
7. **退出时收尾**（`:261-267`）：插件被禁用/重载时 `api.detached.stop()`，否则 helper 进程会
   活过拥有它的代码。

## 3. 一次请求的生命周期

`handle(api, req, res)`（`lib/index.js:1189-1248`）：

```
routeOf(req.url)                 // lib/http.js:88  剥掉 /session-explorer/api
  ↓ null → 404 bad-request
compileRoute 匹配表               // lib/index.js:1145  段数相等 + :param 解码
  ↓ 无 → 404 no route for <METHOD> <path>
迁移守卫                          // 非 GET/HEAD 且非 /datadir* → migration-in-progress
assertSameOrigin(req)            // 非 GET/HEAD：跨站 / 非 JSON → 403 / 415
readJsonBody(req)                // 非 GET/HEAD，上限 8 MiB（lib/http.js:57）
handler(api, req, res, query, params)
  ↓ 正常 → ok(res, result)        // { ok: true, result }
  ↓ 抛错 → statusFor(code)        // lib/index.js:1310  错误码 → HTTP 状态
           fail(res, status, code, message)
```

三条不变量：

- **信封唯一**：`{ ok: true, result }` / `{ ok: false, error, code }`（`lib/http.js:22-48`）。
  客户端只对 `code` 分支，`error` 只给人看。
- **错误码直通**：DSH 原生错误带的命名空间码（`workspace/name-conflict`、
  `session/title-invalid`）原样透出，不翻译，避免多一层会漂移的映射（`lib/index.js:1274`）。
- **SSE 例外**：`GET /bridge/events` 自己接管响应，`handle` 在 `headersSent` 时不再写信封
  （`lib/index.js:1223`）。
- **写请求必须同源**：没有 token，所以靠 `Sec-Fetch-Site` 与 `Content-Type: application/json`
  这两个浏览器强制的信号拒绝跨站写（`lib/index.js` 的 `assertSameOrigin()`，见
  [api.md](api.md#31-写请求的同源约束)）。

## 4. 分层

```
lib/
├─ index.js          1717  插件装配 + 路由表（62 条）+ 错误映射（唯一编排层）
├─ http.js            101  信封、body 解析、URL 切分
├─ constants.js        39  API_PREFIX / PLUGIN_ID / REPO_URL / FIXED_NODES / WORKSPACE_NODE_PREFIX
├─ capabilities.js     73  Cordis 服务的防御式探测
├─ paths.js           327  数据目录解析、`.location` 指针、原子写临时目录清理
│
├─ sources/                 读 DSH 的数据（只读，除 move 的受控重写）
│  ├─ heads.js        233  L2：sessions 目录遍历（按实际版本名取最新日志，并发 8，结果排序）
│  ├─ projcache.js    177  L1：storages/session_projcache 的每会话小 JSON
│  ├─ workspaces.js   127  workspace registry：优先活服务，回退 storages/workspace.json
│  ├─ logfacts.js     250  日志两端：空白会话 / 已中断（按 path|size|mtime 有界缓存）
│  ├─ artifact.js     227  会话文件路径编码/解码、读日志、重写 header
│  └─ reader.js       264  三源合并 + TTL 缓存策略（/bootstrap 的数据源）
│
├─ domain/                  纯规则，无 IO，可直接单测
│  ├─ sessions.js     310  合并三源 → 扁平会话列表（header 定身份，cache 只填空）
│  ├─ tree.js         450  树投影：workspace 节点 + 固定节点 + 用户文件夹
│  ├─ tree-rules.js   451  规则表 R1–R5 的唯一实现（accepts / scope / ref 装饰）
│  ├─ folders.js      330  新建/重命名/移动/删除文件夹（改 tree draft）
│  ├─ shortcuts.js    233  快捷方式：引用而非移动
│  ├─ annotations.js  276  标签、备注、收藏/待办
│  ├─ settings.js     315  设置文档形状与归一化
│  ├─ trash.js        210  回收站条目形状、恢复阶梯
│  ├─ subagents.js    107  子智能体绑定：isBound / descendantsOf / withDescendants / boundIds
│  ├─ export.js       258  日志 → Markdown / JSONL（处理 surfaceOp 遮蔽）
│  └─ session-state.js 38  单个会话的布尔位（给 DSH 自己的按钮用，含 subagent）
│
├─ store/                   自己的持久化
│  ├─ sidecar.js      238  原子写 + revision + 串行化 + mtime/size 缓存
│  └─ documents.js    130  四份侧车文档的注册表
│
├─ host/                    需要动文件系统或跨进程的操作
│  ├─ actions.js      697  改名/派生/归档/置顶 → 调 DSH 自己的服务
│  ├─ trash.js        496  删除/恢复/清空的字节搬运
│  ├─ move.js         683  跨 workspace 移动/复制（重写 header cwd + 换登记）
│  ├─ move-journal.js 101  移动的意图日志：崩在两次写之间时，启动收尾而不是留下孤儿
│  ├─ datadir.js      380  数据目录检查与七步迁移
│  ├─ bridge.js       170  命令环形缓冲 + 游标
│  ├─ theme.js        103  调色板令牌白名单与校验
│  ├─ native-reveal.js 107 koffi → `SHOpenFolderAndSelectItems`，"在文件夹中显示"
│  ├─ reveal-agent.js  203 常驻 PowerShell：省掉每次 reveal 一秒多的进程启动
│  ├─ update.js       210  更新检查：版本比较、GitHub release 解析、5 分钟缓存
│  ├─ open-link.js    169  链接白名单（repo / star / issues / releases）→ 系统浏览器（带降级链）
│  ├─ maintenance.js  215  缓存清理：内存三件 + `.tmp` / 下载目录 / staging，跳过在装的组件
│  └─ reset.js        193  清除数据：四份侧车 + 回收站净内容 + 隔离区 + `.tmp`，`DELETE` 把关
│
├─ component/               可选 Electron 运行时
│  ├─ layout.js       226  路径、版本、SHA-256、镜像、体积
│  ├─ state.js        160  state.v1.json 生命周期机
│  ├─ downloader.js   339  curl 流式下载（断点续传、镜像、进度）
│  ├─ install.js      562  校验 → 解压 → 原子发布
│  └─ manager.js      688  单飞状态机（install/cancel/remove 共享一把锁）
│
├─ detached/
│  ├─ launcher.js     390  Host 侧：spawn / 重试 / 聚焦 / 关闭、net 控制通道
│  └─ main.cjs        —    跑在 Electron 运行时里，拥有 BrowserWindow
│
└─ dsh/
   ├─ home.js          39  DSH home 解析（与 kernel 同规则）
   └─ zstd.js         197  zstd 帧扫描器（只为跳过帧，不解码）
```

**依赖方向是单向的**：`index` → `host` / `store` / `domain` / `sources`；
`host` → `domain` + `store`；`domain` 不 import 任何 IO 模块；`sources` 不 import `domain` 的规则
（只 import 纯合并函数）。`domain/*` 全部是"传入 draft、返回 draft"，所以测试不需要文件系统。

### 4.1 一件只能 host 做的事：更新检查

设置页「关于」组的三个入口里有两个**不能**由客户端完成，这是它们单独放在 `host/` 的原因：

- **更新检查**：客户端是个普通网页，直接问 `api.github.com` 会撞 CORS；独立窗口里
  `window.open` 与 `fetch` 也被主进程限定。所以由 `host/update.js` 代问、代比较，
  结果缓存 5 分钟——设置页每打开一次就问一次的话，未登录的 60 次/小时会很快用完。
- **打开链接**：`host/open-link.js` 用系统浏览器打开，但**只认四个名字**
  （`repo` / `star` / `issues` / `releases`），不收 URL。这条 API 挂在 DSH 的端口上、没有 token，
  接受任意 URL 就等于送给每个网页一个"用系统浏览器打开这个地址"的按钮。
  打开本身按平台走一条降级链（Windows：`rundll32 url.dll,FileProtocolHandler` → `Start-Process`，
  macOS `open`，Linux `xdg-open` → `gio open`），认的是子进程**退出码**而不是"spawn 成功"——
  后者会让一个起得来、却打不开任何东西的壳子也报成功，用户看到的就是"点了没反应"；全链失败才
  报错，且错误消息里带着那个 URL，面板原样显示，至少还能复制。

第三个（缓存清理，`host/maintenance.js`）固然是 host 的活，但它有一条同样值得记住的边界：
只清**插件自己的**缓存（内存里的三处与 `.tmp` / 下载目录 / staging），`quarantine/` 与
DSH 自己的 `storages/session_projcache` 一律不碰；组件正在下载/校验/解压时跳过那两项。
  浏览器缓存也不归它管：面板的 `/ui/*` 本来就不缓存，其余属于 DSH 的渲染进程和独立窗口。

### 4.2 唯一不可逆的操作：清除数据

设置页最后一组（「危险操作」）只有一个按钮，它删的是用户自己的东西：文件夹、标签、备注、设置、
回收站索引，以及回收站里的**会话目录本体**。回收站是 move 不是 copy（`host/trash.js`），
那些目录曾经就是 DSH 的会话目录——这一步没有"再点一次还原"可退。

所以判断全在 `host/reset.js`，客户端只把用户打的字原样送上去：

- 字面上的 `DELETE`（去掉首尾空白）是**第一件**检查的事，不是删到一半才检查；
- `api.dataDir` 必须过 `isUsableDataDir()`——越是要清空一个目录，越要先确认那是它自己的；
- 它清空的三个目录（`trash/` / `quarantine/` / `.tmp/`）保留目录本身：插件下次还得往里写；
- 浏览器组件不在其中：那是安装，不是用户数据，它的按钮是清理缓存；
- 删完立刻 `invalidateMemory(api)`：面板每张列表都是 memo 过的，不抖掉的话，被删掉的文件夹
  会一直答到进程重启。

页面上的红按钮与输入框只是礼貌。这条路由没有 token，真正的门必须在 host：

```js
if (typed !== RESET_CONFIRMATION) throw codedError("confirm-required", "…");   // 400，一个字节都没动
if (!isUsableDataDir(dataDir)) throw codedError("reset-refused", "…");        // 409
```

## 5. Client 半体：`apply(ctx)` 注册了什么

`lib/client.js:10339-10510`。`inject = ["slots", "locale", "uiWorkspace"]`（`:10513`）。

**插槽**（order 决定与 DSH 自带条目的相对位置）：

| 插槽 | id | order | 组件 | 作用 |
|---|---|---|---|---|
| `sidebar.footer.action` | `session-explorer-footer` | 40 | `FooterAction` | 侧栏底部入口，开/关浮窗 |
| `settings.section` | `session-explorer` | 510 | `SettingsSection` | 设置页分组（label 是 thunk，跟随语言）；组序 打开方式 → 列表 → 会话界面 → 浮窗 → 浏览器组件 → 数据目录 → 关于 → 危险操作 |
| `settings.onboarding` | `session-explorer-opener` | 900 | 匿名 | 只为拿到 `openSection` 后立即 `complete()`，不留 UI |
| `conversation.session.header.actions` | `session-explorer-header` | 60 | `SessionHeaderActions` | 会话标题栏五个按钮（样式跟随设置 `shell.header.style`） |
| `sidebar.workspaces.session.menu.item` | `session-explorer-rows` | 500 | `SessionMenuItems` | 会话行 "…" 菜单两条 |

**effect**（随插件卸载自动清理）：

- 主题上报：`reportTheme()` + `MutationObserver` 监听 `documentElement` 的
  `class` / `data-theme` / `style`（`:10192-10205`）；
- 桥订阅：`subscribeBridge(...)`，处理 `open-session` / `new-session` / `open-settings` /
  `reveal` / `window-closed`（`:10207-10264`）；
- 词典注册：`ctx.locale.register(NS, { zh, en })`（`:10265`）。

**导出**：`apply` / `inject` / `panelStore` / `SettingsSection`（`:10345-10347`）。

浮窗本体是 `Panel`（`lib/client.js:4683`，单函数约 4000 行，内部按功能分段），
它被 portal 到 `<body>` 上的固定层——侧栏有 `overflow: hidden`，原地渲染会被裁掉
（`lib/client.js:594` 的注释）。

## 6. 数据流

```
                       ┌─ L2 heads（sessions 目录 + zstd 第一帧）  ← 真相：存在性、id、cwd
reader.snapshot()  ←───┼─ L1 projcache（每会话小 JSON）            ← 便宜：标题、时间、计数
                       └─ workspace registry（活服务 → 文件）      ← 归属、归档、置顶
        ↓ 合并（domain/sessions.js）
        ↓ 叠加侧车（tree / annotations / trash index）
GET /bootstrap  →  一次往返把面板需要的全部东西给客户端
```

客户端**不重算任何规则**：`tree-rules.js` 在节点上装饰 `accepts` / `scope` / `ref` /
`hasWorkspace`，客户端只读这些字段、只沿 `children` 走两件事（子树、父链）。
`test/tree-mirror.test.mjs` 守着这条线：客户端可以留一个"拖拽时先灰掉"的谓词，但不能有第二套规则表。

归属（`workspaceId`）在 `domain/sessions.js` 里定，且**沿父链继承**：DSH 的
`workspace.sessionIds` 只登记用户从工作区打开的会话，子代理是父会话创建的，永远不在里面。
所以一个 `isSubagent` 且没有登记的会话，按 `parentSession` 向上找最近一个已归属的祖先，
继承它的 `workspaceId` / `workspaceTitle`；整条链都没有归属时才退回到 `cwd` 与工作区
路径的**精确**比较。fork 不是子代理（只有 `parentSession` + `isSeeded`），不参与继承。

子智能体的**操作**也绑定在父会话上，规则同样只在一处：`domain/subagents.js`。它回答三个问题——
`isBound`（能不能单独动）、`descendantsOf`（父会话走了谁跟着走）、`withDescendants`（级联的实际
id 列表）。路由侧统一用 `assertStandalone()` 拒绝单独操作（`subagent-unsupported`），回收站三条
路由再用 `withDescendants()` 把整条委派链一起带走；归档不写子会话，靠 `sessions.js` 的
`archivedUp` 从祖先派生。客户端只消费 `session-state` 里的 `subagent` 位，不自己判断。

## 7. 硬约束（写代码前先读这一节）

1. **零运行时依赖**。`dependencies` 为空，`peerDependencies` 只有 Cordis（optional）。
   React 由宿主提供，`assets/vendor/` 里的两个文件只给独立窗口用。
2. **无构建步骤**。`lib/client.js` 直接是浏览器可执行的文件；`node --check` 只证明能解析，
   行为靠 `test/render-smoke.mjs` 与几个真实渲染测试兜底。
3. **`lib/client.js` 是单文件，且是刻意的**。模块加载器只给一个 factory，拆文件就要自己实现
   模块系统。不要在"整理代码"时拆它。
4. **绝不背着 kernel 写 DSH 的存储**。标题、归档、置顶、派生都调 DSH 自己的服务
   （`lib/host/actions.js`）。两个受控例外：`host/move.js` 移动会话文件并重写 header 的 `cwd`
   （必须同时走 registry 的写路径，否则下次启动会话就丢了），`host/trash.js` 把会话目录整体
   移进/移出回收站（DSH 与插件对"它不在了"的理解因此天然一致）。两个例外都用"先记账、后动手"
   兜住崩溃：回收站写 `pending` 条目，移动写 `move-journal.v1.json`，启动时各自对账。
5. **侧车可删**。`tree.v1.json` / `annotations.v1.json` / `settings.v1.json` /
   `trash/index.v1.json` 只存 DSH 不知道的东西；删掉它们不会丢会话。
   `move-journal.v1.json` 是例外：它记录的是**正在进行**的一次移动，正常情况下是空文件（不存在）。
6. **服务探测全部防御式**。缺服务只降级一个功能（`/bootstrap` 的 `capabilities` 会告诉客户端
   哪些不可用），不能让整个插件挂掉。
7. **副作用都要挂 `ctx.effect`**，否则热重载会漏掉清理（路由 dispose、主题 observer、桥订阅、
   helper 进程）。

## 8. 文档地图

| 文件 | 内容 |
|---|---|
| [README.md](README.md) | 索引、阅读顺序、三条最容易违反的约定 |
| [api.md](api.md) | 全部路由、信封、错误码 → 状态、revision 契约 |
| [data-directory.md](data-directory.md) | 数据目录解析、侧车文件、原子写、七步迁移 |
| [tree-and-placement.md](tree-and-placement.md) | 树结构、R1–R5、节点 id、快捷方式、虚拟放置 |
| [bridge-and-theme.md](bridge-and-theme.md) | 浮窗 ↔ 独立窗口的命令总线与调色板同步 |
| [component.md](component.md) | 浏览器组件：下载、校验、安装、独立窗口进程 |
| [testing.md](testing.md) | 测试矩阵与怎么跑 |

历史文档（已移出仓库，归档在 `C:\Users\mi\Desktop\project_old\docs-archive\`：`交接文档.md`、
`实现粗规划.md`、`规划.md`、`独立窗口复刻规格.md`、`重构方案-核心UI复用.md`、
`session-manager-prototype.html` 等）。它们描述的是开发过程中的计划，与当前代码有多处不一致，
**不要照着它们改代码**——这正是这套文档改为"照代码写"的原因。
