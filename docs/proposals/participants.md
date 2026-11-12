# 提案：参与者模型（Participant / Presence / Lobby）

> 状态：草案 v0.1（2026-10-24）
> 定位：这是「双方都能用 AI」「在线状态」「准备阶段」「聊天室」四件事的共同地基。先评审，再动手。
> 关联：[ROADMAP](../roadmap.md)、[PROPOSAL-AGENT-CHAT](agent-chat.md)、[PROPOSAL-GO-MCP](go-mcp.md)

---

## 1. 背景

现在 agent-arena 的座位模型是 **「一个人 + 一个 agent」**：

- `PlayerSpec = { kind: ParticipantKind, name? }`，`GameState.seats` 固定黑白两席；
- 落子用 `moveBy(actor: 'human' | 'agent')` 按 kind 找座位；
- `wait_for_turn` 只等「agent 座位」，且假设全房间只有一个 agent；
- 没有在线状态、没有准备阶段、没有「谁在等」的概念。

接下来三件事都会撞上这个模型：

1. **双 AI 对局**：五子棋/围棋都希望两边都能是 agent（人只看，或人当裁判）。
2. **在线与准备**：人类点「准备」后不该干等一个可能根本没连上的 agent。
3. **聊天室**：成员、在线、准备、轮流发言——和上面的需求是同一个东西。

所以先抽出 **参与者（Participant）** 这一层，三个功能共用，避免各写一套身份/在线/等待逻辑。

---

## 2. 现状与具体卡点

| 位置 | 现状 | 卡点 |
|---|---|---|
| `shared/src/game.ts` | `PlayerSpec { kind, name? }`，`seats: Record<StoneColor, PlayerSpec>` | 座位只有「kind」，没有稳定身份；两个 agent 无法区分 |
| `server/src/rooms/room.ts` | `getSeatFor(actor)` / `getAgentSeat()` 返回**唯一** agent 座位 | 双 AI 时 `moveBy('agent')` 不知道该动哪边 |
| `server/src/rooms/room.ts:241` | `waitForSeat(seat, timeoutMs)`，waiter 存在 `waiters` 集合（`room.ts:107`） | 只按颜色等，不按人；waiter 不可见 |
| `shared/src/game.ts:136` | `RoomView { state, history, commentary }` | 没有参与者、没有在线/准备 |
| `shared/src/game.ts:142` | `RoomSummary` 只有计数 | 房间列表做不出来 |
| `server/src/mcp/tools.ts` | 6 个工具都围绕「你的座位」 | 没有 `join`/`ready`，身份靠「唯一 agent 座位」隐式确定 |

结论：**双 AI 不是加个参数的事，座位必须先变成「可标识的参与者」。**

---

## 3. 目标与非目标

### 目标

- 房间里可以有 **0–2 个（未来 N 个）参与者**，每人有稳定 id、名字、类型（human/agent）、客户端信息。
- 座位（黑/白）指向参与者 id，而不是 kind；支持 human vs agent、agent vs agent、human vs human（本地观战/接管）。
- 每个参与者有 **presence**：`unknown / waiting / thinking / idle / disconnected`，由连接与回合信号判定，不靠「最后活动时间」猜。
- 房间有 **phase**：`lobby / waiting / playing / paused / finished`，双方 ready 才开局。
- `wait_for_turn` 按参与者等待；两个 agent 各等各的，互不干扰。
- 旧客户端（`actor: 'human'|'agent'`、不带身份的 `wait_for_turn`）行为不变。

### 非目标（本提案不做）

- 观战者/多观众权限体系（v1 所有人都是本地可信）。
- 跨机器、公网、账号系统。
- 聊天室的消息模型（见 CHAT 提案，只复用本提案的 Participant/Presence/WaitHub）。
- 围棋规则（见 GO 提案）。

---

## 4. 模型

### 4.1 Participant

```ts
type ParticipantKind = 'human' | 'agent';

interface Participant {
  id: string;              // 房间内稳定 id，如 "p_7f3a"；重连不变
  name: string;            // 展示名，房间内唯一，如 "dsh" / "you"
  kind: ParticipantKind;
  client?: string;         // MCP clientInfo.name/version 或 "web"
  seat: StoneColor | null; // 入座后固定；lobby 阶段可为 null
  presence: Presence;
  ready: boolean;
  joinedAt: string;
  lastSeenAt: number;      // epoch ms
  sessionId?: string;      // MCP 会话 id（stdio 客户端没有则为空）
}

type Presence =
  | 'unknown'        // 从未连接
  | 'waiting'        // 有挂起的长轮询（强在线）
  | 'thinking'       // 轮到它，沉默中（人类/AI 长考都算）
  | 'idle'           // 连接在，没在等也没轮到
  | 'disconnected';  // 传输层/进程确认断开
```

