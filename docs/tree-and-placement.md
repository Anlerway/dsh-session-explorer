# 树与放置

左侧那棵树不是 DSH 的树。DSH 只认识 **workspace** 和 **session** 两种东西；这棵树是它们加上
用户自己造的节点（文件夹、快捷方式）的一个投影，**由 host 每次请求重建**，只有用户造的部分落盘。

规则集中在 `lib/domain/tree-rules.js`，`lib/client.js` 里**没有任何决策表**——它只读节点上算好的
字段（`accepts` / `scope` / `hasWorkspace`）和两条形状（子树、父链）。三处各写一份规则是 bug
生成器，所以规则只有一份。

## 1. 节点种类

`NODE_KINDS`（`lib/domain/tree-rules.js:36`）：

| kind | id | 能装目录 | 能装会话 | 说明 |
|---|---|---|---|---|
| `root` | `f-root` | ✅ | ❌ | 只装目录；徽章是活跃会话总数 |
| `all` | `f-all` | ❌ | 视图 | 所有活跃会话的平铺视图 |
| `ungrouped` | `f-ungrouped` | ✅ | ✅ | 真容器：没有 workspace 的会话的家 |
| `todos` | `f-todos` | ❌ | 快捷方式 | 引用容器 |
| `favorites` | `f-favorites` | ❌ | 快捷方式 | 引用容器 |
| `trash` | `f-trash` | ❌ | 回收站 | 根节点之外唯一的分支 |
| `folder` | `d-…` | ✅ | ❌ | 用户建的目录 |
| `workspace` | `w-…` | ✅ | ✅ | DSH workspace 的投影 |
| `shortcut` | `s-…` | ❌ | 视 target 而定 | 引用，永不移动目标 |

`roots` 是 `["f-root", "f-trash"]`——回收站故意不在根下面，它是另一个分支。

## 2. 五条承重规则

每条都在 `test/tree.test.mjs` 里有覆盖。

| 规则 | 内容 | 代码 |
|---|---|---|
| **R1** | workspace 永不嵌进另一个 workspace；文件夹可以夹在根与 workspace 之间，但夹不到两个 workspace 之间 | `canMove()` 用祖先链判断"里面"，因为经过文件夹仍然算嵌套 |
| **R2** | 会话的容器是它的 workspace 节点；没有 workspace 就是 `f-ungrouped` | `placementOfNode()` |
| **R3** | 会话只在一个容器里被数一次 | `sessionsOfNode()` 同时产出列表和徽章数字 |
| **R4** | 收藏/待办装的是快捷方式（引用）而不是会话；引用不改变总数，根目录自己也不装会话 | `counts[...]` 的赋值 |
| **R5** | 父节点消失的**目录**降级到根，而不是让子树变孤儿；环永远构造不出来 | `folderParent()` |

R5 的降级是**纯函数**：`folderParent()` 只依赖 `folders` 表，与迭代顺序无关。
父节点缺失、父节点不是文件夹、父链成环，三种情况一律回落到 `f-root`。

降级只适用于文件夹和 workspace。**引用不降级**：`f-root` 装的是目录（`canHoldShortcuts(f-root)`
为假），所以把一条父节点已消失的快捷方式挂到根上，只会得到一行没有任何分支渲染、也没有任何手势
能删掉的行（`lib/domain/tree.js:278-296`）。这种情况直接不建这一行；容器消失时 host 会先把里面的
引用上提（删文件夹 → 父节点，父节点是根则进 `f-收藏`；删 workspace → `f-收藏`）。

## 3. 徽章数字 == 列表行数

`buildTree()` 最后那段计数不是"另一次过滤的模仿"，而是直接调用 `sessionsOfNode()` 的同一个函数，
再加上子树里的引用行：

```js
counts[id] = sessionsOfNode(id, view, treeLike, { trashedIds: trashed }).length + shortcutRowsWithin(id);
```

**一行 = 一个会话，或一条指向会话的引用。** 所以徽章不可能和它下面那几行对不上——包括一个只装了一条
引用的文件夹（以前它显示 0，展开却有 1 行）。四个例外各自有意义：

- `f-root` 的列表是目录（空），但数字是活跃会话总数——那正是它旁边那个数的意思；
- `f-favorites` / `f-todos` = 带标记的会话数 + 指向会话的快捷方式行数；
- `f-trash` = 回收站条目数；
- 快捷方式：指向会话的是 1 行；指向文件夹/workspace 的显示目标的大小，否则那个数字会看起来像 0。

在这之前还有一道前置：**看不见的会话不计数**。`buildTree()` 先把 `sessions` 按 `listSettings.hideBlank`
过一遍，计数用的是"列表真正会画"的那个集合（`lib/domain/tree.js:149`）：

```js
const shown = listSettings?.hideBlank === false ? live : live.filter((session) => session.blank !== true);
```

过滤空会话是视图设置，不是删除——关掉它，数字立刻回来。之所以修在 host 而不是 client：徽章比行多，
就是 R2/R3 禁止的那种"两处各算一次"，只不过差了一步。

## 4. 会话放置（`sessionPlacement`）

**核心矛盾**：DSH 从 header 的 `cwd` 推导会话属于哪个 workspace。要改变这个归属，唯一物理手段
是搬目录——而"不重构 `sessions/`"是本插件的第一条硬约束。

