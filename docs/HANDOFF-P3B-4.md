# 工作单：P3b-4 · 网页围棋盘 + 人机端到端

> 面向：GLM
> 状态：**围棋服务端已完整**（P3b-3 已合入，249 测试全绿）
> 分支：从最新 main 新建 `feat/go-web`
> 预计：1–1.5 天
> 规范来源：`docs/PROPOSAL-GO-MCP.md` §7.2、M4

---

## 0. 前置条件

```text
[ ] P3b-3 已合入 main（249 测试全绿）
[ ] 服务端能 `new_game({game:'go'})`、落子、pass、scoring 全流程
[ ] web 当前对围棋显示占位「围棋模式暂未开放界面」
```

**这一份是纯前端 + 端到端验收。服务端不该再改。**

---

## 1. 这次做什么

```text
✅ 做：GoBoard 组件（9 路，星位 (2,2)(2,6)(4,4)(6,2)(6,6)）
✅ 做：网页开局能选「五子棋 / 围棋」
✅ 做：围棋控件：pass / resign
✅ 做：scoring 阶段交互：点棋子 toggle 死子、confirm_score、resume_play
✅ 做：显示 scorePreview / score（黑白总分、komi、margin）
✅ 做：StatusBar / ResultOverlay 处理 scoring 与 scored
✅ 做：api.ts + store 补 4 个方法
❌ 不做：服务端任何改动
❌ 不做：围棋 AI（AI 通过 MCP 接入，网页只是人类这边）
```

---

## 2. 现状

P3b-2 在 `App.tsx:186` 留了占位：

```tsx
{gomokuState === null && state !== null ? (
  // A Go state: the web has no Go board yet (lands after P3b-3).
  <div className="go-placeholder">
    <p className="go-placeholder-title">围棋模式</p>
    <p>网页围棋界面尚未开放。请在 MCP 端对局...</p>
  </div>
) : (
  <Board ... />
)}
```

**这一份就是要把这个占位换掉。**

---

## 3. 关键前提：网页读的是 `GoState`，不是 `GoAgentStateView`

这个容易搞混：

| 类型 | 用途 | 有 `board` 二维数组吗 |
|---|---|---|
| `GoAgentStateView` | 给 **LLM** 看（`boardText` + `groups`） | ❌ 没有 |
| `GoState` | 房间状态（`RoomView.state`） | ✅ 有 `board: GoBoard` |

`RoomView.state` 是 `AnyGameState`，所以网页拿到的是 **`GoState`**，
可以直接 `state.board[row][col]` 渲染。

**不要**去用 `boardText` 解析字符画——那是给模型看的。

---

## 4. GoBoard 组件

### 4.1 能不能复用 `Board.tsx`

现有 `Board.tsx` 是**交叉点模型**（棋子落在线上），围棋也是交叉点，
所以**结构可以复用**，但有几处必须不同：

| 项 | 五子棋 | 围棋 |
|---|---|---|
| 尺寸 | 15 | 9 |
| 星位 | 13 路以上才有，`(3,3)` 起 | **固定 5 个**：`(2,2)(2,6)(4,4)(6,2)(6,6)` |
| 胜利标记 | `winLine` 高亮 | **没有**（面积法，无连线） |
| 最后手 | 小写/高亮 | 同 |
| 提子标记 | 无 | 最近提掉的点标 `×` |
| 可落子判断 | `turn === humanColor` | 同，但 **scoring 阶段全部不可落子** |
| scoring 交互 | 无 | 点棋子 **toggle 死子** |

### 4.2 建议：新建 `GoBoard.tsx`，不要硬改 `Board.tsx`

提案 §7.2 原文：

> 五子棋继续用现有 `Board`；Go 用独立 `GoBoard`（9 路、星位 (2,2)(2,6)(4,4)(6,2)(6,6)），
> **不要硬改 15 路组件的星位逻辑**。

`starPoints()` 现在是「size < 13 返回空」，围棋 9 路需要 5 个星位。
硬改会让五子棋和围棋的逻辑纠缠在一起。

**复用 CSS class（`board-frame` / `board-grid` / `cell` 等），复制结构，改规则。**

### 4.3 死子标记的视觉

scoring 阶段，被标记的死子要有明显区分：

