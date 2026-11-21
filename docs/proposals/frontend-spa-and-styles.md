# 前端 SPA 外壳与样式现代化

> 设计提案 · 2026-11-21
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
| 外壳 | 每个页面自带一份 topbar，开发任务只是大厅顶栏一个 ghost 按钮 | 常驻 App Shell，三域 Tab 无刷新切换 |
| 样式 | 单文件 [styles.css](../../web/src/styles.css) 2153 行，无预处理器、无变量体系 | 预处理器 + 按组件拆分的 partial（2a）；组件作用域按需（2b） |
| 大厅 | 四段平铺、历史 20 条封顶 | 域内分栏 + 状态筛选 + 标准分页，窄屏 1~2 列 |

### 1.3 范围

- **改**：`web/src/**`、`web/package.json`（新增 `react-router`、`sass`）。
- **不改**：`server/**`、`shared/**`、任何 `/api` 与 `/ws` 的报文结构、`data/` 下任何落盘格式。
- **不碰**：后端 SPA fallback（[app.ts:65](../../server/src/app.ts) 已经存在且正确，见 §2.1）。

### 1.4 可观察的验收条件

1. 六种旧 URL 逐条打开，页面内容与改造前一致，地址栏变成新路径（对照表见 §2.3）。
2. 任一深链**直接刷新**不 404：生产 `pnpm build && pnpm start` 与开发 `pnpm dev` 各验一次。
3. 浏览器后退/前进在页面之间正确回退，不出现「后退又被打回新地址」的循环。
4. 顶栏三个 Tab 点击后无整页刷新地切换。
5. 逐页视觉对照无回退：大厅 / 五子棋 / 围棋 / 数子 / 聊天 / 看板 / 两种回放。
6. `pnpm typecheck` 与 `pnpm build:web` 通过。
7. 375px 窄屏与 1440px 桌面下大厅可用，卡片不溢出。

---

## 2. 方案设计

### 2.1 后端不用改（已核实）

- [app.ts:65-84](../../server/src/app.ts) 已有静态托管 + 非 API 路径回落 `index.html`，且排除了 `/api`、`/mcp`、`/work/mcp`、`/ws`。
- [vite.config.ts](../../web/vite.config.ts) 没设 `appType`，dev 默认就是 SPA fallback，且只代理 `/api` 与 `/ws`。

所以 `/games/xxx` 这类路径在 dev 与生产都不会 404，**本提案不新增任何后端路由**。

### 2.2 路由表

| 路径 | 视图 | 说明 |
|---|---|---|
| `/` | 大厅总览 | 已确认保留现状的跨域卡片（三域 + 历史），见 §5 |
| `/games` | 棋类大厅 | 五子棋 / 围棋 / 历史 三个子 Tab + 状态筛选 + 分页 |
| `/games/:roomId` | 对局室 | 原 `?room=` |
| `/games/:roomId/replay` | 当前局回放 | 原 `?view=replay` |
| `/replay/:archiveId` | 归档回放 | 原 `?archive=` |
| `/chats` | 聊天大厅 | 房间列表 + 分页 |
| `/chats/:roomId` | 聊天室 | 原 `?room=x&kind=chat` |
| `/work` | 开发看板 | 原 `?view=work` |
| `*` | 重定向 `/` | 未知路径回大厅 |

**两个命名决定，都有硬理由：**

- **`/chats` 而不是 `/chat`。** `/chat/mcp` 是真实 MCP 端点（[chat/mcp.ts:151](../../server/src/chat/mcp.ts)、[207](../../server/src/chat/mcp.ts)），而房间名允许叫 `mcp`（`ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/`）。用 `/chat/:roomId` 的话，名字为 `mcp` 的聊天室永远打不开——GET 会命中 MCP 的 SSE 而不是页面。改成复数就彻底没有这个面。棋类没这个问题，端点是单数 `/game/mcp`。
- **归档放 `/replay/:archiveId` 而不是 `/games/replay/:archiveId`。** 归档里同时有五子棋和围棋，不属于棋类子页；同时避开「房间名叫 `replay`」与静态段 `replay` 的歧义。归档 ID 是 `[a-zA-Z0-9_-]{1,80}`（[repository.ts:27](../../server/src/rooms/repository.ts)），放路径段天然安全，不需要额外编码。

### 2.3 旧 URL 兼容层（LegacyRedirector）

在路由根部挂一个只在**带旧参数**时生效的组件，用 `<Navigate replace>` 跳转（`replace` 避免后退时被打回来）。

按优先级匹配，与 [App.tsx:48-74](../../web/src/App.tsx) 的现有顺序**完全一致**：

| 优先级 | 旧 URL | 新地址 |
|---|---|---|
| 1 | `?archive=<id>` | `/replay/<id>` |
| 2 | `?view=replay[&room=<id>]` | `/games/<room>/replay` |
| 3 | `?kind=chat[&room=<id>]` | `/chats/<room>` |
| 4 | `?view=work` | `/work` |
| 5 | `?room=<id>` | `/games/<id>` |
| 6 | 无参数 | 停在 `/` |

配套规则：

- `room` 缺省时用 `DEFAULT_ROOM_ID`（现状如此：`?kind=chat` 不带 room 会打开默认房间，不是报错）。
- **非法 `roomId` 不跳大厅。** 只有 URL 里**没有** `room` 参数才进大厅（[constraints.md:31](../architecture/constraints.md)）。分三种情况：
  - 参数存在、值为空（`?room=`）→ 跳 `/games/<DEFAULT_ROOM_ID>`（`/games/` 不匹配路由，且今天这种 URL 也是打开默认房间）。
  - 值为非空但不匹配 `ROOM_ID_PATTERN` → 照样跳 `/games/<原值>`（用 `encodeURIComponent` 拼路径），由页面按现状回落默认房间，地址栏保留用户写的值。
  - 值合法 → 直跳 `/games/<id>`。