> **实现状态（2026-10-25）**
>
> - `Participant` 已实现（`shared/src/participant.ts`），但去掉了 `presence`
>   和 `ready` 两个字段：前者由 presence 注册表实时计算，后者属于 P1c。
> - `sessionId` 不在 `Participant` 上，而是单独放在
>   `SessionBindings`（`server/src/core/session-context.ts`），因为一个会话
>   可以同时存在于多个房间。
> - presence 已实现，但**信号按座位键**（`keyOf(roomId, seat)`），
>   `ParticipantView` 尚未暴露 `participantId`——这是 P1b 的剩余任务，
>   见 [`handoff.md`](../phases/02-p1b-participants/handoff.md) 任务 A。
> - 信号键保持按座位是刻意的：谁占着黑座由 roster 决定，改成按
>   participantId 会牵动 `rebindSeats` 等逻辑，收益为零。

presence 由**最强可用信号**判定，不看「最后一次活动过了多久」：

| 状态 | 条件 | 信号 |
|---|---|---|
| `waiting` | 该参与者有挂起的长轮询 | 强在线 |
| `thinking` | 轮到该参与者，且未超 `turnTimeout` | 沉默是正常的 |
| `idle` | 会话/连接仍在，没在等也没轮到 | 连接级 |
| `disconnected` | WS 关闭 / MCP 会话关闭 / 子进程退出 / 主动离开 | 传输级确认 |
| `unknown` | 从未建立过连接 | — |

**沉默 ≠ 掉线**：人类思考、AI 长考都不产生任何调用；只要连接还在，就该显示「思考中（已 42s）」，而不是「离线」。只有传输层/进程层给出断开证据时才算掉线。没有连接级信号的客户端才退回「`staleAfterMs`（默认 120s）无调用 → 无响应」的兜底，且这个状态不参与任何游戏逻辑。

按参与者类型取信号：

| 类型 | 在线 | 断开 |
|---|---|---|
| human（网页） | WS 连接 | WS close / 关页面 |
| agent（HTTP MCP） | MCP 会话 + 长轮询 | session close / DELETE |
| agent（stdio/runner） | 子进程存活 + runner 心跳 | 进程 exit |
| 无会话信息 | 最近调用（兜底） | > 120s 无调用 → 「无响应」 |

### 4.2 座位

```ts
interface SeatAssignment {
  black: string;  // participant id
  white: string;
}
```

`GameState.seats` 从 `Record<StoneColor, PlayerSpec>` 改为 `Record<StoneColor, ParticipantRef>`：

```ts
interface ParticipantRef {
  id: string;
  name: string;
  kind: ParticipantKind;
}
```

保留 `kind` 是为了兼容旧 UI 和「按 kind 找唯一座位」的旧逻辑；`id` 用于双 AI 路由。

### 4.3 RoomPhase

```ts
type RoomPhase = 'lobby' | 'waiting' | 'playing' | 'paused' | 'finished';
```

```text
lobby ──(human ready)──▶ waiting ──(both ready)──▶ playing ──(end)──▶ finished
  ▲                        │                          │
  └──────(cancel)──────────┘                          │
                                                     ▼
                                                  paused（掉线/暂停，可恢复 playing）
```

- `lobby`：房间已建，座位未定或未齐，可加入/换座。
- `waiting`：座位已定，至少一方 ready，等另一方。
- `playing`：`GameState.status = 'playing'`，正常落子。
- `paused`：掉线/人类暂停；`wait` 返回 `paused` 原因，恢复后回 `playing`。
- `finished`：终局，只读。

**`GameStatus` 不动**（仍是 `idle/playing/finished`），`RoomPhase` 是房间层的新字段。这样 106 个测试和现有 MCP 契约不受影响。

### 4.4 Room 快照

```ts
interface RoomView {
  state: GameState;
  history: Move[];
  commentary: Commentary[];
  phase: RoomPhase;
  participants: Participant[];
  seats: SeatAssignment | null;
}
```

`RoomSummary` 增加 `phase`、`participants`（精简版）、`lastActivityAt`，供房间列表用。

---

## 5. 生命周期

### 5.1 入座（join）

```text
agent 连接 MCP（initialize，带 clientInfo）
  → 调用 join_game({ roomId, name?, seat? })
  → 服务端分配/复用 Participant，绑定 sessionId
  → 返回 participantId、房间快照
```

- 不带 `name`：用 `client` 名 + 短后缀（`dsh-a1`）。
- 带 `seat` 且该座已占：`SEAT_TAKEN`（或 `?takeover=true` 顶替，见开放问题）。
- 同名重连：视为同一参与者，刷新 `sessionId`/`lastSeenAt`，不新建。

### 5.2 准备（ready）