```text
建议：半透明 + 红色虚线边框，或叠加 ×
必须：一眼能看出哪些子被标死
```

点已标记的棋子 = 取消标记（服务端按整块 toggle，前端不用自己算整块）。

### 4.4 提子点标记

`GoState.lastCaptured` 是最近一手提掉的点。渲染成 `×` 或淡色标记，
让人看到「刚才这里被吃了」。

---

## 5. 交互

### 5.1 落子

```ts
// scoring 阶段不能落子
const canPlay =
  state.status === 'playing' &&
  state.turn === humanColor &&
  !busy;
```

注意：`GoStatus` 是 `'idle' | 'playing' | 'scoring' | 'finished'`，
**比五子棋多了 `'scoring'`**。所有 `status === 'playing'` 的判断都要复查一遍。

### 5.2 pass

```ts
api.pass(roomId) → POST /api/rooms/:id/pass
```

只在 `status === 'playing'` 且轮到自己时可用。

**提示文案**：pass 是「我这手不下了」。连续两次 pass 会进入数子，
所以第一次 pass 后要提示「再 pass 一次就进入数子阶段」。

### 5.3 scoring 交互

scoring 阶段界面要变成「数子面板」：

```text
[棋盘：可点击棋子标死/取消]
双方确认状态：你 ✓ / 对方 ○
[确认数子]  [继续下棋]
分数预览：黑 X 目 / 白 Y 目（含贴目 7.5）→ 白胜 Z 目
```

- 点棋子 → `api.markDead(roomId, row, col)`
- 「确认数子」→ `api.confirmScore(roomId)`
- 「继续下棋」→ `api.resumePlay(roomId)`

**重要**：scoring 阶段**没有轮次**，双方可以同时操作。
不要显示「轮到你数子」这种话，应该说「双方各自确认」。

### 5.4 已确认后

一方确认后，该方按钮应禁用并显示「已确认，等对方」。
如果对方又改了死子标记，服务端会重置确认——前端要跟着更新。

---

## 6. api.ts + store

### 6.1 api.ts 补 4 个方法

```ts
pass(roomId: string): Promise<AnyGameState>
markDead(roomId: string, row: number, col: number): Promise<AnyGameState>
confirmScore(roomId: string): Promise<AnyGameState>
resumePlay(roomId: string): Promise<AnyGameState>
```

路径对应：

```text
POST /api/rooms/:id/pass            { actor: 'human' }
POST /api/rooms/:id/dead-stones     { row, col, actor: 'human' }
POST /api/rooms/:id/score/confirm   { actor: 'human' }
POST /api/rooms/:id/score/resume    { actor: 'human' }
```

**注意**：这四个端点已经存在（P3b-2/P3b-3 实现），前端只是接上。

### 6.2 `newGame` 要支持 game 参数

```ts
newGame(roomId: string, agentColor: StoneColor, game?: 'gomoku' | 'go')
```

### 6.3 store 补对应 action

沿用现有 `play` / `resign` 的写法（`busy` + `error` + `applyState`）。

---

## 7. 开局选择

提案 §7.2：

> 开局区先选「五子棋 / 围棋」，再选执黑/执白

`Controls.tsx` 现在有「执黑开局 / 执白开局」。要加游戏选择：

```text
[五子棋] [围棋]     ← 游戏选择
[执黑开局] [执白开局]  ← 颜色选择
```

围棋选中时，开局调 `newGame(roomId, color, 'go')`。

**注意**：围棋只有 9 路，不要给尺寸选项。

---

## 8. StatusBar / ResultOverlay

### 8.1 StatusBar

现在 `describe()` 里判断 `state.status === 'playing'` / `'finished'`。
围棋多了 `'scoring'`，要加：

```ts
if (status === 'scoring') {
  return { title: '数子阶段', detail: '标记死子，双方确认后出分', turn: null };
}
```

### 8.2 ResultOverlay

提案 §7.2 原文：

> 当前 `endReason` 分支会把 scored 误显示成"五连"。ResultOverlay 还要显示
> `score` 的黑白总分、komi 与 margin，而不是只显示"你赢了/五连"。

现在 `ResultOverlay` 大概是按 `endReason` 显示「五连」。要加：

```text
围棋终局显示：
  白胜 7.5 目
  黑 41 目 / 白 33.5 目（含贴目 7.5）
```

