# 桥与主题

面板跑在 DSH 的 document 里，独立窗口是**另一个进程里的另一个 document**。两者渲染的是同一份
`lib/client.js`，但它们彼此看不见：没有共享的 DOM、没有共享的 CSS、没有共享的事件总线。
这两件事——导航命令和配色——就靠下面这套很窄的通道传过去。

## 1. 命令总线

`lib/host/bridge.js:40` 的 `createBridge()` 是一个**进程内的环形缓冲**，不是消息队列：

| 参数 | 值 | 理由 |
|---|---|---|
| `capacity` | 64 条 | 面板关着时攒下的命令，重连时要能补发 |
| `MAX_AGE_MS` | 30 000 | 半分钟前的"打开这个会话"已经不是用户的意图了 |

每条命令是 `{ seq, kind, payload, createdAt }`，`seq` 单调递增，永不复用。
`since(cursor)` 返回 `seq > cursor` **且** 未过期的命令：游标太旧时返回的只是还留着的那些，
补发一部分总比什么都不补发好。

总线**故意是哑的**（`lib/host/bridge.js:60-66`）：它不校验 payload 的语义，只搬运。
认识某个 kind 的监听者自己处理，不认识的忽略。这样新面板可以对着旧窗口说话，不需要升 schema。

## 2. 允许的 kind，以及谁执行

`WINDOW_COMMANDS`（`lib/host/bridge.js:133`）是窗口唯一被允许发的五种命令，其余一律 `bad-request`。
另外两种由 **host 自己**发，用来通知页面窗口的生命周期。

| kind | 谁发 | 谁执行 | 作用 |
|---|---|---|---|
| `open-session` | 窗口 | DSH 页面 | 在 DSH 里打开某个会话 |
| `new-session` | 窗口 | DSH 页面 | 在某个 workspace（或默认位置）新建会话 |
| `open-settings` | 窗口 | DSH 页面 | 打开 DSH 的设置（窗口没有设置外壳） |
| `reveal` | DSH 页面 | **窗口** | 在资源管理器里定位会话文件 |
| `refresh` | 窗口 | DSH 页面 | 刷新面板数据 |
| `window-open` | host | DSH 页面 | 窗口已打开（用于同步"默认打开方式"的状态） |
| `window-closed` | host | DSH 页面 | 窗口已关闭 |

payload 只接受三个字符串字段，各自截到 200 字符：

```jsonc
{ "kind": "open-session", "payload": { "sessionId": "01J…" } }
```

`sessionId` / `workspaceId` / `scope` 之外的键**直接丢掉**。桥是一根窄管子，不是插件的遥控器。

**为什么方向是分开的**（`lib/client.js:9082-9130`）：

- `open-session` / `new-session` 只由 DSH 页面执行。窗口是发起方；窗口若也听自己的命令，
  就会把命令原样再发一次（shim 里的 `ECHO_MS` 回声守卫只是时间启发式，不是契约）。
- `reveal` 只由窗口执行。反过来会让页面在自己刚打开窗口之后，又把面板盖在那个窗口上面。
- 两边都先问 `windowHost()`：同一个 `client.js`，靠这一个判断决定自己现在是哪一端。

## 3. SSE 协议

`GET /bridge/events?since=<cursor>`（`lib/index.js:949`）。帧序列固定：

```
event: ready
data: {"cursor":42,"kinds":["open-session","new-session","reveal","refresh","open-settings"]}

id: 43
event: command
data: {"seq":43,"kind":"open-session","payload":{…},"createdAt":1730000000000}

: keep-alive
```

- `ready` 先发，带上当前游标和允许的 kind，客户端据此决定要补哪些；
- 紧接着补发 `since` 之后的命令（一次往返就能追上，不用第二次请求）；
- 之后是实时的 `command`，每帧带 `id: <seq>`；
- 每 **15 秒**一条注释帧 `: keep-alive`，防止中间层掐掉空闲连接（`keepAlive.unref()`，
  它不该阻止进程退出）；
- `req.on("close" | "aborted")` 时清定时器、退订、`end()`。

**重连不重放**：`EventSource` 断线后会自己重连同一个 URL，并带上 `Last-Event-ID`。服务端优先
读这个头，读不到才回落到查询参数 `since`（`lib/index.js:969-973`）。没有这一步，重连会从
首次连接的游标开始补发，`new-session` 就开两个窗口。

**背压与上限**：`res.write()` 返回 `false` 表示套接字缓冲已满，此时直接结束这条流——面板会带
`Last-Event-ID` 重连，从它真正收到的最后一帧继续，而不是让缓冲无限增长。同时订阅者上限 32
（`MAX_LISTENERS`，`lib/host/bridge.js:35`），满了回 `503`：重连风暴不能把卡住的响应再叠一层。

SSE 而不是轮询：命令是**事件**，而唯一会变的数字（下载百分比）走的是轮询——两者的性质不同。

## 4. 主题

### 问题

面板在 DSH 的 document 里，`getComputedStyle` 能解出每个 `--dsw-alias-*` 的当前值。
独立窗口是另一个 document，DSH 的样式表不在那里，那些 token 会退回面板自己的默认值——
于是用户装了主题插件、或者切到浅色，窗口不跟着变。

### 解法

面板把**它看到的**报给 host，窗口来问 host 要。`lib/host/theme.js` 是个极小的共享 store。

只接受样式表真正用到的 14 个 token（`THEME_TOKENS`，`lib/host/theme.js:31`）：

```
--dsw-alias-bg-layer-1 / -2 / -3
--dsw-alias-label-primary / -secondary / -tertiary
--dsw-alias-border-l1 / -l2
--dsw-alias-state-business-primary / -error-primary / -success-primary / -warning-primary
--dsw-alias-brand-primary
--dsw-alias-interactive-bg-hover
```