- `POST /rooms/:id/ready { participantId, ready }` 或 MCP `ready`（可与 `join_game` 合并参数）。
- 双方 `ready=true` 且座位齐全 → `phase=waiting → playing`，调用 `startGame`。
- 人类在网页点「准备」= 人类参与者 ready。
- **兼容**：没有 lobby 的旧流程（直接 `new_game`）仍然立即开局，新参与者自动 ready。

### 5.3 等待与落子

```ts
// 旧：waitForSeat('white', 25_000)
// 新：waitForParticipant('p_7f3a', 25_000)
```

- 双 AI：两个 agent 各自 `wait_for_turn`，只有轮到的那位被唤醒（`reason: 'your_turn'`）。
- 落子：`moveBy(participantId, row, col)`；MCP 工具仍用调用者身份，不接受模型传 participantId（防冒充）。
- 走完一步，对手的 waiter 立即唤醒。
- 超时返回 `reason: 'timeout'` + 房间快照，模型自行决定再等。

### 5.4 掉线与恢复

- **掉线只由传输层/进程确认**：网页 WS 关闭、MCP 会话关闭、runner 子进程退出、或主动 `leave` → 立即 `disconnected`。
- **轮到某人时的沉默是 `thinking`，不是掉线**：UI 显示「思考中 42s」和 `turnTimeout` 倒计时；超时按房间策略处理（提示 / 暂停 / 跳过），不把 presence 当判负依据。
- `disconnected` 时：座位卡变红，房间可进入 `paused`，给人类「等待重连 / 判负 / 换人」；重连后回 `idle` / `waiting`。
- 服务重启：所有参与者置 `disconnected`（连接已不存在）、`phase=paused`、`seat` 保留，等人类恢复。

---

## 6. 接口变更

### 6.1 REST

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/rooms/:id/participants` | `{name?, kind, seat?}` → Participant（HTTP 客户端/网页/runner 用） |
| `POST` | `/api/rooms/:id/ready` | `{participantId, ready}` |
| `DELETE` | `/api/rooms/:id/participants/:pid` | 离开 |
| `POST` | `/api/rooms/:id/games` | **兼容保留**：`{agentColor}` 立即开局；新增 `{seats?, startWhenReady?}` |
| `POST` | `/api/rooms/:id/moves` | 新增可选 `participantId`；旧 `actor` 继续可用 |
| `GET` | `/api/rooms/:id` | 返回带 `phase/participants/seats` 的 RoomView |
| `GET` | `/api/rooms` | Summary 增加 phase/participants/presence |

### 6.2 MCP 工具

| 工具 | 变化 |
|---|---|
| `join_game`（新） | `{roomId, name?, seat?}` → participant + 房间快照；隐式创建房间 |
| `ready`（新） | `{roomId, ready}`，可并入 `join_game` 的 `ready` 参数 |
| `wait_for_turn` | 语义改为「等待调用者这个参与者轮次」；不再依赖「唯一 agent 座位」 |
| `move` | 身份取调用者；双 AI 时不再歧义 |
| `get_state` | 返回 `you: {participantId, seat, presence}` + `participants[]` |
| `new_game` | 保留；新增 `seats` 参数（双 AI 时用），`agentColor` 继续可用 |
| `resign` | 按调用者身份；双 AI 时人类裁判可 `resign(for: 'black')`（可选，见开放问题） |

### 6.3 身份传递

| 客户端 | 方式 |
|---|---|
| Streamable HTTP（DSH/Claude Code） | 请求头 `X-Arena-Participant: <name>`（DSH `headers` 可配） |
| stdio 桥 | 环境变量 `ARENA_PARTICIPANT=<name>` |
| 网页 | 服务端分配 `human` 参与者，随 `?room=` 建立 WS 时绑定 |
| 都没有 | 回退旧逻辑：房间内唯一 agent 座位；双 AI 时返回 `IDENTITY_REQUIRED` |

### 6.4 WS 事件

```json
{"type":"participants","roomId":"lobby","participants":[...]}
{"type":"phase","roomId":"lobby","phase":"playing"}
{"type":"state","roomId":"lobby","state":{...}}
```

保留现有 `hello/state/commentary/pong`，新增 `participants` 与 `phase` 两类事件。

---

## 7. 兼容策略

1. **旧 `/games` 不变**：`{agentColor}` → 合成两个 Participant（`agent`、`human`），`phase=playing`，立即开局；旧 Web/脚本零改动。
2. **`moveBy(actor)` 保留**：按 kind 解析；若同 kind 有两人 → `AMBIGUOUS_ACTOR`，提示用 participantId。
3. **`wait_for_turn` 不带身份**：回退到「唯一 agent 座位」；没有或有两个 → `IDENTITY_REQUIRED`。
4. **`GameState.seats` 形状兼容**：`ParticipantRef` 保留 `kind`/`name`；旧读取方不炸。
5. **`RoomView` 只增字段**，不删不改旧字段。

验收：现有 106 个测试全绿 + 旧版 `scripts/gomoku-client.mjs`（ZCode 驱动）不改也能跑。

---

## 8. 服务端实现要点

```text
server/src/core/
  wait-hub.ts        // 通用长轮询中心：key=participantId, 谓词唤醒, 超时
  presence.ts        // 连接注册表（WS/session/子进程）、回合态、stale 兜底
