# 工作单：P3b-1 · 围棋类型契约（M0）

> 面向：GLM
> 状态：P1c 已合入 main（206 测试全绿），P3a 引擎已完成（`go.ts`）
> 分支：从最新 main 新建 `feat/go-types`
> 预计：0.5–1 天
> 规范来源：[`go-mcp.md`](../../proposals/go-mcp.md) §4

---

## 0. 为什么先做这一份

P3b 拆成三份工作单，**必须按顺序做**：

| 顺序 | 工作单 | 内容 | 依赖 |
|---|---|---|---|
| **1** | **本文件** | 类型契约（M0） | 无 |
| 2 | [P3b-2 工作单](../07-p3b-2-go-integration/handoff.md) | 接入 room/REST/MCP（M2） | 等本份合入 |
| 3 | [P3b-3 工作单](../08-p3b-3-go-scoring/handoff.md) | scoring 全流程（M3） | 等第 2 份合入 |

理由：类型是地基。第 2 份要给 `new_game` 加 `game` 参数、第 3 份要给
`wait_for_turn` 加 `scoring` 原因，两者都要动类型。**一次改完类型，后面两份只写逻辑。**

---

## 1. 这次只做什么

```text
✅ 做：shared 类型层加 game 判别（GameState + GoState + AnyGameState）
✅ 做：AnyMove（落子 / pass）
✅ 做：WaitReason 加 'scoring'
✅ 做：ErrorCode 加围棋错误码
✅ 做：五子棋代码适配新类型（engine/room/insights 编译通过）
✅ 做：现有 206 个测试全绿
❌ 不做：房间层支持围棋（第 2 份）
❌ 不做：MCP 新工具 pass/mark_dead/confirm_score（第 2、3 份）
❌ 不做：web 围棋盘（第 3 份之后）
❌ 不做：scoring 状态机（第 3 份）
```

**这一份的唯一交付物是「编译通过的、支持两种游戏类型的代码库」。**
功能一点都不能多。

---

## 2. 核心设计：低风险 union

提案 §4.1 明确要求：

> 不要直接把现有 `GameState` 改名成 union 再全仓库找编译错误。推荐：

```ts
// 保留名字 = 五子棋状态，降低迁移
export interface GameState {
  game: 'gomoku';        // 新增
  schemaVersion: 2;      // 1 → 2
  ...现有字段全部保留...
}

export interface GoState {
  game: 'go';
  schemaVersion: 2;
  rules: GoRules;
  board: (StoneColor | null)[][];
  turn: StoneColor;
  status: 'idle' | 'playing' | 'scoring' | 'finished';
  seats: Record<StoneColor, PlayerSpec>;
  winner: StoneColor | 'draw' | null;
  endReason: 'resign' | 'scored' | 'draw' | null;
  winLine: null;
  lastMove: GoMove | null;
  moveCount: number;
  version: number;
  updatedAt: string;
  captures: { black: number; white: number };
  lastCaptured: Cell[];
  koPoint: Cell | null;
  consecutivePasses: number;
  deadStones: Cell[];
  scoreConfirmed: Record<StoneColor, boolean>;
  score: GoScore | null;
}

export type AnyGameState = GameState | GoState;
```

**关键点**：`GameState` 这个名字继续指五子棋，不要改成 union。这样
`engine.ts` / `insights.ts` 等五子棋代码基本不用动，只有 `room.ts` 的公共入口
改成 `AnyGameState`。

### 2.1 `GoState.status` 多一个 `'scoring'`

注意：`GameStatus`（`'idle' | 'playing' | 'finished'`）**不要动**，那是五子棋的。

围棋的状态是**独立的**，可以直接写成 union 字面量：

```ts
// ✅ 围棋自己的状态，可以带 scoring
status: 'idle' | 'playing' | 'scoring' | 'finished';

// ❌ 不要给 GameStatus 加 'scoring'
export type GameStatus = 'idle' | 'playing' | 'scoring' | 'finished';
```

原因：`GameStatus` 被 206 个测试和 MCP 契约引用，加值会连锁。围棋的
`scoring` 只在 `GoState` 里出现，不污染公共类型。

**建议**：给围棋单独定义

