# Agent 视图与威胁雷达 · 审查报告与整改清单

> 审查对象：当前工作区未提交的 Agent 视图改动（`server/src/core/insights.ts`、`shared/src/{game,protocol}.ts`、`server/src/mcp/*`、`server/src/rooms/room.ts`、`server/src/http/routes.ts`、`web/src/api.ts`、测试与文档）
> 审查日期：2026-10-23
> 审查结论：**方向正确，核心 `win/open4/four` 判定可信，演示复现了输棋形；但合并前必须处理 4 个 P0 问题，另有 4 项 P1 建议跟进。**
> 使用方式：GLM 按 §3 逐条修改，按 §5 自测，完成后回传「改动文件 + 测试结果 + 100 手 payload 实测数字」。

---

## 1. 总体评价

这次改动的价值在于：**把 LLM 不擅长的空间计数，换成了服务端的确定性计算**，而不是继续堆提示词。方向完全正确。

- `boardText` 让模型不必逐格消费 15×15 的 null 数组；
- `hotPoints` 的 `win / open4 / four` 用「落子后有几个成五点」定义，能覆盖直四、跳四、双四，`fiveAt` 给出可执行的挡点；
- 两种传输（`InProcessApi` / `HttpApi`）共用 `toAgentStateView()`，不会漂移；
- 演示脚本精确复现了这盘棋的输棋形：黑 **(9,4)** 被标为 `open4`，`fiveAt = [(7,2), (12,7)]`。

但当前版本还有几处会让它「数据对了、决策未必对」，以及一处明显的 token 反向优化。下面按优先级列出。

### 问题索引

| ID | 优先级 | 问题 | 关键文件 | 核心验收 |
|---|---|---|---|---|
| P0-1 | 必改 | 缺「对手 open4 候选点」防守纪律 | `mcp/tools.ts` | 指令含优先级；演示局面应选 (9,4) |
| P0-2 | 必改 | `moves` 全量历史导致 100 手 6.9KB | `core/insights.ts`、`mcp/*` | hot-path ≤ 4000 字符 |
| P0-3 | 必改 | `boardText` 表头 `91011121314` 黏连 | `core/insights.ts` | 表头可解析出 0..14 |
| P0-4 | 必改 | 错误响应丢 history，`moveCount` 矛盾 | `mcp/*`、`http/routes.ts` | 错误里 moves 与 moveCount 一致 |
| P1-1 | 跟进 | `overlineWin:false` 六连误报 win | `core/insights.ts` | 六连不出现 win |
| P1-2 | 跟进 | `three/open3` 启发式噪音 | `core/insights.ts` | `X..XX` 不再叫 three |
| P1-3 | 跟进 | 文档 / 契约漂移 | `docs/DESIGN.md`、`README.md` | 文档与代码一致 |
| P1-4 | 跟进 | 缺不变量 / 规则变体测试 | `test/insights.test.ts` | 新增不变量、规则、表头等测试 |

---

## 2. 验证基线（当前代码实测）

### 2.1 测试与性能

```text
pnpm --filter @arena/server test
Test Files  5 passed (5)
Tests       93 passed (93)
```

`findHotPoints` 在 15×15 中盘局面上平均 **0.214 ms**（500 次），性能没有必要优化。

### 2.2 演示脚本

```text
node scripts/demo-agent-view.mjs
...
(9,4) -> open4 fiveAt=[{"row":7,"col":2},{"row":12,"col":7}]
...
boardText size: 604 chars
```

这就是那局黑棋第 47 手 (9,4) 的致胜形：黑下 (9,4) 形成两个成五点；白挡 (7,2) 则黑 (12,7) 成五，反之亦然。

### 2.3 响应体积（同一 46 子盘面，仅历史长度不同）

| 负载 | 46 手 | 100 手 |
|---|---:|---:|
| 旧 `GameState` JSON | 1732 字符 | 1732 字符 |
| 新 `AgentStateView` | 4474 字符 | 6920 字符 |
| 其中 `moves` | 2077 | 4523 |
| `boardText` | 约 600 | 约 600 |
| `hotPoints`（25 条） | 1311 | 1311 |

