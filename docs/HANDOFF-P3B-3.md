# 工作单：P3b-3 · 围棋数子全流程（M3）

> 面向：GLM
> 状态：**等 `HANDOFF-P3B-2.md`（接入）合入后再开始**
> 分支：从最新 main 新建 `feat/go-scoring`
> 预计：1 天
> 规范来源：`docs/PROPOSAL-GO-MCP.md` §3.4、§3.6、§4.3

---

## 0. 前置条件

```text
[ ] P3b-2 已合入 main（围棋能落子、能 pass，4 个工具接口已存在）
[ ] pnpm test 全绿
```

---

## 1. 这次做什么

```text
✅ 做：pass 两次 → status='scoring'
✅ 做：mark_dead 整块 toggle
✅ 做：confirm_score 双方确认
✅ 做：resume_play 恢复对局
✅ 做：scorePreview / score 计算与写入
✅ 做：wait_for_turn 的 reason='scoring'
✅ 做：REST dead-stones / score/confirm / score/resume
❌ 不做：网页围棋盘（后续单独做）
```

---

## 2. 状态机

```text
playing ──(pass)──▶ playing ──(pass)──▶ scoring
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                    mark_dead      confirm_score     resume_play
                    (仍在 scoring)  (双方齐→finished)  (回 playing)
```

提案 §3.4：

> - 连续两次 pass → `status='scoring'`，`turn` 保持"下一手本应落子的一方"
> - scoring 阶段**禁止** `place_stone` / `pass`，只允许
>   `mark_dead` / `confirm_score` / `resume_play` / `resign`
> - `resume_play`：任意一方可调用；`deadStones=[]`、双方 `scoreConfirmed=false`、
>   `consecutivePasses=0`、`status='playing'`；`turn` 不变

### 2.1 `turn` 在 scoring 时不动

这条容易搞错：进入 scoring 后 `turn` **保持在"下一手本应落子的一方"**，
不要切换，也不要设为 null。

---

## 3. mark_dead

提案 §3.6：

```text
- 只允许 status='scoring'，否则 NOT_SCORING
- 找到该点所在整块；若整块全部已在 deadStones 中，则整块取消标记；
  否则整块加入（不要只 toggle 单颗）
- 任何标记变化都把 scoreConfirmed 两方重置为 false
- 空点/越界 → INVALID_DEAD_STONE
```

**三个易错点**：

1. **按整块 toggle**，不是按单颗。点一颗子，整块一起标/一起取消。
2. **任何变化都重置双方确认**。这是最容易漏的——一方确认后又改了死子，
   原来的确认就不该作数。
3. 空点标死要报 `INVALID_DEAD_STONE`，不要静默忽略。

---

## 4. confirm_score

```text
- 只允许 scoring，否则 NOT_SCORING
- 把调用者 seat 的 scoreConfirmed 置 true
- 双方都 true → 按面积法终局：
    status='finished'
    winner = score.winner
    endReason='scored'
    写 score
- 已确认的一方再次调用是幂等的，不报错
```

⚠️ **幂等**这条要测：连点两次确认不能报错。

---

## 5. 数子计算

**直接用 `go.ts` 的 `scoreBoard`**，不要重写：

```ts
import { scoreBoard } from '../core/go.js';

const score = scoreBoard(state.board, state.deadStones, state.rules.komi);
```

提案 §3.5 的要点（引擎已实现，这里只是提醒）：

- 先移除死子再数
- 空区域只邻黑 → 黑地；只邻白 → 白地；两色都邻 → 中立
- `blackTotal = blackArea`，`whiteTotal = whiteArea + komi`
- **提子数只展示，不计入面积分**

`scorePreview` 用当前 `deadStones` 算，**不写回棋盘**。

---

## 6. wait_for_turn 的 scoring 语义（最易错）

提案 §4.3：

