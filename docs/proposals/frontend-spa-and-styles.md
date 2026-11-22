# 前端 SPA 外壳与样式现代化

> 设计提案 · 2026-11-21（第二版，合并外部评审意见）
> 状态：**草案（取舍已确认，待实现）**
> 基线：`cf3b53b`（`main` 为 `34bd7ef`，两者差异只在部署脚本、README 与 `server/src/index.ts` 一行，不影响本提案的结构判断）
> 范围：只改 `web/`。后端零改动，`/api/*`、`/ws`、MCP 端点与 `shared/` 契约一律不动。
> 兄弟提案：[后端领域目录归拢](backend-domain-layout.md)。两者互不依赖，各自分支、各自合入。

---

## 1. 需求确认

### 1.1 实际场景

1. **旧链接必须照常打开。** 用户收藏了 `/?room=default`（[README:22](../../README.md)）、从大厅点进某间棋局、某间聊天室（`?room=x&kind=chat`）、某个历史对局（`?archive=x`），也从「开发任务」按钮进看板（`?view=work`）。改造后这些地址一个都不能坏。
2. **大厅房间一多就看不过来。** 目前 [LobbyPage.tsx](../../web/src/components/lobby/LobbyPage.tsx) 把五子棋、围棋、聊天、历史对局四段纵向平铺，历史超过 20 局只给一个「查看更多」，没有页码、没有棋种筛选。
3. **切页面会丢上下文。** 现在页面切换靠 [App.tsx:48](../../web/src/App.tsx) 的 if 链，浏览器后退直接退出站点，也没法从一个域跳回另一个域。

### 1.2 当前与期望

| 维度 | 当前 | 期望 |
|---|---|---|
| 路由 | `window.location.search` 手工分支，无 history | `react-router` + `BrowserRouter`，深链可收藏、可刷新、可前进后退 |
| 外壳 | 7 处 `<header className="topbar">` 散在 5 个文件里（`ReplayPage` 三态各一份），开发任务只是大厅顶栏一个 ghost 按钮 | 常驻 App Shell，三域 Tab 无刷新切换，各页移除重复 `topbar` 并归位页内元信息 |
| 状态与链接 | 切页靠整页 `<a href="/?...">` 刷新；store 只在 `connect()` 时重置，路由内换房会先渲染一帧旧房间 | 页内链接改 `<Link>`；换房用 `useLayoutEffect` 连接或渲染门控，同步更新 `document.title` |
| 样式 | 单文件 [styles.css](../../web/src/styles.css) 2153 行，无预处理器、无变量体系 | 预处理器 + 按组件拆分的 partial（2a）；组件作用域按需增量迁移（2b） |
| 大厅 | 四段平铺、历史 20 条封顶 | 域内分栏 + 状态筛选 + 标准分页，窄屏 1~2 列 |

### 1.3 范围

- **改**：`web/src/**`、`web/index.html`（标题）、`web/package.json`（新增 `react-router`、`sass`）。
- **不改**：`server/**`、`shared/**`、任何 `/api` 与 `/ws` 的报文结构、`data/` 下任何落盘格式。
- **不碰**：后端 SPA fallback（[app.ts:65](../../server/src/app.ts) 已经存在且对主路径有效，前提与边界见 §2.1）。

### 1.4 可观察的验收条件

1. 六种旧 URL 及其边界用例逐条打开，页面内容与改造前一致，地址栏规范化为新路径（对照表见 §2.3）。边界至少覆盖：`?room=`（空值）、`?room=bad!`（非法）、`?archive=`（空值）、`?view=replay&room=bad!`、`?kind=chat&room=`、`?utm_source=test`（无关参数，**不得**触发重定向）。
2. 任一深链（含多段路径 `/games/default/replay`）**直接刷新**不 404：生产 `pnpm build && pnpm start` 与开发 `pnpm dev` 各验一次。
3. 浏览器后退/前进在页面之间正确回退，不出现「后退又被打回新地址」的循环。
4. 顶栏三个 Tab 与大厅卡片点击后无整页刷新地切换；连续切换不同房间（`/games/a` → `/games/b`、`/chats/a` → `/chats/b`）**不闪现上一房间**的棋盘、消息或报错条。
5. 逐页视觉对照无回退：大厅 / 五子棋 / 围棋 / 数子 / 聊天 / 看板 / 两种回放，且每个页面**不再出现双顶栏**。
6. `pnpm typecheck` 与 `pnpm build:web` 通过。
7. 375px 窄屏与 1440px 桌面下大厅可用，卡片不溢出。