结论：新视图在 46 手时约为旧负载的 **2.6 倍**，100 手时约为 **4 倍**。`moves` 是主要增长源，而不是 `boardText`。

### 2.4 自定义规则误判（已复现）

`overlineWin: false` 时，构造棋盘黑棋在 (7,3)(7,4)(7,5)(7,6)(7,8)，候选点 (7,7) 会形成六连：

```text
overlineWin=false move (7,7) -> win | engine findWinLine: null
```

即 `findHotPoints` 报告 `win`，但引擎判定不赢。v1 默认 `overlineWin: true` 不受影响，但 `RuleSet` 是参数化的，这是一个真实的规则语义漏洞。

### 2.5 `boardText` 表头黏连

当前实际输出：

```text
    0 1 2 3 4 5 6 7 8 91011121314
```

9、10、11 连成 `9101112`，列号本身不可解析。这是「不要数格子」目标的反例。

### 2.6 错误路径丢历史

`server/src/mcp/tools.ts` 的 `errorResult` 当前写法：

```ts
state: error.state ? toAgentStateView(error.state, []) : null,
```

会导致「`moveCount = 46` 但 `moves = []`」的自相矛盾视图。

---

## 3. P0：合并前必须处理

### P0-1 缺少「对手 open4 候选点」的防守纪律

**问题**

当前 instructions 只写了：

> 每次落子前检查 hotPoints：对手的 win 点必占，four 点必挡（挡点=fiveAt），
> 自己的 win 点直接取胜；其余按 open4 > four > open3 优先级选点。

它没有明确说：**对手的 open4 候选点，必须在本手直接占掉该点本身**。模型很可能把 `open4` 当成自己的进攻优先级，继续下自己的活三，然后输棋。

这盘棋的输棋形（46 手后、轮到黑方）正是：

```json
"hotPoints": {
  "black": [
    { "row": 9, "col": 4, "effect": "open4",
      "fiveAt": [{ "row": 7, "col": 2 }, { "row": 12, "col": 7 }] }
  ]
}
```

对白方而言，上一手（白 46）的正确防守是**占 (9,4)**；一旦黑先下 (9,4)，白再挡 (7,2) 或 (12,7) 都已经晚了。雷达给了正确数据，但提示词没有给「怎么用」的纪律。

**改法（必须）**

1. 更新 `SERVER_INSTRUCTIONS`，明确优先级。
2. 同步更新 `wait_for_turn`、`place_stone`、`get_state` 的 tool description（有些客户端不展示 server instructions）。
3. 建议文字：

```text
每次落子前按以下顺序检查 hotPoints（先看对手，再看自己）：
1. 自己的 win 点：直接落子获胜。
2. 对手的 win 点：必须占住；若对手同时有两个 win 点，说明 open4 已成立，
   无法全挡，选择最能拖延或制造反击的一手。
3. 自己的 open4 候选：优先落子，形成对手挡不住的双杀。
4. 对手的 open4 候选：必须在本手占住该候选点本身（hotPoints[对手] 中
   effect=open4 的 row/col），不要等对方落子后再去挡它的 fiveAt。
5. 对手的 four（占其 fiveAt）、自己的 four / open3。
低阶 three 只作参考；不要为了低阶点放弃上面的必防项。
```

**可选增强（非必须）**

如果希望弱模型不依赖提示词理解，可以在 `AgentStateView` 增加一个派生摘要，例如：

```ts
defense: {
  mustBlockWin: Cell[];      // 对手 win 点
  mustOccupyOpen4: Cell[];   // 对手 open4 候选点
  mustBlockFour: Cell[];     // 对手 four 的 fiveAt
}
```

这样模型不需要自己从 `hotPoints[对手]` 反推。但会增加类型/传输改动，建议先做提示词版本。

**验收**

- `SERVER_INSTRUCTIONS` 和三个相关 tool description 都包含上述优先级。
- 用演示局面回退到白 46 手之前人工检查：白方应选择 (9,4) 而不是自己的 open3。
- 若实现了 `defense` 字段，补单元测试：`defense.mustOccupyOpen4` 包含 (9,4)。

