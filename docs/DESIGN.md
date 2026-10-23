# 五子棋 MCP 对弈系统 · 设计文档

> 版本：v0.8（Agent 视图：double 威胁合并 + 防守纪律）
> 日期：2026-10-23
> 项目路径：`E:\code\fun\gomoku-mcp`
> 技术栈：Node.js + TypeScript（单进程后端） / Vite + React（前端）

---

## 1. 目标与范围

一句话：**人类在浏览器棋盘上落子，AI Agent 通过 MCP 工具接入同一局棋，实现「网页人类 vs 大模型」的实时对弈。**

设计上不绑定任何特定 Agent：只要客户端实现标准 MCP，就能接入。

### 1.1 已确认决策

- 默认人类执黑、AI 执白；网页可选择执黑 / 执白
- UI：极简木色棋盘 + 深色背景
- v1 不做悔棋
- 网页展示 **AI 互动解说**（通过 `say` 工具）：评价人类落子、评论局势、输赢与被偷袭时的反应；不追求完整输出模型推理
- 解说文本上限 2000 字符，超出截断；面板滚动展示
- 首批联调客户端：Command Code（开发验证）、zcode（GUI JSON 配置）
- dsh 使用 cordis 配置，等 zcode 跑通后由用户自行接入
- 默认房间号：`default`

### 1.2 v1 范围

- 15×15 标准无禁手五子棋，黑先，五连（含长连）获胜
- 房间模型：后端支持多房间，v1 UI 只使用 `default` 房间
- 浏览器：开局、落子、认输、实时观战、断线重连、AI 互动面板
- MCP：6 个工具，**Streamable HTTP + stdio 双传输**
- 单进程同时提供页面静态资源、REST/WS、MCP HTTP 入口
- 本地运行，默认仅监听 `127.0.0.1`
- 前后端共享 TypeScript 类型（`shared` workspace）

### 1.3 非目标（v1 不做）

- 多房间 UI / 匹配 / 账号体系
- 禁手规则、悔棋、计时器
- 公网部署、鉴权
- 数据库持久化（只保留接口缝）
- AI vs AI 自动编排
- 逐 token 的模型推理流（MCP 模式下做不到，见 §3）
- 依赖 MCP sampling / elicitation / notifications 等客户端高级能力

---

## 2. 核心问题：回合同步

MCP 的调用方向是 **Agent → Server**；而人类落子发生在浏览器（**浏览器 → Server**）。服务端无法「主动叫醒」Agent —— MCP 没有让客户端自动开始一轮推理的推送通道。

解法：提供一个**长轮询工具 `wait_for_turn`**。Agent 调用后请求挂起，直到：

1. 轮到 Agent（人类已落子）
2. 棋局结束
3. 开了新局
4. 超时

```mermaid
sequenceDiagram
    participant H as 人类 / 浏览器
    participant B as 后端 Room
    participant A as Agent

    H->>B: POST /api/rooms/default/games
    B-->>H: WS state（playing，turn=black）
    A->>B: MCP wait_for_turn
    Note over B: 请求挂起，等待状态变化
    H->>B: POST /api/rooms/default/moves (7,7)
    B-->>H: WS state（turn=white）
    B-->>A: reason=your_turn + state
    A->>B: MCP say("这步抢中路？我不会让你舒服")
    B-->>H: WS commentary
    A->>B: MCP place_stone (7,8)
    B-->>H: WS state（turn=black）
    A->>B: MCP say("我现在双三了，你小心")
    B-->>H: WS commentary
    A->>B: MCP wait_for_turn（下一轮）
```

### 2.1 `wait_for_turn` 语义

| 调用时状态 | 行为 | 返回 reason |
|---|---|---|
| `idle` | 立即返回 | `idle` |
| `finished` | 立即返回 | `game_over` |
| `playing`，轮到 Agent | 立即返回 | `your_turn` |
| `playing`，轮到人类 | 挂起至状态变化或超时 | `your_turn` / `game_over` / `new_game` / `timeout` |

- 默认超时 20s，参数范围 1s–60s
- **超时不是错误**：返回当前 `state` + `reason=timeout`，工具描述引导 Agent 再次调用
- Agent 侧推荐循环：`wait_for_turn` → `say` → `place_stone` → `say` → `wait_for_turn`
- 实现：每个 Room 持有 `Set<Waiter>`，状态变更时统一 resolve；每个 waiter 持有定时器
- 竞态：状态变更在 Room 方法内同步串行完成，每次变更 `version++`；响应始终携带完整 `state`
- waiter 的 resolve 条件独立于颜色：`status !== 'playing'`、`turn === seat`、`gameId` 变化

### 2.2 为什么不用轮询 `get_state`

会产生大量无意义调用和 token 消耗；长轮询把等待成本留在服务端。

为什么不用 MCP notifications：客户端不会因为收到通知就自动触发一轮 Agent 推理。

### 2.3 跨客户端行为差异

| 差异点 | 影响 | 对策 |
|---|---|---|
| 工具调用超时不同 | 长轮询可能被客户端提前掐断 | 默认 20s 有界等待，超时作为正常结果返回，Agent 再调 |
| server instructions 不一定展示 | Agent 可能不知道对局流程 | 完整流程写进每个 tool 的 description |
| Agent 不一定会连续调用工具 | 超时后可能直接结束回合 | tool description 明确要求循环；用户也可回复「继续」 |
| 部分客户端只支持 stdio | 无法直连 HTTP 端点 | 提供 stdio 桥接入口，共用同一套 tool 定义 |
| 客户端可能运行在 WSL/Docker | `127.0.0.1` 语义不同 | stdio 是最稳路径；HTTP 场景按实际网络调整地址 |

结论：**只用 tools 这一个 MCP 原语**，不依赖通知、采样、elicitation，保证最大兼容性。

### 2.4 超时值

先用 20s：覆盖人类思考，又低于大多数 MCP 客户端的默认工具超时。联调时实测各客户端上限，再调整，硬上限 60s。

---

## 3. AI 互动解说：能做什么、不能做什么

### 3.1 能力边界

外部 Agent 的原始推理（reasoning tokens / chain-of-thought）在客户端内部生成，**不会经过 MCP 协议传给服务端**。服务端只能看到一次完整的工具调用及其参数。

因此：