---

## 2. 方案设计

### 2.1 后端不用改（已核实，含边界备注）

- **资源与接口均为根相对路径**：[web/index.html:19](../../web/index.html) 用 `/src/main.tsx`（Vite 默认 `base: '/'`，产物是 `/assets/...`），[web/src/api.ts](../../web/src/api.ts) 与三个 store 全部以 `/api/...`、`/ws?...` 发起请求（[room.ts:361](../../web/src/store/room.ts)、[chat.ts:161](../../web/src/store/chat.ts) 用 `window.location.host` 拼 socket 地址）。所以多段深链刷新时不会出现相对路径的资源或接口 404。
- **生产环境（Express）**：[app.ts:65-84](../../server/src/app.ts) 已有 `express.static(webDist, { index: false })` + 非 API/MCP/WS 的 GET/HEAD 回落 `index.html`。
  - *边界备注*：`app.ts:73-78` 的排除列表只写了 `/api`、`/mcp`、`/work/mcp`、`/ws`，**没有**列 `/game/mcp` 与 `/chat/mcp`。当前不冲突，是因为 `mountMcpHttp`（54 行）和 `mountChatMcp`（60 行）注册在 `express.static`（66 行）之前，会先拦截。本提案不改后端，但以后若调整 `app.ts` 的中间件顺序，必须同步补齐排除项。
- **开发环境（Vite）**：[vite.config.ts](../../web/vite.config.ts) 没设 `appType`，dev 默认就是 SPA fallback，且只代理 `/api` 与 `/ws`。
  - *实测结论*：Vite 8 的 `htmlFallbackMiddleware` 对路径**不做扩展名判断**，末段是无条件回落 `index.html`。起 dev server 实测，`/games/foo.bar`、`/games/foo.js`、`/games/foo.css`、`/games/default/replay` 全部返回 `200 text/html`。**含点号的深链在 dev 下不会 404。**
  - 但兼容层仍然要归一化非法 `roomId`，理由见 §2.3 第 2 条——与 dev 404 无关。

所以常规深链在 dev 与生产都不会 404，**本提案不新增任何后端路由**。

### 2.2 路由表

| 路径 | 视图 | 说明 |
|---|---|---|
| `/` | 大厅总览 | 保留跨域总览（三域 + 历史），同时挂载 `LegacyRedirector` 处理旧 query |
| `/games` | 棋类大厅 | 五子棋 / 围棋 / 历史 三个子 Tab + 状态筛选 + 分页 |
| `/games/:roomId` | 对局室 | 原 `?room=`；组件内仍用 `ROOM_ID_PATTERN` 兜底回落 `DEFAULT_ROOM_ID` |
| `/games/:roomId/replay` | 当前局回放 | 原 `?view=replay`；同样对 `:roomId` 做合法性回落 |
| `/replay` | 归档回放（空 ID 报错态） | 承接旧 URL `?archive=` 空值，保留原报错反馈，不静默回 `/` |
| `/replay/:archiveId` | 归档回放 | 原 `?archive=<id>` |
| `/chats` | 聊天大厅 | 房间列表 + 分页 |
| `/chats/:roomId` | 聊天室 | 原 `?room=x&kind=chat`；对 `:roomId` 做合法性回落 |
| `/work` | 开发看板 | 原 `?view=work` |
| `*` | 重定向 `/` | 未知路径回大厅 |

