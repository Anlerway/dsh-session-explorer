# 数据目录

插件自己的全部状态都落在一个目录里。这个目录**不是** `~/.dsh` 的子目录，而是它的兄弟：

```
C:\Users\<user>\.dsh                    ← DSH 自己的
C:\Users\<user>\.dsh-session-explorer   ← 本插件的
```

两个理由（`lib/paths.js:1-26`）：

1. 回收站里装的是**整个会话目录**，几百 MB。塞进 `~/.dsh` 会让备份、迁移、清理的归属变得模糊。
2. 一个环境变量覆盖让自测指向一次性目录，测试永远碰不到真实数据。

## 1. 目录内容

```
<dataDir>/
├── tree.v1.json          文件夹、放置、workspace 顺序、快捷方式、置顶
├── annotations.v1.json   标签、备注、收藏/待办标记、共享标签库
├── settings.v1.json      跨浏览器的偏好（布局在 localStorage）
├── .location             迁移后留下的指针（只有 copy 模式会留）
├── .tmp/                 原子写的临时文件，启动时只清 `*.tmp`
├── quarantine/           读不出来的文档原件（`<name>.corrupt-<ts>.json`）
├── trash/
│   ├── index.v1.json     回收站索引
│   └── <trashId>/        被删会话的 payload（整个会话目录）
├── component/            可选的 Electron 运行时（见 component.md）
└── detached/
    ├── window.json       独立窗口的几何与控制端口
    └── chromium/<hash>/  helper 专用 Chromium profile
```

`detached/chromium/<hash>` 的 `<hash>` 是 `sha256(dataDir)` 的前 16 位十六进制
（`lib/detached/launcher.js:40`）：必须给 helper 一个专属的 `--user-data-dir`，
和主应用共用 profile 会让两边的 Chromium 状态互相踩。

**侧车只存 DSH 不知道的东西。** 标题、cwd、时间戳、回合数、归档集、置顶集每次请求都从 DSH 读，
侧车删掉也不会丢会话——这是 `lib/store/documents.js:1-17` 写明的设计约束（源文档 S8）。

## 2. 定位顺序（三级回退）

`resolveDataDir()`（`lib/paths.js:293`）按顺序：

| 优先级 | 来源 | 场景 |
|---|---|---|
| 1 | `DSH_SE_DATA_DIR` | 测试、显式覆盖 |
| 2 | `<默认>/settings.v1.json` 的 `dataDir.current` | 一次已完成的迁移 |
| 3 | `<默认>` 目录本身 | 首次运行 |

`<默认>` 里的 `.location` 指针会被跟随（最多 8 跳，防止手改出的环卡住启动）。
这就是 `copy` 模式迁移后旧树还在磁盘上、下次启动不会读到旧副本的原因。

