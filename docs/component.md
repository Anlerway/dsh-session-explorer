# 浏览器组件

独立弹窗需要一份 DSH 不会给的运行时：DSH 的桌面主进程禁掉了 `window.open`，也不把
`BrowserWindow` 暴露给插件。所以本插件自带一份**可选**的 Electron 运行时，由用户显式下载，
装在自己的目录里，带自己的固定校验和。不共享、不借用任何其它插件的东西。

四条设计规则（`lib/component/layout.js:20-30`），其余模块都靠它们成立：

1. **从不隐式下载。** 缺席是正常状态，主插件在没有组件时完全可用。
2. **`ready` 意味着"标记文件和可执行文件都在"。** 别的任何东西都无权宣称就绪。
3. **所有变更（install/cancel/remove）共用一把 promise 锁。** 两次点击不能交错，留下半个解压目录。
4. **失败的安装绝不删掉上一次能用的安装。** 新字节落在 staging，靠 rename 发布。

## 1. 装在哪

全部在插件数据目录下，所以一次数据目录迁移会把它一起搬走：

```
<dataDir>/component/
├── state.v1.json              生命周期记录
├── manifest.v1.json           装了什么、什么时候、从哪来
├── pending-cleanup.v1.json    卸不掉的路径，下次启动再扫
├── download/<asset>.part      可续传的下载体
├── download/<asset>.part.json { url, etag, received, totalBytes }
└── runtime-<stamp>/           一次安装一个**不可变**的运行时
    └── .complete-44.0.0       ← 标记：存在即 "ready"
```

**为什么运行时目录带版本戳。** 安装发布到一个全新的 `runtime-<stamp>` 并把 state 指过去，
而不是 rename 覆盖 `runtime/`。Windows 在目录里**任何**文件被打开时都会拒绝 rename（EPERM）
或删除（EBUSY）——Defender 的扫描器、搜索索引、还没退出的 helper 都算。覆盖固定路径因此会
随机失败且无法恢复，而换一个新名字总是成功，旧目录留给后面扫。**从不把东西 rename 走。**

staging 目录故意放在 `component/` **外面**（`<dataDir>/.component-staging`）：
半解压的树留在里面会让"删除组件"失败在那些残留文件上，而用户没法删掉一个被告知"就是一个目录"的东西。

## 2. 版本与校验

| 项 | 值 |
|---|---|
| `ELECTRON_VERSION` | `44.0.0` |
| 资产名 | `electron-v44.0.0-<platform>-<arch>.zip` |
| 校验 | `PINNED_SHA256`，六个平台/架构各一个，抄自 Electron 官方 `SHASUMS256.txt` |
| 下载体积 | 157 455 369 B（约 150 MB） |
| 磁盘占用 | 383 650 096 B（约 366 MB） |

哈希不匹配会在**解压之前**中止安装，所以被截断或被篡改的下载永远不会被执行。
没有固定哈希的平台直接 `component-download-failed`（`no pinned checksum for <asset>`），
而不是"跳过校验"。

## 3. 镜像

`MIRRORS`（`lib/component/layout.js:71`），按顺序尝试：

| id | 前缀 |
|---|---|
| `mirror` | `https://cdn.npmmirror.com/binaries/electron/v44.0.0/` |
| `backup` | `https://mirrors.huaweicloud.com/electron/44.0.0/` |
| `npmreg` | `https://registry.npmmirror.com/-/binary/electron/v44.0.0/` |
| `github` | `https://github.com/electron/electron/releases/download/v44.0.0/` |

三个独立的国内镜像排在 GitHub 前面，因为 GitHub 的 release 下载在国内经常 302 到一个会卡住的 CDN。
它们提供的都是**同一份**官方 zip，固定 SHA-256 仍然会校验，所以镜像换不掉字节。
`install` 传 `source: "github"` 时顺序反转（`lib/component/manager.js:414`）。

**续传只能续同一个镜像**（`lib/component/downloader.js:244`）：`.part.json` 里的 `url` 与当前
镜像不符时先删掉旧片段。另一个镜像的字节是另一条流，追加进去正是"续传出坏包"的成因。
镜像不支持 Range（对分段请求直接返回整个文件）时，清空重下一次。

下载用系统的 `curl` 子进程，`--progress` 由轮询 `.part` 的大小得到（`PROGRESS_INTERVAL_MS`），
而不是解析 curl 的输出。

**体积上限** 1 GiB（`MAX_ASSET_BYTES`，`lib/component/downloader.js:42`）：`content-length`
超限在写第一个字节前就拒（`component-download-too-large`），实际落盘超限同样拒；curl 侧还有
`--max-filesize` 兜底。正常的 Electron 包约 110 MB，一个数量级的余量足够，同时把"被劫持的镜像
先写满磁盘再被摘要拒掉"变成"直接拒掉"。

## 4. 状态机

`PHASES`（`lib/component/state.js:25`）：`absent` / `downloading` / `verifying` / `extracting` /
`ready` / `error`。未知 phase 降级成 `absent`，而不是渲染一个 UI 不认识的状态。

一次 `install` 的顺序（`lib/component/manager.js:380-520`）：

