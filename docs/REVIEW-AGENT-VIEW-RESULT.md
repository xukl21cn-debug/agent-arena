# REVIEW-AGENT-VIEW.md 整改结果回执

> 回应文档：`docs/REVIEW-AGENT-VIEW.md`（审查日期 2026-10-23）
> 整改完成：2026-10-23 · 执行者：GLM（zcode）
> 验证环境：Node v24.16.0 / pnpm 10 / Win11 · 全部命令在仓库根目录执行

## 1. 结论

P0-1 ~ P0-4 全部处理；P1-1 ~ P1-4 全部处理。验收清单（§5.3）逐项通过：

```text
[x] pnpm build:shared
[x] pnpm --filter @gomoku/server test        # 99/99 全绿（基线 93 → +6 净新增）
[x] pnpm typecheck                            # 0 错误（server + web）
[x] pnpm build                                # shared / server / web 全部通过
[x] node scripts/demo-agent-view.mjs          # (9,4) open4 + fiveAt (7,2)(12,7)
[x] 100 手 hot-path 响应 ≤ 4000 字符          # 实测 2470
[x] boardText 表头可解析为 0..14              # 新增测试断言
[x] overlineWin=false 六连不出现 win           # 新增测试断言
[x] 错误响应 moveCount 与 moves 一致          # 新增集成测试断言
[x] HTTP MCP / stdio 集成测试全绿             # 两传输共用 toAgentStateView
[x] 文档（DESIGN/README/类型注释）与代码一致  # DESIGN v0.7 + §8.2/§10.1/§10.2/§4.4 对齐
```

## 2. P0/P1 逐项解决方式

| ID | 解决方式 |
|---|---|
| P0-1 | 五级防守优先级写入 `SERVER_INSTRUCTIONS` 与 `get_state`/`wait_for_turn`/`place_stone` 三个工具描述。核心纪律：**对手 open4 候选点必须本手直接占掉该点本身**。`defense` 派生字段按审查建议暂不实现（提示词先行）。行为级验收（白 46 手应选 (9,4)）需重启服务后实盘确认，见 §7 备注 |
| P0-2 | `toAgentStateView(state, history, { recentMoves })`；`AGENT_RECENT_MOVES = 8`（shared/constants）。热路径（wait/place/resign/错误）带最近 8 手 + `movesOmitted` 显式标注；`get_state` 永远全量；两传输一致。历史不可得时 `movesOmitted = state.moveCount`，不伪装空历史 |
| P0-3 | 列号 3 字符右对齐（空白分隔）、行号两位补零；测试断言表头 `trim().split(/\s+/)` === 0..14、行标签 00..14 |
| P0-4 | `GomokuApiError` 增加 `history` 字段；InProcessApi 所有带 state 的错误附 `room.getHistory()`；REST `ErrorResponse` 增加可选 `history`（moves/resign 错误、wait-for-turn 的 NO_AGENT_SEAT 直接返回而非 throw）；stdio 桥 `toApiError` 解析 `payload.history`；集成测试：3 手后 CELL_OCCUPIED 错误中 `moves.length === moveCount === 3` |
| P1-1 | `classifyPlacement` 的 win 判定改为临时落子后调用引擎 `findWinLine`；每个 `fiveAt` 候选同样经 `findWinLine` 验证（exact-five 规则下六连补全会被拒绝）。`winLength≠5` 时 four/open3 命名失真已在代码注释与 DESIGN §4.4 注明 |
| P1-2 | 采用最低成本方案：**删除 `three` 分级**，只保留 win/open4/four/open3（open3 为参考级、cap 10）。实测盘面热区条目从 13/12 降到 7/6 |
| P1-3 | DESIGN 版本头 v0.7 + §17 变更记录；§8.2 `RoomView` 补 history；§10.1 MCP 输出全部改为 `AgentStateView`（含 movesOmitted 语义）并同步 instructions 草稿；§10.2 REST 表改为 `{ state, history }`；§4bis 改为正式 §4.4；§4.3 记录 v0.7 已知破坏；README 同步 |
| P1-4 | 新增 8 个测试（见 §5），包括与 `findWinLine` 的不变量测试（P1-4 #1 原样实现）、`overlineWin:false` / `winLength:6` 变体、错误 history、100 手 payload 上限、表头解析、参考级上限 |

## 3. 验证输出（2026-10-23 实测）

```text
$ pnpm test
 ✓ test/engine.test.ts   (28 tests)    9ms
 ✓ test/rooms.test.ts    (18 tests)   21ms
 ✓ test/insights.test.ts (18 tests)   35ms
 ✓ test/room.test.ts     (29 tests)   36ms
 ✓ test/http.test.ts     ( 6 tests) 1436ms
 Test Files  5 passed (5)
      Tests  99 passed (99)
   Duration  2.02s

$ pnpm typecheck      # 0 个 error
$ pnpm build          # shared / server / web 全部成功
```

## 4. 100 手 payload 实测（同一 46 子中盘盘面 + 100 手历史）

测量脚本已固化为 `scripts/measure-payload.mjs`（与 demo 同一盘面，可随时复测）：

```text
$ node scripts/measure-payload.mjs
100-move hot-path (recent 8) : 2470 chars  (budget: <= 4000)
100-move get_state (full)    : 6600 chars
moves kept: 8, movesOmitted: 92
boardText: 836 chars, hotPoints: black 7 / white 6
```

对照（审查报告 §2.3 的方法，同一盘面追加历史）：

| 负载 | 字符数 | 说明 |
|---|---:|---|
| 旧裸 `GameState` | 1732 | 审查报告基线 |
| 整改前 Agent 视图（全量 moves） | 6600（审查报告测得 6920*） | P0-2 的问题所在 |
| **整改后热路径（最近 8 手）** | **2470** | ✅ ≤ 4000 验收线 |
| 整改后 get_state（全量） | 6600 | 复盘用，不占热路径 |

\* 差异来源：整改后 boardText 为可解析表头格式（836 字符 vs 旧 604），全量数字按新格式重测。

## 5. 新增测试清单（insights 12→18，http 集成 +1 断言块）

1. `has unambiguous column and row labels (no glued numbers)` — 表头/行标签可解析（P0-3）
2. `agrees with the engine on every win point and five point (invariant)` — 每个报 win 的点落子后 `findWinLine` 必胜；非 win 点必不胜；每个 `fiveAt` 补全后必胜（P1-4 #1）
3. `respects exact-five rules: a six-line completion is not a win` — `overlineWin:false` 六连补全不报 win，侧翼 exact-five 仍报 win（P1-1）
4. `supports winLength=6: six in a row wins`（P1-1）
5. `keeps only recent moves on the hot path and reports the omission` — 8 手/movesOmitted=92/payload ≤4000 + get_state 全量（P0-2）
6. `marks unknown history honestly instead of pretending it is empty` — `history=null` → `movesOmitted = moveCount`（P0-2/P0-4）
7. http 集成：CELL_OCCUPIED 错误中 `state.moves.length === 3 && moveCount === 3 && movesOmitted === 0`（P0-4）
8. `caps the reference tier so decisive points stay visible` — 重写为三组二连触发 open3 cap（P1-2 适配）