- 做不到「把模型正在生成的思考逐 token 转发到网页」
- 也不需要这样做：产品目标是**互动感**，不是展示模型的完整推理
- 能做到「模型主动调用工具，对玩家说一句话，网页实时展示」
- 前端可以在收到文本后做逐字动画，但内容到达时机取决于模型何时调用工具
- 不同客户端的 MCP 工具调用超时、展示方式不同，但工具通道本身通用

结论：解说是**模型对玩家说的话**，不是模型的隐藏思维链。

### 3.2 互动设计

新增第 6 个 MCP 工具：

```ts
say({
  roomId?: string,
  text: string,
  kind?: 'evaluation' | 'position' | 'reaction' | 'result' | 'banter',
  mood?: 'neutral' | 'confident' | 'happy' | 'nervous' | 'surprised' | 'sad'
}) -> { ok: true, commentary: Commentary }
```

`kind` 语义：

| kind | 使用时机 | 示例 |
|---|---|---|
| `evaluation` | 人类落子后，评价这一步 | 「这步想抢中路？我偏不让你舒服。」 |
| `position` | 自己落子后，判断局势 | 「我现在双三了，你只剩一条路。」 |
| `reaction` | 被偷袭、失误、局势突变 | 「等等，这步我没算到……」 |
| `result` | 对局结束 | 「GG，下一局我不会留手。」 |
| `banter` | 闲聊 / 挑衅 / 活跃气氛 | 「你手速挺快，棋还得练。」 |

`mood` 用于前端气泡配色，不参与规则。

行为约定：

- 工具描述引导模型：`wait_for_turn` 返回 `your_turn` 后，先 `say` 评价人类落子，再 `place_stone`
- 落子后可以再 `say` 一次，评论局势或表达情绪
- 对局结束时用 `say` 做收尾
- 每个回合 1–2 条即可，鼓励简短、有个性
- 上限 2000 字符，超长截断；空文本拒绝
- **服务端不生成假解说**；所有内容都来自模型。v1 不做「模型没说话时自动填词」
- 解说是否出现取决于模型是否调用 `say`；提示词里可以明确要求

### 3.3 实现方案

- 服务端把 `Commentary` 加入当前房间的互动日志（保留最近 50 条，换局清空）
- 通过 WebSocket 广播 `commentary` 事件
- 网页「AI 互动」面板追加显示，并按 `mood` 着色
- 互动通道**不影响棋局状态和 `version`**，是独立事件流
- 重连时通过 WS `hello` 一次性下发最近解说

### 3.4 实现难度

低。属于增量通道，不需要推翻回合同步机制。改动点：

1. `shared` 增加 `Commentary` / `CommentaryKind` / `CommentaryMood`
2. Room 增加互动日志与事件
3. REST 增加 `POST /api/rooms/:roomId/commentary`（stdio 桥接与调试用）
4. WS 增加 `commentary` 消息
5. MCP 增加 `say` 工具
6. 前端增加互动面板

### 3.5 未来可选：内置 AI 流式模式

如果以后想要真正的逐 token 流，需要另一种模式：后端直接调用 LLM API，边生成边通过 WS 推 token。这与「外部 Agent 通过 MCP 下棋」是两条独立路径，可作为 M7 的可选模式，不影响 v1。

---

## 4. 可扩展性设计

原则：**模块化单体 + 预留缝，不提前实现功能。** 不为假设中的需求引入插件系统、微服务、事件溯源或数据库。

### 4.1 现在预留的扩展点

| 未来功能 | 现在预留的缝 | 后续需要改什么 |
|---|---|---|
| 多房间 | `RoomManager` + 全链路 `roomId` | 增加房间列表 UI / 路由，后端基本不动 |
| 人类 vs 人类 / 多 Agent | `seats` 座位模型；引擎只认颜色 | 增加参与者身份与鉴权，扩展 actor 映射 |
| 悔棋 | Room 内部保留完整 `Move[]` | 新增 undo 操作 + waiter 通知 |
| 计时器 | 状态版本 + 事件通道 | 增加 clock 字段与定时任务 |
| 持久化 / 回放 | `RoomRepository` 接口 + 纯 JSON 状态 + 历史 | 把内存实现换成 SQLite / 文件 |
| 禁手 / 规则变体 | `RuleSet` 参数化 | 实现规则校验，新增规则选项 |
| 观战 | WS 只读订阅，多客户端天然支持 | 增加观众列表 / 权限 |
| 解说扩展（语音 / 表情） | `Commentary` 的 kind / mood 通道 | 增加 TTS 或前端表现层 |
| 内置 AI 流式 | 独立事件通道 | 新增 LLM provider，不影响 MCP |

### 4.2 分层

```
core/       纯规则与纯函数，零 I/O
rooms/      房间编排：状态、waiters、事件、历史
adapters/   HTTP / WebSocket / MCP（进程内或 stdio）
web/        只依赖 shared 类型与 REST/WS 协议
```

- 规则引擎不知道房间、传输、Agent 的存在
- Room 不知道 HTTP / MCP，只暴露方法与事件
- MCP 工具不知道底层是进程内调用还是 REST，只依赖 `GomokuApi`

### 4.3 兼容性策略

- `GameState.schemaVersion = 1`；新增字段只做加法，不删不改名
- MCP 工具名稳定；参数只增加可选字段
- REST 前缀 `/api`；未来破坏性变更走 `/api/v2`
- WS 消息带 `type` 与 `roomId`，客户端忽略未知字段与未知消息类型
- v0.7 一次已知破坏：REST 变更类端点（`POST /games` `/moves` `/resign`）与
  `wait-for-turn` 的响应从裸 `GameState` 改为 `{ state, history, ... }` 包装，
  错误响应增加可选 `history` 字段；目的是让 stdio 桥接拿到走子历史、与进程内
  MCP 返回同一份 Agent 视图。web 前端与测试同步更新，无外部消费方

### 4.4 Agent 视图：LLM 友好的棋盘表达

实测（zcode，49 手完整对局）暴露的问题：LLM 逐格消费 15×15 嵌套 null 数组
会数错列，斜线上的跳四（`x 1 2 x 3 x`）在读盘阶段被漏看，直接导致输棋。
对策是把 MCP 边界的表达从「数据结构」换成「认知友好」：

- **boardText**：等宽棋盘图，`X`=黑 `O`=白 `.`=空，小写=最新一手，
  `#`/`@`=五连；行号两位补零、列号空白分隔（`10+` 不会黏连成 `9101112`）
