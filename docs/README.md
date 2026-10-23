# 开发文档

这套文档是**照代码写的**，不是照设计稿写的。每一条规则都标了它的出处（文件 + 行号），
所以当代码变了，能一眼看出哪一段需要跟着改。

## 读的顺序

| 文档 | 讲什么 | 什么时候读 |
|---|---|---|
| [architecture.md](architecture.md) | 两半结构、一次请求怎么走完、读管道与缓存、硬约束 | 第一次进这个仓库 |
| [api.md](api.md) | 62 条 HTTP 路由、信封、错误码表、乐观锁 | 改 host 或写客户端调用 |
| [data-directory.md](data-directory.md) | 数据目录布局、四份侧车、原子写、回收站、迁移 | 改存储、调试"数据不见了" |
| [tree-and-placement.md](tree-and-placement.md) | 节点种类、R1–R5、计数、虚拟放置、快捷方式 | 改左侧树或拖拽 |
| [bridge-and-theme.md](bridge-and-theme.md) | 面板 ↔ 窗口的命令总线、SSE、主题同步 | 改独立窗口或配色 |
| [component.md](component.md) | 浏览器组件：状态机、镜像、校验、发布、清扫 | 改安装流程 |
| [testing.md](testing.md) | 三十二个测试文件各钉住什么、怎么跑 | 提交之前 |

## 三条最容易被违反的约定

1. **不重构 `sessions/` 的物理布局。** 移动会话是唯一改文件的操作，走
   `lib/host/move.js` 的三件事一个事务；"换个分组"用侧车覆盖（`sessionPlacement`），不动字节。
2. **规则只有一份。** `lib/domain/tree-rules.js` 拥有全部树规则；`lib/client.js` 只读 host 算好的
   字段，不持有任何决策表。历史上三份规则漂移过一次，`test/tree-mirror.test.mjs` 就是为那次写的。
3. **侧车只存 DSH 不知道的东西。** 标题、cwd、归档集、置顶集每次从 DSH 读；侧车删掉也不会丢会话。

## 源码地图

```
lib/
  index.js            路由表（62 条）、分发、错误映射、启动装配
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
assets/vendor/        自带 React 18.3.1 UMD 构建（无构建步骤的前提）
test/                 32 个测试文件 + render-smoke
```

`client.js` 是**刻意**的单文件：没有构建步骤是这个插件能在 DSH 的模块加载器里直接跑起来的前提。
不要为了"结构好看"拆它——拆了就要引入打包器，而打包器会带来一个必须维护的构建产物。