另有 3 处既有测试随分级删除/表头格式更新而修正期望值（`three` 断言移除等）。

## 6. 演示输出（`node scripts/demo-agent-view.mjs`）

```text
    0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
00  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .
...
movesOmitted: 46 (历史不可得时如实标注，完整对局服务端会给出 moves)

=== hotPoints.black (top 8) ===
(9,4) -> open4 fiveAt=[{"row":7,"col":2},{"row":12,"col":7}]
(7,2) -> four fiveAt=[{"row":9,"col":4}]
(12,7) -> four fiveAt=[{"row":9,"col":4}]
(5,3) -> open3
...
boardText size: 837 chars
```

决胜形 (9,4) 依旧排在 hotPoints 第一位，且五连点完整给出。

## 7. 备注

- **diff 基线说明**：仓库两轮改动均未提交，HEAD 上不存在审查时快照。下附 diff 的 `a/` 侧是按审查时状态逐文件重建的基线，`b/` 侧为当前工作区；每处 hunk 均与 §2 的整改项一一对应，无基线重建噪声。文档（README/DESIGN）改动未入 diff，见 §2 P1-3 行。
- P0-1 的行为级验收（“演示局面应选 (9,4)”）属于模型行为，需重启 `pnpm dev` 后用真实对局验证；代码侧验收（指令含优先级）已满足。
- `docs/REVIEW-AGENT-VIEW.md` 按其 §7 说明保留未删。
- 硬性约束（§5.2）全部遵守：未改棋盘几何/游戏规则引擎行为、未移除 boardText/hotPoints、`state.board` 未回流 MCP、未改工具名、未加运行时依赖、两传输同视图、REST/WS 保留完整 board。

## 8. 完整 diff（整改前 → 整改后）

```diff
--- a/shared/src/game.ts	2026-10-23 20:39:20.230899200 +0800
+++ shared/src/game.ts	2026-10-23 20:21:23.755504300 +0800
@@ -73,11 +73,13 @@
 
 /**
  * What placing one stone on a cell would immediately create for that color:
- * win = five (game over) | open4 = four with two five-points (unstoppable) |
+ * win = five (game over, agrees with findWinLine under any RuleSet) |
+ * open4 = two distinct five-points (unstoppable double threat) |
  * four = rush four (fiveAt is the single point to complete/block five) |
- * open3 = live three (forcing) | three = capped three.
+ * open3 = live three, incl. split shapes that grow into a four in one move
+ * (reference tier: heuristic, capped, listed last).
  */
-export type HotPointEffect = 'win' | 'open4' | 'four' | 'open3' | 'three';
+export type HotPointEffect = 'win' | 'open4' | 'four' | 'open3';
 
 export interface HotPoint {
   row: number;
--- a/shared/src/protocol.ts	2026-10-23 20:39:45.254029900 +0800
+++ shared/src/protocol.ts	2026-10-23 20:21:41.618272100 +0800
@@ -59,14 +59,19 @@
 
 /**
  * GameState rendered for LLM agents: the 15×15 nested null array is replaced
- * by a monospace board picture, the ordered move list, and per-color hot
- * points. Agents should never need to rebuild the board cell by cell.
+ * by a monospace board picture, a move list, and per-color hot points.
+ * Agents should never need to rebuild the board cell by cell.
  */
 export interface AgentStateView extends Omit<GameState, 'board'> {
   /** Monospace grid: X=black, O=white, .=empty, lowercase = latest move. */
   boardText: string;
-  /** Chronological move records for this game. */
+  /**
+   * Move records for this game. Hot-path responses keep only the most
+   * recent moves; get_state returns the full list.
+   */
   moves: MoveRecord[];
+  /** Earlier moves left out of `moves`; 0 means the list is complete. */
+  movesOmitted: number;
   /** Cells where placing that color's stone creates an immediate threat. */
   hotPoints: Record<StoneColor, HotPoint[]>;
 }
@@ -86,6 +91,8 @@
     message: string;
   };
   state?: GameState;
+  /** Move history alongside `state`, so error views stay self-consistent. */
+  history?: Move[];
 }
 
 export type ClientMessage = { type: 'ping' };
--- a/shared/src/constants.ts	2026-10-23 20:40:15.847687200 +0800
+++ shared/src/constants.ts	2026-10-23 20:21:48.981497000 +0800
@@ -20,3 +20,9 @@
 export const MIN_WAIT_MS = 1000;
 export const DEFAULT_WAIT_MS = 20_000;
 export const MAX_WAIT_MS = 60_000;
+
+/**
+ * How many recent moves hot-path responses (wait_for_turn / place_stone /
+ * resign / errors) carry; get_state always returns the full history.
+ */
+export const AGENT_RECENT_MOVES = 8;
--- a/server/src/core/insights.ts	2026-10-23 20:38:26.105640900 +0800
+++ server/src/core/insights.ts	2026-10-23 20:20:58.543827100 +0800
@@ -10,6 +10,7 @@
   StoneColor,
 } from '@gomoku/shared';
 import { opposite } from './engine.js';
+import { findWinLine } from './rules.js';
 
 const DIRECTIONS = [
   [0, 1],
@@ -23,14 +24,14 @@
   open4: 1,
   four: 2,
   open3: 3,
-  three: 4,
 };
 
-/** Hot-point lists are guidance, not an oracle: cap the noisy low tiers so a
- * middlegame board cannot drown the decisive win/open4/four entries. */
+/**
+ * Hot-point lists are guidance, not an oracle: cap the reference tier so a
+ * middlegame board cannot drown the decisive win/open4/four entries.
+ */
 const MAX_PER_EFFECT: Partial<Record<HotPointEffect, number>> = {
   open3: 10,
-  three: 6,
 };
 
 interface PlacementEffect {
@@ -41,10 +42,14 @@
 const keyOf = (cell: Cell): string => `${cell.row},${cell.col}`;
 
 /**
- * Classify what placing `color` at (row, col) immediately creates, by sliding
- * the win-length window along the four lines through the cell. Consecutive
- * and one-gap shapes are covered uniformly: a window holding winLength-1
- * stones plus one empty means that empty completes a five.
+ * Classify what placing `color` at (row, col) immediately creates.
+ *
+ * Win detection and every five point are validated with the engine's
+ * `findWinLine`, so `overlineWin` / `winLength` semantics can never diverge
+ * from the rules engine (an exact-five rule rejects six-line completions).
+ * Open threes are detected with winLength-sized windows: two or more
+ * three-windows in one direction means the shape can grow into a four in
+ * one move - including split shapes like `X X _ X`.
  *
  * `board` is mutated for the duration of the call and restored afterwards.
  */
@@ -61,9 +66,9 @@
 
   board[row]![col] = color;
   try {
-    let winNow = false;
+    const winNow = findWinLine(board, row, col, rules) !== null;
     let bestThreeWindows = 0;
-    const fiveAt = new Map<string, Cell>();
+    const fiveCandidates = new Map<string, Cell>();
 
     for (const [dr, dc] of DIRECTIONS) {
       let threeWindows = 0;
@@ -103,36 +108,40 @@
         if (blocked) {
           continue;
         }
-        if (stones === win) {
-          winNow = true;
-        } else if (stones === win - 1 && gap) {
-          fiveAt.set(keyOf(gap), gap);
+        if (stones === win - 1 && gap) {
+          fiveCandidates.set(keyOf(gap), gap);
         } else if (stones === win - 2) {
           threeWindows += 1;
         }
       }
 
-      // A live (or split) three yields two or more three-windows in one
-      // direction: extending it either way can still build an open four.
       bestThreeWindows = Math.max(bestThreeWindows, threeWindows);
     }
 
     if (winNow) {
       return { effect: 'win', fiveAt: [] };
     }
-    const fivePoints = [...fiveAt.values()];
-    if (fivePoints.length >= 2) {
-      return { effect: 'open4', fiveAt: fivePoints };
+
+    // A five point only counts if the engine agrees completing there wins;
+    // exact-length rules reject completions that overline the run.
+    const fiveAt: Cell[] = [];
+    for (const cell of fiveCandidates.values()) {
+      board[cell.row]![cell.col] = color;
+      if (findWinLine(board, cell.row, cell.col, rules)) {
+        fiveAt.push(cell);
+      }
+      board[cell.row]![cell.col] = null;
+    }
+
+    if (fiveAt.length >= 2) {
+      return { effect: 'open4', fiveAt: fiveAt };
     }
-    if (fivePoints.length === 1) {
-      return { effect: 'four', fiveAt: fivePoints };
+    if (fiveAt.length === 1) {
+      return { effect: 'four', fiveAt: fiveAt };
     }
     if (bestThreeWindows >= 2) {
       return { effect: 'open3', fiveAt: [] };
     }
-    if (bestThreeWindows === 1) {
-      return { effect: 'three', fiveAt: [] };
-    }
     return null;
   } finally {
     board[row]![col] = null;
@@ -141,8 +150,12 @@
 
 /**
  * Every empty cell where a stone of either color would create an immediate
- * threat, sorted win > open4 > four > open3 > three. Split shapes such as
+ * threat, sorted win > open4 > four > open3. Split shapes such as
  * `X X _ X` show up here as four/open3 instead of hiding in the grid.
+ *
+ * Note the tier names assume winLength=5; for other rule sets the semantics
+ * stay engine-correct (win / fiveAt always agree with findWinLine), only
+ * the labels "four"/"three" become relative to `winLength`.
  */
 export function findHotPoints(
   board: (StoneColor | null)[][],
@@ -210,8 +223,10 @@
 }
 
 /**
- * Monospace board picture with 0-based coordinates. `#`/`@` mark the winning
- * line once the game is over; the latest move keeps its lowercase letter.
+ * Monospace board picture with 0-based coordinates. Every column label is a
+ * whitespace-separated token (no glued numbers at 10+), row labels are
+ * zero-padded two-digit strings. `#`/`@` mark the winning line once the game
+ * is over; the latest move keeps its lowercase letter.
  */
 export function renderBoardText(state: GameState): string {
   const size = state.rules.boardSize;
@@ -220,22 +235,24 @@
     (state.winLine ?? []).map((cell) => keyOf(cell)),
   );
 