```ts
export type GoStatus = 'idle' | 'playing' | 'scoring' | 'finished';
```

### 2.2 `schemaVersion` 升到 2

现有 `GameState.schemaVersion: 1`，要升到 `2`，因为加了 `game` 字段。

⚠️ **这会触发持久化迁移**：`server/src/rooms/repository.ts` 读旧快照时
`schemaVersion: 1` 没有 `game` 字段。两个选择：

| 方案 | 做法 | 推荐度 |
|---|---|---|
| A | 读到 v1 时补 `game: 'gomoku'`，升到 v2 | ✅ 推荐 |
| B | 直接不兼容，旧快照丢弃 | ❌ 会丢数据 |

选 A。迁移逻辑放 `repository.ts`，注释说明「v1 快照没有 game 字段，一律是五子棋」。

### 2.3 ⚠️ `go.ts` 已有同名类型，不要重复定义

P3a 的 `server/src/core/go.ts` 里**已经导出**了这些类型：

```text
GoRules / GoScore / GoBoard / GoErrorCode / GoMoveResult
GoGroupSummary / GoGroupsView / GoBoardTextOptions
```

而本工作单要求在 `shared/src/game.ts` 定义 `GoState` 等。

**处理原则：共享类型上提，实现留在 go.ts。**

| 类型 | 放哪 | 理由 |
|---|---|---|
| `GoRules` / `GoScore` / `GoBoard` | **上提到 `shared`** | `GoState` 要引用它们，web 也要读 `GoScore` |
| `GoGroupSummary` / `GoGroupsView` | **上提到 `shared`** | `GoAgentStateView` 要引用 |
| `GoErrorCode` | **上提到 `shared`** | 要并进 `ErrorCode` |
| `GoMoveResult` / `GoBoardTextOptions` | **留在 `go.ts`** | 纯实现细节，外面不需要 |
| `playMove` / `scoreBoard` / `summarizeGroups` / `renderGoBoardText` 等函数 | **留在 `go.ts`** | 实现 |

做法：把要上提的类型**搬到 `shared`**，`go.ts` 改成 `import type { ... } from '@arena/shared'`。

⚠️ **不要两处都定义**（一份在 shared、一份在 go.ts），那会导致类型不兼容的
诡异错误。搬走后 `go.ts` 里不要留副本。

⚠️ **`go.test.ts` 可能要跟着改 import**。这是预期的，不是返工。

---

## 3. Move / pass

提案 §4.2：

```ts
export interface GoPassMove {
  kind: 'pass';
  color: StoneColor;
  index: number;
  at: string;
}

export type GoMove = Move | GoPassMove;
export type AnyMove = Move | GoPassMove;
```

`Move` 现有形状（`row`/`col`/`color`/`index`/`at`）**不要改**，pass 用单独的
`GoPassMove`。

`MoveRecord`（给 agent 看的）加 `kind`：

```ts
export interface MoveRecord {
  kind: 'place' | 'pass';   // 新增
  row?: number;             // pass 时没有
  col?: number;
  color: StoneColor;
  index: number;
}
```

---

## 4. 要改的类型清单

### 4.1 `shared/src/game.ts`

```text
[ ] GameState 加 game: 'gomoku'，schemaVersion 改 2
[ ] 新增 GoState / GoStatus / GoRules / GoScore
[ ] 新增 GoPassMove / GoMove / AnyMove
[ ] MoveRecord 加 kind，row/col 改可选
[ ] WaitReason 加 'scoring'
[ ] ErrorCode 加：SUICIDE / KO / WRONG_GAME / NOT_SCORING /
    INVALID_DEAD_STONE / UNSUPPORTED_RULE
[ ] RoomView.state 改 AnyGameState，history 改 AnyMove[]
[ ] RoomSummary 加 game: 'gomoku' | 'go'
```

### 4.2 `shared/src/protocol.ts`

```text
[ ] MutationResponse / ErrorResponse 的 state 改 AnyGameState，history 改 AnyMove[]
[ ] AgentStateView 保留（五子棋），新增 GoAgentStateView，导出 AnyAgentStateView
[ ] AgentStateResponse / AgentWaitForTurnResponse 用 AnyAgentStateView
[ ] ServerMessage 的 state 改 AnyGameState
```