**两个命名决定，都有硬理由：**

- **`/chats` 而不是 `/chat`。** `/chat/mcp` 是真实 MCP 端点（[chat/mcp.ts:151](../../server/src/chat/mcp.ts)、[207](../../server/src/chat/mcp.ts)），而房间名允许叫 `mcp`（`ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/`）。用 `/chat/:roomId` 的话，名字为 `mcp` 的聊天室永远打不开——GET 会命中 MCP 的 SSE 而不是页面。改成复数就彻底没有这个面。棋类没这个问题，端点是单数 `/game/mcp`。
- **归档放 `/replay/:archiveId` 而不是 `/games/replay/:archiveId`。** 归档里同时有五子棋和围棋，不属于棋类子页；同时避开「房间名叫 `replay`」与静态段 `replay` 的歧义。归档 ID 是 `[a-zA-Z0-9_-]{1,80}`（[repository.ts:27](../../server/src/game/rooms/repository.ts)），放路径段天然安全，不需要额外编码。

### 2.3 旧 URL 兼容层（LegacyRedirector）

只在 `/` 路径下检查 `location.search`；当且仅当命中下表 1~5 中任一旧参数时，用 `<Navigate replace>` 跳转（`replace` 避免后退时被打回来），并丢弃全部 query。**无关 query 参数（如 `/?utm_source=xxx`）不触发重定向**，直接停在 `/` 渲染大厅。

按优先级匹配，与 [App.tsx:48-74](../../web/src/App.tsx) 的现有顺序**完全一致**：

| 优先级 | 判定条件（严格对齐现状） | 旧 URL 示例 | 新地址 |
|---|---|---|---|
| 1 | `params.get('archive') !== null` | `?archive=<id>` / `?archive=` | 合法 → `/replay/<id>`；空值 → `/replay` |
| 2 | `params.get('view') === 'replay'` | `?view=replay[&room=<id>]` | `/games/<normalizedRoom>/replay` |
| 3 | `params.get('kind') === 'chat'` | `?kind=chat[&room=<id>]` | `/chats/<normalizedRoom>` |
| 4 | `params.get('view') === 'work'` | `?view=work` | `/work` |
| 5 | `params.has('room')` | `?room=<id>` / `?room=` | `/games/<normalizedRoom>` |
| 6 | 以上皆不命中 | `/` 或 `/?foo=bar` | 停在 `/` |

**配套规则（覆盖全部边界）：**

1. **统一 `normalizeRoomId(raw)`**，沿用 [App.tsx:34-39](../../web/src/App.tsx) 的现有判定：

   ```ts
   const normalizedRoom = raw && ROOM_ID_PATTERN.test(raw) ? raw : DEFAULT_ROOM_ID;
   ```

   适用于第 2、3、5 条全部三个带房间号的分支。
2. **为什么非法 `roomId` 归一化到 `DEFAULT_ROOM_ID`，而不把原值拼进路径**：
   - 满足 [constraints.md:31](../architecture/constraints.md) 的核心契约：只有 URL 里**没有** `room` 参数才进大厅；带 `?room=`（空或非法）仍进默认房间。
   - `ChatRoomPage` 与 `ReplayPage` 自身不做 `ROOM_ID_PATTERN` 校验，透传非法值会直接发错误请求。
   - 含 `/` 的值经 `encodeURIComponent` 会变成 `%2F`，在 Express 与 Router 两层解码时容易产生路径段歧义。
   - 重定向本来就是把旧地址规范化，没有必要把垃圾留在新路径里。
   - **不是**因为 Vite dev 会对含 `.` 的路径 404——实测不会（见 §2.1）。
