# 评审：P3b-2 围棋接入房间 / REST / MCP（M2）

> 评审人：DSH
> 对象：`feat/go-mode` @ `8269f4f`（14 文件，+1225/−62）
> 结论：**通过，合入 main**

---

## 1. 结论

| 项 | 结果 |
|---|---|
| 测试 | ✅ 228 全绿（211 + 17 新增，零破坏） |
| 类型 / 构建 | ✅ server / web / shared 全过 |
| **`core/go.ts` 零改动** | ✅ `git diff` 为空——规则没有在房间层重写 |
| 独立验证 | ✅ 我另写脚本走真实 MCP 下棋，提子/自杀/劫/pass/错误分发全对 |
| 判定 | **通过** |

---

## 2. 最关键的一条：规则没有被重写

工作单硬约束 1 是「规则不要在房间层重写」。验证方式：

```powershell
git diff main -- server/src/core/go.ts feat/go-mode
# → 空
```

**零改动。** 提子/劫/自杀全部走 P3a 引擎的 `playMove`，房间层只做状态搬运。
P3a 的引擎是过了独立审计的，没被二次实现，这是本份工作单最重要的正确性保证。

---

## 3. 独立验证（真实 MCP 下棋）

我没有只看 GLM 的测试，而是自己起服务、用 MCP 客户端真实下棋。

### 3.1 提子

黑 (1,1)，白 (0,1)(1,0)(1,2) 三面包围，白下 (2,1)：

```text
captures.white = 1                    ✅
lastCaptured = [(1,1)]                ✅
boardText 出现 × 标记                 ✅
```

### 3.2 自杀

白 (0,1)(1,0) 封住 (0,0)，黑下 (0,0)：

```text
REJECTED code=SUICIDE                 ✅
```

### 3.3 劫（重点）

精确构造劫形后，白 (3,4) 提掉黑 (4,4)：

```text
白提子成功，koPoint = (4,4)           ✅
黑立即回提 → REJECTED code=KO        ✅
```

### 3.4 pass

```text
turn 从 black 翻到 white              ✅
consecutivePasses = 1                 ✅
moveCount = 1                         ✅
history 记录 {kind:'pass', color, index} 且无 row/col   ✅
落子后 consecutivePasses 归零          ✅
```

### 3.5 G17 错误分发

五子棋房间调四个围棋工具：

```text
pass / mark_dead / confirm_score / resume_play
→ 全部 WRONG_GAME                     ✅
```

### 3.6 N6 兼容（最关键）

```text
new_game 无参数           → gomoku     ✅
new_game 只传 agentColor  → gomoku     ✅
围棋房间切回 game:'gomoku' → gomoku     ✅
```

### 3.7 N1 非法参数

```text
boardSize: 13  → UNSUPPORTED_RULE      ✅
```

---

## 4. 我审计脚本里的 6 个误报（记录）

第一版审计报了 6 个 FAIL，**全部是我的脚本问题**，逐个查清后确认引擎无误：

| 我报的 FAIL | 真实情况 |
|---|---|
| `komi` 是 undefined | `komi` 在 `state.rules.komi`，不在顶层。值 7.5 正确 |
| `koRule:'superko'` 没返回 UNSUPPORTED_RULE | **MCP schema 直接拒绝**了非法枚举值（`-32602`）。比运行时检查更严格，是更好的设计 |
| 自杀没被拒 | 我的房间里有两个 agent，`AMBIGUOUS_ACTOR` 让前面的落子全部失败，棋盘根本没摆成 |
| `consecutivePasses` 是 0 | 同上，turn 一直是黑，pass 落在错误回合 |
| turn 没翻 | 同上 |
| history 没有 pass 记录 | 同上 |

**教训**：审计脚本自己也要验证前置状态。我应该在每次落子后断言「这手确实生效了」，
而不是假定它生效。后来用单 agent + 显式身份重测，全部通过。

---

## 5. G8 预算：口径要看清

我第一版测出 `get_state` 是 5731 字符，超了 4000，报了 FAIL。

查提案原文（§413）：