**涉及文件**：`server/src/mcp/tools.ts`（可能还有 `shared/src/protocol.ts`、`server/src/core/insights.ts`、两个 API 适配器）。

---

### P0-2 `moves` 全量历史让响应变大，和节省 token 的初衷相反

**问题**

每次 `wait_for_turn` / `place_stone` / `resign` 都返回完整 `moves`。100 手时 `moves` 占 4523 字符，每次工具调用都在重复发送历史。

实测：

| 负载 | 46 手 | 100 手 |
|---|---:|---:|
| 旧 `GameState` | 1732 | 1732 |
| 新视图 | 4474 | 6920 |

**影响**

- 100 手时每次工具响应多出约 5KB，一局累积的上下文非常可观；
- 长上下文会稀释模型对当前盘面的注意力，可能反过来降低走子质量；
- `wait_for_turn` 每次超时（默认 20s）也会重发一次全量历史。

**改法（必须至少选一种）**

优先推荐：

1. `get_state` 保留完整 `moves`；
2. `wait_for_turn` / `place_stone` / `resign` / 错误响应只带最近 6–10 手，并显式标记省略：
   ```ts
   moves: MoveRecord[];      // 最近 N 手
   movesOmitted: number;     // 更早的手数，0 表示完整
   ```
   或用紧凑的 `movesText` **替代** hot-path 上的结构化 `moves`（如 `1.X77 2.O78 ...`，100 手约 700 字符），而不是和全量 `moves` 并存。
3. 错误路径同样按此规则处理。

**硬性要求**

- 不能悄悄截断而不告诉模型：加 `movesOmitted` / `historyTruncated` / `movesFrom` 任一明确字段。
- 两种传输（HTTP / stdio）返回完全一致。
- `get_state` 仍然能拿到完整历史，供复盘使用。

**验收**

- 构造 100 手历史，`wait_for_turn` / `place_stone` 的响应 JSON **≤ 4000 字符**（当前 6920），`get_state` 可以更大。
- 新增测试：100 手时 hot-path 长度上限；`movesOmitted` 数值正确；`get_state.moves` 完整。
- 若采用 `movesText`，测试 100 手时 `movesText` 长度 ≤ 1000 字符。

**涉及文件**：`shared/src/protocol.ts`（`AgentStateView`）、`server/src/core/insights.ts`（`toAgentStateView` 增加选项或新函数）、`server/src/mcp/http.ts`、`server/src/mcp/stdio.ts`、`server/src/mcp/tools.ts`、测试、README/DESIGN。

---

### P0-3 `boardText` 表头会黏连，列号不可解析

**问题**

当前实际输出：

```text
    0 1 2 3 4 5 6 7 8 91011121314
```

9、10、11 连成 `9101112`，模型可能把它读成 910、1112 等。

**改法（二选一）**

- 方案 A（最小改动）：列号和行号都补成两位数，即 `00 01 ... 09 10 11 ... 14`；单元格宽度不变。在 legend 里注明「行列为 0-based，两位数补零」。
- 方案 B：每列改成 3 字符宽（`  0`、` 10`、` 14`），行与表头一起调整。

方案 A 不增加体积，推荐优先；但无论哪种，都必须让每个列号可被唯一解析。

**验收**

- 新增测试：把表头按空白拆分后，得到 `[0,1,...,14]`；行标签同样。
- 演示输出不再出现 `9101112` 这种连续串。

**涉及文件**：`server/src/core/insights.ts`（`renderBoardText`）、`server/test/insights.test.ts`。

---

### P0-4 错误响应丢历史，`moveCount` 与 `moves` 自相矛盾

**问题**

`tools.ts` 当前：

```ts
state: error.state ? toAgentStateView(error.state, []) : null,
```

对局进行到 46 手时若 `place_stone` 返回 `CELL_OCCUPIED`，错误里会出现 `moveCount: 46` 但 `moves: []`。模型想根据错误复盘时上下文断裂。