`DSH_SE_DATA_DIR` 是**校验过的**：解析结果若是文件系统根（`/`、`C:\`）、`~/.dsh` 本身或其内部，
或者反过来**包含** `~/.dsh`（家目录就是最常见的误填），都忽略并警告，回落默认值。
理由写在 `lib/paths.js:isUsableDataDir`：清空回收站会递归删掉数据目录下的 payload，
一个能包含 DSH 数据的数据目录会把"清空回收站"变成"删掉 DSH"。

同一条规则用在四个入口上：`DSH_SE_DATA_DIR`、已记录的 `dataDir.current`（`settings.v1.json`
是磁盘上的普通 JSON，手改过的值不能直接信）、`POST /datadir/migrate` 的 body、以及迁移目标目录。

## 3. 四份侧车文档

`lib/store/documents.js:29` 的 `openDocuments()` 一次打开四份。每份的初始形状：

| 文件 | 初始形状 | 说明 |
|---|---|---|
| `tree.v1.json` | `{ folders, placement, workspaceOrder, shortcuts, pins, sessionPlacement }` | `placement` 是 workspace 的显式顺序；`sessionPlacement` 是会话的**显示**归属覆盖 |
| `annotations.v1.json` | `{ sessions: {}, tags: [] }` | `tags` 是共享标签库；`sessions[id]` 是单条注解 |
| `settings.v1.json` | `defaultSettings()` | 形状的唯一出处是 `lib/domain/settings.js:74` |
| `trash/index.v1.json` | `{ entries: {} }` | 见第 5 节 |

`settings.v1.json` 的完整形状：

```jsonc
{
  "shell": {
    "open":   { "mode": "panel" },                    // panel | detached
    "modal":  { "sizing": "fixed",                    // fixed | percent
                "size": "md",                         // sm | md | lg | xl
                "percent": "p70",                     // p50 | p70 | p85 | p100
                "dim": 0,                             // 0 – 0.8，默认无遮罩
                "closeOnBackdrop": true },
    "window": { "alwaysOnTop": false, "bounds": null } // 独立窗口记住的几何
  },
  "list": { "autoCollapse": false, "showArchived": true },
  "dataDir": { "current": null }
}
```

三条硬约束写在这个文件里：`dim` 默认 0 且上限 `MAX_DIM = 0.8`（面板在壁纸上要看得清）；
归档是视觉降权而不是隐藏，所以 `showArchived` 默认 `true`；
默认打开方式是浮窗，因为它不会失败——独立窗口依赖可能没装的组件。

`mergeSettings()` 只认已知键，未知键在归一化时被丢掉，而不是落盘等下个版本困惑。

## 4. 原子写与乐观锁

`lib/store/sidecar.js` 保证两件事：

- **不撕裂**：写临时文件（同卷的 `.tmp/`）→ flush → `rename` 覆盖目标。崩溃只会留下旧文件，
  不会留下半个 JSON。
- **不互相覆盖**：每次成功写入 `revision += 1`。客户端带着它看到的 revision 来，
  不匹配就 `revision-conflict`，而不是静默覆盖别人刚做的改动。

读损坏（不是 JSON 对象）时文件被改名成 `<name>.corrupt-<ts>.json` 移进 `quarantine/`，
然后以空文档重建——**不会**因为一个坏文件让插件起不来。
放在 `quarantine/` 而不是 `.tmp/`：`.tmp/` 每次启动都会清空，那份"留着给人手工恢复"的原件
会被自己删掉。启动时只清 `.tmp/` 下的 `*.tmp`（原子写的残留），`*.corrupt-*` 会被搬进
`quarantine/`。

## 5. 回收站

`lib/host/trash.js` 做的就是文件管理器做的事：

| 操作 | 动作 |
|---|---|
| 删除 | `rename <sessions>/<project>/<session>/` → `<dataDir>/trash/<trashId>/` |
| 恢复 | rename 回去 |
| 清空 | `rm -rf` payload 目录 |

跨卷时 rename 退化成 copy-then-delete，其余流程不变。

**索引条目**（`lib/domain/trash.js:95`）：

```jsonc
{
  "sessionId": "01J…",
  "trashId": "k3f9ab12",
  "title": "…", "cwd": "…", "workspaceId": "…", "workspaceTitle": "…",
  "sizeBytes": 1234567, "createdAt": 1730000000000,
  "originalLogPath": "<sessions>/<project>/<session>/session.jsonl",
  "deletedAt": 1730000000000,
  "pending": true            // 只在写入过程中短暂存在
}
```

`title/cwd/workspaceId/…` 是**快照**而不是镜像：payload 已经不可读了，这几项描述的是它进回收站
那一刻的样子。

**崩溃安全**：索引条目在 payload 移动**之前**写入并标记 `pending`。两者之间崩溃只会留下
"pending 但 payload 还在原地"——可对账，不是丢会话。下次启动的 `reconcileTrash` 收尾：
payload 已经到位 → 升级为 ready；payload 从未离开 → 删掉这条记录。

**恢复落点**（`projectDirFor()`，`lib/host/trash.js:255`）是三级阶梯：

1. 记录里的原项目目录，不存在就重建；
2. 同一 workspace 下还有会话的目录（让恢复的会话落在邻居旁边）；
3. 任何一个活的项目目录。

第 3 级就是"未分组"能当安全落点的原因：workspace 成员关系存在 DSH 的 registry 里，
一个不再属于任何 workspace 的 id 自动出现在未分组。

清空回收站时，指向已删会话的快捷方式会一并删除——引用不能活得比目标久。

## 6. 迁移

`POST /datadir/migrate`（`lib/host/datadir.js:189`）按顺序做七件事，每一步都推进 `steps` 数组：

| # | 步骤 | 说明 |
|---|---|---|
| 1 | 预检 | 复用 `inspect` 的全部校验：绝对路径、非根、非当前目录、可写、目标不含另一套安装 |
| 2 | `api.migration` 上锁 | 期间所有非 GET 请求返回 `409 migration-in-progress` |
| 3 | `copied` | `cp` 递归复制（同卷 `move` 也用 `cp`：它保留时间戳、源缺失会失败） |
| 4 | `verified` | 校验目标可读、内容齐全 |
| 5 | `reopened` | 关闭并重开读端，指向新目录 |
| 6 | `recorded` | 把 `dataDir.current` 写进**新目录**的 `settings.v1.json` |
| 7 | `pointer` / `pruned` / `removed` | `copy` 模式在旧目录留 `.location` 指针并清空其余内容（`pruned`）；`move` 模式直接删旧目录（`removed`） |

任何一步失败都走同一个回滚（`lib/host/datadir.js:204` 的 `rollbackCopy`）：重开旧目录、失效缓存，
再**只删这次复制写进去的东西**——目标目录原本不存在就整个删掉，原本存在（空目录）就只删 `carry`
写过的那些顶层条目。回滚不会删用户自己放进去的文件。
**旧目录在成功之前从不被碰**，所以一次失败的迁移只损失那次复制。

`mode` 不是用户选的，是**同卷性**决定的：同卷 `move`，跨卷 `copy`。
`move` 是唯一会删旧目录的模式。

`datadir-not-empty` 有两个来源（`lib/host/datadir.js:146-155`）：

- `OCCUPANCY_MARKERS = ["tree.v1.json", "trash/index.v1.json"]` 在目标里出现，说明那里是另一套安装；
- 目标目录存在且**非空**。迁移是往目标里复制、失败时按 `carry` 写过的条目回滚，所以目标必须从空开始；
  否则要么两套数据混在一起，要么回滚时误删用户的文件。

## 7. 相关文件

| 文件 | 职责 |
|---|---|
| `lib/paths.js` | 目录解析、`.location` 跟随、`dataPaths()` 的路径表 |
| `lib/store/sidecar.js` | 原子写、revision、损坏隔离、`codedError` |
| `lib/store/documents.js` | 四份文档的初始形状与迁移函数 |
| `lib/domain/settings.js` | 设置形状的唯一出处、`mergeSettings`、`normalizeSettings` |
| `lib/host/datadir.js` | `describeDataDir` / `inspectDataDir` / `migrateDataDir` |
| `lib/host/trash.js` | 移动字节、维持索引、对账、恢复阶梯 |