于是有了这层覆盖：`sessionPlacement[sessionId] = 节点 id`，只影响**分组**，不动一个字节。

```
解析顺序（placementOfNode）
  sessionPlacement[id] 存在且节点还在  → 用它
  会话有 workspaceId                    → w-<workspaceId>
  会话没有 workspaceId                  → f-ungrouped
  有 workspaceId 但那个 workspace 没了   → null（只出现在"所有会话"里）
```

`buildTree()` 把结果一次性算进 `sessionHome`，随每个会话下发，客户端不重放这个判断（R2）。
`homeOverride` 标记"这是虚拟放置而不是 DSH 自己的归属"。

**跨 workspace 拖会话**因此有两条路：真的搬（`POST /move`，改文件）或只改分组
（`POST /sessions/placement`，改侧车）。前者是移动，后者是重命名一个视图。

## 5. 快捷方式

`lib/domain/shortcuts.js`。一条快捷方式是**自己的节点**，`targetId` 永远在目标自己的 id 空间里：
文件夹 `d-…`、workspace 去掉 `w-` 前缀、会话原样。

三条约束：

1. 快捷方式加在真容器**之后**，所以它永远不会遮蔽一个真 id；
2. 它不给父节点贡献会话数（R4）——同一个会话在它家出现一次，在每个引用处各出现一次；
3. 引用不能活得比目标久。指向会话的引用在会话进回收站时**保留**（会话还能回来），
   一旦 payload 真的没了（清空回收站，或用户手工删了目录），这条引用就消失——
   否则用户会得到一行点了没反应、又不允许删的行。host 在 purge 时顺手清侧车，
   保证下次重建不会把它带回来。同样地，指向文件夹/workspace 的引用在目标不存在时也不建行
   （`lib/domain/tree.js:289-291`）；而引用的**容器**不存在时也不建行，见 §2 的 R5 说明。

标签不在快捷方式上：`name` 留空，客户端从目标解析，所以目标改名后引用自动跟上。

## 6. 置顶

DSH 置顶的是**会话**；这里还有容器置顶（文件夹、workspace），存在树的侧车里
（`pins[id] = 时间戳`），按时间倒序。两块合起来是视觉上的同一条置顶带，但它们来自两套存储，
所以 `/bootstrap` 里 `pinnedSessionIds` 和 `tree.pinnedNodes` 是分开的两个字段。

## 7. 移动的合法目标

`acceptsOf(nodeId, tree)` 返回四个布尔，客户端直接照它涂色：

| 字段 | 含义 |
|---|---|
| `accepts.folder` | 目录（文件夹/workspace）能不能落在这里 |
| `accepts.workspace` | 带着 workspace 的目录能不能落在这里（R1 从目标侧问） |
| `accepts.session` | 会话能不能放在这里（只有 workspace 和 `f-ungrouped`） |
| `accepts.shortcut` | 引用能不能丢进来（`canHoldShortcuts`） |

`canMove()` 只用两条规则：不能进自己的子树（会整支掉出树）、workspace 不能套 workspace。
其余组合全部自由：文件夹进文件夹、文件夹进 workspace、workspace 进文件夹、workspace 在根下。

两条规则问的都是**结构**（`subtreeOf(id, tree, { followReferences: false })`）：引用不是父边，
所以"装了一条指向 workspace W 的引用的文件夹"不算"带着 W"，把这条引用拖进 W 也不是环。
列表那一侧仍然跟随引用（默认 `followReferences: true`），因为引用的意义就是显示目标的行。

固定节点不可移动；客户端会先把非法目标变灰，但 host 一定会**再校验一次**——一个过期的客户端
不应该能写出非法的树。

### 7.1 写进 draft 之前的第二次校验

`canMove()` 看的是请求到达时读到的树。两个移动**同时**到达时，它们看到的是同一棵"之前"的树：
A 进 B 通过，B 进 A 也通过，写下去就是一个环（渲染时整支降级到根）。所以 `moveNode()`
（`lib/domain/folders.js`）在 mutate 回调里再问一次 `isInsideDraft(draft, nodeId, parentId)`，
看到的是"第二次移动即将扩展的那份 draft"，于是第二次被拒（`cannot move … inside itself`）。
`sidecar.mutate` 的串行锁让这次检查是原子的。

### 7.2 名字与顺序

同一父节点下不允许重名（`assertUniqueName`，比较前 `trim` + 小写；不同父节点可以同名），
新建、重命名、移动三条路径都会查。`order` 也不再取 `siblings.length`——删掉中间一个之后，
`length` 会把最后一个兄弟的编号再发一次，两行同号，用户排好的次序变成平局。
现在取"当前最大 `order` + 1"（`nextOrder`），编号单调。

## 8. 相关文件

| 文件 | 职责 |
|---|---|
| `lib/domain/tree.js` | `buildTree()`：造节点、算 `sessionHome`、算徽章、排序 |
| `lib/domain/tree-rules.js` | 全部规则：`placementOfNode` / `sessionsOfNode` / `acceptsOf` / `canMove` / `decorateTree` |
| `lib/domain/shortcuts.js` | 快捷方式的规范化、目标解析、`canHoldShortcuts`、`dropShortcutsTo` |
| `lib/domain/folders.js` | 文件夹命名、新建、上提删除 |
| `lib/domain/sessions.js` | 合并视图、`home` / `homeOverride` 的推导 |
