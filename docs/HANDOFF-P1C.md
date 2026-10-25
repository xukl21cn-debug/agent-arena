# 工作单：P1c · 大厅 / 准备 / 房间阶段

> 面向：GLM
> 状态：P3a 已合入 main（193 测试全绿），P1c 未开始
> 分支：从最新 main 新建 `feat/lobby`
> 预计：0.5–1 天
> 设计来源：`docs/proposals/PROPOSAL-PARTICIPANTS.md` §4.3、§5.2、§6

---

## 0. 先读什么

1. **本文件**（边界、坑、验收）
2. [`PROPOSAL-PARTICIPANTS.md`](proposals/PROPOSAL-PARTICIPANTS.md) §4.3（RoomPhase）、§5.2（ready）、§6（接口）
3. 现有实现：`server/src/rooms/room.ts`（`newGame` / `getView` / `getSummary`）、
   `shared/src/game.ts`（`RoomView` / `RoomSummary`）

---

## 1. 要解决什么问题

现在点「执黑开局」后只能干等，不知道 AI 是没连上还是在长考。P1a 解决了**在线状态**，
但还缺**准备阶段**：双方没齐就开局，等于对着空气下棋。

P1c 要做的：**双方 ready 才开局**，没齐时给出明确提示。

---

## 2. 这次做什么

```text
✅ 做：RoomPhase 类型 + 房间层 phase 字段
✅ 做：ready 状态（谁准备好了）
✅ 做：POST /api/rooms/:id/ready
✅ 做：MCP join_game 支持 ready 参数（可选）
✅ 做：RoomView / RoomSummary 增加 phase 字段
✅ 做：WS 推送 phase 变化
✅ 做：网页准备态（checklist + 60s 提示）
❌ 不做：围棋（P3b）
❌ 不做：聊天室（P4）
❌ 不做：改 GameStatus
```

---

## 3. 硬性约束（踩了就返工）

### 3.1 `GameStatus` 绝对不加新值

提案原文（§4.3 结尾）：

> **`GameStatus` 不动**（仍是 `idle/playing/finished`），`RoomPhase` 是房间层的新字段。
> 这样 106 个测试和现有 MCP 契约不受影响。

`GameStatus` 在 `shared/src/game.ts:4`。**不要动它**。`RoomPhase` 是**另一个类型**，
放在房间层（`shared/src/room.ts` 或 `shared/src/participant.ts`）。

现在有 193 个测试依赖 `GameStatus`，改它会连锁崩。

### 3.2 `RoomView` / `RoomSummary` 只增字段

```ts
// ✅ 只加
interface RoomView {
  ...现有字段全部保留...
  phase: RoomPhase;          // 新增
}

// ❌ 不要改现有字段的类型或名字
```

旧 Web 和旧客户端都在读这些字段。

### 3.3 旧流程必须还能立即开局

提案 §5.2 原文：

> **兼容**：没有 lobby 的旧流程（直接 `new_game`）仍然立即开局，新参与者自动 ready。

也就是说：

- `POST /api/rooms/:id/games { agentColor }` → **立刻开局**，`phase='playing'`
- 不能变成「必须双方 ready 才开局」，否则现有所有脚本和测试全挂

**默认行为不变，新行为是显式选择的。**

### 3.4 旧 `actor` 路径保留

`moveBy(actor, ...)` 继续可用，双 agent 时仍报 `AMBIGUOUS_ACTOR`。

---

## 4. 设计要点

### 4.1 RoomPhase 状态机

```ts
type RoomPhase = 'lobby' | 'waiting' | 'playing' | 'paused' | 'finished';
```

```text
lobby ──(human ready)──▶ waiting ──(both ready)──▶ playing ──(end)──▶ finished
  ▲                        │                          │
  └──────(cancel)──────────┘                          ▼
                                                   paused
```

| phase | 含义 |
|---|---|
| `lobby` | 座位未定或未齐，可加入/换座 |
| `waiting` | 座位已定，至少一方 ready，等另一方 |
| `playing` | 对局进行中 |
| `paused` | 掉线/暂停（**本轮可以先不做**，见 §6） |
| `finished` | 终局，只读 |

### 4.2 phase 和 GameStatus 的关系

两者**独立**，不要试图合并：

| 场景 | `phase` | `GameStatus` |
|---|---|---|
| 房间刚建 | `lobby` | `idle` |
| 一方 ready | `waiting` | `idle` |
| 双方 ready，开局 | `playing` | `playing` |
| 终局 | `finished` | `finished` |
| 旧流程直接 `new_game` | `playing` | `playing` |

注意最后一行：**旧流程跳过 lobby/waiting，直接 playing**。

### 4.3 ready 存在哪

`Participant` 加 `ready: boolean`（提案 §4 已定义）。

```ts
// server/src/rooms/participant-roster.ts 的 Participant
interface Participant {
  id: string;
  name: string;
  kind: 'agent' | 'human';
  seat: StoneColor | null;
  ready: boolean;        // ← 新增
  ...
}
```