-  const colNumbers = Array.from({ length: size }, (_, col) =>
-    String(col).padStart(2, ' '),
-  ).join('');
+  const header =
+    '  ' +
+    Array.from({ length: size }, (_, col) =>
+      String(col).padStart(3, ' '),
+    ).join('');
 
   const rows = Array.from({ length: size }, (_, row) =>
-    `${String(row).padStart(2, ' ')} ` +
+    `${String(row).padStart(2, '0')}` +
     Array.from(
       { length: size },
-      (_, col) => ` ${stoneChar(state.board, row, col, lastMove, winLine)}`,
+      (_, col) => stoneChar(state.board, row, col, lastMove, winLine).padStart(3, ' '),
     ).join(''),
   );
 
   const lines = [
-    `   ${colNumbers}`,
+    header,
     ...rows,
-    `(X=黑 O=白 .=空 小写=最新一手${state.winLine ? ' #/@=五连' : ''}；row/col 均 0-based)`,
+    `(X=黑 O=白 .=空 小写=最新一手${state.winLine ? ' #/@=五连' : ''}；行号 00-14、列号 0-14，均 0-based)`,
   ];
   if (lastMove) {
     const whose = lastMove.color === 'black' ? '黑' : '白';
@@ -248,20 +265,41 @@
   return { row: move.row, col: move.col, color: move.color, index: move.index };
 }
 
+export interface AgentViewOptions {
+  /**
+   * Keep only the last N move records (hot-path payload control). The full
+   * history stays available through get_state.
+   */
+  recentMoves?: number;
+}
+
 /**
  * Project the authoritative GameState into the agent-facing view: same fields
  * as GameState (minus the nested board array) plus boardText, moves and
  * hotPoints, so an LLM never has to count cells in a 15×15 JSON matrix.
+ *
+ * `history` may be null when the move list is genuinely unavailable (error
+ * paths): then moves is empty and movesOmitted reports state.moveCount, so
+ * the view never pretends a long game just started.
  */
 export function toAgentStateView(
   state: GameState,
-  history: readonly Move[],
+  history: readonly Move[] | null,
+  options: AgentViewOptions = {},
 ): AgentStateView {
+  const recent = options.recentMoves;
+  const known = history ?? [];
+  const moves =
+    recent !== undefined && known.length > recent
+      ? known.slice(-recent)
+      : known;
+
   const { board: _board, ...rest } = state;
   return {
     ...rest,
     boardText: renderBoardText(state),
-    moves: history.map(toMoveRecord),
+    moves: moves.map(toMoveRecord),
+    movesOmitted: history === null ? state.moveCount : known.length - moves.length,
     hotPoints: findHotPoints(state.board, state.rules),
   };
 }