### 4.3 `shared/src/index.ts`

```text
[ ] 导出所有新类型
```

---

## 5. 五子棋代码怎么适配

原则：**能不改就不改**。

| 文件 | 要做什么 |
|---|---|
| `core/engine.ts` | `createInitialState` / `startGame` 返回值加 `game: 'gomoku'`，`schemaVersion: 2` |
| `core/insights.ts` | `toAgentStateView` 参数保持 `GameState`，加 `game: 'gomoku'` 到输出 |
| `core/rules.ts` | 不动 |
| `core/go.ts` | **不动**（P3a 已完成，第 2 份才接入） |
| `rooms/room.ts` | `state` 字段改 `AnyGameState`；`getState()` 返回类型跟着改；**逻辑暂只处理 gomoku**，遇到 `game === 'go'` 先抛「未实现」 |
| `rooms/repository.ts` | 加 v1→v2 迁移 |
| `mcp/api.ts` / `stdio.ts` / `http.ts` | 类型跟着改，逻辑不动 |

`room.ts` 里遇到围棋时的临时处理：

```ts
// 第 2 份工作单会实现真正的分派；在此之前围棋状态不可能出现。
if (this.state.game !== 'gomoku') {
  throw new RoomError('UNSUPPORTED_RULE', 'Go is not wired into rooms yet.');
}
```

---

## 6. 测试

### 6.1 必须保持绿

```text
[ ] 206 个现有测试一个都不能挂
```

这是本份工作单**最重要的验收项**。测试里没有直接构造 `GameState` 字面量
（都用 `createInitialState` / `startGame` 工厂），所以返工面比想象小。

### 6.2 建议新增

| 编号 | 内容 |
|---|---|
| T1 | `createInitialState` 返回 `game: 'gomoku'`、`schemaVersion: 2` |
| T2 | v1 快照能迁移成 v2（补 `game: 'gomoku'`） |
| T3 | `AnyMove` 里 pass 与 place 可区分 |
| T4 | 类型守卫：`state.game === 'go'` 时能收窄到 `GoState` |

T4 示例：

```ts
function assertGo(state: AnyGameState): GoState {
  if (state.game !== 'go') throw new Error('not go');
  return state;   // 应该能自动收窄，不需要 as
}
```

**如果收窄需要 `as`，说明 union 设计有问题**，停下来讨论。

---

## 7. 完成标准

```text
[ ] GameState 有 game: 'gomoku' 和 schemaVersion: 2
[ ] GoState / AnyGameState / AnyMove / GoPassMove 定义完整
[ ] GameStatus 未改（仍是 idle/playing/finished）
[ ] WaitReason 加 'scoring'
[ ] ErrorCode 加 6 个围棋错误码
[ ] 类型守卫不需要 as 就能收窄
[ ] v1 快照迁移到 v2
[ ] pnpm test 全绿（206）
[ ] pnpm typecheck 通过
[ ] pnpm build 通过（含 web）
```

### 自查

```powershell
cd E:\code\fun\agent-arena
pnpm test
pnpm typecheck
pnpm build
git diff --stat
```

`git diff --stat` 这次会动 `shared/`、`server/src/core/engine.ts`、
`server/src/core/insights.ts`、`server/src/rooms/`、`server/src/mcp/`、`web/src/`。

**但 `server/src/core/go.ts` 不该出现在 diff 里**（P3a 的成果，这份不动它）。

---

## 8. 提交

```text
feat(types): a game discriminant, so a room can hold either game

GameState keeps its name and now says game: 'gomoku'; GoState sits beside it
and AnyGameState is their union. Renaming GameState to a union would have
touched every gomoku file for no benefit.

GameStatus is untouched. Go's extra 'scoring' status lives in GoStatus, so the
MCP contract and the 206 existing tests never see it.

schemaVersion goes to 2; persisted v1 snapshots migrate by gaining
game: 'gomoku', since that was the only game that existed.
```

---

## 9. 做完之后

**停下来等评审。** 不要接着做第 2 份（[P3b-2](../07-p3b-2-go-integration/handoff.md)）——那份要改
`new_game` 的签名，必须在类型稳定之后单独做。