**不要**把 ready 放进 `GameState.seats`——那是游戏状态，ready 是房间状态。

### 4.4 双方 ready 触发开局

```text
setReady(participantId, true)
  → 检查：两个座位都有人？两人都 ready？
  → 是：phase = 'playing'，调用 startGame
  → 否：phase = 'waiting'（至少一方 ready 时）或 'lobby'
```

**边界情况**：

- 只有一个人 ready，另一个人还没加入 → `waiting`
- 两个座位都有人，但只有一方 ready → `waiting`
- 一方 ready 后又取消 → 回 `lobby`（如果另一方也没 ready）
- 开局后再调 ready → 忽略或报错（建议幂等返回当前状态，不报错）

---

## 5. 接口

### 5.1 REST

```text
POST /api/rooms/:id/ready
  body: { participantId?, ready }
  → { state, history, commentary, phase, participants }

GET  /api/rooms/:id        → RoomView 多一个 phase
GET  /api/rooms            → RoomSummary 多一个 phase
```

`participantId` 可选：网页人类场景下由服务端绑定，不传就按 human 座位找。

### 5.2 MCP（可选，别做太多）

`join_game` 加一个可选参数：

```ts
join_game({ roomId, name?, seat?, ready? })
```

**不要**新增独立的 `ready` 工具——本轮先让 `join_game` 带参数就够。
新增工具会改工具列表，所有客户端都要重新适配。

### 5.3 WS

提案 §6.4：

```json
{"type":"phase","roomId":"lobby","phase":"playing"}
```

保留现有 `hello/state/commentary/pong`，**只新增** `phase` 事件。

---

## 6. `paused` 本轮可以不做

提案里有 `paused`（掉线暂停），但它牵扯「重连后恢复对局」，和 P2 的 §4.4
（长考假断线）纠缠在一起。**建议本轮先不实现 `paused`**：

- 类型里保留 `'paused'` 这个值（避免以后改类型）
- 但状态机暂时不产生它

如果实现中觉得不做不行，先停下来讨论，不要自己加逻辑。

---

## 7. 网页

提案 §8：

> 座位卡（顶栏两张）：名字、kind 徽标、presence 点、ready 勾。
> 准备阶段：`phase=lobby/waiting` 时显示 checklist 与「取消」，
> 60s 未齐给明确文案（「agent 未接入：检查 MCP 配置」+ 复制配置按钮）。

本轮最少要做到：

```text
[ ] phase=lobby/waiting 时，开局按钮变成「准备」按钮
[ ] 显示双方 ready 状态（勾/未勾）
[ ] 双方 ready 后自动开局
[ ] 60 秒未齐，显示提示文案
```

`paused` 相关 UI 不做。

---

## 8. 测试

### 8.1 必须新增

| 编号 | 内容 |
|---|---|
| R1 | 新房间 `phase='lobby'` |
| R2 | 一方 ready → `phase='waiting'` |
| R3 | 双方 ready → `phase='playing'`，对局开始 |
| R4 | 一方取消 ready → 回 `lobby` |
| R5 | 旧流程 `new_game` 直接 → `phase='playing'`（**兼容性关键**） |
| R6 | `RoomView` / `RoomSummary` 都带 `phase` |
| R7 | WS 收到 `phase` 事件 |

### 8.2 必须保持绿

```text
[ ] 193 个现有测试一个都不能挂
```

**R5 是最重要的**：它保证旧流程不被破坏。写测试时先写这条。

---

## 9. 完成标准

```text
[ ] RoomPhase 类型新增，GameStatus 未改
[ ] Participant 加 ready 字段
[ ] POST /api/rooms/:id/ready 可用
[ ] RoomView / RoomSummary 带 phase（只增字段）
[ ] 旧 new_game 流程仍立即开局
[ ] 网页准备态可用
[ ] pnpm test 全绿（193 + 新增）
[ ] pnpm typecheck 通过
```

### 自查

```powershell
cd E:\code\fun\agent-arena
pnpm test
pnpm typecheck
git diff --stat
```

`git diff --stat` 这次**会**出现多个文件（shared / server / web 都要改），
这是正常的。但要确认**没有** `server/src/core/` 下的文件（围棋引擎不该动）。

---

## 10. 提交

```powershell
git checkout -b feat/lobby
# ... 工作 ...
```

提交信息：

```text
feat(lobby): a ready phase, so a game starts when both sides are present

RoomPhase is a room-level field, deliberately not a new GameStatus value:
GameStatus is part of the MCP contract and 193 tests read it. The old
new_game path still starts immediately, so every existing script and client
keeps working without a ready call.
```

---

## 11. 做完之后

P1c 合入后，**P3b（围棋集成）就可以开始了**——它和 P1c 都改 `new_game`，
所以必须一前一后，不能并行。