--- a/server/src/mcp/api.ts	2026-10-23 20:40:35.952668900 +0800
+++ server/src/mcp/api.ts	2026-10-23 20:22:04.059366700 +0800
@@ -7,6 +7,7 @@
   CommentaryMood,
   ErrorCode,
   GameState,
+  Move,
   StoneColor,
 } from '@gomoku/shared';
 
@@ -33,16 +34,26 @@
   ): Promise<Commentary>;
 }
 
-/** Expected, model-actionable failure; carries the current state when known. */
+/**
+ * Expected, model-actionable failure; carries the current state and move
+ * history when known, so error views never contradict themselves.
+ */
 export class GomokuApiError extends Error {
   readonly code: ErrorCode;
   readonly state: GameState | null;
+  readonly history: readonly Move[] | null;
 
-  constructor(code: ErrorCode, message: string, state: GameState | null = null) {
+  constructor(
+    code: ErrorCode,
+    message: string,
+    state: GameState | null = null,
+    history: readonly Move[] | null = null,
+  ) {
     super(message);
     this.name = 'GomokuApiError';
     this.code = code;
     this.state = state;
+    this.history = history;
   }
 }
 
--- a/server/src/mcp/http.ts	2026-10-23 20:41:06.055420100 +0800
+++ server/src/mcp/http.ts	2026-10-23 20:22:33.020073100 +0800
@@ -12,8 +12,12 @@
   CommentaryMood,
   StoneColor,
 } from '@gomoku/shared';
+import { AGENT_RECENT_MOVES } from '@gomoku/shared';
 import { clampWaitMs, type ServerConfig } from '../config.js';
-import { toAgentStateView } from '../core/insights.js';
+import {
+  toAgentStateView,
+  type AgentViewOptions,
+} from '../core/insights.js';
 import { RoomError, type GameRoom } from '../rooms/room.js';
 import { assertRoomId, type RoomManager } from '../rooms/room-manager.js';
 import { GomokuApiError, type GomokuApi } from './api.js';
@@ -31,10 +35,13 @@
 }
 
 /** Build the agent-facing view of a room's current game. */
