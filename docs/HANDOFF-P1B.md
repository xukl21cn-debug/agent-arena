# 交接：参与者模型（P1b）

> 面向：接手继续开发的 AI agent（GLM）
> 状态：**✅ P1b 已完成并合入 main**（任务 A、B 及掉线推送修复均已落地、实测通过）。仅剩可选的任务 C
> 最后更新：2026-10-25
> 分支：已合入 `main`；worktree `gomoku-mcp-p1b` 已清理
>
> **下一步是 P2**，见 [`HANDOFF-P2.md`](HANDOFF-P2.md)。本文件保留作为 P1b 的历史记录和约束参考。

---

## 0. 先读什么

按这个顺序，不要跳：

1. **本文件**（你在哪、要做什么）
2. [`docs/ROADMAP.md`](../ROADMAP.md) — 整体顺序和依赖，知道为什么先做参与者模型
3. [`docs/proposals/PROPOSAL-PARTICIPANTS.md`](../proposals/PROPOSAL-PARTICIPANTS.md) — 设计意图，尤其是 presence 语义那一节
4. 代码：`shared/src/participant.ts` → `server/src/rooms/participant-roster.ts` → `server/src/rooms/room.ts` → `server/src/core/presence.ts`

---

## 1. 一句话背景

这个项目原本是「人类 vs 一个 AI」的五子棋。现在要让它支持：

- **双 AI 对弈**（两个 agent 各执一色）
- **在线状态可见**（谁连着、谁在思考、谁掉了）
- **准备阶段**（双方就绪才开局，而不是点完就干等）

这三件事共用一个地基：**参与者（Participant）**。之前座位只记 `kind: 'human' | 'agent'`，两个 agent 就无法区分。P1b 就是把这个地基补上。

---

## 2. 已经做完的（不要重做）

### 2.1 参与者名册

`server/src/rooms/participant-roster.ts` — `ParticipantRoster`

```ts
join({ name?, kind, seat?, client? })  // 同名 = 重连，复用 id
leave(id)                              // 释放座位
bySeat(seat) / byKind(kind) / get(id)
assignSeat(participant, seat)          // 占座会驱逐原占座者
```

关键语义：

- id 形如 `p_3f9a2c`，房间内唯一、不复用
- **同名 join 视为重连**，拿回原 id 和座位（agent 重启后能恢复身份）
- **占座会驱逐**：新参与者抢同一个颜色时，原占座者变成「无座」但仍在房间里

### 2.2 座位带身份

`shared/src/game.ts` 的 `PlayerSpec` 加了**可选** `id`：

```ts
interface PlayerSpec {
  id?: string;      // 新增，可选（旧快照没有）
  kind: ParticipantKind;
  name?: string;
}
```

为什么可选：engine 默认值和持久化快照只有 `kind`，设成必填会编译不过。**这个决定是刻意的，不要改成必填。**

### 2.3 按身份路由

`server/src/rooms/room.ts` 新增：

```ts
type ActorRef =
  | { participantId: string }   // 新路径，无歧义
  | { actor: Actor }            // 旧路径，只在唯一时可用

room.resolve(ref)               // → { ok, participant, seat } | { ok:false, code }
room.moveAs(ref, row, col)      // 按身份落子
room.resignAs(ref)              // 按身份认输
room.join(...) / room.leave(id) / room.getRoster()
```

`resolve` 的降级顺序：

1. 有 `participantId` → 直接查，查不到报 `PARTICIPANT_NOT_FOUND`，无座报 `NOT_SEATED`
2. 只有 `actor` → 按 kind 找已入座的，**恰好一个**才成功；两个报 `AMBIGUOUS_ACTOR`；零个再退回旧座位查找（兼容无 roster 的房间）

### 2.4 会话绑定身份（核心）

`server/src/core/session-context.ts` — `SessionBindings`

```ts
bindings.bind(sessionId, roomId, participantId)
bindings.participantOf(sessionId, roomId)
```

MCP 工具 `join_game` 把会话绑定到 participant，**之后所有工具调用自动以该身份执行**。模型从不传 id，所以不会传错、也无法冒充。

`server/src/mcp/http.ts` 的 `InProcessApi.actorRef()` 就是读这个绑定，读不到才退回 `{ actor: 'agent' }`。

