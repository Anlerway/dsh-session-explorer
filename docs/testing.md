# 测试

没有构建步骤，没有打包器，没有任何东西对 `lib/client.js` 做类型检查。所以测试是唯一的安全网，
它的形状也就跟着这个事实长：**纯规则用断言钉死，UI 用真实渲染跑一遍**。

```bash
npm test                 # node --test test/*.test.mjs
npm run test:render      # node test/render-smoke.mjs
```

单个文件：`node --test test/tree.test.mjs`。

测试全部用 `node:test` + `node:assert`，没有第三方测试框架、没有 DOM 实现依赖——
`render-smoke` 自带一个极小的假 document。

## 1. 三十一个测试文件，各自钉住什么

| 文件 | 行数 | 钉住的东西 |
|---|---|---|
| `test/tree.test.mjs` | 545 | 树投影的规则 R1–R5：嵌套、计数、降级、环、`sessionHome` |
| `test/tree-mirror.test.mjs` | 160 | 客户端只持有**遍历**、不持有**规则**——同一问题在两处必须同答案 |
| `test/sessions.test.mjs` | 229 | 合并视图：一个会话"是什么"的唯一判定处 |
| `test/store.test.mjs` | 405 | 侧车存储、原子写、revision、损坏隔离，以及改它的两个规则模块 |
| `test/revision.test.mjs` | 183 | 乐观锁的两端：侧车拒绝过期写，HTTP 层把 409 送到客户端 |
| `test/shortcuts.test.mjs` | 159 | 快捷方式永不移动目标；主题 store 的往返 |
| `test/theme.test.mjs` | 104 | 主题 store 只交出窗口用的 token，且拒绝注入 |
| `test/theme-report.test.mjs` | 132 | 面板**上报**的那一半：DSH 把调色板声明在 `body` 上、值是 `var()` 引用 |
| `test/bridge.test.mjs` | 143 | 总线的边界：容量、30 秒时效、游标、坏订阅者 |
| `test/settings.test.mjs` | 234 | 设置文档的默认值、合并、归一化 |
| `test/settings-page.test.mjs` | 576 | 设置页真实渲染：打开方式、「关于」组、危险操作组（DELETE 才亮红按钮）、数据目录、写请求的 body |
| `test/session-state.test.mjs` | 100 | DSH 自己的界面读的那一个布尔集合 |
| `test/subagents.test.mjs` | 80 | 子智能体绑定四问；fork 带 `parentSession` 但是独立会话 |
| `test/trash.test.mjs` | 425 | 回收站：删除、恢复阶梯、清空、对账 |
| `test/move.test.mjs` | 510 | 跨 workspace 移动/复制的三件事一个事务 |
| `test/datadir.test.mjs` | 364 | 数据目录迁移：预检、七步、回滚、`.location` |
| `test/component.test.mjs` | 369 | 组件状态机：单飞锁、复用、校验、pending 清扫 |
| `test/export.test.mjs` | 154 | 会话日志 → Markdown / JSONL |
| `test/detached-window.test.mjs` | 422 | 独立窗口的页面、路由、以及冒充 DSH 的 shim |
| `test/client-launch.test.mjs` | 595 | 两个入口对着 stub 宿主跑；两条"线上才炸"的路径 |
| `test/row-rename.test.mjs` | 185 | 列表行必须打开自己的重命名编辑器，而不是别人的 |
| `test/row-rail.test.mjs` | 169 | 子会话引导线的几何：必须落在上面那个折叠箭头的中心（深度 0 与非 0 是两条式子） |
| `test/list-containers.test.mjs` | 151 | 列表里哪些容器行该出现：搜索放宽到整棵树，筛选变成"含命中"的结果视图 |
| `test/filter-dialog.test.mjs` | 115 | 筛选对话框的两个出口：重置还要按应用，取消是一步；没东西可取消时它不存在 |
| `test/heads.test.mjs` | 109 | 会话 header 扫描：换过格式版本的日志仍找得到、同 id 只出一份、无日志目录跳过 |
| `test/logfacts.test.mjs` | 168 | 空白会话 / 已中断：读日志两端的两个事实，以及只读头尾时的窗口边界 |
| `test/annotations.test.mjs` | 32 | 注解 id 守卫：`__proto__` / `constructor` / `prototype` 不能变成幻影条目 |
| `test/reveal.test.mjs` | 237 | reveal 白名单：只开自己列出来的路径（UNC 路径是凭据泄漏，不是便利） |
| `test/update.test.mjs` | 135 | 更新检查：数字段比较、release 解析、5 分钟缓存、失败码而不是假"已是最新" |
| `test/about.test.mjs` | 236 | 链接白名单与降级链，以及缓存清理只清自己的（quarantine 与会话不动，组件在装就跳过） |
| `test/reset.test.mjs` | 208 | 清除数据：一个字都没动之前先验 `DELETE`、四份侧车与回收站本体一起删、组件与数据目录本身留下、迁移路径写回 |
| `test/render-smoke.mjs` | 916 | 每个组件真实渲染一次（不是 `node --test` 的一部分） |

## 2. 为什么是这些

**规则和 IO 分开测。** `lib/domain/*` 全是纯函数，可以脱离内核和文件系统断言；
`lib/host/*` 才碰磁盘，用临时目录。`test/tree.test.mjs` 的头注释说得很直接：
树投影是 P1 里唯一"编码规则而不是 IO"的部分，所以它是唯一值得用断言钉死的部分。

**"三份规则"是被测试记住的教训。** `test/tree-mirror.test.mjs` 存在的原因是曾经有三份
"节点能去哪"的规则（`lib/domain/tree.js`、`lib/client.js`、已删除的静态壳），它们会漂移。
现在客户端只允许持有遍历（子树、父链），任何决策表都必须来自 host 算好的字段。

**线上才炸的东西单独钉。** `test/client-launch.test.mjs` 的头注释写明：这里钉的两件事
都是"在现场炸的，不是在测试里炸的"。比如独立弹窗模式下双击窗口里的会话——`bridgeActions`
为 `null` 时请求会静默消失，因为面板根本没挂载。这类 bug 只有对着 stub 宿主跑一遍入口才会露出来。

**UI 也要真渲染。** `render-smoke.mjs` 对每个组件渲染一次，用假的 hooks 返回值。
`test/row-rename.test.mjs` 补的正是它漏掉的一类：渲染一次看不出"点第二行却打开了第一行的
编辑器"这种交互错误。

## 3. 测试怎么隔离真实数据

- 一律用临时目录，通过 `DSH_SE_DATA_DIR` 或直接把 `paths` 传进 `openDocuments()`；
- 组件的测试用 `mirrorOverride` / `pinnedOverride` 之类注入，不会真的去下 150 MB；
- `render-smoke.mjs` 自带假 document，不依赖 jsdom。

## 4. 提交前

```bash
npm test && npm run test:render
```

两条都过才算过。`render-smoke` 不在 `npm test` 里，因为它比断言慢得多，而它检查的是
"渲染不抛异常"这一件事。
