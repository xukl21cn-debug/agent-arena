# 工作单：P3a · 围棋规则引擎（M1）

> 面向：GLM
> 状态：P2 已合入 main（167 测试全绿），P3a 未开始
> 分支：从最新 main 新建 `feat/go-engine`
> 预计：2–3 天
> 规范来源：[`go-mcp.md`](../../proposals/go-mcp.md) 第 3 节（规则）、3.7（测试表）

---

## 0. 先读什么

1. **本文件**（边界和工作顺序）
2. [`go-mcp.md`](../../proposals/go-mcp.md) §3.1–§3.7 —— 规则细节以那里为准
3. 现有代码风格参考：`server/src/core/rules.ts`、`server/src/core/engine.ts`

---

## 1. 这次只做什么（重要）

**只写 `server/src/core/go.ts` + 它的测试。**

```text
✅ 做：go.ts 纯函数引擎
✅ 做：server/test/go.test.ts
❌ 不做：改 GameState / 加 game 判别（那是 M0，属于 P3b）
❌ 不做：改 room / REST / MCP 工具
❌ 不做：改 web
❌ 不做：pass / scoring 状态机（那要状态容器，M3 做）
```

### 为什么边界这么死

ROADMAP 里有一条明确警告：

> ⚠️ **围棋必须等 P2 完成后再开始**：围棋要改 `new_game` 加 `game` 参数，
> 而 P1c 也要改 `new_game` 加准备阶段，同时做必冲突。

P2 现在完成了，但 **P1c 还没做**。所以：

- **P3a（纯引擎）现在就能做**，它不碰 `new_game`、不碰座位、不碰 `shared` 类型；
- **P3b（集成）要等 P1c 定下来再做**，否则两边抢着改 `new_game`。

`go.ts` 自成模块，类型（`GoRules` / `GoScore` 等）先放在**模块内部**，
不要提升到 `shared`。等 M0 做类型契约时再决定哪些要上提。

---

## 2. 要实现的函数

```ts
// server/src/core/go.ts

export const GO_BOARD_SIZE = 9;
export const DEFAULT_KOMI = 7.5;

export interface GoRules {
  boardSize: 9;
  komi: number;
  koRule: 'simple';
}

export function createGoBoard(size?: number): GoBoard;

/** 该点所在整块 + 去重后的气点（气按整块算，不能按单颗重复计数） */
export function blockAt(board, row, col): {
  stones: Cell[];
  liberties: Set<string>;
  libertyCells: Cell[];
};

export function libertiesAt(board, row, col): number;

/** 落子。返回新棋盘（不改输入）+ 本手提掉的子 + 新的 ko 点 */
export function playMove(
  board, color, row, col, koPoint?: Cell | null
): GoMoveResult;

/** 中国规则面积法。死子先移除，再数子+数地 */
export function scoreBoard(board, deadStones?: Cell[], komi?: number): GoScore;

/** 给 agent 看的棋块摘要，按危险度排序 */
export function summarizeGroups(board): GoGroupsView;

/** 9×9 等宽棋盘图 */
export function renderGoBoardText(board, options?): string;
```

`GoMoveResult` 用判别式，和现有 `engine.ts` 保持一致：

```ts
type GoMoveResult =
  | { ok: true; board: GoBoard; captured: Cell[]; koPoint: Cell | null }
  | { ok: false; code: GoErrorCode; message: string };

type GoErrorCode = 'OUT_OF_BOUNDS' | 'CELL_OCCUPIED' | 'SUICIDE' | 'KO';
```

---

## 3. 五条容易写错的规则

### 3.1 落子顺序（最常错）

必须是这个顺序，不能颠倒：

```text
1. 检查：空点 / 越界 / ko
2. 暂时落子（在副本上，别改输入）
3. 提掉所有无气的相邻敌块（是"所有"，不是找到一块就停）
4. 若己方块仍无气 → SUICIDE，丢弃副本
5. 记录 captures / lastCaptured
6. 算新的 koPoint
```

**先提敌块再判自杀**。顺序反了的话，「提子解围」这种合法手会被误判成自杀。

### 3.2 气必须按整块去重

```ts
// ❌ 错：按单颗数，共享的气会被数两次
stones.reduce((n, s) => n + neighbours(s).filter(isEmpty).length, 0)

// ✅ 对：整块的唯一气点集合
blockAt(board, row, col).liberties.size
```

按单颗数会让一块活棋看起来气数翻倍，死活判断全错。

### 3.3 ko 必须检查「独立一子」

提案原文：

> 提子方的落子本身是**独立一子**（没有和己方其他子相连）、提子后只有**一个气**，
> 这个气正好是被提点

只判断「棋块一气」不够。漏掉「独立一子」会把多子块提单子的普通反提误判成劫，
对手就被错误禁手了。

### 3.4 提子不计入分数

中国规则是**面积法**：

```text
黑总分 = 黑子数 + 黑地
白总分 = 白子数 + 白地 + komi
```

`captures` **只用于展示**，不进总分。这是最容易写出「看起来合理但是错的」结果的地方。

