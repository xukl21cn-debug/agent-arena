# 评审：P3b-3 围棋数子全流程（M3）

> 评审人：DSH
> 对象：`feat/go-scoring` @ `ad96d17`（9 文件，+1023/−60）
> 结论：**通过，合入 main**

---

## 1. 结论

| 项 | 结果 |
|---|---|
| 测试 | ✅ 249 全绿（228 + 21 新增） |
| 类型 / 构建 | ✅ 全过 |
| **`core/go.ts` 零改动** | ✅ 数子直接调 `scoreBoard`，规则仍只有一处 |
| 双会话验证 | ✅ 我用两个真实 MCP 会话走完 scoring 全流程 |
| 判定 | **通过** |

---

## 2. 最关键的一条：scoring 没有轮次

工作单里我特意警告过这是最大的坑。实测验证：

### 2.1 双方都能立刻拿到 `scoring`

进入 scoring 后，黑、白**同时**调 `wait_for_turn`：

```text
black（未确认）→ reason='scoring' 立刻返回   ✅
white（未确认）→ reason='scoring' 立刻返回   ✅
```

**不是轮流**。这正是提案 §4.3 要求的「数子确认是双方并行的」。

### 2.2 一方确认后：它挂起，另一方继续拿到 `scoring`

```text
black confirm_score
→ black 再等   → 'timeout'（挂起）      ✅
→ white 再等   → 'scoring'（立刻返回）   ✅
```

### 2.3 G14：mark_dead 重置后，已确认方重新拿到 `scoring`

```text
black 已确认
→ white mark_dead
→ black 再等 → 'scoring'（重新被唤醒）   ✅
```

这条是 P3b-3 最容易漏的：重置必须 `emitState` 唤醒挂起的 waiter。
GLM 实现了，实测通过。

---

## 3. 其他实测

### 3.1 进入 scoring 时 turn 不动

```text
黑 pass → turn=white
白 pass → status=scoring, turn=black   ✅
```

`turn` 保持「下一手本应落子的一方」，没有切换、没有设 null。符合提案 §3.4。

### 3.2 S1/S2：scoring 阶段禁止落子和 pass

```text
place_stone → NOT_SCORING   ✅
pass        → NOT_SCORING   ✅
```

用的是 `NOT_SCORING` 而不是 `GAME_NOT_PLAYING`——更可操作，符合工作单要求。

### 3.3 mark_dead 整块 toggle

两子相连的块，点其中一颗：

```text
mark_dead(5,5) → deadStones 长度 2（整块）   ✅
mark_dead(5,6) → deadStones 长度 0（取消）   ✅
```

### 3.4 S4：空点标死

```text
mark_dead 空点 → INVALID_DEAD_STONE   ✅
```

### 3.5 confirm_score 幂等

```text
连续两次 confirm → 第二次不报错   ✅
```

### 3.6 双方确认 → 终局

```text
黑 1 子 / 白 1 子 + komi 7.5
→ status=finished, endReason='scored'
→ score = { blackArea:1, whiteArea:1, komi:7.5,
            blackTotal:1, whiteTotal:8.5, winner:'white', margin:7.5 }
→ scorePreview = null              ✅
```

**分数算对了**：白 1 子 + 7.5 贴目 = 8.5，黑 1 子 = 1，白胜 7.5 目。

### 3.7 G15：resume_play

```text
status: scoring → playing   ✅
deadStones: []              ✅
scoreConfirmed: 双方 false   ✅
consecutivePasses: 0        ✅
turn 不变                    ✅
棋盘保留（B 仍在）            ✅
能继续落子                   ✅
```

---

## 4. 我审计脚本的 5 类误报（记录）

第一版审计报了 20+ 个 FAIL，**全部是我的脚本问题**：

| 误报 | 真实原因 |
|---|---|
| `wait_for_turn` 全部 `isError` | **我传了 `timeoutMs: 800`**，而 schema 最小是 1000。这个校验一直存在，不是新 bug |
| 第二次运行全 `AMBIGUOUS_ACTOR` | 我复用了房间名 `scoring-audit`，上次运行留下的参与者和状态还在 |
| 落子/确认全部失败 | 同上 |
| 终局没到 finished | 前面 G14 那步重置了黑方确认，之后我只让白方确认了一次 |
| 分数断言崩溃 | 上一条导致 `score` 是 null，我的断言没做空值保护 |