```text
3. status='scoring'：
   - 本 seat 尚未 confirmed → 'scoring'（立即返回，让 agent 去标死/确认）
   - 本 seat 已 confirmed、对方未 confirmed → 继续等待
   - 双方 confirmed 后 status 变 finished → 'game_over'
4. turn === seat → 'your_turn'
...
```

**顺序很重要**：`scoring` 判断要在 `turn` 判断**之前**。

提案 §4.3 结尾特别警告：

> `mark_dead` / `resume_play` 重置确认后要 `emitState`，让已确认的一方重新收到
> `scoring`。`confirm_score` 也要 `emitState`，让等待的对方收到 `game_over` 或继续等待。
> **不要用 `turn` 判断 scoring 阶段"轮到谁"；数子确认是双方并行的。**

这条是整个 M3 最容易写错的地方。数子阶段**没有轮次**，双方可以同时操作。

### 6.1 测试要点

```text
[ ] 刚进 scoring，双方都没确认 → 两人调 wait_for_turn 都立刻拿到 'scoring'
[ ] A 确认后：A 再等 → 挂起；B 再等 → 立刻拿到 'scoring'
[ ] B 也确认 → 双方都拿到 'game_over'
[ ] A 确认后 B mark_dead → A 的确认被重置，A 再等应重新拿到 'scoring'
```

---

## 7. REST

```text
POST /api/rooms/:id/dead-stones    { row, col, actor? }
POST /api/rooms/:id/score/confirm  { actor? }
POST /api/rooms/:id/score/resume   { actor? }
```

---

## 8. 测试

### 8.1 必须保持绿

```text
[ ] 之前所有测试（206 + P3b-1 + P3b-2 新增），一个都不能挂
```

### 8.2 必须新增（对应提案 G6/G10/G14/G15/G16）

| 编号 | 内容 |
|---|---|
| G6 | 死子与数子：标记死子 → 双方确认 → 移除死子 → 区域归属正确；提子不参与分数 |
| G10 | 两次 pass → scoring；resume_play → playing，pass=0 |
| G14 | mark_dead 确认重置 |
| G15 | resume_play：死子清空、确认清空、pass 清零、棋盘不变 |
| G16 | 数子胜负/贴目：黑 40 白 35 komi 7.5 → 白 42.5 胜 |
| S1 | scoring 阶段 `place_stone` → `NOT_SCORING` |
| S2 | scoring 阶段 `pass` → `NOT_SCORING` |
| S3 | 非 scoring 调 `mark_dead` → `NOT_SCORING` |
| S4 | 空点 mark_dead → `INVALID_DEAD_STONE` |
| S5 | 重复 confirm_score 幂等 |
| S6 | 完整流程：下到 pass pass → 标死 → 双方确认 → 出分 |

**S6 是总验收**：写一个脚本式测试，走完整个 scoring 流程。

---

## 9. 完成标准

```text
[ ] 两次 pass → scoring
[ ] mark_dead 整块 toggle + 重置确认
[ ] confirm_score 幂等 + 双方齐 → finished
[ ] resume_play 正确恢复
[ ] scorePreview / score 正确
[ ] wait_for_turn 的 scoring 语义（重点是并行，不是轮次）
[ ] REST 三个端点
[ ] pnpm test 全绿
[ ] pnpm typecheck + build 通过
```

---

## 10. 提交

```text
feat(go): scoring — two passes, mark dead, both confirm

Two consecutive passes move the game to scoring. Scoring has no turn: both
sides mark dead stones and confirm independently, which is why wait_for_turn
answers 'scoring' per seat rather than following turn order — and why any
mark_dead resets both confirmations.

The area count itself was already in core/go.ts; this change only carries state.
```

---

## 11. 做完之后

scoring 完成后，围棋的**服务端**就齐了。剩下的是：

```text
[ ] 网页围棋盘（GoBoard 组件 + pass/scoring 交互）—— 单独工作单
[ ] 端到端：人 vs AI 完整下一盘 9 路（含 pass、标死、数子）
```

这两项建议合成一份「P3b-4 web + 端到端」，等 scoring 合入后再定。