server/src/rooms/
  room.ts            // 持有 participants/seats/phase；waitForParticipant
  room-manager.ts    // 不变
```

- **WaitHub**：`Map<participantId, Set<Waiter>>`；`notify(participantId)` 在落子/换人/终局时调用；超时用定时器。聊天室的 `wait_for_messages` 可以复用同一个类（key 换成 memberId）。
- **Presence**：维护「连接注册表」——WS 连接、MCP 会话、runner 子进程各自登记；有挂起长轮询标 `waiting`，轮到某人标 `thinking`，传输断开标 `disconnected`。`touch(participantId)` 只用于兜底的「无响应」判断，不再决定在线。
- **会话绑定**：Streamable HTTP 的每个 session 在 initialize 时记录 `clientInfo`；`X-Arena-Participant` 头把 session 绑到 participant。stdio 客户端直接读环境变量。
- **重启恢复**：参与者从仓库加载，全部 `disconnected`（连接已不存在），`phase=paused`。
- **并发**：Node 单线程 + 同步内存操作；落子与 waiter 唤醒在同一 tick 内完成，避免「落子后对手还睡着」。

---

## 9. 前端

- 座位卡（顶栏两张）：名字、kind 徽标、presence 点、ready 勾。
- 准备阶段：`phase=lobby/waiting` 时显示 checklist 与「取消」，60s 未齐给明确文案（「agent 未接入：检查 MCP 配置」+ 复制配置按钮）。
- 观战模式：双方都是 agent 时，人类不占座位，页面进入观战布局（只读棋盘 + 双方 presence）。
- 双 AI 时隐藏「执黑/执白开局」，改为「添加 AI 对手 / 观战」。
- 掉线横幅：`disconnected` 参与者的座位卡变红，给「继续等 / 判负 / 换人」；`thinking` 显示计时，不报警。

---

## 10. 测试计划

单元：

- presence 判定：沉默（thinking）不算掉线；传输断开 → disconnected；waiting 覆盖 thinking；兜底 stale 阈值。
- seat 分配：两人不同座；第三人 `SEAT_FULL`；同名重连复用 id。
- phase 状态机：lobby→waiting→playing→paused→playing→finished 的合法/非法迁移。
- 兼容：`moveBy('agent')` 单 agent 正常、双 agent 报 `AMBIGUOUS_ACTOR`。

集成：

- 两个 MCP client（不同 `X-Arena-Participant`）各自 `join_game` + `wait_for_turn`，交替落子 10 手。
- 一个 client 挂起 wait，另一个落子 → 200ms 内唤醒。
- 沉默：轮到 agent 后 60s 无调用仍是 `thinking`；关闭 WS/会话后立即 `disconnected`。
- 旧脚本回归：`gomoku-client.mjs` 不改跑通一局。

---

## 11. 里程碑

| 阶段 | 内容 | 验收 | 预估 |
|---|---|---|---|
| P1a | presence + `RoomView.participants` + WS 事件（不改座位） | 网页能看到「agent 等待中/未连接」 | 0.5 天 |
| P1b | Participant 模型替换 PlayerSpec；按 id 落子/等待；兼容层 | 106 测试绿；旧脚本跑通 | 1 天 |
| P1c | lobby/ready/phase + 前端准备态 | 双方 ready 才开局；60s 提示 | 0.5 天 |

P1a 可以单独先合，风险最低、收益立竿见影。

---

## 12. 开放问题

1. **双 AI 时人类角色**：纯观战、裁判（可暂停/判负）、还是可随时接管一方？我倾向「观战 + 裁判」，接管留到以后。
2. **同名/同座冲突**：后连接顶替前一个（方便重连）还是拒绝（防误连）？我倾向「同名重连复用，同座他人拒绝」。
3. **无连接信号客户端的 stale 兜底**：默认 120s、文案「无响应」，不参与游戏逻辑——这个阈值合适吗？
4. **`join_game` 是否隐式建房**：沿用 `new_game` 的习惯（不存在就建）还是必须显式建房？我倾向隐式，降低 agent 门槛。
5. **聊天室是否共用 `Participant` 类型**：共用（放 `shared/src/participant.ts`）还是各自定义？我倾向共用，字段完全一致。

---

## 13. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-24 | v0.1 | 初稿：participant/presence/phase 模型、接口与兼容策略 |