- **moves**：走子记录 `{row, col, color, index}`。热路径
  （wait_for_turn / place_stone / resign / 错误）只带最近 8 手并标注
  `movesOmitted`；`get_state` 返回全量。历史不可得时 `movesOmitted =
  moveCount`，绝不伪装成空历史。实测 100 手热路径负载 2470 字符
  （全量历史为 6600）
- **hotPoints**：对每个空点、每种颜色做落子模拟，分级
  `win > open4 > four > open3`（`fiveAt` 给出成五点）。`win` 与 `fiveAt`
  都经引擎 `findWinLine` 校验，`overlineWin` / `winLength` 语义与规则引擎
  一致（exact-five 规则下六连补全不会被误报）；open3 为参考级启发式并设
  数量上限。决定第一局胜负的那手棋（黑 (9,4) 斜跳四成开四）在落下前
  就会被标为 `open4` 并给出两个成五点
- **double 威胁合并**：同一手制造两个独立必应威胁时，`HotPoint.double`
  标为 `["four","open3"]`（四三杀）或 `["open3","open3"]`（双活三），
  `open3At` 给出活三的拆点。独立性按“对手能否一手同时化解”判断：
  同方向的 four + three 不独立（挡 fiveAt 即同时拆三），不同方向的
  four + live three 才合并。double 点在同级 effect 中排最前
- **防守纪律写入提示词**：对手 open4 候选点必须本手直接占掉该点本身；
  对手 double 点本手优先占点（four+open3 可退而挡 `fiveAt`/拆 `open3At`
  一端；双活三必须占点或自己更快取胜，只拆一端挡不住）；对手 four
  必须本手挡 `fiveAt`，不能等它落子。SERVER_INSTRUCTIONS 与工具描述同步
- **第二局验收**：25 手黑胜（白方认输）。第 21 手后黑 `(4,7)` 不再只是
  `four`，而是 `four + double[four+open3]`，`open3At = (3,8)/(7,4)`；
  白 22 的发展着被标为必防点，复现脚本见 `scripts/replay-game2.mjs`

实现位置：`core/insights.ts`（纯函数）；MCP 两个传输
（`InProcessApi` / `HttpApi`）都经 `toAgentStateView()` 出同一份视图，
`GameState.board` 数组只保留在 REST/WS（前端渲染用），不再进入 MCP 负载。
错误负载同样转换并携带 history（见 §4.3 的 `history` 字段）。

---

## 5. 总体架构

```
┌──────────────────────┐         REST（动作）           ┌─────────────────────────────────────┐
│  浏览器（React）      │ ─────────────────────────────▶ │  后端（Node + TS，单进程）           │
│  棋盘 + 互动面板      │ ◀───────────────────────────── │                                     │
└──────────────────────┘  WebSocket（state/commentary） │   ┌──────────────┐                  │
                                                        │   │ RoomManager  │                  │
┌──────────────────────┐   MCP Streamable HTTP          │   └──────┬───────┘                  │
│  Agent A（支持 HTTP） │ ─────────────────────────────▶ │   ┌──────┴───────┐                  │
└──────────────────────┘                                 │   │  GameRoom(s) │ 状态/等待者/互动 │
                                                        │   └──────┬───────┘                  │
┌──────────────────────┐  MCP stdio   ┌────────────┐    │   ┌──────┴───────┐                  │
│  Agent B（仅 stdio）  │ ───────────▶ │ stdio 桥接 │───┼──▶│  GameEngine  │ 纯规则            │
└──────────────────────┘              │ （无状态） │REST│   └──────────────┘                  │
                                      └────────────┘    └─────────────────────────────────────┘
```

关键点：

- **棋局状态只有一份**，在提供 Web 服务的后端进程里
- HTTP MCP 与 REST/WS 同进程，直接共享 `RoomManager`
- stdio 桥接是独立进程，但**不持有棋局状态**，所有操作通过 REST 代理回后端
- 若每个 Agent 各起一个 stdio 进程且各自持有状态，会出现「各下一局」的错误，必须避免
- 互动解说走独立 WS 事件，不进入棋局状态

---

## 6. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 20 | MCP TypeScript SDK、WebSocket 生态成熟 |
| 包管理 | pnpm | workspace 严格、安装快 |
| 语言 | TypeScript（strict） | 前后端共享类型 |
| HTTP | Express 5 | 简单，够用 |
| WebSocket | `ws` | 轻量 |
| MCP | `@modelcontextprotocol/sdk` | 官方 SDK，支持 Streamable HTTP 与 stdio |
| 参数校验 | `zod` | MCP SDK 原生使用 zod schema |
| 前端 | Vite + React + TS | 快速开发 |
| 样式 | 原生 CSS | 不引入 UI 框架 |
| 测试 | Vitest | 引擎、Room、协议单测 |
| 开发编排 | `concurrently` | 一条命令同时起 shared / server / web |

不引入数据库、Redis、状态管理库。

---

## 7. 目录结构

```
gomoku-mcp/
├── package.json                 # 根脚本、devDependencies、packageManager
├── pnpm-workspace.yaml          # pnpm workspace: shared / server
├── .gitignore
├── README.md                    # 项目入口，链接到设计文档
├── docs/
│   └── DESIGN.md                # 本文件
├── .mcp.json                    # Command Code project 级 MCP 配置
├── shared/
│   ├── package.json             # @gomoku/shared，只放类型与常量
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── game.ts              # GameState / Move / RuleSet / Commentary
│       ├── constants.ts         # 默认规则、上限、房间号规则
│       └── protocol.ts          # WS 消息、REST DTO、Agent 视图类型
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts             # 启动：读取配置、创建房间、监听端口
│   │   ├── app.ts               # Express 组装：REST + MCP + 静态资源（测试可复用）
│   │   ├── config.ts            # PORT/HOST/默认参数
│   │   ├── core/
│   │   │   ├── rules.ts         # RuleSet、胜负检测、平局
│   │   │   ├── insights.ts      # Agent 视图：boardText / hotPoints / moves
│   │   │   └── engine.ts        # 纯函数状态转移
│   │   ├── rooms/
│   │   │   ├── room.ts          # 单房间：状态、waiters、互动、事件
│   │   │   ├── room-manager.ts  # 房间注册与默认房间
│   │   │   └── repository.ts    # RoomRepository + 内存实现
│   │   ├── http/
│   │   │   ├── routes.ts        # REST API
│   │   │   └── ws.ts            # WebSocket 广播
│   │   └── mcp/
│   │       ├── api.ts           # GomokuApi 接口
│   │       ├── tools.ts         # 6 个工具的唯一实现
│   │       ├── http.ts          # HTTP 适配：InProcessApi -> RoomManager
│   │       └── stdio.ts         # stdio 桥接：HttpApi -> 后端 REST
│   └── test/
│       ├── engine.test.ts
│       ├── room.test.ts
│       ├── rooms.test.ts
│       └── http.test.ts        # REST / WS / MCP 集成
└── web/
    ├── package.json
    ├── vite.config.ts           # /api、/ws 代理到 3000
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api.ts               # REST 封装
        ├── useRoomSocket.ts     # WS 连接 + 状态 / 互动
        ├── components/
        │   ├── Board.tsx
        │   ├── Stone.tsx
        │   ├── StatusBar.tsx
        │   ├── CommentaryPanel.tsx
        │   └── Controls.tsx
        └── styles.css
```