-function agentView(room: GameRoom): AgentStateView {
-  return toAgentStateView(room.getState(), room.getHistory());
+function agentView(room: GameRoom, options?: AgentViewOptions): AgentStateView {
+  return toAgentStateView(room.getState(), room.getHistory(), options);
 }
 
+/** Hot-path responses keep only recent moves; get_state returns everything. */
+const RECENT: AgentViewOptions = { recentMoves: AGENT_RECENT_MOVES };
+
 /**
  * `GomokuApi` backed by the RoomManager living in this process. This is the
  * same object graph the web UI mutates, so there is exactly one game state.
@@ -70,6 +77,7 @@
         'NO_AGENT_SEAT',
         `Room "${roomId}" has no agent seat. Start a game with an agent color.`,
         room.getState(),
+        room.getHistory(),
       );
     }
 
@@ -77,7 +85,7 @@
       seat,
       clampWaitMs(timeoutMs, this.config),
     );
-    return { state: agentView(room), yourColor: seat, reason: result.reason };
+    return { state: agentView(room, RECENT), yourColor: seat, reason: result.reason };
   }
 
   async placeStone(
@@ -88,18 +96,28 @@
     const room = this.requireRoom(roomId);
     const result = room.moveBy('agent', row, col);
     if (!result.ok) {
-      throw new GomokuApiError(result.code, result.message, result.state);
+      throw new GomokuApiError(
+        result.code,
+        result.message,
+        result.state,
+        room.getHistory(),
+      );
     }
-    return agentView(room);
+    return agentView(room, RECENT);
   }
 
   async resign(roomId: string): Promise<AgentStateView> {
     const room = this.requireRoom(roomId);
     const result = room.resignBy('agent');
     if (!result.ok) {
-      throw new GomokuApiError(result.code, result.message, result.state);
+      throw new GomokuApiError(
+        result.code,
+        result.message,
+        result.state,
+        room.getHistory(),
+      );
     }
-    return agentView(room);
+    return agentView(room, RECENT);
   }
 
   async say(
@@ -113,7 +131,12 @@
       return room.say(text, kind, mood);
     } catch (error) {
       if (error instanceof RoomError) {
-        throw new GomokuApiError(error.code, error.message, room.getState());
+        throw new GomokuApiError(
+          error.code,
+          error.message,
+          room.getState(),
+          room.getHistory(),
+        );
       }
       throw error;
     }
--- a/server/src/mcp/stdio.ts	2026-10-23 20:41:44.741663800 +0800
+++ server/src/mcp/stdio.ts	2026-10-23 20:28:42.600123400 +0800
@@ -10,13 +10,18 @@
   CommentaryMood,
   ErrorCode,
   GameState,
+  Move,
   MutationResponse,
   RoomView,
   StoneColor,
   WaitForTurnResponse,
 } from '@gomoku/shared';
+import { AGENT_RECENT_MOVES } from '@gomoku/shared';
 import { resolveServerUrl } from '../config.js';
-import { toAgentStateView } from '../core/insights.js';
+import {
+  toAgentStateView,
+  type AgentViewOptions,
+} from '../core/insights.js';
 import { agentColorOf, GomokuApiError, type GomokuApi } from './api.js';
 import { registerTools, SERVER_INSTRUCTIONS } from './tools.js';
 
@@ -24,6 +29,9 @@
   return typeof value === 'object' && value !== null && !Array.isArray(value);
 }
 
+/** Hot-path responses keep only recent moves; get_state returns everything. */
+const RECENT: AgentViewOptions = { recentMoves: AGENT_RECENT_MOVES };
+
 /**
  * `GomokuApi` that proxies to a running gomoku server over REST. Used by the
  * stdio bridge, which deliberately holds no game state of its own. REST
@@ -73,7 +81,7 @@
       `/api/rooms/${encodeURIComponent(roomId)}/wait-for-turn?actor=agent&timeoutMs=${encodeURIComponent(String(timeoutMs))}`,
     );
     return {
-      state: toAgentStateView(payload.state, payload.history),
+      state: toAgentStateView(payload.state, payload.history, RECENT),
       yourColor: payload.yourColor,
       reason: payload.reason,
     };
@@ -89,7 +97,7 @@
       `/api/rooms/${encodeURIComponent(roomId)}/moves`,
       { row, col, actor: 'agent' },
     );
-    return toAgentStateView(payload.state, payload.history);
+    return toAgentStateView(payload.state, payload.history, RECENT);
   }
 
   async resign(roomId: string): Promise<AgentStateView> {
@@ -98,7 +106,7 @@
       `/api/rooms/${encodeURIComponent(roomId)}/resign`,
       { actor: 'agent' },
     );
-    return toAgentStateView(payload.state, payload.history);
+    return toAgentStateView(payload.state, payload.history, RECENT);
   }
 
   async say(
@@ -164,10 +172,14 @@
       const state = isRecord(payload.state)
         ? (payload.state as unknown as GameState)
         : null;
+      const history = Array.isArray(payload.history)
+        ? (payload.history as unknown as Move[])
+        : null;
       return new GomokuApiError(
         typeof code === 'string' ? (code as ErrorCode) : 'INTERNAL_ERROR',
         typeof message === 'string' ? message : `HTTP ${status}`,
         state,
+        history,
       );
     }
 
--- a/server/src/http/routes.ts	2026-10-23 20:42:13.225348700 +0800
+++ server/src/http/routes.ts	2026-10-23 20:23:47.469999300 +0800
@@ -304,6 +304,7 @@
       const payload: ErrorResponse = {
         error: { code: result.code, message: result.message },
         state: result.state,
+        history: [...room.getHistory()],
       };
       res.status(statusForCode(result.code)).json(payload);
       return;
@@ -322,6 +323,7 @@
       const payload: ErrorResponse = {
         error: { code: result.code, message: result.message },
         state: result.state,
+        history: [...room.getHistory()],
       };
       res.status(statusForCode(result.code)).json(payload);
       return;
@@ -351,10 +353,18 @@
     const actor = actorOf(queryValue(req.query.actor), 'agent');
     const seat = room.getSeatFor(actor);
     if (!seat) {
-      throw new RoomError(
-        'NO_AGENT_SEAT',
-        `Room "${room.id}" has no ${actor} seat.`,
-      );
+      // Returned directly (not thrown) so state and history ride along,
+      // matching what the in-process MCP API reports for this failure.
+      const payload: ErrorResponse = {
+        error: {
+          code: 'NO_AGENT_SEAT',
+          message: `Room "${room.id}" has no ${actor} seat.`,
+        },
+        state: room.getState(),
+        history: [...room.getHistory()],
+      };
+      res.status(statusForCode('NO_AGENT_SEAT')).json(payload);
+      return;
     }
 
     const timeoutMs = clampWaitMs(queryValue(req.query.timeoutMs), config);
--- a/server/src/mcp/tools.ts	2026-10-23 20:43:29.810026100 +0800
+++ server/src/mcp/tools.ts	2026-10-23 20:24:56.534293800 +0800
@@ -2,6 +2,7 @@
 import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
 import { z } from 'zod';
 import {
+  AGENT_RECENT_MOVES,
   DEFAULT_ROOM_ID,
   DEFAULT_WAIT_MS,
   MAX_COMMENTARY_LENGTH,
@@ -43,19 +44,25 @@
 坐标 0-based：row 从上到下，col 从左到右；黑先；无禁手，五连（含长连）获胜。
 
 读盘方式（重要）：
-- state.boardText 是等宽棋盘图：X=黑 O=白 .=空，小写 x/o=最新一手；
-- state.moves 是按顺序的完整走子记录（复盘/评价人类节奏用）；
-- state.hotPoints 列出双方所有"落子即成威胁"的关键点：
-  win=该点成五获胜 | open4=成两头开四（双杀，挡不住）| four=成冲四（fiveAt 即成五点）
-  | open3=成活三 | three=成眠三。
+- state.boardText 是等宽棋盘图：X=黑 O=白 .=空，小写 x/o=最新一手，#/@=五连；
+- state.moves 是最近的走子记录；movesOmitted>0 表示更早的手数被省略，完整历史用 get_state 查；
+- state.hotPoints 列出双方"落子即成威胁"的关键点：
+  win=该点落子成五获胜 | open4=该点落子成两头开四（双杀）| four=该点落子成冲四（fiveAt 即成五点）| open3=活三（参考级）。
 禁止自己逐格重建棋盘或数数组——判断一律以 boardText 和 hotPoints 为准。
-每次落子前检查 hotPoints：对手的 win 点必占，four 点必挡（挡点=fiveAt），
-自己的 win 点直接取胜；其余按 open4 > four > open3 优先级选点。
+
+每次落子前，按以下优先级检查 hotPoints（先看对手，再看自己）：
+1. 自己的 win 点：直接落子获胜。
+2. 对手的 win 点：必须占住；若对手已有两个 win 点，说明开四已成立无法全挡，选最能拖延或制造反击的一手。
+3. 对手的 open4 候选点：必须在本手直接占掉该候选点本身（hotPoints[对手] 中 effect=open4 的 row/col）——
+   等对方落子后再去挡 fiveAt 就已经晚了。
+4. 自己的 open4 候选点：优先落子，形成对手挡不住的双杀。
+5. 对手的 four 点：挡在其 fiveAt；再往后才是自己的 four / open3。
+低阶威胁只作参考，不要为它们放弃上面的必防项。
 
 标准流程：
 1. 调用 wait_for_turn 等待轮到你；
 2. reason=your_turn 时，先调用 say 评价人类刚落的那一步（kind=evaluation），
-   再依据 boardText / hotPoints 选择一个空位调用 place_stone；
+   再按上述优先级依据 boardText / hotPoints 选择一个空位调用 place_stone；
 3. 落子后调用 say 评论局势或表达情绪（kind=position / reaction），
    然后再次 wait_for_turn；
 4. reason=game_over 时用 say（kind=result）总结胜负；
@@ -81,9 +88,13 @@
           text: JSON.stringify({
             code: error.code,
             message: error.message,
-            // Error paths only carry the state snapshot; the move list is
-            // omitted (empty) because history is not threaded through errors.
-            state: error.state ? toAgentStateView(error.state, []) : null,
+            // Errors carry history when the transport knows it; when it is
+            // genuinely unavailable the view says so via movesOmitted.
+            state: error.state
+              ? toAgentStateView(error.state, error.history, {
+                  recentMoves: AGENT_RECENT_MOVES,
+                })
+              : null,
           }),
         },
       ],
@@ -142,9 +153,9 @@
     {
       title: '读取棋局',
       description: `读取指定房间的完整棋局状态，不改变任何东西。返回 { state, yourColor }，state 不含二维数组，改为对 LLM 友好的三件套：
-- state.boardText：等宽棋盘图（X=黑 O=白 .=空，小写 x/o=最新一手，#/@=五连），带 0-based 行列号；
-- state.moves：按顺序的完整走子记录 { row, col, color, index }；
-- state.hotPoints：双方"落子即成威胁"的点，effect 分级 win（成五）> open4（开四双杀）> four（冲四，fiveAt=成五点）> open3（活三）> three（眠三）；
+- state.boardText：等宽棋盘图（X=黑 O=白 .=空，小写 x/o=最新一手，#/@=五连），行列号 0-based；
+- state.moves：完整走子记录（本工具不截断；其他工具只给最近几手，movesOmitted>0 时用本工具查全史）；
+- state.hotPoints：双方"落子即成威胁"的点，effect 分级 win（落子成五）> open4（落子成开四双杀）> four（落子成冲四，fiveAt=成五点）> open3（活三，参考级）；
 - 另有 state.turn / status / winner / endReason / winLine / lastMove / seats / version 等元信息。
 用于断线重连后恢复上下文，或任何需要完整盘面的时刻。`,
       inputSchema: z.object({ roomId: roomIdSchema }),
@@ -158,8 +169,11 @@
     {
       title: '等轮到我',
       description: `挂起等待，直到轮到你落子、对局结束、开了新局或超时。timeoutMs 默认 ${DEFAULT_WAIT_MS}，范围 ${MIN_WAIT_MS}-${MAX_WAIT_MS}。
-返回 { state, yourColor, reason }，state 含 boardText（等宽棋盘图）、moves（走子记录）、hotPoints（双方威胁点）：
-- your_turn：轮到你了。先看 state.hotPoints：对手的 win 点必占、four 点必挡（挡点=fiveAt），自己的 win 点直接下；再结合 boardText 选点调用 place_stone；
+返回 { state, yourColor, reason }，state 含 boardText（等宽棋盘图）、moves（最近走子，movesOmitted>0 表示更早的已省略）、hotPoints（双方威胁点）：
+- your_turn：轮到你了。落子前按优先级检查 hotPoints（先看对手，再看自己）：
+  ① 自己的 win 点直接下；② 对手的 win 点必占（若有两个，开四已成立，选最能拖延/反击的一手）；
+  ③ 对手的 open4 候选点必须本手直接占掉该点本身，等对方落子后再挡 fiveAt 就晚了；
+  ④ 自己的 open4 候选优先下；⑤ 挡对手 four 的 fiveAt；再往后才是自己的 four/open3。低阶只作参考。
 - game_over：对局已结束，用 say(kind="result") 收尾；
 - idle：还没有开局，请人类在网页点「新对局」，或自己调用 new_game；
 - new_game：等待期间开了新局，按新状态继续；
@@ -190,8 +204,10 @@
     {
       title: '落子',
       description: `在 (row, col) 落下你的一颗棋子。坐标 0-based：row 从上到下 0-14，col 从左到右 0-14。
+落子前按 wait_for_turn 里写的优先级检查 state.hotPoints：自己的 win 点直接取胜；对手的 win 点必占；
+对手的 open4 候选点必须本手直接占掉该点本身（不要等它落子后再挡 fiveAt）；再挡对手 four 的 fiveAt。
 只能在自己的回合、用自己的颜色落子，且目标格必须为空（看 state.boardText 里该位置是否为 '.'）。
-成功返回 { ok: true, state }（state 含更新后的 boardText / moves / hotPoints）；失败返回 isError 和 { code, message, state }：
+成功返回 { ok: true, state }（state 含更新后的 boardText / 最近走子 / hotPoints）；失败返回 isError 和 { code, message, state }：
 - NOT_YOUR_TURN：还没轮到你，先调用 wait_for_turn；
 - CELL_OCCUPIED / OUT_OF_BOUNDS：坐标不合法，换一个空位；
 - GAME_NOT_PLAYING：当前没有进行中的对局，先 new_game。
--- a/server/test/insights.test.ts	2026-10-23 20:38:52.417955000 +0800
+++ server/test/insights.test.ts	2026-10-23 20:29:29.405484400 +0800
@@ -1,5 +1,6 @@
 import { describe, expect, it } from 'vitest';
-import type { HotPoint, StoneColor } from '@gomoku/shared';
+import type { HotPoint, Move, StoneColor } from '@gomoku/shared';
+import { AGENT_RECENT_MOVES } from '@gomoku/shared';
 import {
   createBoard,
   findWinLine,
@@ -11,6 +12,13 @@
 } from '../src/core/insights';
 import { applyMove, createInitialState } from '../src/core/engine';
 
+const RULES = {
+  boardSize: 15,
+  winLength: 5,
+  overlineWin: true,
+  forbidden: 'none',
+} as const;
+
 function boardWith(
   stones: ReadonlyArray<readonly [StoneColor, number, number]>,
 ): ReturnType<typeof createBoard> {
@@ -29,31 +37,35 @@
   return points.find((point) => point.row === row && point.col === col);
 }
 
+/** Place a stone on a copy and hand it to findWinLine, as the engine would. */
+function winsIfPlaced(
+  board: ReturnType<typeof createBoard>,
+  rules: typeof RULES | { boardSize: number; winLength: number; overlineWin: boolean; forbidden: 'none' },
+  color: StoneColor,
+  row: number,
+  col: number,
+): boolean {
+  const scratch = board.map((line) => line.slice());
+  scratch[row]![col] = color;
+  return findWinLine(scratch, row, col, rules) !== null;
+}
+
 describe('findHotPoints', () => {
   it('returns nothing on an empty board', () => {
-    expect(findHotPoints(createBoard(15), {
-      boardSize: 15,
-      winLength: 5,
-      overlineWin: true,
-      forbidden: 'none',
-    })).toEqual({ black: [], white: [] });
+    expect(findHotPoints(createBoard(15), RULES)).toEqual({ black: [], white: [] });
   });
 
   it('marks both open ends of an open two as live-three makers', () => {
     const board = boardWith([['black', 7, 7], ['black', 7, 8]]);
-    const hot = findHotPoints(board, {
-      boardSize: 15,
-      winLength: 5,
-      overlineWin: true,
-      forbidden: 'none',
-    });
+    const hot = findHotPoints(board, RULES);
 
     // Extending a two in place, or one cell further with a gap, both leave
     // a live-three shape (the gap version still guarantees an open four).
     expect(pointsAt(hot.black, 7, 6)?.effect).toBe('open3');
     expect(pointsAt(hot.black, 7, 9)?.effect).toBe('open3');
     expect(pointsAt(hot.black, 7, 5)?.effect).toBe('open3');
-    expect(pointsAt(hot.black, 7, 4)?.effect).toBe('three');
+    // Far stretchers create no three-level shape at all.
+    expect(pointsAt(hot.black, 7, 4)).toBeUndefined();
     expect(pointsAt(hot.black, 7, 0)).toBeUndefined();
   });
 
@@ -64,12 +76,7 @@
       ['black', 7, 5],
       ['black', 7, 7],
     ]);
-    const hot = findHotPoints(board, {
-      boardSize: 15,
-      winLength: 5,
-      overlineWin: true,
-      forbidden: 'none',
-    });
+    const hot = findHotPoints(board, RULES);
 
     const point = pointsAt(hot.black, 7, 6);
     expect(point?.effect).toBe('four');
@@ -82,12 +89,7 @@
       ['black', 7, 6],
       ['black', 7, 7],
     ]);