### 2.5 新工具与端点

MCP 工具（`server/src/mcp/tools.ts`）：

| 工具 | 说明 |
|---|---|
| `join_game` | `{roomId, name?, seat?, kind?}` → `{participantId, name, seat, state, participants}` |
| `leave_room` | `{roomId}` → `{ok}` |

REST（`server/src/http/routes.ts`）：

| 方法 | 路径 |
|---|---|
| `GET` | `/api/rooms/:roomId/participants` |
| `POST` | `/api/rooms/:roomId/participants` |
| `DELETE` | `/api/rooms/:roomId/participants/:participantId` |

身份传递：HTTP header `X-Gomoku-Participant`，或 body 字段 `participantId`，或 query `participantId`。

### 2.6 修掉的两个 bug（别改回去）

1. **`new_game` 丢身份**：原来只按 `agentColor` 重建座位，把 join 建立的 id/name 抹掉。现在座位**优先从 roster 取**（`seatSpecOf()`），`agentColor` 只在没人入座时兜底。
2. **`wait_for_turn` 等错座位**：原来等「唯一的 agent 座位」，双 AI 时第二个 agent 等错颜色。现在按调用者身份解析，返回 `yourColor` 是调用者自己的颜色。

### 2.7 错误码

`NO_AGENT_SEAT` 已被取代，新码：

| 码 | 含义 | HTTP |
|---|---|---|
| `IDENTITY_REQUIRED` | 没传 id，房间也推断不出 | 400 |
| `PARTICIPANT_NOT_FOUND` | id 不在房间 | 404 |
| `NOT_SEATED` | 有这个人但没座位 | 400 |
| `AMBIGUOUS_ACTOR` | 两个同 kind，actor 无法区分 | 409 |
| `SEAT_TAKEN` | 保留，当前占座用驱逐而非拒绝 | 409 |

### 2.8 测试现状

**166 个测试全绿**。相关文件：

| 文件 | 覆盖 |
|---|---|
| `server/test/participant-roster.test.ts` | 名册语义（8 个） |
| `server/test/room-identity.test.ts` | 身份路由（12 个） |
| `server/test/dual-agent.test.ts` | **双 AI 端到端**（4 个，两个真实 MCP 会话打完一盘） |
| `server/test/presence.test.ts` | presence 规则（31 个，含 participantId 断言） |
| `server/test/presence-wire.test.ts` | presence 跨 WS/MCP（4 个） |

跑测试：

```powershell
cd E:\code\fun\gomoku-mcp-p1b
pnpm test
```

### 2.9 任务 A：presence 视图带身份（f2d7942，2026-10-25）

`ParticipantView` 新增**可选** `participantId`，`snapshot()` 从 `PlayerSpec.id` 读取；
座位后面没人（engine 默认、旧快照）时省略该字段。`getParticipants()` 的无注册表兜底
路径同样填充。信号键保持按座位（见任务 A 的「注意」）。新增断言：单元测试 2 个
（presence.test.ts）+ 端到端 RoomView 与 roster 一致（dual-agent.test.ts）。

### 2.10 任务 B：Web 双 AI 观战（6a2f741，2026-10-25）

`seatColors()` 在两座皆 agent 时返回 `spectator: true`（human/agent 均为 null），
各表面随之渲染：

- **StatusBar**：观战文案（观战中 / 轮到黑棋 / 黑方获胜），座位卡按黑白各渲染一张，
  双方名字 + presence 都显示
- **Controls**：开局/认输按钮换成「观战中」chip
- **ResultOverlay**：印章与标题报获胜方颜色（黑/白），不提供「再来一局」
- **CommentaryPanel**：meta 显示「双 AI 对弈」，thinking 指示跟随当前行棋方
- 页眉副标题对观战者不再说「你在网页落子」

棋盘无需改动：`canPlay` 依赖 `humanColor`，观战时天然只读。人类局走
`spectator: false` 路径，渲染与之前逐字节一致（已实测）。

### 2.11 掉线推送修复（d65b152，2026-10-25）