3. **页面侧再校验一次**：直接访问深链 `/games/:roomId`、`/games/:roomId/replay`、`/chats/:roomId` 时，页面读到 `useParams().roomId` 后同样过一遍 `normalizeRoomId`，保证手输非法深链的行为一致。
4. **`?archive=` 必须用 `!== null` 而非真值判断**：防止 `/?archive=&view=replay` 因空串 falsy 改变优先级落到第 2 条。空值跳 `/replay` 渲染 `<ReplayPage archiveId="" />`，保留原报错反馈，不静默跳回 `/`。
5. **单次重定向保障**：只挂在 `/` 路由，且重定向目标都不再带旧 query，不会产生重定向循环。

### 2.4 App Shell、页面清理与 SPA 生命周期

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Agent Arena · MCP   [ 棋局对弈 ] [ AI 聊天室 ] [ 开发任务 ]   右区槽位 │
├──────────────────────────────────────────────────────────────────────┤
│                          <Outlet />                                  │
└──────────────────────────────────────────────────────────────────────┘
```

- 点 logo 回 `/`；三个 Tab 用 `NavLink` 高亮当前域（`/games*` 高亮「棋局对弈」，`/chats*` 高亮「AI 聊天室」，`/work` 高亮「开发任务」）。
- **连接状态胶囊只在棋局路由渲染**（[store/room.ts](../../web/src/store/room.ts) 的 `connection` 只代表当前棋局 socket）。非棋局路由右侧显示域标题；聊天室的连接状态留在聊天页内，看板没有 socket。
- `/work` 的前提：看板只在后端监听回环时挂载（[app.ts:43](../../server/src/app.ts) 的 `isWorkLoopback`）。非回环部署下该路由会显示接口错误，Tab 上标注「本机」或加 tooltip。

#### 现有 7 处重复 `<header className="topbar">` 拆除与内容归位

| 文件 | 现状 `topbar` 位置 | 改造方式 | 原顶栏内元素的归位 |
|---|---|---|---|
| [App.tsx](../../web/src/App.tsx)（`GamePage`） | 第 228 行 | 拆出 `web/src/components/game/GamePage.tsx` 并移除 `<header className="topbar">` | `room / {roomId}` 与棋局 `connection` 胶囊移入 App Shell 右区；棋种标题与副标题保留在页内紧凑头栏 |
| [LobbyPage.tsx](../../web/src/components/lobby/LobbyPage.tsx) | 第 306 行 | 移除 `<header className="topbar">` | 「开发任务」按钮删除（顶栏 Tab 已替代）；大厅标题与筛选条保留在页内 |
| [ChatRoomPage.tsx](../../web/src/components/chat/ChatRoomPage.tsx) | 第 210 行 | 移除 `<header className="topbar">` | 聊天室名、`chat-phase`、聊天 `connection`、返回聊天大厅的链接下沉为页内紧凑工具条 |
| [ReplayPage.tsx](../../web/src/components/replay/ReplayPage.tsx) | 第 132、149、168 行（三态） | 合并移除 3 处 `<header className="topbar">` | 回放标题、棋局元信息与返回链接合并为页内头部 |
| [WorkPage.tsx](../../web/src/components/work/WorkPage.tsx) | 第 109 行 | 移除 `<header className="topbar">` | 删除 `<a href="/">返回大厅</a>`（点顶栏 logo 或 Tab 即可切换） |

#### 页内硬编码旧链接改造清单（全部改为 `<Link>`）

| 文件 | 行号 | 现状 | 改后 |
|---|---|---|---|
| [LobbyPage.tsx](../../web/src/components/lobby/LobbyPage.tsx) | 54 | `href: '/?room=...'` | `<Link to={'/games/...'}>` |
| [LobbyPage.tsx](../../web/src/components/lobby/LobbyPage.tsx) | 72 | `href: '/?room=...&kind=chat'` | `<Link to={'/chats/...'}>` |
| [LobbyPage.tsx](../../web/src/components/lobby/LobbyPage.tsx) | 313 | `<a href="/?view=work">开发任务</a>` | 删除（由 App Shell 顶栏 Tab 接管） |
| [LobbyPage.tsx](../../web/src/components/lobby/LobbyPage.tsx) | 335 | 文案「打开 `?room=<房间名>` 即可开一间」 | 改为「打开 `/games/<房间名>` 即可开一间」 |
| [LobbyPage.tsx](../../web/src/components/lobby/LobbyPage.tsx) | 389 | `href: '/?archive=...'` | `<Link to={'/replay/...'}>` |
| [WorkPage.tsx](../../web/src/components/work/WorkPage.tsx) | 111 | `<a href="/">返回大厅</a>` | 删除或改 `<Link to="/">`；注意第 19 行的 `/api/work/.../artifact` 是文件下载接口，**保持 `<a>` 不动** |

#### 换房不闪旧数据（时序问题，不是清理问题）

两个 store 的 `connect()` 入口**已经**重置了状态——[room.ts:154-166](../../web/src/store/room.ts) 会清空 `state` / `participants` / `commentary` / `error` / `resultDismissed`，[chat.ts:51-60](../../web/src/store/chat.ts) 会清空 `room` / `messages` / `error`。cleanup 只负责关 socket 和清 `retryTimer`，这没问题。

**真正的问题是时序**：`connect()` 在 `useEffect` 里调用，而 `useEffect` 在浏览器**绘制之后**才执行。从 `/games/a` 跳到 `/games/b`，会先用 a 的残留状态渲染一帧，再被重置成空态。

处置：

- 房间页的连接改用 `useLayoutEffect`（绘制前执行，无闪烁）；或
- 页面在 `store.roomId !== 路由 roomId` 时渲染骨架/空态，不渲染棋盘。
- `key={roomId}` 只保证组件局部 state 不残留，**单独用它消除不了这一帧**。

其他两项：

- **`document.title` 同步**：[web/index.html:15](../../web/index.html) 当前写死「五子棋 · 与 AI 对弈」。在 App Shell 或各域页面按当前路由更新（大厅 / 棋局 / 聊天 / 看板 / 回放）。
- **组件目录边界**：只把 `GamePage` 从 [App.tsx:76-351](../../web/src/App.tsx) 拆到 `web/src/components/game/GamePage.tsx`，让 `App.tsx` 专注路由与 Shell；现有 8 个棋类子组件（`Board`、`GoBoard`、`Controls` 等）在 F2 保留原路径，不顺手大搬家。

### 2.5 样式改造：先 2a，后 2b

#### 阶段 2a：换成预处理器，**类名不动、JSX 零改动**

把 `styles.css` 按组件拆成 partial，仍保持全局类名与 BEM 命名：

```text
web/src/styles/
├── _tokens.scss        # 原 :root 的设计令牌（颜色/阴影/圆角/字号）
├── _breakpoints.scss   # 断点变量 + 响应式 mixin
├── base.scss           # reset、body、滚动条、全局排版
├── layout.scss         # .app / .topbar / 主栅格骨架
├── game.scss           # 棋盘、棋子、控制栏、状态栏、解说
├── lobby.scss          # 大厅卡片与网格
├── chat.scss
├── work.scss
└── index.scss          # 只做 @use 汇总，main.tsx 引它
```

- 唯一的 TS 改动：[main.tsx](../../web/src/main.tsx) 里 `import './styles.css'` → `import './styles/index.scss'`，`styles.css` 删除。
- 为什么先做这一步：**它没有 JSX 改动，是纯文件搬运**，可以单独验收「视觉零差异」，把风险与前后的路由/组件改造隔开。
- 拆分按**选择器归属**切，不按行号切。当前 6 组 `@media (max-width)` 散在 1190/1205/1828/1917/2077/2150 行，7 个 `@keyframes` 与 2 处 `prefers-reduced-motion` 也要跟着所属组件走，不能切出「半截媒体查询」。
- 验收：`pnpm build:web` 后对比 `dist/assets/*.css` 的选择器集合，只允许顺序与注释差异；再逐页肉眼对照。

#### 阶段 2b：按组件拆成 CSS Modules

2b 的实质是给组件加**作用域**，把 `xxx.scss` 改成 `Xxx.module.scss`，同时改该组件的 `className` 引用。

**顺序：2b 排在路由与大厅改造之后。** 2b 要改每个组件的 `className`，而路由和大厅会重写页面组件；先做 2b 等于同一批代码改两遍。

**已确认：2b 只做增量，不设「全站 module 化」的交付目标。** 边界如下：

| 范围 | 内容 |
|---|---|
| 做 | 本次新写或重写的组件（AppShell、大厅、分页器）从第一行就用 `Xxx.module.scss` |
| 做 | 后续任何组件被重写时，顺手把它迁成 module |
| 不做 | 存量组件（`Board` / `GoBoard` / `Controls` / `SeatBadge` / `StatusBar` / `CommentaryPanel` / `ChatComposer` …）的批量迁移 |
| 不做 | 为迁移而迁移：没有功能改动的组件一律不动 |

为什么这样切：

1. 2a 之后样式已经按域拆成 partial，「一个文件互相踩」的问题已经解决，2b 剩下的只是类名作用域这一层，边际收益低。
2. 现有组件已按域分文件、类名前缀基本隔离（`.lobby-*`、`.card-*`、`.seat-*`），污染风险本来就小。
3. 全站迁移要改每一个 `className` 外加全站 **18 处**动态类名，而前端零测试，回归面远大于收益。
4. 增量路线的好处是：新代码天然干净，存量代码在动手改它时才付成本，不为「统一」制造一次高风险大改。

**最大的坑：动态类名会静默失效。** 全站实测共 **18 处** `className` 用模板字符串拼接，改成 module 后拼出来的 key 不存在时**不报编译错误，只是没样式**：

| 文件 | 行号 | 示例模式 |
|---|---|---|
| [CommentaryPanel.tsx](../../web/src/components/CommentaryPanel.tsx) | 142、170 | `panel-live …`、`bubble--${item.mood}` |
| [SeatBadge.tsx](../../web/src/components/SeatBadge.tsx) | 61、64、69、75 | `seat--${presence}`、`seat-dot--${color}`、`presence--${presence}`、`is-ready` |
| [StatusBar.tsx](../../web/src/components/StatusBar.tsx) | 177 | `turn-stone--${turn}` |
| [Controls.tsx](../../web/src/components/Controls.tsx) | 136、156、165、209 | `btn--primary`、`is-active`、`is-confirming` |
| [App.tsx](../../web/src/App.tsx)（拆出后在 `GamePage` / Shell） | 245 | `connection--${connection}` |
| [LobbyPage.tsx](../../web/src/components/lobby/LobbyPage.tsx) | 110 | `card-phase--${tone}` |
| [ChatRoomPage.tsx](../../web/src/components/chat/ChatRoomPage.tsx) | 51、74、222、225 | `chat-hop--${tone}`、`is-turn`、`chat-phase--${phase}`、`connection--${connection}` |
| [ChatTimeline.tsx](../../web/src/components/chat/ChatTimeline.tsx) | 90 | `chat-line--own` |

迁移任何包含上述模式的组件时，必须改成显式映射表，不能留字符串拼接：

```tsx
const TONE_CLASS = { active: styles.phaseActive, warn: styles.phaseWarn, done: styles.phaseDone };
```

两条硬规则：

- **同一个组件不允许一半 module 一半全局。** 混用时两类选择器在同一层级竞争，出问题极难定位。要么整体迁，要么整体不迁。
- **动态类名必须改显式映射表**——凡迁到上表 18 处中的任何文件，一个都不能漏。

迁移一个组件 = 一个提交 = 一次视觉对照 + 一次 `pnpm typecheck`，出问题能单独回退。

### 2.6 大厅分页与筛选

- **历史对局**：`GET /api/archive` 一次返回全量（[LobbyPage.tsx:176](../../web/src/components/lobby/LobbyPage.tsx) 的 `fetchArchives`），分页纯前端做，每页 12 条，**不需要改后端**。
- **棋类与聊天房间**：数量小，同样前端分页 + 状态筛选（`playing/open` 绿、`waiting/paused` 金、`finished/closed` 灰，沿用 [phaseTone](../../web/src/components/lobby/LobbyPage.tsx)）。
- **保留现有竞态控制。** [useLobbyList](../../web/src/components/lobby/LobbyPage.tsx) 里「只有比已应用的**结果**更新才能落地」的那套逻辑（195-234 行）是修慢响应 bug 留下的，重写页面时必须原样搬过去，不要退回「比较最新请求」。
- 聊天卡片仍然**不显示在线状态**（[constraints.md:44](../architecture/constraints.md)：聊天没有 presence）。

---

## 3. 分步实施

| 步 | 内容 | 验收 |
|---|---|---|
| **F1（2a）** | 装 `sass`，`styles.css` 拆成 `styles/*.scss`，`main.tsx` 改引用 | 构建通过、产物选择器集合一致、逐页视觉对照 |
| **F2** | 装 `react-router`，加 App Shell、路由表、`LegacyRedirector`；拆出 `GamePage`；拆除 7 处旧 `topbar` 并归位元素；页内旧链接改 `<Link>`；换房时序处理与 `document.title` 同步 | §1.4 的第 1~5 条（旧 URL + 边界值 + 刷新 + 前进后退 + Tab/换房无串态 + 无双顶栏） |
| **F3** | 大厅域内分栏、状态筛选、分页器 | 窄屏/桌面排版，历史翻页，`useLobbyList` 竞态逻辑保留 |
| **F4（2b）** | 新组件用 CSS Modules；存量组件按需逐个迁移 | 每个组件单独提交，逐组件视觉对照 |

F1 独立于 F2/F3，可以先合。F4 放最后且允许长期未完成。

## 4. 风险与护栏

**前端目前零测试。** `web/package.json` 没有 `test` 脚本，仓库里没有任何 `*.test.*` 前端用例——本提案要动 2153 行样式和 6 个页面，唯一的自动关卡是 `tsc --noEmit`。

护栏建议（按成本从低到高）：

1. **F2 结束时补一个 CDP 冒烟脚本**（[reviewing.md:40](../reviewing.md) 那套 `--remote-debugging-port`，不引 playwright 包）：覆盖 6 种旧 URL + 4 个边界（`?room=`、`?room=foo.bar`、`?archive=`、`?utm_source=1`），断言最终 `location.pathname` 与页面主标题；再断言深链（含 `/games/default/replay`）直接刷新后 DOM 有内容。这是「旧链接不许死」唯一能自动回归的地方。
2. 一份手工验收清单（§1.4 七条），每次改动跑一遍并记录结论。
3. 每个步骤单独提交，出问题整步回退。

其他风险：

| 风险 | 处置 |
|---|---|
| 重定向循环或误拦截无关 query | 只挂在 `/`，且仅命中 5 个旧参数之一时才 `<Navigate replace>` |
| 非法 `roomId` 被写进路径 | 兼容层与房间页入口统一按 `ROOM_ID_PATTERN` 归一化到 `DEFAULT_ROOM_ID` |
| 换房闪一帧旧棋盘/旧消息 | 连接改 `useLayoutEffect`，或按 `store.roomId === 路由 roomId` 门控渲染 |
| 深链刷新 404 | 已核实前后端均有 fallback 且资源全根相对路径（Vite dev 已实测）；验收项 2 在 dev 与生产双路径强验 |
| CSS Modules 静默丢样式 | 2b 强制「动态类名改显式映射」，覆盖全站 18 处 |
| 视觉回退与双顶栏 | 2a 先做、单独验收；F2 按表逐页拆除旧 `topbar` |

## 5. 已确认的取舍

| 议题 | 结论 | 理由 |
|---|---|---|
| `/` 的定位 | **保留跨域总览**：三域卡片 + 历史，内容沿用现有 `LobbyPage`；`/games` 与 `/chats` 只是过滤视图 | [decisions.md:80](../architecture/decisions.md)「大厅就是首页」的延续；三个路由共用一个组件加 `domain` 参数，不产生重复实现 |
| 非法 `roomId` 的 URL 处理 | **归一化为 `DEFAULT_ROOM_ID`**，不把原值拼进路径 | 满足 [constraints.md:31](../architecture/constraints.md)（带 `room` 不进大厅）；房间页自身不校验 roomId；避免 `%2F` 路径段歧义；重定向本就是规范化 |
| `?archive=` 空值 | **路由至 `/replay` 保留报错态**，判定用 `!== null` | 避免空串 falsy 改变与 `?view=replay` 的优先级，也不静默吞掉错误提示 |
| 前端组件目录 | **只把 `GamePage` 拆出 `App.tsx`**，8 个存量棋类子组件暂不搬目录 | 避免 F2 同时叠加「路由重构 + 跨文件大搬家」，降低无测试场景下的回归面 |
| 2b 的范围 | **增量**：新组件用 module，存量按需迁移，不设全站截止线 | 见 §2.5，回归面与收益的权衡 |
| 每页条数 | 历史 12 条/页，房间 12 条/页 | 纯展示参数，实现时觉得不合适可直接微调，不影响结构 |

以上取舍已确认。实现过程中若出现新的产品或兼容分歧，回到本文档追加，不要私自在实现里决定。

## 6. 实施记录

分支 `feat/backend-and-frontend-refactor`。

**F1（2a）`ddbdd3d`**

- `styles.css`（2152 行）按原有 banner 拆成 10 个 partial + `index.scss`，`main.tsx` 只改一行引用。
- 验证：构建产物的 CSS 与改造前**逐字节相同**（SHA-256 一致，连 `index-4Aa-PB0C.css` 这个 hash 文件名都没变）；dev 模式下 `/src/styles/index.scss` 返回 200。
- 与计划的偏差：提案写的是「按选择器归属切」，实际必须按**连续区段**切。`scoring.scss` 的 `.btn--toggle` 与 `responsive.scss` 中 980px 查询内的 `.btn` 特异度相同，按归属合并会改变窄屏按钮样式。因此比提案多了 `responsive` / `scoring` / `replay` 三个文件，顺序约束写进了 `index.scss` 的注释。

**F2（路由外壳）本提交**

- `react-router` 接管路径：`/`、`/games`、`/games/:roomId`、`/games/:roomId/replay`、`/replay[/:archiveId]`、`/chats[/:roomId]`、`/work`，未知路径回 `/`。
- `AppShell` 成为唯一渲染 `.topbar` 的地方（改造前 7 处散在 5 个文件），页面改用紧凑的 `.page-head` 承载房间号、阶段与连接状态；`GamePage` 从 `App.tsx` 拆到 `components/game/`。
- `LegacyRedirector` 挂在 `/`，按 `archive → replay → chat → work → room` 的旧优先级跳转，非法 roomId 归一化到 `DEFAULT_ROOM_ID`，无关 query（如 `?utm_source=`）不触发跳转。
- 房间页的连接改成 `useLayoutEffect`：`connect()` 会重置 store，普通 effect 会先绘制一帧上一间房。
- 验证：用 CDP 驱动真实 Chrome 跑 17 条用例（8 条新路径 + 7 条旧 query + 未知路径），全部通过——路径、`document.title`、`.page-title`、`topbar` 数量都断言；另验 tab 点击不整页刷新（`window` 标记存活）、`history.back()` / `forward()` 落在正确路径。
- 已知偏差：`/games` 与 `/chats` 目前只做了「隐藏另一域的列表」的过滤，子 Tab、状态筛选与分页仍是 F3。

**待办：** F3（大厅分栏与分页）、F4（2b 增量 module）。


## 7. 独立审核

（待实现完成后由未参与实现的 agent 补：基线、独立检查结果、未覆盖项）
