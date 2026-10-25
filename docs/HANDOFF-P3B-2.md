# 工作单：P3b-2 · 围棋接入房间 / REST / MCP（M2）

> 面向：GLM
> 状态：**等 `HANDOFF-P3B-1.md`（类型契约）合入后再开始**
> 分支：从最新 main 新建 `feat/go-mode`
> 预计：1–1.5 天
> 规范来源：`docs/PROPOSAL-GO-MCP.md` §6、§7.1

---

## 0. 前置条件

```text
[ ] P3b-1 已合入 main（GameState 有 game 判别，GoState 已定义）
[ ] pnpm test 全绿（206 + P3b-1 新增）
[ ] server/src/core/go.ts 存在（P3a 成果）
```

**如果 P3b-1 没合入，不要开始这份。**

---

## 1. 这次做什么

```text
✅ 做：new_game 支持 game 参数（'gomoku' | 'go'）
✅ 做：房间层按 state.game 分派（落子/等待/认输）
✅ 做：GoAgentStateView（围棋雷达：气/块/提子）
✅ 做：MCP 工具 pass / mark_dead / confirm_score / resume_play（只加，不实现 scoring 逻辑）
✅ 做：REST 端点对应
✅ 做：SERVER_INSTRUCTIONS 分段（gomoku / go）
✅ 做：web 类型收窄到能编译（**不做围棋盘 UI**）
❌ 不做：scoring 状态机（第 3 份）
❌ 不做：网页围棋盘（第 3 份之后）
```

**注意**：`pass` / `mark_dead` 等工具这一份**只做接口和落子/pass 的引擎接入**，
scoring 流程（标死子、确认、数子）留给第 3 份。

---

## 2. `new_game` 的参数

提案 §6：

```ts
new_game({
  roomId,
  game?: 'gomoku' | 'go',   // 默认 'gomoku'
  boardSize?: number,        // go 只接受 9
  komi?: number,             // 默认 7.5
  koRule?: 'simple',         // 默认 simple
  agentColor?: StoneColor,
})
```

### 2.1 兼容性（关键）

```text
[ ] 不传 game → 等同现在的五子棋行为，旧客户端零改动
[ ] 传 game='go' 且 boardSize ≠ 9 → UNSUPPORTED_RULE
[ ] 传 game='go' 且 koRule ≠ 'simple' → UNSUPPORTED_RULE
```

提案 §0 第 2 条明确要求：

> v1 只做 9 路；`new_game` 对非 9 的 `boardSize` 先返回 `UNSUPPORTED_RULE`，
> **不要静默接受**。

### 2.2 房间绑定游戏类型

一个房间当前局绑定一种游戏。切换游戏等于开新局。

---

## 3. 房间层分派

`room.ts` 现在是五子棋专用。要改成按 `state.game` 分派：

```ts
moveAs(ref, row, col) {
  if (this.state.game === 'go') {
    return this.moveGo(ref, row, col);   // 新
  }
  return this.moveGomoku(ref, row, col); // 现有逻辑改名
}

passAs(ref) {
  if (this.state.game !== 'go') {
    return this.failure('WRONG_GAME', 'pass is only available in Go.');
  }
  // ...
}
```

### 3.1 围棋落子流程

```text
1. resolve 身份 → seat
2. 检查 status === 'playing'，否则 GAME_NOT_PLAYING
3. 检查 turn === seat，否则 NOT_YOUR_TURN
4. 调 go.ts 的 playMove(board, seat, row, col, koPoint)
   → 失败返回 SUICIDE / KO / CELL_OCCUPIED / OUT_OF_BOUNDS
   → 成功：更新 board、captures、lastCaptured、koPoint、consecutivePasses=0
5. 切换 turn，moveCount+1，version+1
6. 写 history（Move），emitState
```

**引擎已经处理好了提子/劫/自杀**，房间层只负责状态搬运。不要把规则再写一遍。

### 3.2 围棋 pass

```text
1. 检查 status / turn（同上）
2. 写 history（GoPassMove），consecutivePasses += 1
3. koPoint = null（pass 也清劫）
4. lastCaptured = []
5. 切换 turn，moveCount+1
6. consecutivePasses === 2 → status = 'scoring'（第 3 份实现细节，这份先留钩子）
```

---

## 4. GoAgentStateView

提案 §5.1。字段清单：

```ts
interface GoAgentStateView {
  game: 'go';
  boardText: string;          // 用 go.ts 的 renderGoBoardText
  turn: StoneColor;
  status: GoStatus;
  moveCount: number;
  lastMove: GoMove | null;
  komi: number;
  consecutivePasses: number;
  koPoint: Cell | null;
  moves: MoveRecord[];
  movesOmitted: number;
  captures: { black: number; white: number; lastCaptured: Cell[] };
  groups: GoGroupsView;       // 用 go.ts 的 summarizeGroups
  deadStones: Cell[];
  scoreConfirmed: Record<StoneColor, boolean>;
  scorePreview: GoScore | null;
  score: GoScore | null;
}
```

### 4.1 预算

提案 §5.2 / G18：**60 手 9 路局面序列化 ≤ 4000 字符**。

我实测过 P3a 的 `summarizeGroups` + `renderGoBoardText`：60 手局面约 2613 字符，
在预算内。但加上其他字段后要重新确认。

### 4.2 只给事实

提案 §5.2 原文：

> 只给事实：气数、坐标、块大小、提子；**不给"该逃/该弃/哪块死了"的结论**。

这条很重要——和 P2 的教训一致：**工具负责感知，判断留给模型**。

---

## 5. MCP 工具

提案 §6，工具从 8 个变 10 个：