实测任务 B 时发现：**agent 掉线后，打开着的网页不刷新就看不到「已断开」**。原因是
sweep() 跳过所有带 viewer 的房间——这是 c348f45 里 `watchedAt` 时代的语义，
ad9b870 删掉 `watchedAt` 后成了遗留：它不再保护任何东西，唯一效果是阻止过期
agent 会话触发 emit，于是正在看棋盘的那一个标签页永远收不到掉线推送（REST 和
刷新后的页面倒是对的，因为 snapshot 按空闲窗口现算）。修复：sweep 不再跳过
watched 房间；viewer 只是人类座位的证据，对 agent 会话毫无说明力。 parked wait
的逐座跳过保留。已实测：页面开着不动，两个 agent 消失后 90s+15s 内标签页自行
翻成「已断开」。

---

## 3. 你要做的（按顺序）

### 任务 A：presence 改为按 participant 键 ⭐ 最重要 —— **已完成（f2d7942，见 2.9）**

**问题**：`server/src/core/presence.ts` 现在按**座位**存信号（`keyOf(roomId, seat)`）。双 AI 时两个 agent 都叫「agent 座位」，但座位只有黑/白两个——信号是对的，**但 `ParticipantView` 里没有 participantId**，UI 无法把 presence 和具体的人对应起来。

**要做**：

1. `shared/src/presence.ts` 的 `ParticipantView` 加 `participantId?: string`（可选，兼容无 roster 的房间）
2. `presence.snapshot()` 从 `seats` 里读 `PlayerSpec.id`，填进 `participantId`
3. `seatLabel()` 已经会用 `name`，无需改

**验收**：

- 两个 agent 各占一色时，`RoomView.participants` 里两项的 `participantId` 不同且与 roster 一致
- 现有 163 个测试仍全绿（新增 1-2 个针对 participantId 的断言）

**注意**：presence 的信号键**保持按座位**是对的，因为「谁占着黑座」本身由 roster 决定。**不要**把整个 presence 改成按 participantId 键，那会牵动 `rebindSeats` 等一堆逻辑，收益为零。

### 任务 B：Web 双 AI 观战布局 —— **已完成（6a2f741，见 2.10）**

**问题**：`web/src/store/room.ts` 的 `seatColors()` 假设「一个 human + 一个 agent」。双 AI 时两个座位都是 agent，`humanColor` 为 null，页面会显示「还没有开局」之类的错误文案。

**要做**：

1. `seatColors()` 增加判断：如果**两个座位都是 agent**，返回 `{ human: null, agent: null, spectator: true }`
2. `App.tsx` 在观战模式下：
   - 隐藏「执黑/执白开局」按钮（人类不占座）
   - 显示「观战中」标识
   - 棋盘只读（`canPlay` 已依赖 `humanColor !== null`，天然为 false）
3. 座位卡（`SeatBadge.tsx`）在双 AI 时显示两个 agent 的名字和 presence

**验收**：

- 两个 agent 入座后，网页显示双方名字 + 在线状态，棋盘不可点，没有「执黑开局」按钮
- 人类局（一 human 一 agent）行为完全不变

### 任务 C（可选，未做）：`join_game` 的 seat 缺省行为

现在 `join_game` 不带 `seat` 时，参与者进房间但不占座。可以再加一个便利：**如果房间有空座，自动占一个**。这样 agent 只调 `join_game(name: 'dsh')` 就能开始。

**是否要做由你判断**——我倾向做，因为能减少 agent 的心智负担。但要小心别破坏「明确指定颜色」的语义。

---

## 4. 之后还有（不要现在做）

### P1c：房间阶段 / 准备

设计见 `docs/proposals/PROPOSAL-PARTICIPANTS.md` 第 4.3 节。核心是加 `RoomPhase`：

```ts
type RoomPhase = 'lobby' | 'waiting' | 'playing' | 'paused' | 'finished';
```

- `POST /games` 只建局 → `ready` → 双方就绪才真正 `startGame`
- **`GameStatus` 不要动**（仍是 `idle/playing/finished`），`RoomPhase` 是房间层的新字段

### P2：双 AI 真实模型验证

用两个真实 MCP 客户端（DSH + Codex/Claude）各占一色打完一盘。测试已经证明协议层能跑，这步是验证**模型行为**（它会不会自觉 wait、会不会替对手落子）。