**校验**（`isSafeTokenValue`，`lib/host/theme.js:57`）：值最终会进 CSS 自定义属性，所以无界的
map 就是一条样式注入通道。规则是：

- 必须是字符串，trim 后非空，长度 ≤ 160（`VALUE_MAX`，够放颜色和小的 color-mix 表达式）；
- 含 `;` `{` `}` → 拒；
- 含 `url(` / `expression(` / `@import` / `javascript:`（忽略大小写）→ 拒；
- 必须整体匹配 `^[#\w\s.,%()\-+/'"*]+$`。

不匹配的单个 token 被丢掉，不影响其它 token。

### 上报时机

`reportTheme()`（`lib/client.js:8404`）：读 `.se-shell`（没挂载就读 `body`，最后才退到
`documentElement`）的 computed style，取这 14 个 token 的值，`POST /theme` 带 `{ mode, tokens }`。
`mode` 来自 `documentElement` 的 `data-theme` 是否为 `light`。

读 `body` 而不是 `documentElement` 是有原因的：DSH 把调色板声明在 `body` 上
（`--dsw-alias-*` 定义在 `body` / `body[data-ds-dark-theme]`），自定义属性只向下继承，
所以从 `<html>` 读拿到的是**空**调色板。上一版正是在 `apply()` 里从 `documentElement`
读一次——那时面板还没挂载、`<html>` 又没有 token，于是 host 存下一份空的调色板，
窗口只好用样式表里硬编码的兜底色（工作区名字/图标因此是深蓝 `#4176e6`，而 DSH 里是主题色）。

**值必须解析成具体颜色**（`resolveThemeValue()`，`lib/client.js:8383`）：DSH 的 alias token
几乎都是指向自己调色板的引用，例如 `--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50)`。
窗口没有 `--dsw-static-*` 这一层，原样搬过去会得到一个"引用了不存在变量"的值——这在 CSS 里是
*无效*而不是*未设置*，消费方 `var(--token, fallback)` 的 fallback 根本轮不到，文字会掉成
`unset`。所以在这里就地展开引用（深度上限 8 层，支持 `var(--x, #fallback)`），解不出来的
token 直接丢给 host 丢弃，让窗口保留自己的兜底。

触发点有三个：`apply()` 时一次；`Panel` 挂载后一次（`lib/client.js:4709`，此时 `.se-shell`
才存在，读到的就是面板真正看到的调色板）；以及一个 `MutationObserver`——监视
`documentElement` 的 `class` / `data-theme` / `style` 三个属性。这是 DSH 里所有主题插件切换
明暗的方式，所以监听它就等于监听"主题变了"。观察器挂在 `ctx.effect` 里，卸载时断开。

### 窗口侧

`assets/detached/shim.js` 在窗口启动时 `GET /theme`，把每个 token `setProperty` 到
`documentElement`，并同步 `data-theme`。

shim **会拦掉**窗口发出的 `POST /theme`（`assets/detached/shim.js:93`）。因为窗口里的
`client.js` 也在跑，它也会上报——但窗口的配色本来就是**从 host 拿来的**，回声会把一份空调色板
盖在真的上面（首帧还没拿到回复时尤其明显）。所以这条通道只允许单向：面板 → host → 窗口。

## 5. 独立窗口

`POST /detached/open` / `POST /detached/close`（`lib/index.js:994`）。窗口本体是 DSH 的
Electron 窗口，加载 `/session-navigator/api/ui`，需要浏览器组件就绪，否则 404 `component-not-installed`。

窗口打开/关闭时 host 往总线发 `window-open` / `window-closed`（`lib/index.js:157-158`），
页面据此更新"默认打开方式"的状态和按钮文案。

窗口的几何（`shell.window.bounds` / `alwaysOnTop`）存在设置里：`bounds` 为 `null` 表示"还没放过"，
客户端先居中一次再把落点记下来。

## 6. shim 到底做了什么

`assets/detached/shim.js:1-25` 写得很清楚：窗口和面板是同一个 UI，窗口**原样加载**
`lib/client.js`，shim 只是在那份模块 mount 之前假装自己是 DSH。client.js 向平台要四样东西，
shim 四样全给：

| 平台接口 | shim 给的 |
|---|---|
| `window.__ModuleLoader__.load({ id, factory })` | 直接调用 factory |
| `require("react")` | 仓库里自带的 UMD 构建 |
| `ctx.slots` / `ctx.locale` / `ctx.effect` / `ctx.get` | 一个"刚好够用"的 ctx |
| `document.body` + `createPortal` | 窗口自己的 document |

因为面板是通过 portal 渲染进 `document.body` 的（`getOverlayRoot`），这在任何 document 里都能工作，
所以窗口只需要渲染一次 footer-action 槽位、把 panel store 打开就行。

shim **故意不做**两件事：不上报主题（见上），不订阅命令桥（窗口只向 host 请求导航，
执行由 DSH 页面里的面板完成）。

## 7. 相关文件

| 文件 | 职责 |
|---|---|
| `lib/host/bridge.js` | 总线、`WINDOW_COMMANDS`、`normalizeCommand` |
| `lib/host/theme.js` | `THEME_TOKENS`、`isSafeTokenValue`、theme store |
| `lib/index.js:938` | `POST /bridge/commands` |
| `lib/index.js:949` | `GET /bridge/events`（SSE） |
| `lib/client.js:8404` | `reportTheme()` + `resolveThemeValue()`（`lib/client.js:8383`）+ MutationObserver |
| `lib/client.js:544` | `subscribeBridge()` |
| `lib/client.js:10359` | `apply()` 里装配桥与主题监听 |
| `assets/detached/shim.js` | 窗口的假 DSH 外壳、主题拉取、回声守卫 |