**改法（必须）**

- 给 `ArenaApiError` 增加 `history?: readonly Move[]`（或 `AgentStateView`）；
- `InProcessApi` 在构造错误时带上 `room.getHistory()`；
- `HttpApi` 在 REST 错误响应中携带 `history`（需要给 `ErrorResponse` 加可选 `history`，并同步 `routes.ts` 的所有错误返回）；
- `errorResult` 使用 `error.history ?? []`，并按 P0-2 的截断策略处理；如果历史不可得，显式标记 `historyOmitted`，不要伪装成空历史。

**验收**

- 进行 3 手后制造 `CELL_OCCUPIED`，错误文本里 `state.moves.length === 3` 且 `moveCount === 3`。
- HTTP MCP 与 stdio 的错误行为一致。
- 无历史可用的错误（如未知房间）返回 `state: null`，不要出现矛盾字段。

**涉及文件**：`shared/src/protocol.ts`（`ErrorResponse`）、`server/src/mcp/api.ts`、`server/src/mcp/http.ts`、`server/src/mcp/stdio.ts`、`server/src/mcp/tools.ts`、`server/src/http/routes.ts`、测试。

---

## 4. P1：建议跟进（不阻塞合并，但应排期）

### P1-1 自定义规则语义

**证据**：`overlineWin: false` 时，六连候选被报告为 `win`，引擎 `findWinLine` 返回 `null`（见 §2.4）。

**改法**

- `classifyPlacement` 的 `win` 判定改为复用引擎的 `findWinLine()`（在临时落子后调用），让 `overlineWin` / `winLength` 语义与规则引擎一致；
- `open4/four/open3` 的窗口算法本身可以保留，但要在注释/文档中说明它们按 `winLength` 计算；
- `winLength != 5` 时 `four/open3/three` 的名字会失真，至少在文档里注明，或改成 `threatLevel` 这类中性命名。

**验收**

- `overlineWin: false` 的六连不出现 `win`；
- `winLength: 6` 的规则能正确识别六连获胜，并有测试；
- 不改变默认 15×15 / `winLength=5` 的行为。

### P1-2 `three` / `open3` 是启发式，名字比实际强

**证据**

当前 `insights.test.ts` 中，黑棋在 (7,7)(7,8)，候选 (7,4) 被断言为 `three`：

```ts
expect(pointsAt(hot.black, 7, 4)?.effect).toBe('three');
```

但落子后是 `X..XX`（两格空隙），并不是「眠三」。`open3` 也存在类似的宽松判定。

**影响**

模型如果把 `three` 当真，会去防一个假威胁；虽然低阶有数量上限、且排在最后，但会稀释真正重要的点。

**建议**

- 最低成本：**删掉 `three`**，只保留 `win/open4/four`；`open3` 可选保留。
- 或把 `three` 改名为 `potential`，并在提示词里明确「只作参考」。
- 或收紧判定：只有「一个缺口、可一着变成开四」的形才算 `open3`；`three` 需要更严格的定义。

**验收**

- `X..XX` 不再被标为 `three`（或改名后语义正确）；
- 更新测试和提示词；
- 若删除 `three`，`MAX_PER_EFFECT` 同步清理。

### P1-3 文档 / 契约漂移

当前代码已经与设计文档不一致，请一并修正：

| 位置 | 现状 | 应改为 |
|---|---|---|
| `docs/DESIGN.md` 版本头 | `v0.6` | 本次改动后的版本（如 v0.7），并在 changelog 记录 |
| §8.2 `RoomView` | `{ state, commentary }` | `{ state, history, commentary }` |
| §10.1 MCP 输出 | `state: GameState` | `state: AgentStateView`（boardText / moves / hotPoints） |
| §10.2 REST 表 | `GameState` | `POST games/moves/resign` 返回 `{ state, history }`；`wait-for-turn` 含 `history` |
| §4bis 标题 | `## 4bis` | 建议改成正式编号，避免目录混乱 |
| README | 93 测试、Agent 视图段 | 与最终实现一致；补 payload 取舍说明 |