### 7.1 共享类型

- `@gomoku/shared` 只包含纯类型和常量，不引入运行时依赖
- server 与 web 都从它导入，避免协议漂移
- 开发时 `tsc --watch` 增量构建；生产构建先 build shared

### 7.2 MCP 层设计原则

- `tools.ts` 是唯一的工具定义来源：名称、description、zod schema、handler 都在这里
- handler 只依赖 `GomokuApi` 接口，不关心底层是进程内调用还是 HTTP
- 两种 transport 只是装配方式不同：

```ts
// HTTP：同进程
registerTools(server, new InProcessApi(roomManager));

// stdio：桥接进程
registerTools(server, new HttpApi('http://127.0.0.1:3000'));
```

这样保证任何客户端看到的工具行为完全一致。

---

## 8. 领域模型

### 8.1 规则

- 15×15，黑先
- 横 / 竖 / 两条对角线，**≥5 连即胜**（无禁手，长连算胜）
- 棋盘下满且无人获胜 → 平局
- 认输 → 对方胜
- 落子不可覆盖已有棋子、不可越界
- 落子后换手

### 8.2 类型定义

```ts
export type StoneColor = 'black' | 'white';
export type GameStatus = 'idle' | 'playing' | 'finished';
export type EndReason = 'five' | 'draw' | 'resign';
export type ParticipantKind = 'human' | 'agent' | 'remote';
export type Actor = 'human' | 'agent'; // v1

export type CommentaryKind =
  | 'evaluation'
  | 'position'
  | 'reaction'
  | 'result'
  | 'banter';

export type CommentaryMood =
  | 'neutral'
  | 'confident'
  | 'happy'
  | 'nervous'
  | 'surprised'
  | 'sad';

export interface Cell {
  row: number;
  col: number;
}

export interface PlayerSpec {
  kind: ParticipantKind;
  name?: string;
}

export interface RuleSet {
  boardSize: number;        // 15
  winLength: number;        // 5
  overlineWin: boolean;     // true
  forbidden: 'none';        // v1 仅无禁手
}

export interface Move extends Cell {
  color: StoneColor;
  index: number;            // 第几手，从 1 开始
  at: string;               // ISO 时间
}

export interface Commentary {
  id: string;
  roomId: string;
  gameId: string;
  text: string;
  kind: CommentaryKind;
  mood: CommentaryMood;
  moveIndex: number;        // 说话时的手数
  at: string;
}

export interface GameState {
  schemaVersion: 1;
  roomId: string;
  gameId: string;
  rules: RuleSet;
  board: (StoneColor | null)[][]; // [row][col]
  turn: StoneColor;
  seats: Record<StoneColor, PlayerSpec>;
  status: GameStatus;
  winner: StoneColor | 'draw' | null;
  endReason: EndReason | null;
  winLine: Cell[] | null;
  lastMove: Move | null;
  moveCount: number;
  version: number;          // 房间级单调递增，跨局不重置
  updatedAt: string;
}

export interface RoomView {
  state: GameState;
  history: Move[];
  commentary: Commentary[];
}
```

说明：

- `seats` 取代原来的 `humanColor` / `agentColor`，为人类 vs 人类、多 Agent 留出空间
- 引擎只认 `StoneColor`，不认 actor；角色映射在 Room 层完成
- `version` 每个房间单调递增，换局也不重置，前端可直接用它丢弃旧消息
- `Commentary` 是给玩家看的互动内容，不进入 `GameState`
- `RoomView.history` 是当前局完整走子记录，供 stdio 桥接构建 Agent 视图

### 8.3 错误码

```ts
export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_EXISTS'
  | 'INVALID_ROOM_ID'
  | 'GAME_NOT_PLAYING'
  | 'NOT_YOUR_TURN'
  | 'OUT_OF_BOUNDS'
  | 'CELL_OCCUPIED'
  | 'NO_AGENT_SEAT'
  | 'INVALID_COMMENTARY'
  | 'INVALID_REQUEST'      // 请求体 / 参数不合法
  | 'BACKEND_UNAVAILABLE'  // stdio 桥接连不上后端
  | 'INTERNAL_ERROR';
```

### 8.4 引擎函数（pure）

```ts
createInitialState(roomId: string, rules?: Partial<RuleSet>): GameState
startGame(prev: GameState, seats: Record<StoneColor, PlayerSpec>): GameState

applyMove(
  state: GameState,
  color: StoneColor,
  row: number,
  col: number
):
  | { ok: true; state: GameState; move: Move }
  | { ok: false; code: ErrorCode; message: string }

resignGame(state: GameState, color: StoneColor): GameState
findWinLine(board, row, col, rules): Cell[] | null
```

- 所有函数不修改入参，返回新对象
- `applyMove` 校验顺序：状态 → 越界 → 占用 → 是否轮到该颜色
- 胜负只检查最后一手所在的四条线，收集连续同色棋子
- `version`、`moveCount`、`lastMove`、`updatedAt` 在引擎内更新
- 完整 `Move[]` 由 Room 维护，不放进 wire 状态，避免 MCP 响应膨胀

---

## 9. 房间与事件模型

### 9.1 GameRoom