| # | 步骤 | 细节 |
|---|---|---|
| 0 | 单飞锁 | `run()` 里若已有操作在跑，直接 `component-busy`；不排队——点第二次的人想让第二下被忽略，而不是稍后执行 |
| 1 | 复用检查 | 磁盘上已有带 marker + binary 的完整运行时就直接 `ready`，`source: "reuse"`。卸载被拒后字节还在，让用户为还在硬盘上的 150 MB 再下一次是说不过去的 |
| 2 | 磁盘检查 | 需要 `downloadBytes × 2.2 + 500 MB` 空闲，不够就 `component-disk-full`（507） |
| 3 | `downloading` | 依次试镜像，`AbortController` + 1 小时超时（`INSTALL_TIMEOUT_MS`） |
| 4 | `verifying` | `verifyZip()` 比对固定 SHA-256 |
| 5 | `extracting` | 先清空 staging（上一次中断可能留着锁住的 bundle），再解压；解压后必须能找到可执行文件，否则 `component-extract-failed`。解压子进程接同一个 `AbortSignal`，超时/取消会 `SIGKILL` 它，而不是让 `tar` 在后台继续写 |
| 6 | 发布 | `publishRuntime()` 到 `runtime-<stamp>`，写 `manifest.v1.json`，删 `.part` 与 `.part.json` |
| 7 | 扫旧 | `sweepRuntimes()` 删旧运行时；删不掉的进 `pending-cleanup.v1.json` |
| 8 | `ready` | `receivedBytes: 0`，`source` 记录来源 |

取消（`component-cancelled`）回到 `absent` 且不留错误；其它失败进 `error` 并把消息写进 state。

**卸载前先关窗口，而且"关掉了"必须是真的**：`remove()` 调 `closeHelper()`（即
`api.detached.close()`），只有它返回 `true` 才继续（`lib/component/manager.js:549-552`）。
`close()` 的返回值因此是"现在确实没有在跑的 helper"：先发 `close` 消息，1.5 秒后还在就 `SIGTERM`，
再 0.5 秒后还在就 `SIGKILL`，最后用 `exitCode !== null` 判断（`lib/detached/launcher.js:318-345`）。
以前它无条件返回 `true`，于是一个不理会退出信号的窗口会让 `remove` 删掉它正在用的可执行文件。

## 5. 卸不掉的 111 KB

`resources/default_app.asar` 是每个官方 Electron zip 都带的 111 KB 应用包，本插件从不使用它
（helper 是用显式 `main.cjs` 启动的）。但一旦被加载过，Windows 会把这个句柄留到进程结束——
重试多少次都没用。

所以 `removeTree()` 是**尽力而为**的（`lib/component/install.js:220`）：

1. 先对 `EBUSY` / `EPERM` / `EACCES` / `ENOTEMPTY` 重试几次——Defender 扫描、索引器、没退干净的
   helper 都属于"暂时"；
2. 剩下的整棵树照删，只留下那个已知无用的 bundle，并告诉调用者哪些路径活了下来。

为一个 111 KB 的文件让用户重下 150 MB 不值得。留下的路径写进 `pending-cleanup.v1.json`，
**下次启动**（持有句柄的进程正是启动的这个）再扫一遍，仍删不掉的留到再下次。
`status()` 里的 `pendingCleanup` 就是给设置页解释"磁盘占用为什么对不上"用的。

这份 JSON 是纯磁盘文件，可以被改坏或手改，而扫描会 `removeTree` 递归删除。所以读取时只接受
`component/` 之内的路径（`lib/component/manager.js` 的 `readPending` + `lib/paths.js` 的
`isInside`），越界条目直接丢弃——坏文件不能让启动清理变成删任意目录。

## 6. 窗口怎么起来

`lib/detached/` 三件：

| 文件 | 职责 |
|---|---|
| `launcher.js` | 在 DSH 主进程这一侧 spawn / 聚焦 / 关闭窗口，持有 profile 键 |
| `main.cjs` | Electron 侧的窗口本体（`.cjs` 后缀是刻意的：包里 `"type": "module"`，`.js` 会被当 ESM 加载，`require("electron")` 直接抛 `require is not defined in ES module scope`） |
| `preload.cjs` | 预加载：把窗口需要的最小 API 注入页面 |

`component.binary` 解析的是**已安装**那个带戳的目录；`component.paths.binary` 是没戳的默认值，
一次安装发布之后那个路径根本不存在。把默认值交给 launcher 会 spawn 一个不存在的路径，
而失败表现为"窗口永远打不开"——子进程在能报告任何东西之前就退出了。

窗口通过 `onEvent` 把 `hello` / `closed` 报告给 host，host 再转成总线上的 `window-open` /
`window-closed`（`lib/index.js:157-158`）。窗口的 OS 层面知识只有那个进程有，走同一条总线意味着
面板不需要第二条通道。

## 7. 相关文件

| 文件 | 职责 |
|---|---|
| `lib/component/layout.js` | 版本、固定哈希、镜像、路径表、体积常量 |
| `lib/component/state.js` | phase 集合、state 的读写与归一化、进度写入节流 |
| `lib/component/downloader.js` | curl 下载、续传、镜像切换、进度轮询 |
| `lib/component/install.js` | `verifyZip` / `extractZip` / `publishRuntime` / `removeTree` / `freeBytes` |
| `lib/component/manager.js` | 单飞状态机、`status()`、`install` / `cancel` / `remove` / `retry`、pending 清扫 |
| `lib/detached/launcher.js` | spawn / 聚焦 / 关闭 |
| `lib/detached/main.cjs` | Electron 窗口 |
| `lib/detached/preload.cjs` | 预加载注入 |