另外确认 `ErrorResponse`、`RoomView`、`AgentStateView` 的类型定义与文档一致。

### P1-4 测试缺口

现有 12 个 insights 测试覆盖了主要形状，建议补：

1. **与引擎的不变量测试**（最有价值）：
   ```ts
   for (const color of ['black', 'white'] as const) {
     for (const point of findHotPoints(board, rules)[color]) {
       const after = place(board, color, point);
       if (point.effect === 'win') {
         expect(findWinLine(after, point.row, point.col, rules)).not.toBeNull();
       }
       for (const five of point.fiveAt) {
         const finalBoard = place(after, color, five);
         expect(findWinLine(finalBoard, five.row, five.col, rules)).not.toBeNull();
       }
     }
   }
   ```
2. `overlineWin: false` / `winLength: 6` 的规则变体；
3. 错误路径 history（见 P0-4）；
4. 100 手 payload 上限（见 P0-2）；
5. 表头解析（见 P0-3）；
6. 低阶点的上限/排序（若保留）。

---

## 5. 实施顺序与验收清单

### 5.1 建议顺序

1. P0-3（表头）——最小、纯文本、好测；
2. P0-4（错误 history）——类型改动小，但涉及两个传输；
3. P0-2（payload）——类型/适配器改动最大，先定方案再写；
4. P0-1（防守纪律）——提示词 + 可选 `defense` 字段；
5. P1-1 / P1-2（规则与低阶噪音）；
6. P1-3 / P1-4（文档、测试）。

### 5.2 硬性约束

- **不要**改棋盘几何、Web UI、游戏规则引擎的行为；
- **不要**移除 `boardText` / `hotPoints`，也不要让 `state.board` 回到 MCP 负载；
- **不要**改 MCP 工具名，参数只做加法；
- **不要**引入新的运行时依赖；
- `InProcessApi` 与 `HttpApi` 必须返回同一份视图；
- REST/WS 仍保留完整 `board` 供网页渲染；
- 不要求做 minimax / 内置棋力引擎 / 自动落子。

### 5.3 验收清单

```text
[ ] pnpm build:shared
[ ] pnpm --filter @arena/server test        # ≥ 93 且全绿
[ ] pnpm typecheck
[ ] pnpm build
[ ] node scripts/demo-agent-view.mjs         # 输出 (9,4) open4 + fiveAt (7,2)(12,7)
[ ] 100 手 hot-path 响应 ≤ 4000 字符         # 记录实测值
[ ] boardText 表头可解析为 0..14
[ ] overlineWin=false 六连不出现 win
[ ] 错误响应 moveCount 与 moves 一致
[ ] HTTP MCP / stdio 集成测试全绿
[ ] 文档（DESIGN/README/类型注释）与代码一致
```

### 5.4 回传格式（给 GLM）

改完后请在回复里附：

1. 改动文件清单；
2. P0 每项的解决方式（一两句话）；
3. `pnpm test` / `pnpm typecheck` / `pnpm build` 结果；
4. 100 手 payload 实测字符数（改前 / 改后）；
5. `node scripts/demo-agent-view.mjs` 的输出片段；
6. 新增测试列表。

---

## 6. 不要做的事

- 不要用「在 prompt 里写记住检查斜线」来替代 `hotPoints` 的确定性数据；提示词只负责防守优先级；
- 不要为了减小 payload 而删掉 `boardText` 或 `hotPoints`；
- 不要把 `hotPoints` 移回客户端或让模型自己算；
- 不要引入数据库、Redis、棋力引擎依赖；
- 不要为了这次改动重写 Room / 传输层。

---

## 7. 备注

- 本文档是审查记录，不是设计文档；实现完成后可归档或删除。
- 文中「100 手 payload」是按当前同一中盘盘面追加历史测得的，改完后请用同样方法复测，避免因为盘面不同导致数字不可比。
- 本盘决胜形的复盘数据在 `scripts/demo-agent-view.mjs`，可直接作为回归用例。