```ts
class GameRoom {
  readonly id: string;

  getState(): GameState;
  getView(): RoomView;
  getAgentSeat(): StoneColor | null;
  getHumanSeat(): StoneColor | null;

  newGame(opts?: { agentColor?: StoneColor }): GameState;

  moveBy(actor: Actor, row: number, col: number): MoveResult;
  resignBy(actor: Actor): GameState;

  waitForSeat(seat: StoneColor, timeoutMs: number): Promise<WaitResult>;

  say(
    text: string,
    kind?: CommentaryKind,
    mood?: CommentaryMood
  ): Commentary;

  onState(listener: (state: GameState, cause: StateChangeCause) => void): () => void;
  onCommentary(listener: (commentary: Commentary) => void): () => void;

  getHistory(): readonly Move[]; // 内部/未来回放用
}
```

职责：

- 持有该房间的唯一 `GameState`
- 串行化所有变更（Node 单线程，方法内同步完成）
- 维护 waiter、互动日志、完整落子历史
- 广播 `state` / `commentary` 事件
- 通过 `RoomRepository` 保存可序列化快照（v1 内存实现）

### 9.2 RoomManager

```ts
class RoomManager {
  get(roomId: string): GameRoom | undefined;
  getOrCreate(roomId: string, config?: RoomConfig): GameRoom;
  create(roomId: string, config?: RoomConfig): GameRoom;
  list(): RoomSummary[];
  remove(roomId: string): void;
}
```

- 服务启动时创建 `default` 房间：人类执黑、Agent 执白
- roomId 规则：`[a-zA-Z0-9_-]{1,32}`
- v1 前端只使用 `default`；其他房间可通过 API / MCP 参数创建，为后续多房间留缝

### 9.3 waiters

- 每个 Room 一个 `Set<Waiter>`
- 每次状态变更后调用 `notify()`
- resolve 条件：`status !== 'playing'`、`turn === seat`、或 `gameId` 变化
- 每个 waiter 带 `setTimeout`，resolve / 清理时清除
- 返回 `{ state, reason }`
- 超时返回当前 state，不抛错

### 9.4 互动日志

- 每个 Room 保存当前局最近 50 条 `Commentary`
- 新局开始时清空
- 通过 `onCommentary` 推给 WS
- 不进入 `GameState`，不影响 `version`
- 重连时通过 WS `hello` 一次性下发当前 `RoomView`

### 9.5 并发与一致性

- 单进程单线程：落子与 waiter 唤醒不会真正并行
- 同一瞬间两人同时落子：第一个成功，第二个收到 `NOT_YOUR_TURN`
- 前端以 `version` 为准，忽略旧版本状态
- 多个 MCP 客户端同时连接时共享同一房间：v1 假设只有一个 Agent 操作 agent 座位
- 多房间之间状态完全隔离

### 9.6 持久化缝

```ts
interface RoomRepository {
  load(roomId: string): PersistedRoom | null;
  save(room: GameRoom): void;
  list(): RoomSummary[];
  delete(roomId: string): void;
}

interface PersistedRoom {
  id: string;
  state: GameState;
  history: Move[];
  commentary: Commentary[];
}
```

v1 使用 `MemoryRoomRepository`，不落盘。未来替换为 SQLite / JSON 文件时，Room 与传输层无需改动。

---

## 10. 接口设计

### 10.1 MCP

- HTTP 端点：`http://127.0.0.1:3000/mcp`（Streamable HTTP）
- stdio 命令：`node <project>/server/dist/mcp/stdio.js`
- Server name：`gomoku`
- 所有工具都接受可选 `roomId`，默认 `default`

#### 工具一览

| 工具 | 作用 | 调用方 |
|---|---|---|
| `new_game` | 开新局，指定 AI 执黑 / 白 | Agent 或网页 |
| `get_state` | 读取完整棋局 | Agent |
| `wait_for_turn` | 挂起直到轮到 AI / 结束 / 超时 | Agent |
| `place_stone` | AI 落子 | Agent |
| `resign` | AI 认输 | Agent |
| `say` | 对玩家说一句互动解说，网页展示 | Agent |

#### `new_game`

```ts
input:  {
  roomId?: string;              // 默认 'default'
  agentColor?: 'black' | 'white'; // 默认 'white'
}
output: { state: AgentStateView; yourColor: StoneColor | null }
```

若网页已开局，Agent 通常不需要调用；重复调用会覆盖当前局。指定不存在的 roomId 时自动创建。

#### `get_state`

```ts
input:  { roomId?: string }
output: { state: AgentStateView; yourColor: StoneColor | null }
// state.moves 为全量历史（movesOmitted = 0）
```

#### `wait_for_turn`

```ts
input:  { roomId?: string; timeoutMs?: number } // 默认 20000，范围 1000–60000
output: {
  state: AgentStateView;   // moves 只带最近 8 手，movesOmitted>0 表示已省略
  yourColor: StoneColor | null;
  reason: 'your_turn' | 'game_over' | 'idle' | 'new_game' | 'timeout';
}
```

#### `place_stone`

```ts
input:  { roomId?: string; row: number; col: number } // 0-based；row 从上到下
output: { ok: true; state: AgentStateView }           // moves 同样只带最近 8 手
```

错误返回 `isError: true`，文本内容为 `{ code, message, state }`（state 同为 AgentStateView，
并携带最近走子使 `moves` 与 `moveCount` 一致），便于模型自我纠正。

#### `resign`

```ts
input:  { roomId?: string }
output: { state: AgentStateView }
```

#### `say`

```ts
input:  {
  roomId?: string;
  text: string;                // 1–2000 字符
  kind?: CommentaryKind;       // 默认 'reaction'
  mood?: CommentaryMood;       // 默认 'neutral'
}
output: { ok: true; commentary: Commentary }
```

互动与落子解耦：可以在等待人类时说话，也可以在落子前后说话。工具描述建议：

- `wait_for_turn` 返回 `your_turn` 后，先评价人类刚落的那一步（`kind='evaluation'`）
- 落子后评论局势（`kind='position'`）或表达情绪（`kind='reaction'`）
- 对局结束用 `kind='result'` 收尾
- 每回合 1–2 条，1–3 句话，说人话，不要输出推理过程

#### Tool description 必须自包含

因为不是所有客户端都会把 server instructions 传给模型，每个工具的 description 都要写清：

- 坐标约定（0-based、行列方向）
- 完整对局循环
- 超时后应再次调用
- 只能操作自己的座位
- `say` 的使用时机、kind / mood 语义、2000 字符上限

#### Server instructions 草稿