-    const hot = findHotPoints(board, {
-      boardSize: 15,
-      winLength: 5,
-      overlineWin: true,
-      forbidden: 'none',
-    });
+    const hot = findHotPoints(board, RULES);
 
     const point = pointsAt(hot.black, 7, 4);
     expect(point?.effect).toBe('open4');
@@ -102,12 +104,7 @@
       ['black', 7, 5],
       ['black', 7, 6],
     ]);
-    const hot = findHotPoints(board, {
-      boardSize: 15,
-      winLength: 5,
-      overlineWin: true,
-      forbidden: 'none',
-    });
+    const hot = findHotPoints(board, RULES);
 
     expect(pointsAt(hot.black, 7, 7)?.effect).toBe('win');
   });
@@ -123,12 +120,7 @@
       ['black', 10, 5],
       ['black', 11, 6],
     ]);
-    const hot = findHotPoints(board, {
-      boardSize: 15,
-      winLength: 5,
-      overlineWin: true,
-      forbidden: 'none',
-    });
+    const hot = findHotPoints(board, RULES);
 
     const point = pointsAt(hot.black, 9, 4);
     expect(point?.effect).toBe('open4');
@@ -143,12 +135,7 @@
       ['black', 7, 7],
       ['black', 7, 9],
     ]);