### 之后：围棋

**等 P2 完成后再开始**。原因：围棋要接 `new_game` 的 `game` 参数，而 P1c 也要改 `new_game`，同时做必冲突。

---

## 5. 硬性约束（踩了就返工）

| 约束 | 原因 |
|---|---|
| **`PlayerSpec.id` 保持可选** | engine 默认值和旧快照没有 id，设必填编译不过 |
| **`GameStatus` 不要加新值** | 会牵动 106 个既有测试和 MCP 契约 |
| **`RoomView` / `RoomSummary` 只增字段** | 网页和旧客户端依赖现有形状 |
| **presence 信号键保持按座位** | 改成 participantId 会牵动 rebindSeats，收益为零 |
| **旧 `actor` 路径必须保留** | ZCode 驱动脚本、旧 MCP 客户端还在用 |
| **`moveBy` / `resignBy` 不要删** | 是兼容层，删了旧脚本全挂 |
| **中文文案风格** | 现有 UI 是「AI 未接入」「思考中」这种短句，保持一致 |

---

## 6. 工作方式

### 分支

当前 worktree：`E:\code\fun\gomoku-mcp-p1b`，分支 `feat/participants-model`。

**不要直接改 main。** 做完一个任务就提交一次，提交信息用现有风格（看 `git log`）：

```text
feat(room): ...
fix(presence): ...
chore(web): ...
```

正文说清「为什么」，不只是「做了什么」。现有提交都带详细说明，照着写。

### 每次提交前

```powershell
cd E:\code\fun\gomoku-mcp-p1b
pnpm test          # 必须全绿
pnpm typecheck     # 必须通过
```

### 调试技巧

启动开发环境：

```powershell
pnpm dev           # 服务 3000 + Vite 5173
```

打开 http://localhost:5173/?room=default

**注意**：`tsx watch` 热重载**不会迁移 presence 内存状态**。改完 presence 相关代码后，**重启整个 dev**，否则会看到旧状态残留（我调试时被这个坑过两次）。

模拟一个 agent（不用真模型）：

```powershell
# 在另一个终端，用项目里的 SDK
node -e "
const { Client } = require('./node_modules/.pnpm/@modelcontextprotocol+sdk@1.32.1_zod@4.6.7/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StreamableHTTPClientTransport } = require('./node_modules/.pnpm/@modelcontextprotocol+sdk@1.32.1_zod@4.6.7/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js');
(async () => {
  const c = new Client({ name: 'probe', version: '0.1' });
  await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp')));
  const j = await c.callTool({ name: 'join_game', arguments: { roomId: 'default', name: 'dsh', seat: 'black' } });
  console.log(j.content[0].text);
})();
"
```

### 看状态

```powershell
curl http://127.0.0.1:3000/api/rooms/default   # 完整 RoomView（含 participants）
curl http://127.0.0.1:3000/api/rooms/default/participants  # roster
```

---

## 7. 已知的坑

| 坑 | 说明 |
|---|---|
| **热重载不迁移内存状态** | 改 presence/room 后必须重启 dev，否则状态错乱 |
| **MCP SDK 的 `client.close()` 不发 DELETE** | 服务端靠「会话静默 90 秒」判定掉线，测试里要等或直接 `terminateSession()` |
| **`place_stone` 返回 `{ok, state}`** | 不是直接返回视图，`boardText` 在 `state` 里 |
| **`new_game` 会重置 history 和 commentary** | 这是预期行为，不是 bug |
| **占座是驱逐而非拒绝** | 新参与者抢同色时，原占座者变无座但仍在房间 |

---

## 8. 完成标准

任务 A + B 做完，应该满足：

```text
[x] 两个 agent 各 join_game 占一色
[x] 网页显示双方名字 + 在线/思考状态
[x] 网页棋盘不可点，无「执黑开局」按钮
[x] 一个 agent 掉线，网页显示「已断开」（需 2.11 的修复，实测通过）
[x] 人类 vs agent 的老流程完全不变
[x] pnpm test 全绿（166 个）
[x] pnpm typecheck 通过
```

以上均已实测（2026-10-25，两个真实 MCP 会话 + 浏览器观战页）。**P2 可以开始了。**