```
你是五子棋对弈 Agent，在 15×15 棋盘上与人类对弈。
坐标 0-based：row 从上到下，col 从左到右；黑先。

读盘方式（重要）：
- state.boardText 是等宽棋盘图：X=黑 O=白 .=空，小写 x/o=最新一手，#/@=五连；
- state.moves 是最近的走子记录；movesOmitted>0 表示更早的手数被省略，完整历史用 get_state 查；
- state.hotPoints 列出双方"落子即成威胁"的关键点：
  win=该点落子成五获胜 | open4=该点落子成两头开四（双杀）| four=落子成冲四（fiveAt 即成五点）| open3=活三（参考级）。
  double=该点同时制造两个独立必应威胁（four+open3 或双活三），open3At 给出活三的拆点——
  四三杀不能只当普通 four（挡完 fiveAt 还会被活三开四），双活三不能只拆一端。
禁止自己逐格重建棋盘或数数组——判断一律以 boardText 和 hotPoints 为准。

每次落子前，按以下优先级检查 hotPoints（先算胜，再算防）：
1. 自己的 win 点：直接落子获胜。
2. 对手的 win 点：必须占住；若对手已有两个 win 点，说明开四已成立无法全挡，选最能拖延或制造反击的一手。
3. 自己的 open4 候选点：优先落子，形成对手挡不住的双杀——它通常比防守对手的 open4 候选更快获胜。
4. 对手的 open4 候选点：必须在本手直接占掉该候选点本身——等对方落子后再去挡 fiveAt 就已经晚了。
5. 对手的 double 点：本手优先占掉该点本身，不要下发展棋。
   - four+open3（double 含 four）：占不了时，可挡 fiveAt，或拆 open3At 的一端；之后还要防另一条线。
   - 双活三（double 只有 open3）：必须占点，或自己有更快的成五/开四；只拆一个端点挡不住两个活三。
6. 对手的 four 点：本手挡在其 fiveAt；不要等它落子。
7. 再往后才是自己的 double / four / open3；自己的 double 是两步杀，但没有上述必防项时才优先。
低阶威胁只作参考，不要为它们放弃上面的必防项。

标准流程：
1. 调用 wait_for_turn 等待轮到你；
2. reason=your_turn 时，先调用 say 评价人类刚落的那一步（kind=evaluation），
   再按上述优先级依据 boardText / hotPoints 选择一个空位调用 place_stone；
3. 落子后调用 say 评论局势或表达情绪（kind=position / reaction），
   然后再次 wait_for_turn；
4. reason=game_over 时用 say（kind=result）总结胜负；
   reason=timeout 时再次调用 wait_for_turn；
   reason=idle 时可调用 new_game 或提示人类在网页开局。

只能操作 yourColor 颜色的棋子，不要替人类落子。每次落子前确认目标格为空。
解说是对玩家说的话，简短、有个性，不要输出完整推理过程。
```

### 10.2 REST（浏览器与 stdio 桥接）

统一前缀 `/api`，JSON 请求 / 响应。

| 方法 | 路径 | Body | 返回 |
|---|---|---|---|
| GET | `/api/health` | - | `{ ok: true }` |
| GET | `/api/rooms` | - | `RoomSummary[]` |
| POST | `/api/rooms` | `{ roomId?, seats?, rules? }` | `RoomView` |
| GET | `/api/rooms/:roomId` | - | `RoomView` |
| POST | `/api/rooms/:roomId/games` | `{ agentColor? }` | `{ state: GameState, history: Move[] }` |
| POST | `/api/rooms/:roomId/moves` | `{ row, col, actor? }` | `{ state: GameState, history: Move[] }` |
| POST | `/api/rooms/:roomId/resign` | `{ actor? }` | `{ state: GameState, history: Move[] }` |
| POST | `/api/rooms/:roomId/commentary` | `{ text, kind?, mood?, actor? }` | `Commentary` |
| GET | `/api/rooms/:roomId/wait-for-turn?timeoutMs=&actor=` | - | `{ state, yourColor, reason, history }` |

错误：4xx + `{ error: { code, message }, state?, history? }`（有房间上下文时携带 state 与 history）。

- 浏览器动作使用默认 `actor='human'`
- stdio 桥接调用时显式传 `actor='agent'`
- `/wait-for-turn` 专供桥接使用，浏览器不用
- 所有变更由 Room 完成，REST 与 MCP 共用同一套逻辑
- `commentary` 是独立事件，不改变棋局 `version`
- v1 不做鉴权，服务只监听回环地址

### 10.3 WebSocket

Path：`/ws?roomId=default`

- 连接建立后立即发送 `hello` + 当前 `RoomView`（状态 + 最近解说）
- 之后每次状态变化广播 `state`
- 每次互动解说广播 `commentary`
- 客户端不通过 WS 发动作（动作走 REST），仅心跳

Server → Client：

```ts
{ type: 'hello'; roomId: string; state: GameState; commentary: Commentary[] }
{ type: 'state'; roomId: string; state: GameState }
{ type: 'commentary'; roomId: string; commentary: Commentary }
{ type: 'error'; code: string; message: string }
{ type: 'pong' }
```

Client → Server：

```ts
{ type: 'ping' }
```

- 服务端每 30s 发送 `ws.ping()`，无响应则断开
- 前端断线后指数退避重连（1s → 2s → 4s，上限 10s）
- 重连成功后以 `hello` 的 `RoomView` 覆盖本地状态，并恢复最近解说
- `state.version` 小于本地版本时丢弃

---

## 11. 前端设计

### 11.1 页面结构

- 顶部：标题 + 房间号 + 连接状态点（在线 / 重连中）
- 左侧：棋盘（正方形，自适应，最大 640px）
- 右侧：AI 互动面板（桌面端并排，移动端堆叠到棋盘下方）
- 棋盘上方：状态栏「你的回合」「AI 正在思考…」「你赢了」「AI 认输」
- 底部：新对局（我执黑 / 我执白）+ 认输

### 11.2 棋盘

- 标准 15×15 交叉点棋盘：15 条横线与 15 条竖线，棋子落在交叉点，四周留半格木边
- 网格线用一层 SVG 叠加绘制，穿过下方命中格子的中心；CSS Grid 15×15 只作为点击命中区域，每个格子一个 button，点击 → `POST /api/rooms/:roomId/moves`
- 棋子：圆形 radial-gradient；最后一手加小圆点标记
- 获胜五子：高亮描边 / 脉冲
- 人类回合且交叉点为空时显示 hover 预览；星位用同一层 SVG 圆点绘制，与交点严格重合（避免小尺寸 HTML 圆角盒在亚像素位置被吸附成椭圆）
- 棋盘外圈标注 0–14 坐标，与网格线对齐（方便调试和与 Agent 沟通）
- 禁用点击条件：非 `playing` / 非人类回合 / 交点已有子 / 请求进行中