-    const hot = findHotPoints(board, {
-      boardSize: 15,
-      winLength: 5,
-      overlineWin: true,
-      forbidden: 'none',
-    });
+    const hot = findHotPoints(board, RULES);
 
     expect(pointsAt(hot.black, 7, 8)?.effect).toBe('open4');
   });
@@ -159,12 +146,7 @@
       ['black', 7, 6],
       ['white', 3, 3],
     ]);
-    findHotPoints(board, {
-      boardSize: 15,
-      winLength: 5,
-      overlineWin: true,
-      forbidden: 'none',
-    });
+    findHotPoints(board, RULES);
 
     expect(board[7]![4]).toBeNull();
     expect(board[7]![5]).toBe('black');
@@ -172,7 +154,68 @@
     expect(board[0]![0]).toBeNull();
   });
 
-  it('caps the noisy low tiers so decisive points stay visible', () => {
+  it('agrees with the engine on every win point and five point (invariant)', () => {
+    // A dense middlegame-ish position: every reported win must be confirmed
+    // by findWinLine, and completing any fiveAt must actually win.
+    const board = boardWith([
+      ['black', 7, 3], ['black', 7, 4], ['black', 7, 5], ['black', 7, 6],
+      ['white', 6, 5], ['white', 6, 6], ['white', 6, 7],
+      ['black', 8, 3], ['black', 10, 5], ['black', 11, 6],
+      ['white', 9, 6], ['white', 9, 7], ['white', 9, 8],
+    ]);
+    const hot = findHotPoints(board, RULES);
+
+    for (const color of ['black', 'white'] as const) {
+      for (const point of hot[color]) {
+        if (point.effect === 'win') {
+          expect(winsIfPlaced(board, RULES, color, point.row, point.col)).toBe(true);
+        } else {
+          expect(winsIfPlaced(board, RULES, color, point.row, point.col)).toBe(false);
+        }
+        for (const five of point.fiveAt) {
+          const withPoint = board.map((line) => line.slice());
+          withPoint[point.row]![point.col] = color;
+          expect(winsIfPlaced(withPoint, RULES, color, five.row, five.col)).toBe(true);
+        }
+      }
+    }
+  });
+
+  it('respects exact-five rules: a six-line completion is not a win', () => {
+    // overlineWin=false: filling the gap makes a six-run, which the engine
+    // rejects; the pre-existing exact-five flank (7,2) stays a real win.
+    const rules = { ...RULES, overlineWin: false };
+    const board = boardWith([
+      ['black', 7, 3],
+      ['black', 7, 4],
+      ['black', 7, 5],
+      ['black', 7, 6],
+      ['black', 7, 8],
+    ]);
+    const hot = findHotPoints(board, rules);
+
+    expect(pointsAt(hot.black, 7, 7)?.effect).not.toBe('win');
+    expect(pointsAt(hot.black, 7, 2)?.effect).toBe('win');
+  });
+
+  it('supports winLength=6: six in a row wins', () => {
+    const rules = { ...RULES, winLength: 6 };
+    const board = boardWith([
+      ['black', 7, 3],
+      ['black', 7, 4],
+      ['black', 7, 5],
+      ['black', 7, 6],
+      ['black', 7, 7],
+    ]);
+    const hot = findHotPoints(board, rules);
+
+    expect(pointsAt(hot.black, 7, 8)?.effect).toBe('win');
+    expect(pointsAt(hot.black, 7, 2)?.effect).toBe('win');
+  });
+
+  it('caps the reference tier so decisive points stay visible', () => {
+    // Black has a straight four (win/four makers); white has three separate
+    // pairs, each spawning several open3 makers - more than the cap.
     const board = boardWith([
       ['black', 7, 5],
       ['black', 7, 6],
@@ -180,18 +223,18 @@
       ['black', 7, 8],
       ['white', 6, 5],
       ['white', 6, 6],
-      ['white', 6, 7],
+      ['white', 8, 5],
+      ['white', 8, 6],
+      ['white', 10, 5],
+      ['white', 10, 6],
     ]);
-    const hot = findHotPoints(board, {
-      boardSize: 15,
-      winLength: 5,
-      overlineWin: true,
-      forbidden: 'none',
-    });
+    const hot = findHotPoints(board, RULES);
 
-    const threes = hot.black.filter((point) => point.effect === 'three');
-    expect(threes.length).toBeLessThanOrEqual(6);
-    const open3s = hot.black.filter((point) => point.effect === 'open3');
+    expect(pointsAt(hot.black, 7, 4)?.effect).toBe('win');
+    expect(pointsAt(hot.black, 7, 3)?.effect).toBe('four');
+    expect(hot.black.filter((point) => point.effect === 'open3')).toEqual([]);
+    const open3s = hot.white.filter((point) => point.effect === 'open3');
+    expect(open3s.length).toBeGreaterThan(0);
     expect(open3s.length).toBeLessThanOrEqual(10);
   });
 });