**教训（第二次犯同样的错）**：P3b-2 评审时我记过「审计脚本要断言自己的前置状态」，
这次又栽在**房间复用**和**参数范围**上。正确的做法是：

- 每次运行用全新房间名（带时间戳或随机后缀）
- 调工具前先确认参数在 schema 允许范围内

---

## 5. GLM 主动说明的三件事

### 5.1 `go-room.test.ts` 的 N5 断言翻转

```diff
- // Two consecutive passes accumulate; the scoring transition is M3's.
- expect(afterSecond.status).toBe('playing');
+ // Two consecutive passes now move the game into scoring (P3b-3); the
+ // scoring-phase behaviour itself lives in go-scoring.test.ts.
+ expect(afterSecond.status).toBe('scoring');
```

**这个改动是正确且必要的。** P3b-2 时 scoring 还没实现，断言 `playing` 是当时的真实行为；
P3b-3 正是要实现它，断言必须跟着改。

而且注释写清楚了「为什么改」和「新行为在哪测」，这是好的工程习惯。
这是本份唯一的既有测试改动，合理。

### 5.2 错误码用 `NOT_SCORING` 而非 `GAME_NOT_PLAYING`

工作单 S1/S2 明确要求 `NOT_SCORING`。实现上 `checkTurn` 对 scoring 特判。

**这个选择更好**：`GAME_NOT_PLAYING` 会让 agent 以为对局结束了；
`NOT_SCORING` 明确告诉它「现在是数子阶段，去做该做的事」。符合 P2 学到的
「错误信息要可操作」。

### 5.3 两个自纠错

- `cornerBlockRoom` 收官在黑，pass 须白先
- 对终局房调 `dead-stones` 先命中状态检查（`NOT_SCORING`）再检查点位

第二条我核对了：**状态检查先于点位检查是合理顺序**。已结束的对局，
不管点位合不合法都该先答「你现在不该做这个」。

`deadStones` 数组顺序是引擎 DFS 副产品、无契约，测试按集合排序比较——处理得当。

---

## 6. 一个观察（不阻塞）

`resume_play` 后 `turn` 保持进入 scoring 前的值。实测：

```text
黑 pass → white
白 pass → scoring, turn=black
resume_play → turn=black
```

符合提案「turn 不变」的要求。但**语义上有个小尴尬**：白方提的 resume，
结果轮到黑方下。这不是 bug（提案明确要求 turn 不变），但 UI 层提示
「已恢复对局，轮到黑方」时需要说清楚，否则用户会困惑。

留给 P3b-4（web）处理。

---

## 7. 代码质量

| 维度 | 评价 |
|---|---|
| 规则复用 | ✅ `go.ts` 零改动，数子直接调 `scoreBoard` |
| 并行语义 | ✅ scoring 判断在 turn 之前，按 seat 确认状态分派 |
| 幂等 | ✅ confirm_score 重复调用不报错、不 bump version |
| 重置唤醒 | ✅ mark_dead 重置后 `emitState` 唤醒挂起的 waiter |
| 错误码 | ✅ `NOT_SCORING` 比 `GAME_NOT_PLAYING` 更可操作 |

值得肯定：GLM 主动做了**双会话验证**（工作单提醒的 P2 教训），
而且加进了 `dual-agent.test.ts`（149 行），不是只跑一次就完事。

---

## 8. 合入

```text
git checkout main
git merge --ff-only feat/go-scoring
pnpm test        # 249 全绿
```

**围棋服务端至此完整。** 剩余工作：

| 项 | 说明 |
|---|---|
| P3b-4 | 网页围棋盘（GoBoard）+ pass/scoring 交互 + 人 vs AI 端到端 |
| P4 | 聊天室 |
| P5 | 大厅 |

---

## 9. 给 P3b-4 的提醒

1. **切换游戏类型时的视图缓存**：P3b-2 评审提过，`new_game` 能切游戏类型，
   观战页若缓存旧视图会短暂错乱。围棋盘实现时要用 `state.game` 守卫。

2. **`resume_play` 的 turn 提示**：见 §6，恢复后轮到谁要说清楚。

3. **`scorePreview` vs `score`**：scoring 阶段看预览，finished 后看终局分，
   两者不能混用。提案明确「预览不是终局」。
