# dsh-session-explorer（会话资源管理器）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的资源管理器式会话浏览器：
虚拟文件夹、标签、备注、回收站、多 workspace 浏览——**从不改动 `~/.dsh` 的物理布局**。

> 状态：两个面都已功能完整。会话可重命名、归档、置顶、分叉、移动、打标签、写备注、筛选、
> 删除到回收站、导出；文件夹可嵌套可拖拽；删除会把 payload 移进真正的回收站，能还原也能清空；
> 跨 workspace 的剪切/复制/粘贴会换掉 artifact 的归属并同步 registry 记账。
> workspace、文件夹、会话共用一条置顶带；收藏和待办装的是快捷方式而不是副本；
> 面板有标签页、可调三栏、行内重命名和命令栏。设置页结尾两组是「关于」（版本号、检查更新、
> 清理缓存、Star 与反馈入口）和「危险操作」：清除数据——不可逆，要照字打一遍 DELETE。

## 两个面，一份 UI

| 面 | 是什么 |
|---|---|
| **浮窗** | 从 DSH 侧栏打开的面板，`lib/client.js`，渲染进 DSH 页面的浮层 |
| **独立窗口** | 同一份 UI 在独立的无边框 OS 窗口里：页面**原样加载** `lib/client.js`，所以只有一份实现。需要浏览器组件（可选，150 MB，显式下载） |

导出会话走 `GET /export`，输出 Markdown 或 JSONL。只有文本：附件和二进制工具输出会被描述，
不会被内联。

## 结构

零运行时依赖。一个 DSH 插件是 bundles 里的一行，两半：

| 半 | 入口 | 谁加载 |
|---|---|---|
| Host | `lib/index.js` | Cordis，应用启动时加载一次 |
| Client | `lib/client.js` | 渲染进程里的 `window.__ModuleLoader__.load`，无构建步骤 |

Host 在 DSH 的 web 服务器上注册一个 `/session-explorer/api` 前缀路由；Client 注册
`sidebar.footer.action` 等 5 个槽位，并把面板 portal 到 `<body>` 上的固定层。

```
lib/
  index.js            路由表（62 条）、分发、错误映射
  client.js           整个面板与设置页（单文件、无构建）
  http.js             信封与请求体解析
  constants.js        API 前缀、插件 id、固定节点 id
  capabilities.js     对宿主服务的防御式探测
  paths.js            数据目录解析（env → settings → .location）
  domain/             纯规则：tree-rules / tree / folders / shortcuts / sessions /
                      annotations / settings / trash / export / session-state
  sources/            读管道：heads（zstd 扫描）、projcache、reader、artifact、workspaces
  store/              sidecar（原子写 + revision）、documents（四份文档）
  host/               actions、trash、move、datadir、bridge、theme、
                      update（更新检查）、open-link（链接白名单）、maintenance（缓存清理）、
                      reset（清除数据，唯一不可逆的操作）
  component/          浏览器组件：layout、state、downloader、install、manager
  detached/           Electron helper：launcher、main.cjs、preload.cjs
assets/detached/      独立窗口的页面：index.html、window.css、shim.js（不自带 UI）
assets/vendor/        自带 React 18.3.1 UMD 构建
test/                 31 个测试文件 + render-smoke
docs/                 开发文档（见下）
```

## 安装（本地、树外）

```bash
# 1. 让包在 desktop profile 里可解析
cd ~/.dsh/profiles/desktop
#    package.json -> dependencies: { "dsh-session-explorer": "link:<绝对路径>" }
#    package.json -> dsh.profile.bundles: [... "dsh-session-explorer" ...]
#    然后建好 node_modules 里的条目（Windows 上是 junction）

# 2. 重启 DSH 应用
```

**Host 侧**改动（`lib/index.js`、路由、store）必须完整重启应用才生效：Cordis 只加载一次，
desktop profile 是 Electron 应用组装出来的，`dsh profile` 也重建不了它。
**Client 侧**改动（`lib/client.js`）由 client-plugin HMR 接收器热更新，或刷新页面。

## 数据

全部侧车状态在 `~/.dsh-session-explorer/`——`~/.dsh` 的**兄弟**，不是子目录，所以卸载插件
就是删一个目录。定位顺序是 `DSH_SE_DATA_DIR` → 默认位置 `settings.v1.json` 里的
`dataDir.current` → `.location` 指针，详见 [docs/data-directory.md](docs/data-directory.md)。

## 功能要点

| 能力 | 说明 |
|---|---|
| 六个固定入口 | 根目录 / 所有会话 / 未分组 / 回收站 / 待办 / 收藏，每个都有实时计数 |
| 虚拟放置 | 会话可"放进"任意 workspace 而不搬字节（DSH 从 header 的 `cwd` 推导归属，改它就要搬 payload） |
| 快捷方式 | 引用，永不移动目标；目标没了引用才消失 |
| 子智能体绑定 | 子智能体跟随父会话：不能单独删除/剪切/复制/收藏/待办/归档/重命名/分叉，父会话删除时整条委派链一起走；fork 不算子智能体 |
| 回收站 | 真移动会话目录，可还原、可清空，崩溃安全（索引先写、对账后收尾） |
| 导出 | Markdown / JSONL，来自详情面板或行菜单 |
| 搜索 | 只匹配标题、备注、标签——插件自己拥有的东西；不读会话日志 |
| 会话状态 | 运行中（DSH 里活着）/ 已中断（日志停在一轮中间）/ 空闲，三者互斥；已中断的会话可以删除 |
| 空会话 | 从未开始过一轮对话的会话被标为空白，默认从列表里过滤掉（设置里可关） |
| 定位 | 会话详情面板与行菜单都有「复制文件路径」：由 Host 找出日志路径（含回收站里的），写进剪贴板；不弹窗口，跨机器也能用 |
| 主题 | 不硬编码颜色，全部用 `--dsw-alias-*`；独立窗口由面板把 14 个 token 报给 Host 再取用 |
| 设置 | 浮窗/独立弹窗、尺寸、遮罩、会话界面按钮样式（自动/仅图标）、自动折叠、显示已归档、折叠子智能体（开关）、过滤空会话（开关）、数据目录迁移、组件管理、关于（版本、检查更新、清理缓存、Star、反馈）、危险操作（清除数据，不可逆，需键入 DELETE） |

## 开发文档

| 文档 | 讲什么 |
|---|---|
| [docs/README.md](docs/README.md) | 文档索引 + 三条最容易被违反的约定 |
| [docs/architecture.md](docs/architecture.md) | 两半结构、一次请求怎么走完、读管道与缓存 |
| [docs/api.md](docs/api.md) | 62 条路由、信封、错误码表、乐观锁 |
| [docs/data-directory.md](docs/data-directory.md) | 数据目录、四份侧车、回收站、迁移 |
| [docs/tree-and-placement.md](docs/tree-and-placement.md) | 节点种类、R1–R5、计数、快捷方式 |
| [docs/bridge-and-theme.md](docs/bridge-and-theme.md) | 命令总线、SSE、主题同步 |
| [docs/component.md](docs/component.md) | 浏览器组件的状态机与安装流程 |
| [docs/testing.md](docs/testing.md) | 三十一个测试文件各钉住什么 |

## 测试

```bash
npm test              # node --test test/*.test.mjs
npm run test:render   # 面板对着 stub React 真实渲染一遍
```

测试跑在 `mkdtemp` 出来的临时目录和手写的 `paths` 对象上，从不碰 `~/.dsh` 和真实侧车。

## 许可

MIT。