⚠️ **这是最容易漏的**：`endReason` 多了 `'scored'`，如果不处理会显示成
「五连」或直接崩。

---

## 9. 端到端验收（总验收）

提案 M4 验收：

> 完整人机对局一盘（含 pass、标死子、数子）

### 9.1 怎么测

**用户观战，agent 通过 MCP 接入**。所以：

```text
1. 网页开围棋局（人类执黑或执白）
2. agent 通过 MCP join_game 占另一座
3. 双方下到终局
4. 中途至少 pass 一次
5. 进入 scoring，标记死子，双方确认
6. 出分
```

### 9.2 必须验证的点

```text
[ ] 网页能开局围棋（9 路棋盘、5 个星位）
[ ] 人类落子，agent 通过 MCP 应招
[ ] pass 按钮可用，连续两次进 scoring
[ ] scoring 阶段棋盘可点，点棋子能标死
[ ] 双方确认后出分，分数正确（黑/白/komi/margin）
[ ] 对方改死子后，我的确认被重置（界面同步）
[ ] resume_play 能继续下
[ ] 围棋终局不显示「五连」
[ ] 五子棋完全没回归
```

---

## 10. 必须避开的坑

### 10.1 `status === 'playing'` 的判断要复查

`GoStatus` 多了 `'scoring'`。所有只判断 `playing` 的地方都要想一下
「scoring 时应该怎样」。比如：

```ts
// ❌ 只判断 playing，scoring 时会被当成"不在对局中"
if (state.status === 'playing') { ... }

// ✅ 明确处理
if (state.status === 'playing') { ... }
else if (state.status === 'scoring') { ... }
```

### 10.2 切换游戏类型的视图缓存

P3b-2 评审提过：`new_game` 能让同一房间**切换游戏类型**。
如果 React 状态里缓存了旧棋盘，切换后会短暂显示错乱。

**建议**：用 `state.gameId` 或 `state.game` 作为 key 重置组件。

### 10.3 `resume_play` 后轮到谁

P3b-3 评审提过：`resume_play` 后 `turn` 保持进入 scoring 前的值。
可能是「白方提的 resume，结果轮到黑方下」。

**界面提示要说清楚**：「已恢复对局，轮到黑方」，否则用户会困惑。

### 10.4 不要用 `boardText` 渲染

`boardText` 是给 LLM 的字符画。网页用 `state.board` 二维数组。

---

## 11. 测试

### 11.1 必须保持绿

```text
[ ] 249 个现有测试一个都不能挂
```

前端没有单元测试（项目现状），所以**靠 typecheck + build + 端到端实测**。

### 11.2 端到端脚本（建议）

写一个脚本模拟「人类 + agent」完整下一盘：

```text
REST 扮演人类，MCP 扮演 agent
→ 下到 pass pass
→ scoring 标死确认
→ 断言分数
```

这样能自动化验证整条链路，不用每次手动点。

---

## 12. 完成标准

```text
[ ] GoBoard 组件（9 路 + 5 星位 + 死子标记 + 提子点）
[ ] 开局能选围棋
[ ] pass / resign 可用
[ ] scoring 交互完整（标死 / 确认 / 恢复）
[ ] scorePreview / score 显示正确
[ ] ResultOverlay 处理 scored，显示分数而非「五连」
[ ] StatusBar 处理 scoring
[ ] api + store 补 4 个方法
[ ] pnpm test 全绿（249）
[ ] pnpm typecheck + build 通过
[ ] 端到端：人机完整下一盘（含 pass、标死、数子）
```

---

## 13. 提交

```text
feat(go): a 9x9 board on the web, with pass and scoring

GoBoard is its own component rather than a resized Board: the star points,
the absence of a win line and the dead-stone interaction differ enough that
sharing one component would tangle two rule sets.

The web reads GoState.board, not GoAgentStateView.boardText — the latter is the
character grid meant for the model.

Scoring has no turn, so the panel asks both sides to confirm rather than
announcing whose move it is.
```

---

## 14. 做完之后

P3 完成。之后是：

```text
P4 聊天室（只依赖 P1a/P1b）
P5 大厅 / 房间列表
```

**P3b-4 合入后，建议先让用户自己玩一盘**，确认真实体验没问题，
再开 P4。