- 组合参数只认上表优先级最高的一个，其余忽略；重定向后丢弃全部 query。
- 重定向只跑一次（`useMemo` 读 `location.search`），避免 `/` 反复重定向。

### 2.4 App Shell

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Agent Arena · MCP   [ 棋局对弈 ] [ AI 聊天室 ] [ 开发任务 ]   域标题 │
├──────────────────────────────────────────────────────────────────────┤
│                          <Outlet />                                  │
└──────────────────────────────────────────────────────────────────────┘
```

- 点 logo 回 `/`；三个 Tab 用 `NavLink` 高亮当前域。
- **连接状态胶囊只在棋局路由渲染。** 现状里 `connection`（[store/room.ts](../../web/src/store/room.ts)）是「本浏览器到房间 socket」的状态，聊天页有自己的通道，看板没有 socket。把它挂到全局顶栏会在聊天页/看板页谎报「已断开」。非棋局路由显示域标题即可。
- `/work` 的前提：看板只在后端监听回环时挂载（[app.ts:43](../../server/src/app.ts) 的 `isWorkLoopback`）。非回环部署下该路由会显示接口错误——这是现状，不是本提案引入的，但 Tab 上要能看出「本机专用」。

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
3. 全站迁移要改每一个 `className` 外加 11 处动态类名，而前端零测试，回归面远大于收益。
4. 增量路线的好处是：新代码天然干净，存量代码在动手改它时才付成本，不为「统一」制造一次高风险大改。

**最大的坑：动态类名会静默失效。** 有 11 处 `className` 是模板字符串拼的，改成 module 后拼出来的 key 不存在时**不报编译错误，只是没样式**：

| 文件 | 行 |
|---|---|
| [CommentaryPanel.tsx](../../web/src/components/CommentaryPanel.tsx) | 142、170 |
| [SeatBadge.tsx](../../web/src/components/SeatBadge.tsx) | 61、64、69、75 |
| [StatusBar.tsx](../../web/src/components/StatusBar.tsx) | 177 |
| [Controls.tsx](../../web/src/components/Controls.tsx) | 136、156、165、209 |

这些必须改成显式映射表，不能留字符串拼接：

```tsx
const TONE_CLASS = { active: styles.phaseActive, warn: styles.phaseWarn, done: styles.phaseDone };
```

两条硬规则：

- **同一个组件不允许一半 module 一半全局。** 混用时两类选择器在同一层级竞争，出问题极难定位。要么整体迁，要么整体不迁。
- **动态类名必须改显式映射表**，不能留字符串拼接——上面列出的 11 处一个都不能漏。

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
| **F2** | 装 `react-router`，加 App Shell、路由表、LegacyRedirector | §1.4 的第 1~4 条（六种旧 URL + 刷新 + 前进后退 + Tab 切换） |
| **F3** | 大厅域内分栏、状态筛选、分页器 | 窄屏/桌面排版，历史翻页，`useLobbyList` 竞态逻辑保留 |
| **F4（2b）** | 新组件用 CSS Modules；存量组件按需逐个迁移 | 每个组件单独提交，逐组件视觉对照 |

F1 独立于 F2/F3，可以先合。F4 放最后且允许长期未完成。

## 4. 风险与护栏

**前端目前零测试。** `web/package.json` 没有 `test` 脚本，仓库里没有任何 `*.test.*` 前端用例——本提案要动 2153 行样式和 6 个页面，唯一的自动关卡是 `tsc --noEmit`。

护栏建议（按成本从低到高）：

1. **F2 结束时补一个 CDP 冒烟脚本**（[reviewing.md:40](../reviewing.md) 那套 `--remote-debugging-port`，不引 playwright 包）：开六个旧 URL，断言最终 `location.pathname` 与页面主标题；再断言任一深链直接刷新后 DOM 有内容。这个脚本是「旧链接不许死」唯一能自动回归的地方。
2. 一份手工验收清单（§1.4 七条），每次改动跑一遍并记录结论。
3. 每个步骤单独提交，出问题整步回退，不做「一大坨一起上」。

其他风险：

| 风险 | 处置 |
|---|---|
| 重定向循环把 `/` 打回自己 | 只在 `location.search` 非空时跳转，且用 `replace` |
| 深链刷新 404 | 已核实前后端都有 fallback；验收项 2 强制覆盖 |
| CSS Modules 静默丢样式 | 2b 强制「动态类名改显式映射」，见 §2.5 |
| 视觉回退 | 2a 先做、单独验收，把样式与逻辑的风险拆开 |

## 5. 已确认的取舍

| 议题 | 结论 | 理由 |
|---|---|---|
| `/` 的定位 | **保留跨域总览**：三域卡片 + 历史，内容沿用现有 `LobbyPage`；`/games` 与 `/chats` 只是过滤视图 | [decisions.md:80](../architecture/decisions.md)「大厅就是首页」的延续；三个路由共用一个组件加 `domain` 参数，不产生重复实现 |
| 2b 的范围 | **增量**：新组件用 module，存量按需迁移，不设全站截止线 | 见 §2.5，回归面与收益的权衡 |
| 每页条数 | 历史 12 条/页，房间 12 条/页 | 纯展示参数，实现时觉得不合适可直接微调，不影响结构 |

以上取舍已确认。实现过程中若出现新的产品或兼容分歧，回到本文档追加，不要私自在实现里决定。

## 6. 实施记录

（待实现后按步骤补：提交号、跑过的验收项、遗留项）

## 7. 独立审核

（待实现完成后由未参与实现的 agent 补：基线、独立检查结果、未覆盖项）