### 11.3 AI 互动面板

- 面板标题「AI 互动」
- AI 回合时显示「AI 正在思考…」+ 呼吸点动画
- 收到 `commentary` 后追加气泡：
  - 文本（最多 2000 字符）
  - kind 标签：评价 / 局势 / 反应 / 结果 / 闲聊
  - 手数标记
  - 按 mood 使用不同强调色（confident 暖色、nervous 冷色、surprised 紫色等）
- 可对文本做逐字显示动画；这是前端效果，不代表服务端流式
- 面板固定高度、内部滚动、自动滚到底部
- 用户向上滚动查看历史时暂停自动滚动，并提供「回到底部」按钮
- 保留最近 50 条
- 新局开始（`gameId` 变化）时清空面板
- 重连后由 `hello.commentary` 恢复

### 11.4 状态管理

- 单一 `GameState` 来源是 WS
- REST 响应也返回 state，按 `version` 去重
- 解说列表独立于 GameState
- 不引入 Redux / Zustand，`useState` + 自定义 hook 足够
- `roomId` 从 URL `?room=default` 读取，为多房间路由留缝

### 11.5 交互细节

- 开局：`POST /api/rooms/:roomId/games`，等待 WS 广播
- 认输：二次确认
- 对局结束：结果浮层，可一键再来一局
- 刷新页面：WS `hello` 恢复；必要时补 `GET /api/rooms/:roomId`

---

## 12. 后端设计

### 12.1 启动流程

1. 读取配置（`PORT=3000`、`HOST=127.0.0.1`）
2. 创建 `RoomRepository`（v1 内存）
3. 创建 `RoomManager`，初始化 `default` 房间
4. 创建 Express app：json 中间件、REST 路由、静态文件（生产）、MCP HTTP 路由
5. 创建 `http.Server(app)`
6. 挂载 `WebSocketServer({ server, path: '/ws' })`
7. listen

### 12.2 MCP HTTP 集成

- `McpServer` + `StreamableHTTPServerTransport`
- 每个 MCP session 一个 transport + McpServer 实例，共享同一个 `RoomManager`
- `POST /mcp` 处理初始化与请求，`GET /mcp` 提供 SSE 流，`DELETE /mcp` 关闭 session
- 按官方 SDK 示例实现 session map（`mcp-session-id` 头）
- 工具输入用 zod schema 声明
- `wait_for_turn` 直接 `await room.waitForSeat(seat, timeout)`
- 客户端断开时清理该 session；waiter 由超时兜底

### 12.3 stdio 桥接

- 独立入口 `src/mcp/stdio.ts`，由客户端按需拉起
- 使用 `StdioServerTransport` + 同一套 `registerTools`
- `GomokuApi` 的实现是 `HttpApi`，调用后端 REST（默认 `http://127.0.0.1:3000`）
- **必须先启动后端**；桥接进程自身不保存棋局
- 环境变量：`GOMOKU_SERVER_URL`（默认 `http://127.0.0.1:3000`）
- 后端未启动时，工具调用返回明确的连接错误，提示先运行 `npm start`

### 12.4 静态资源

- 生产：`express.static(web/dist)`，非 `/api|/mcp|/ws` 的 GET 回退 `index.html`
- 开发：不托管，Vite 5173 + 代理

### 12.5 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | HTTP / MCP 端口 |
| `HOST` | 127.0.0.1 | 监听地址 |
| `WAIT_DEFAULT_MS` | 20000 | `wait_for_turn` 默认超时 |
| `WAIT_MAX_MS` | 60000 | `wait_for_turn` 上限 |
| `GOMOKU_SERVER_URL` | `http://127.0.0.1:3000` | stdio 桥接访问的后端地址 |
| `DEFAULT_ROOM_ID` | `default` | 默认房间 |

---

## 13. 客户端接入

### 13.1 选择传输方式

| 客户端能力 | 接入方式 | 说明 |
|---|---|---|
| 支持 Streamable HTTP | 填 URL `http://127.0.0.1:3000/mcp` | 首选，无额外进程 |
| 只支持 stdio | 运行 `node .../server/dist/mcp/stdio.js` | 桥接进程，需后端已启动 |
| 运行在 WSL / Docker | 优先 stdio | 避免 localhost 网络语义差异 |

> 各客户端的 MCP 配置语法以其当前版本文档为准；协议层完全一致。

### 13.2 首批联调客户端

| 客户端 | 接入方式 | 状态 |
|---|---|---|
| Command Code | Streamable HTTP | 开发与联调验证 |
| zcode | GUI 中配置 MCP JSON，指向 HTTP URL | 首批 |
| dsh | cordis 配置 | 延后，等 zcode 跑通后自行接入 |

Claude Code、Codex 等标准 MCP 客户端协议上同样可用，但不在本批实测范围。

### 13.3 配置示例

```bash
# Command Code（HTTP）
cmd mcp add --transport http gomoku http://127.0.0.1:3000/mcp

# 任意支持 stdio 的客户端
cmd mcp add gomoku -- node E:/code/fun/gomoku-mcp/server/dist/mcp/stdio.js
```

项目级 `.mcp.json`（Command Code project scope）：