> **Go 视图热路径 ≤4000 字符**

以及 §319：

> G8 用 60 手局面测 ≤4000 字符

**约束的是「热路径」，不是 `get_state`。** 实测：

| 视图 | 字节 | 预算 | 结果 |
|---|---|---|---|
| 热路径（`wait_for_turn`，`recentMoves=8`） | **3780** | 4000 | ✅ |
| `get_state`（全量） | 5701 | 不适用 | — |

`get_state` 的 5701 分解：

```text
boardText  354
groups    2125
moves     2452   ← 41 手全量，这是 get_state 的本职
其余        770
```

**符合设计**：`get_state` 就该给完整 history，五子棋也是这样。
GLM 的实现是对的，是我的断言口径错了。

---

## 6. GLM 主动说明的三件事

### 6.1 工具数量口径：「8 → 10」还是「8 → 12」

GLM 说得对，两个口径混了：

| 口径 | 数量 |
|---|---|
| 注册工具总数（含 `join_game` / `leave_room`） | 8 → **12** |
| 提案 §6 表格里的对弈工具数 | 10 |

实测注册总数确实是 **12**：

```text
confirm_score, get_state, join_game, leave_room, mark_dead, new_game,
pass, place_stone, resign, resume_play, say, wait_for_turn
```

我工作单里写的「8 → 10」是照抄提案 §6 的表格，**措辞不准**。
GLM 在提交信息里把两种口径都写了，处理得当。

### 6.2 stdio 桥的 scoring 工具直接答 NOT_SCORING

`mark_dead` / `confirm_score` / `resume_play` 在桥内直接返回 `NOT_SCORING`，
与 in-process 行为一致。`pass` 走真实 `/pass` 端点。

合理：这三个工具的 REST 端点属于第 3 份工作单，现在没有可调用的后端。

### 6.3 `engine.ts` 的 2 行签名放宽

```ts
// startGame 的 prev 从 GameState 放宽为 { roomId, version, rules? }
```

原因：围棋房间切回五子棋时，`prev` 是 `GoState`，不满足 `GameState`。

**这是必要的最小放宽**，逻辑零改动，28 个 engine 测试原样通过。可接受。

---

## 7. 一个需要留意的设计点

`new_game` 现在可以让**同一个房间在不同局之间切换游戏类型**（围棋 → 五子棋，实测通过）。

这带来一个语义问题：房间的 `history` 在切换时会被清空（`newGame` 里 `this.history = []`），
所以不会出现「围棋 pass 记录混进五子棋 history」。

**但 UI 层要注意**：如果观战页缓存了旧视图，切换游戏后可能短暂显示错乱的棋盘。
第 3 份（web 围棋盘）实现时要处理。

本轮不阻塞。

---

## 8. 代码质量

| 维度 | 评价 |
|---|---|
| 规则复用 | ✅ `go.ts` 零改动，规则只在引擎里 |
| 分派清晰 | ✅ `moveAt` / `resignAt` 按 `state.game` 分派 |
| 新增模块 | ✅ `core/go-game.ts` 对应 `engine.ts` 之于五子棋，职责对等 |
| 兼容 | ✅ N6 三种路径都测了 |
| 错误处理 | ✅ 四工具对五子棋答 `WRONG_GAME`，语义准确 |

值得肯定：新建 `go-game.ts` 而不是把围棋逻辑塞进 `engine.ts`，
保持了「五子棋引擎」和「围棋状态搬运」的边界清晰。

---

## 9. 合入

```text
git checkout main
git merge --ff-only feat/go-mode
pnpm test        # 228 全绿
```

合入后 **P3b-3（scoring）可以开始**。

---

## 10. 给 P3b-3 的提醒

第 3 份要动 `wait_for_turn` 的语义（加 `reason='scoring'`），
而 P2 里发现过 `yourColor` 的座位解析 bug——**同一类问题容易重犯**。

建议第 3 份实现 `scoring` 的 wait 语义时，**用两个真实 agent 会话验证**，
不要只靠单 agent 测试。P2 的教训是：单 agent 测不出双 agent 的座位问题。