| 工具 | 这一份做什么 |
|---|---|
| `new_game` | 加 `game` 等参数 |
| `get_state` | 按 `game` 返回不同视图 |
| `wait_for_turn` | 第 3 份加 `reason='scoring'`；这一份先不改语义 |
| `place_stone` | 按 `game` 分派校验 |
| `pass` | **新增**，仅 go |
| `mark_dead` | **新增**，仅 go + scoring（这一份先返回 `NOT_SCORING`） |
| `confirm_score` | **新增**，同上 |
| `resume_play` | **新增**，同上 |
| `resign` | 两游戏通用 |
| `say` | 通用 |

⚠️ **工具列表变了，所有客户端的工具快照都会更新。** 这是预期内的，但要
在提交信息里写清楚，方便用户知道需要重启客户端。

### 5.1 错误码

```text
SUICIDE / KO / WRONG_GAME / NOT_SCORING / INVALID_DEAD_STONE / UNSUPPORTED_RULE
```

`WRONG_GAME` 用在：五子棋房间调 `pass` / `mark_dead` / `confirm_score` / `resume_play`。

---

## 6. SERVER_INSTRUCTIONS 分段

提案 §5.3：

> 开头写"先读 `state.game`"，然后分两段

**gomoku 段**：保留现有 v0.4 的防守优先级（win/open4/double/four），**一字不改**。

**go 段**：

```text
1. 每次落子前先看 groups 里自己气=1 的块和对手气=1 的块；气数自己再数一遍；
2. 不要填自己的真眼；不要在没价值时自紧气；
3. koPoint 非空时不得立即回提；
4. 没有有价值的落子时再 pass；连续两次 pass 进入 scoring，不要为了不终局而乱下；
5. scoring 阶段用 mark_dead 标死子、confirm_score 确认；不同意就 resume_play；
6. captures 不是分数；面积分看 scorePreview，且预览不是终局。
```

⚠️ 提案 §5.3 结尾：

> 工具描述要与 instructions 同步，**不能只改一处**。

---

## 7. REST

提案 §7.1：

```text
POST /api/rooms/:id/games          { game?, agentColor?, boardSize?, komi?, koRule? }
POST /api/rooms/:id/pass           { actor? }
POST /api/rooms/:id/dead-stones    { row, col, actor? }
POST /api/rooms/:id/score/confirm  { actor? }
POST /api/rooms/:id/score/resume   { actor? }
```

这一份先实现 `games`（加参数）和 `pass`；`dead-stones` / `score/*` 留给第 3 份。

---

## 8. web 类型收窄

提案 §7.2 / M2 验收：

> M2 必须先把 web 的类型收窄到能编译（旧五子棋 UI 可暂不显示围棋入口）

也就是说：**`pnpm build` 必须过**，但网页上不需要围棋盘。

最小改动：

```text
[ ] web 里读 state 的地方加 game 判断（目前只处理 gomoku）
[ ] 围棋状态下网页显示「围棋模式暂未开放界面」之类的占位
[ ] 不要为了编译而 `as any`
```

---

## 9. 测试

### 9.1 必须保持绿

```text
[ ] 206 + P3b-1 新增，一个都不能挂
```

### 9.2 必须新增

| 编号 | 内容 |
|---|---|
| G7 | `new_game({game:'go'})` 后房间进入围棋模式 |
| G8 | 围棋视图序列化 ≤ 4000 字符（60 手局面） |
| G17 | 五子棋房间调 `pass` → `WRONG_GAME` |
| N1 | `new_game({game:'go', boardSize: 13})` → `UNSUPPORTED_RULE` |
| N2 | 围棋落子：提子后 `captures` 正确 |
| N3 | 围棋自杀 → `SUICIDE`，棋盘不变 |
| N4 | 围棋劫 → 立即回提 `KO` |
| N5 | `pass` 计入 moveCount 和 history |
| N6 | 不传 `game` → 仍是五子棋（兼容） |

---

## 10. 完成标准

```text
[ ] new_game 支持 game 参数，默认 gomoku
[ ] 房间层按 state.game 分派
[ ] GoAgentStateView 字段齐全
[ ] 4 个新 MCP 工具（pass / mark_dead / confirm_score / resume_play）
[ ] SERVER_INSTRUCTIONS 分段，工具描述同步
[ ] REST games + pass
[ ] web 能编译（围棋显示占位）
[ ] pnpm test 全绿
[ ] pnpm typecheck + build 通过
```

> ⚠️ **关于 `core/go.ts` 的 diff**：这份工作单**会让 `go.ts` 被真正调用**，
> 所以它出现在 diff 里是预期的。判断标准是「**有没有逻辑改动**」，
> 不是「有没有出现」。
>
> 如果需要给 `go.ts` 加函数（比如为视图加个辅助），加是允许的——
> 但**规则逻辑不要改**。P3a 的引擎已经过独立审计，改它要非常小心。
>
> 上一条工作单（P3b-1）的自查里我写了「`go.ts` 不该出现在 diff」，
> 那句话是错的（搬类型必然要动它），已在该份评审里认过。

---

## 11. 提交

```text
feat(go): wire the 9x9 engine into rooms, REST and MCP

new_game gains a game parameter defaulting to gomoku, so every existing client
keeps its behaviour. Sizes other than 9 and ko rules other than simple are
rejected with UNSUPPORTED_RULE rather than silently accepted.

The room dispatches on state.game; the rules stay in core/go.ts and are never
reimplemented here. Four tools are added (pass, mark_dead, confirm_score,
resume_play) — the scoring behaviour behind them lands in the next change, so
they answer NOT_SCORING for now.

Note for clients: the tool list grew from 8 to 10, so tool snapshots refresh.
```

---

## 12. 做完之后

停下来等评审。第 3 份（scoring 全流程）在第 2 份合入后再开始。