### 3.5 komi 加给白方

`komi` 默认 **7.5**，**加给白方**。这是补偿白方后手，是公平规则，不是给黑方的优惠。
UI/文档都要写明「贴目给白方」。

---

## 4. 测试：G1–G13 里属于 M1 的部分

提案 3.7 的表格，**按 M1 能不能做**筛过一遍：

| 编号 | 内容 | M1 能做吗 |
|---|---|---|
| G1 | 单子提子 | ✅ |
| G2 | 多子/多块提子 | ✅ |
| G3 | 自杀非法 | ✅ |
| G4 | 单子劫 | ✅（只测 `playMove` 返回的 `koPoint`，不测 pass） |
| G5 | 领地判定 | ✅ |
| G9 | 双活 | ✅ |
| G11 | 引擎不变量 | ✅（随机自对弈，只测提子守恒） |
| G12 | ko 清理 | ⚠️ 只测「非 ko 点落子会重算 ko」，pass 那半留给 M3 |
| G13 | 多块提子 | ✅ |
| G6 | 死子与数子 | ✅ 只测 `scoreBoard(board, deadStones)`，mark_dead 协议留给 M3 |
| G10 | pass 与恢复 | ❌ 需要状态机，M3 |
| G14 | mark_dead 重置 | ❌ 需要状态机，M3 |
| G15 | resume_play | ❌ 需要状态机，M3 |
| G16 | 数子胜负/贴目 | ✅ 纯 `scoreBoard` |
| G17 | wrongGame 分发 | ❌ 需要 room 层，M2 |
| G18 | 视图预算 | ⚠️ 可以先用 `summarizeGroups` + `renderGoBoardText` 测，不用等集成 |

### 4.1 提案里标出的两个测试构造问题（必须避开）

**G6 的构造不成立**（提案 §0 第 8 条原文）：

> G5 的棋盘上 (1,1) 放一颗白子并不会被黑围住；G6 需要明确的黑包围形。

自己构造一个真的能被围死的形状，别照抄 G5 的棋盘。

**G11 不能用 `moveCount`**：

> 随机自对弈 N 手：`黑落子数 = 黑盘面子数 + 被白提走数`；**用 place 数，不用 moveCount**；pass 不落子。

M1 里没有 pass，所以 `moveCount` 暂时等于 place 数——但**测试要按 place 数写**，
别依赖 `moveCount`，否则 M3 加 pass 后这条测试会莫名其妙挂掉。

### 4.2 G4 的劫构造

提案说「v2 的 G4 构造可用」，但 v2 文档没保留。自己构造一个标准劫形，参考：

```text
白棋先提黑一子形成劫，黑立即回提应得 KO
```

关键是**独立一子**：提子的那颗黑子周围不能有别的黑子。

---

## 5. 代码风格约定

跟现有 `rules.ts` / `engine.ts` 保持一致：

| 约定 | 说明 |
|---|---|
| 纯函数 | 输入不改，返回新棋盘（`board.map(line => line.slice())`） |
| 判别式返回 | `{ ok: true, ... }` / `{ ok: false, code, message }` |
| 错误码大写 | `SUICIDE` / `KO`，不要小写 |
| 注释写「为什么」 | 不写「这行在干什么」，写「为什么必须这样」 |
| 中文文案 | 面向用户的字符串用中文，代码和注释用英文 |

注释风格参考 `rules.ts` 的 `findWinLine`——讲清楚边界条件为什么这么处理。

---

## 6. 完成标准

```text
[ ] server/src/core/go.ts 写完，纯函数、不改输入
[ ] server/test/go.test.ts 覆盖 G1–G5、G9、G11–G13、G16
[ ] 提子顺序：先提敌块再判自杀
[ ] 气按整块去重
[ ] ko 检查「独立一子」
[ ] 提子不计入面积分
[ ] pnpm test 全绿（167 + 新增，不能挂现有的）
[ ] pnpm typecheck 通过
[ ] 没有改 shared/、没有改 room/、没有改 MCP 工具
```

### 自查一遍

```powershell
cd E:\code\fun\agent-arena
pnpm test        # 必须 ≥167 全绿
pnpm typecheck
git diff --stat  # 应该只看到 go.ts 和 go.test.ts
```

最后一条很重要：**`git diff --stat` 只该出现两个新文件**。如果动了别的地方，
说明越界了，退回去。

---

## 7. 提交

```powershell
git checkout -b feat/go-engine
# ... 写代码 ...
git add server/src/core/go.ts server/test/go.test.ts
git commit
```

提交信息：

```text
feat(go): 9x9 rules engine — capture, ko, area scoring

Pure functions only: board in, board out. No room, transport or session
concerns, so this lands without touching new_game or the seat model that
P1c will also edit.

Captures are display-only under Chinese area scoring; prisoners never enter
the total.
```

---

## 8. 做完之后

**不要**接着做 M0 或 M2。P3b 要等 P1c 定下来，否则两边抢 `new_game`。
做完 P3a 就停下，等评审。