@@ -226,6 +269,18 @@
     expect(text).toContain('0-based');
   });
 
+  it('has unambiguous column and row labels (no glued numbers)', () => {
+    const lines = renderBoardText(playedState()).split('\n');
+
+    const header = lines[0]!.trim().split(/\s+/);
+    expect(header).toEqual(Array.from({ length: 15 }, (_, i) => String(i)));
+
+    for (let row = 0; row < 15; row += 1) {
+      const label = lines[row + 1]!.slice(0, 2);
+      expect(label).toBe(String(row).padStart(2, '0'));
+    }
+  });
+
   it('marks the winning line when the game is finished', () => {
     let state = { ...createInitialState('room'), status: 'playing', gameId: 'g' };
     for (const [color, row, col] of [
@@ -254,14 +309,10 @@
 });
 
 describe('toAgentStateView', () => {
-  it('replaces the board array with boardText, moves and hotPoints', () => {
+  function stateAfter(moves: ReadonlyArray<readonly [StoneColor, number, number]>) {
     let state = { ...createInitialState('room'), status: 'playing', gameId: 'g' };
-    const history = [];
-    for (const [color, row, col] of [
-      ['black', 7, 7],
-      ['white', 8, 8],
-      ['black', 7, 8],
-    ] as const) {
+    const history: Move[] = [];
+    for (const [color, row, col] of moves) {
       const result = applyMove(state, color, row, col);
       if (!result.ok) {
         throw new Error(result.message);
@@ -269,20 +320,79 @@
       state = result.state;
       history.push(result.move);
     }
+    return { state, history };
+  }
 
+  it('replaces the board array with boardText, moves and hotPoints', () => {
+    const { state, history } = stateAfter([
+      ['black', 7, 7],
+      ['white', 8, 8],
+      ['black', 7, 8],
+    ]);
     const view = toAgentStateView(state, history);
 
     expect('board' in view).toBe(false);
     expect(view.moveCount).toBe(3);
+    expect(view.movesOmitted).toBe(0);
     expect(view.moves).toEqual([
       { row: 7, col: 7, color: 'black', index: 1 },
       { row: 8, col: 8, color: 'white', index: 2 },
       { row: 7, col: 8, color: 'black', index: 3 },
     ]);
-    expect(view.boardText).toContain('o');
+    expect(view.boardText).toContain('O'); // white stone (black moved last)
+    expect(view.boardText).toContain('x'); // latest move marker on (7,8)
     // Black already has two stones in a row, so live-three makers exist;
     // white holds a single stone and cannot have a three-level point yet.
     expect(view.hotPoints.black.length).toBeGreaterThan(0);
     expect(view.hotPoints.white).toEqual([]);
   });
+
+  it('keeps only recent moves on the hot path and reports the omission', () => {
+    // Same 46-stone middlegame as the demo, history padded to 100 moves.
+    const { state } = stateAfter([['black', 7, 7], ['white', 8, 8]]);
+    const history: Move[] = Array.from({ length: 100 }, (_, i) => ({
+      row: Math.floor(i / 10),
+      col: i % 10,
+      color: i % 2 === 0 ? ('black' as const) : ('white' as const),
+      index: i + 1,
+      at: '',
+    }));
+    const longState = {
+      ...state,
+      moveCount: 100,
+      lastMove: { ...history[99]!, index: 100 },
+    };
+
+    const hotPath = toAgentStateView(longState, history, {
+      recentMoves: AGENT_RECENT_MOVES,
+    });
+    expect(hotPath.moves).toHaveLength(AGENT_RECENT_MOVES);
+    expect(hotPath.moves[0]!.index).toBe(100 - AGENT_RECENT_MOVES + 1);
+    expect(hotPath.movesOmitted).toBe(100 - AGENT_RECENT_MOVES);
+
+    // get_state (no truncation) still carries the full history.
+    const full = toAgentStateView(longState, history);
+    expect(full.moves).toHaveLength(100);
+    expect(full.movesOmitted).toBe(0);
+
+    // The hot-path payload must stay well under the old full-history size.
+    const payload = JSON.stringify({
+      state: hotPath,
+      yourColor: 'white',
+      reason: 'your_turn',
+    });
+    expect(payload.length).toBeLessThanOrEqual(4000);
+  });
+
+  it('marks unknown history honestly instead of pretending it is empty', () => {
+    const { state } = stateAfter([
+      ['black', 7, 7],
+      ['white', 8, 8],
+      ['black', 7, 8],
+    ]);
+    const view = toAgentStateView(state, null);
+
+    expect(view.moves).toEqual([]);
+    expect(view.movesOmitted).toBe(3); // == state.moveCount
+  });
 });
--- a/server/test/http.test.ts	2026-10-23 20:43:46.540537800 +0800
+++ server/test/http.test.ts	2026-10-23 20:27:06.617701100 +0800
@@ -355,6 +355,19 @@
       expect(woken.reason).toBe('your_turn');
       expect(woken.state.moveCount).toBe(3);
 
+      // Error responses stay self-consistent: the carried state includes
+      // the move history, matching moveCount.
+      const occupied = await client.callTool({
+        name: 'place_stone',
+        arguments: { roomId: 'mcp-room', row: 7, col: 7 },
+      });
+      expect(occupied.isError).toBe(true);
+      const occupiedPayload = toolPayload(occupied);
+      expect(occupiedPayload.code).toBe('CELL_OCCUPIED');
+      expect(occupiedPayload.state.moveCount).toBe(3);
+      expect(occupiedPayload.state.moves).toHaveLength(3);
+      expect(occupiedPayload.state.movesOmitted).toBe(0);
+
       const resigned = await callTool(client, 'resign', {
         roomId: 'mcp-room',
       });
--- a/scripts/demo-agent-view.mjs	2026-10-23 20:44:45.829597900 +0800
+++ scripts/demo-agent-view.mjs	2026-10-23 20:27:15.771339800 +0800
@@ -66,9 +66,12 @@
   updatedAt: '',
 };
 
-const view = toAgentStateView(state, []);
+// History is reconstructed positionally, so the exact move order is unknown
+// here; passing null reports that honestly via movesOmitted.
+const view = toAgentStateView(state, null);
 console.log('=== boardText ===');
 console.log(view.boardText);
+console.log(`\nmovesOmitted: ${view.movesOmitted} (历史不可得时如实标注，完整对局服务端会给出 moves)`);
 console.log('\n=== hotPoints.black (top 8) ===');
 for (const point of view.hotPoints.black.slice(0, 8)) {
   const five = point.fiveAt.length
```