```json
{
  "mcpServers": {
    "gomoku": {
      "transport": "http",
      "enabled": true,
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

zcode（GUI 的 MCP JSON 配置，模板；字段名以 zcode 界面为准）：

```json
{
  "mcpServers": {
    "gomoku": {
      "transport": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

如果 zcode 的 JSON 字段名不同，只需要映射三个值：名称 `gomoku`、传输 `http`、地址 `http://127.0.0.1:3000/mcp`。

验证：

```bash
cmd mcp list
cmd mcp get gomoku
```

会话内 `/mcp` 可看到 6 个工具。

### 13.4 对局流程

1. `npm run dev`（或生产模式 `npm run build && npm start`）
2. 浏览器打开 `http://localhost:5173`，点「新对局」
3. 对 Agent 说：「用 gomoku 工具和我下一局五子棋。每步先用 say 评价我的落子，落子后再评论一下局势，输赢时给点反应」
4. Agent：`wait_for_turn` → 你落子 → Agent 收到 `your_turn` → `say` → `place_stone` → `say` → 循环
5. 网页实时显示 AI 的解说和落子

### 13.5 兼容性注意事项

- 不同客户端的工具超时不同，若频繁超时，让 Agent 重新调用 `wait_for_turn`
- 部分客户端不会展示 server instructions，流程已在 tool description 中重复
- 若 Agent 在超时后结束回合，用户回复「继续」即可恢复等待
- 同一时间只让一个 Agent 操作 agent 座位；多 Agent 会共享同一局棋
- 解说是否出现，取决于模型是否调用 `say`；初始提示词里明确要求效果更稳
- 不追求完整推理输出；`say` 的内容是模型对玩家说的话

---

## 14. 错误与边界

| 场景 | 处理 |
|---|---|
| Agent 在人类回合落子 | `NOT_YOUR_TURN`，返回当前 state |
| 坐标越界 / 占用 | 对应错误码 + state，引导重试 |
| 重复调用 `new_game` | 直接覆盖，旧局作废，等待中的 waiter 收到 `new_game` |
| 网页刷新 / 断线 | WS 重连，`hello` 下发 RoomView |
| Agent 断开 | waiter 超时清理；重连后 `get_state` 继续 |
| 两个浏览器同时点 | 先到先得，后者 `NOT_YOUR_TURN` |
| 棋盘下满 | `winner='draw'`，`endReason='draw'` |
| 对局结束后落子 | `GAME_NOT_PLAYING` |
| 房间不存在 | `ROOM_NOT_FOUND` |
| 房间已存在仍创建 | `ROOM_EXISTS` |
| 房间没有 agent 座位 | `NO_AGENT_SEAT` |
| 空解说文本 | `INVALID_COMMENTARY` |
| 超长解说文本 | 截断到 2000 字符 |
| stdio 桥接找不到后端 | 工具返回连接错误，提示先启动后端 |
| 服务重启 | 内存状态丢失，回到 idle；v1 不持久化 |

---

## 15. 测试计划

### 单元测试（Vitest）

- engine：横 / 竖 / 主副对角线五连；长连（6 子）判胜；四连不胜；越界；占用；轮次错误；平局；认输；规则参数化（winLength）
- room：人类落子后 waiter resolve；超时 resolve `timeout`；新局 resolve `new_game`；对局结束 resolve `game_over`；并发落子只有一个成功；解说日志上限；新局清空解说
- rooms：多房间状态隔离；默认房间初始化；roomId 校验；仓库读写
- http（集成）：`createApp` 挂到临时端口，验证 REST 错误码、WS `hello`/`state`/`commentary`/`ping`、MCP SDK 客户端完整回合（含跨 REST 的 `wait_for_turn` 唤醒）

### 集成 / 手工

- 棋盘几何：15×15 条线、棋子中心与交叉点重合、星位为正圆且与线对齐、坐标与线对齐、四周半格木边
- 浏览器落子 → WS 广播 → 另一个页面同步
- 互动事件：`say` → WS `commentary` → 页面追加
- HTTP MCP 全流程（Command Code `/mcp` 检查 6 个工具）
- stdio MCP 全流程（桥接进程 + 后端）
- 断线重连后 state 与 commentary 恢复
- 长轮询 20s 超时后 Agent 再次调用
- 多房间：两个 roomId 互不影响
- zcode 验证工具列表、落子、解说展示

---

## 16. 里程碑

- [x] M1 `shared` + 规则引擎 + 单测（可独立验证规则）
- [x] M2 Room / RoomManager / 仓库缝 + REST + WS（curl / websocat 验证）
- [x] M3 React 棋盘 + 状态栏 + 断线重连（人类可自己走完一局）
- [x] M4 互动通道：Room 日志 + REST + WS + 前端面板（临时用 curl 验证）
- [x] M5 MCP：`tools.ts` + HTTP 入口 + stdio 桥接（6 个工具）
- [x] M6 生产构建 + 静态托管 + README + MCP 协议联调（官方 SDK 客户端，HTTP / stdio 均通）
- [ ] M6b 在 Command Code / zcode 客户端实测（需本地手动接入一次）
- [ ] M7（可选）多房间 UI、悔棋、计时器、持久化、内置 AI 流式模式；dsh 接入

---

## 17. 变更记录

- v0.1：初版，单房间、5 个 MCP 工具、HTTP + stdio
- v0.2：补充跨客户端通用性，stdio 桥接升为 P0
- v0.3：房间 / 座位 / 规则集 / 历史 / 持久化缝，明确可扩展边界
- v0.4：设计文档移入 `docs/`；AI 思考改为 AI 互动解说（`say`）；上限 2000 字符并滚动；zcode 优先，dsh 延后
- v0.5：M2–M6 实现：房间与长轮询、REST / WS、MCP 双传输、React 棋盘与 AI 互动面板；补充 `INVALID_ROOM_ID` / `INVALID_REQUEST` / `BACKEND_UNAVAILABLE` / `INTERNAL_ERROR` 错误码，抽出 `app.ts` 供集成测试复用
- v0.6：修正棋盘几何：棋子改为落在 15×15 交叉点（SVG 网格线 + CSS Grid 命中格 + 半格木边），坐标与星位对齐；星位改用同层 SVG 圆点，避免亚像素吸附成椭圆
- v0.7：Agent 视图（见 §4.4）：MCP 响应以 boardText / moves / hotPoints 取代 `state.board` 数组；
  热路径只带最近 8 手（`movesOmitted` 标注省略，get_state 仍全量）；错误响应携带 history；
  `win`/`fiveAt` 判定复用引擎 `findWinLine`（overlineWin / winLength 语义一致）；威胁分级
  精简为 win/open4/four/open3；boardText 列号可解析；REST 变更端点返回 `{ state, history }`（已知破坏，见 §4.3）
- v0.8：`HotPoint.double`（four+open3 / 双活三）+ `open3At` 拆点；同方向 four+three 不合并；
  double 点排在同级之前；提示词把“对手 double 本手优先占点（four+open3 可拆，双活三必须占点）”
  “对手 four 本手挡 fiveAt”写成硬约束；新增第二局 25 手复盘与 `scripts/replay-game2.mjs`；测试 106
