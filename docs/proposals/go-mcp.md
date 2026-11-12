# 提案：9 路围棋模式并入 agent-arena

> 状态：**v3，DeepSeek 评审修订**｜原作者：GLM (ZCode)｜日期：2026-10-24
> 评审结论：**方向可行，但 v2 不能直接开工。** 规则引擎本身不难，真正的成本在
> `GameState` 判别、pass/scoring 状态机、`wait_for_turn` 的数子唤醒，以及 web 的类型收窄。
> v3 把这几处补成可实现的契约，并澄清了贴目语义（7.5 是白方后手的公平补偿，
> 不是“对黑更宽松”），同时修正了“106 测试原样不动”的乐观假设。
>
> v2 变更保留：不新建仓库，围棋作为第二种游戏并入本仓库（web 可选五子棋 / 围棋）；
> 仓库名后续由用户手动改，纯重命名不阻塞开发。

## 0. 评审结论（先读）

**可以按“同仓库、同服务、同 MCP 端点、房间级 game 变体”做。** 9 路 + 中国规则面积法
是正确选择；围棋雷达只给气/块/提子事实，不接引擎，也符合这组对局的目的。

但 v2 有 8 个硬问题，必须在 M0/M1 解决，否则实现会返工：

1. **贴目是公平补偿，不是给黑方的优惠**：komi 加给白方；白方后下，7.5 是国际比赛
   常用的公平补偿。v2 的 bug 只是把它写成“对黑更宽松”，不是 7.5 本身错了。
   v1 默认 **7.5**（可配；不因用户水平自动降低，让子另设，v1 不做），并在 UI 明示
   “贴目给白方”。
2. **“boardSize 可配 5/7/9/13”是范围蔓延**：v1 只做 9 路；5/7/13 的星位、贴目、
   UI 和平衡都要单独处理，放到 M5。`new_game` 对非 9 的 `boardSize` 先返回
   `UNSUPPORTED_RULE`，不要静默接受。
3. **`GameState` 不是“gomoku 分支原样保留”**：必须引入 `AnyGameState` / `GoState`，
   并给现有 `GameState` 加 `game: 'gomoku'` 与 `schemaVersion: 2`。106 个五子棋测试
   要改 fixture，不是“原样不动”；行为断言可以保持。
4. **pass 不是普通 `Move`**：`Move` 目前强制 `row/col`。必须新增 `GoPassMove` /
   `AnyMove`，否则 history、`lastMove`、`moves` 和持久化都会变形。
5. **scoring 没有唤醒协议**：两次 pass 后 `status='scoring'`，`wait_for_turn` 现在只会
   看 `turn`，会返回错误的 `your_turn` 或永久挂起。必须新增 `reason='scoring'`，
   并定义“已确认的一方等对方确认”的阻塞语义。
6. **Go 视图缺 `deadStones` / `scoreConfirmed` / `scorePreview`**：只给 `scorePreview`
   不够，agent 不知道哪些子被标死、谁已确认，无法完成数子确认。
7. **v2 的 `+15%` 工作量估计过于乐观**：类型/room/transport 的判别 + scoring 状态机 +
   web 入口与围棋盘，实际更接近 **+40%–60%**（不含调规则和死话题材）。
8. **G6 测试构造不成立**：G5 的棋盘上 (1,1) 放一颗白子并不会被黑围住；
   G6 需要明确的黑包围形。G11 的不变量也不能用 `moveCount` 当“黑落子数”（pass 也计数）。

## 1. 背景与动机

五子棋系列赛 4 局打完 2:2，但黑棋 4 战 4 胜（49 / 25 / 23 / 19 手）；自由规则先手优势
在实测中非常明显。换 9 路围棋的动机成立：

1. **贴目可以平衡先后手**，颜色不再直接决定胜负；
2. **不接围棋引擎**时，LLM 的数气、打吃、死活判断会真实暴露，和用户形成可玩的对手；
3. **9 路**只保留“数气 + 吃子 + 围地”，不需要 19 路定式。

## 2. 产品定位与非目标

一句话：**同一服务进程内新增 9 路围棋模式，与五子棋并存；web 开局时选游戏，
MCP 用 `state.game` 判别；围棋的 Agent 视图提供气/块/提子/数子事实，不提供胜负结论。**

v1 明确不做：

- 不接 KataGo / GNU Go 等围棋引擎，也不做 AI 分析模式。
- 不做 19 路；v1 只做 9 路。5/7/13 路放 M5。
- 不做日式数目法；只做中国规则面积法。
- v1 不做 superko；只做 simple ko（见 §3.3），superko 放 M5。
- 不做段位 / 排行榜；每房间一局，不同房间可各下一种游戏。
- **不破坏五子棋行为**：现有工具语义、REST/WS 字段和 106 个测试的行为断言保持；
  但 `GameState` 会增加 `game` / `schemaVersion` 字段，测试 fixture 需要同步更新。

## 3. 规则引擎（M1）

### 3.1 规则集与棋盘

```ts
interface GoRules {
  boardSize: 9;          // v1 固定 9；非 9 返回 UNSUPPORTED_RULE
  komi: number;          // 默认 7.5，加给白方；建议半整数避免和棋
  koRule: 'simple';      // v1 只有 simple；superko 放 M5
}
```

- `board: (StoneColor | null)[][]`，9×9；坐标 `(row, col)` 0-based。
- 引擎放 `server/src/core/go.ts`，纯函数、board 进 board 出；`rules.ts` 不承载围棋规则。
- `komi` 方向必须在 UI/文档写死：**白方总分 = 白子 + 白地 + komi**。
  默认 **7.5** 是公平补偿白方后手，不是给黑方的优惠；7.5 让白方有利正是设计目的。
  若显式降低 komi，那是 handicap（让子/让目），不属于公平规则；v1 只做标准 7.5（可配），
  不因用户水平自动调整。

### 3.2 落子、提子、自杀

落子顺序必须是：

1. 检查空点、轮次、ko；
2. 暂时落子；
3. 找出并提掉**所有**无气的相邻敌块（不是只找一块）；
4. 若己方块仍无气 → 非法 `SUICIDE`，恢复棋盘与状态；
5. 记录 `captures[color] += 提掉子数`、`lastCaptured`；
6. 轮次切换、`consecutivePasses=0`、清空上一手的 `koPoint`。

错误码统一用现有大写风格：`CELL_OCCUPIED`、`SUICIDE`、`KO`、`OUT_OF_BOUNDS`、
`NOT_YOUR_TURN`、`GAME_NOT_PLAYING`。v2 里的小写 `occupied/suicide/ko` 不要用。

### 3.3 劫（simple ko）

v1 只实现 simple ko：

- 一手提掉**恰好一颗**子，且提子方的**落子本身是独立一子**（没有和己方其他子相连）、
  提子后只有**一个气**，这个气正好是被提点，则把该点设为 `koPoint`；
- `koPoint` 只禁止**下一手**立即回提；任何落子或 pass 都先清空 `koPoint`，再按新一手重算；
- 多子提、提子方棋块有多个气/多颗子、或非单子回提，不设 simple ko（superko 另说）。
  不要只判断“棋块一气”而漏掉“独立一子”，否则会把多子反提误判成劫。

G4 的构造可用；补一条“pass 也清 ko”的测试（G12）。

### 3.4 pass 与终局

- `pass` 是正式的一手：计入 `moveCount` 和 history，`lastMove` 为 `GoPassMove`；
  不计入棋盘子数，不增加 captures，`lastCaptured=[]`；清空 ko，`consecutivePasses += 1`。
- 连续两次 pass → `status='scoring'`，`turn` 保持“下一手本应落子的一方”（
  两次 pass 后通常就是最后 pass 者的对手）；`consecutivePasses` 保留为 2 供视图显示。
- scoring 阶段禁止 `place_stone` / `pass`，只允许 `mark_dead` / `confirm_score` /
  `resume_play` / `resign`。
- `resume_play`：任意一方可调用；`deadStones=[]`、双方 `scoreConfirmed=false`、
  `consecutivePasses=0`、`status='playing'`；`turn` 不变（就是下一手方）。

### 3.5 数子（中国规则面积法）

- 先复制棋盘，移除 `deadStones` 标记的死子；
- 黑/白“子数”= 棋盘上剩余该色棋子数；
- 空区域洪泛：只邻黑 → 黑地；只邻白 → 白地；同时邻两色 → 中立；
- `blackArea = blackStones + blackTerritory`；
  `whiteArea = whiteStones + whiteTerritory`；
  `blackTotal = blackArea`；`whiteTotal = whiteArea + komi`；
- **提子数只用于展示，不计入面积分**（`captures` 不是 prisoner score）；
- 双活/公气按面积法自然处理：双方活子照计，公共气中立，不需要死活算法；
- `score` 结构：
  ```ts
  interface GoScore {
    blackArea: number; whiteArea: number;
    komi: number;
    blackTotal: number; whiteTotal: number;
    winner: StoneColor | 'draw';
    margin: number;       // abs(blackTotal - whiteTotal)
  }
  ```
- scoring 阶段的 `scorePreview` 用当前 `deadStones` 计算，但**不写回棋盘**；
  `confirm_score` 双方都确认后才移除死子、写 `score`、置 `status='finished'`、
  `endReason='scored'`。

### 3.6 死子标记协议

`GoState` 必须显式保存：

```ts
deadStones: Cell[];                    // 所有被标死的棋子坐标（按整块 toggle）
scoreConfirmed: Record<StoneColor, boolean>;
```

`mark_dead(row,col)`：

- 只允许 `status='scoring'`，否则 `NOT_SCORING`；
- 找到该点所在整块；若整块**全部**已在 `deadStones` 中，则整块取消标记；
  否则整块加入（不要只 toggle 单颗）；
- 任何标记变化都把 `scoreConfirmed` 两方重置为 false；
- 空点/越界 → `INVALID_DEAD_STONE`。

`confirm_score`：只允许 scoring；把调用者 seat 的 `scoreConfirmed` 置 true；
双方都为 true 时按 §3.5 终局。已确认的一方再次调用是幂等的，不报错。

### 3.7 引擎验收测试表（修正版）

| 编号 | 内容 | 期望 |
|---|---|---|
| G1 | 单子提子 | 黑(2,2)；白(2,1)(1,2)(3,2)，白下(2,3) → (2,2) 变空；`captures.white=1`；`lastCaptured=[(2,2)]` |
| G2 | 多子/多块提子 | 构造一个被围的连二 + 另一个被围单子，一手同时提掉；两块都移除，captures 数正确 |
| G3 | 自杀非法 | 白(0,1)(1,0)(1,1)；黑下(0,0) → `SUICIDE`，棋盘/状态不变 |
| G4 | 单子劫 | v2 的 G4 构造；白立即回提 → `KO`；白他处一手、黑应一手后回提合法 |
| G5 | 领地判定 | 黑占满 col0，白占满 col8，其余空 → 中间 7 列中立；黑 9 / 白 9+komi |
| G6 | 死子与数子 | 白(1,1)，黑(0,1)(1,0)(1,2)(2,0)(2,2)(3,1)；白块唯一气(2,1)，是合法死子；mark_dead(1,1)、双方 confirm → 移除白子后 (1,1)+(2,1) 成为黑地；captures 不参与分数 |
| G9 | 双活（可选） | 标准双活型；双方活子照计，公共气中立，不误判 |
| G10 | pass 与恢复 | 两次 pass → scoring；resume_play → playing，pass=0，turn 为下一手方 |
| G11 | 引擎不变量 | 随机自对弈 N 手：`黑落子数 = 黑盘面子数 + 被白提走数`（白同理）；**用 place 数，不用 moveCount**；pass 不落子 |
| G12 | ko 清理 | 提劫后 pass，下一手回提合法（koPoint 已清） |
| G13 | 多块提子 | 一手同时提两个独立敌块，顺序/计数正确 |
| G14 | mark_dead 确认重置 | 一方 confirm 后另一方 mark_dead → 双方 confirm 都变 false |
| G15 | resume_play | scoring 中 resume → 死子清空、确认清空、pass 清零、棋盘不变 |
| G16 | 数子胜负/贴目 | 黑 40、白 35、komi 7.5 → 白 42.5 胜；和棋/半目边界 |
| G17 | wrongGame 分发 | gomoku 房间调用 pass/mark_dead/confirm_score/resume_play → `WRONG_GAME` |
| G18 | 视图预算 | 60 手 9 路局面序列化 ≤4000 字符，`groupsOmitted` 生效 |

## 4. 状态模型（M0，必须先做）

### 4.1 推荐的低风险 union

不要直接把现有 `GameState` 改名成 union 再全仓库找编译错误。推荐：

```ts
export interface GameState {          // 保留名字 = 五子棋状态，降低迁移
  game: 'gomoku';
  schemaVersion: 2;
  rules: RuleSet;
  ...
}

export interface GoState {
  game: 'go';
  schemaVersion: 2;
  rules: GoRules;
  board: (StoneColor | null)[][];
  turn: StoneColor;                   // scoring 时仍是“下一手方”
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

- `RoomView.state: AnyGameState`，`history: AnyMove[]`；`RoomSummary` 增加 `game`；
  `PersistedRoom` / `RoomRepository`、`MutationResponse` / `ErrorResponse` 的
  `state`/`history` 同样改用 `AnyGameState` + `AnyMove[]`。
- 现有 `engine.ts` / `room.ts` 的五子棋分支继续用 `GameState`；room 的公共入口用
  `AnyGameState`，用 `state.game` 分派。
- `AgentStateView` 同理：保留五子棋 `AgentStateView`，新增 `GoAgentStateView`，
  导出 `AnyAgentStateView` 给 transport/工具使用；`AgentStateResponse` /
  `AgentWaitForTurnResponse` 的 `state` 都用这个 union。
- `schemaVersion` 升到 2；五子棋新增 `game:'gomoku'`，现有 REST/WS 客户端忽略额外字段即可。
- 106 个五子棋测试的 fixture 要补 `game`/`schemaVersion`；行为断言不变。

### 4.2 Move / pass

`Move` 当前强制 `row/col`，不能直接表示 pass。推荐：

```ts
export interface GoPassMove {
  kind: 'pass';
  color: StoneColor;
  index: number;
  at: string;
}
export type GoMove = Move | GoPassMove;   // Go 的落子复用 Move
export type AnyMove = Move | GoPassMove;
```

- `GoState.lastMove: GoMove | null`；room `history: AnyMove[]`。
- `MoveRecord` 增加 `kind: 'place' | 'pass'`；pass record 不带 row/col（或单独
  `GoMoveRecord`），`moves` 中显示为 `pass(B)`。
- `lastMove` 为 pass 时，`boardText` 不标小写最新子，末尾写 `最新一手: 白 pass 第N手`。
- 落子被提/提子记录可放在 `lastCaptured`，不必塞进 `Move`；若 UI 需要逐手提子，
  再给 `Move` 加 `captured?: Cell[]`。

### 4.3 wait_for_turn 的 scoring 语义

`WaitReason` 增加 `'scoring'`。`reasonFor` 按以下顺序：

1. `status='idle'` → `idle`；
2. `status='finished'` → `game_over`；
3. `status='scoring'`：
   - 本 seat 尚未 `confirmed` → `scoring`（立即返回，让 agent 去标死/确认）；
   - 本 seat 已 confirmed、对方未 confirmed → 继续等待；
   - 双方 confirmed 后 status 变 finished → `game_over`；
4. `turn === seat` → `your_turn`；
5. gameId 变化 → `new_game`；
6. 否则等待。

`mark_dead` / `resume_play` 重置确认后要 `emitState`，让已确认的一方重新收到 `scoring`。
`confirm_score` 也要 `emitState`，让等待的对方收到 `game_over` 或继续等待。
不要用 `turn` 判断 scoring 阶段“轮到谁”；数子确认是双方并行的。

## 5. AgentStateView（围棋雷达，M2）

### 5.1 判别与字段

Go 视图顶层 `game:'go'`；五子棋视图顶层 `game:'gomoku'`。Go 分支：

| 字段 | 内容 |
|---|---|
| `boardText` | 9×9 等宽图，列 0–8、行 00–08；`B/W/.`；小写=最新落子；最近一手提掉的空点用 `×` 标注（只标 `lastCaptured`）；pass 无小写 |
| `turn/status/moveCount/lastMove/komi` | 常规；scoring 时 `status='scoring'`，`turn` 是下一手方 |
| `consecutivePasses` | >0 时透出 |
| `koPoint` | simple ko 禁点；无则 null |
| `moves` + `movesOmitted` | 最近 8 手；pass 记录为 `{kind:'pass',color,index}` |
| `captures` | `{black,white,lastCaptured}`；**只展示，不计分** |
| `groups` | 按危险度排序的棋块摘要；见 §5.2 |
| `deadStones` | scoring 阶段所有被标死的坐标（按整块） |
| `scoreConfirmed` | `{black,white}`，scoring 阶段谁已确认 |
| `scorePreview` | scoring 阶段按当前死子标记计算的 `GoScore`；playing 时为 null |
| `score` | 终局 `GoScore`；未终局 null |

### 5.2 groups 的结构与预算

```ts
interface GoGroupSummary {
  color: StoneColor;
  stones: number;
  representative: Cell;   // 最上、再最左的棋子；稳定可复现
  liberties: number;
  libertyAt?: Cell[];     // liberties <= 2 时给坐标；>=3 省略
}
interface GoGroupsView {
  black: GoGroupSummary[];
  white: GoGroupSummary[];
  omitted: { black: number; white: number };
}
```

- 每色按 `liberties` 升序、`stones` 降序；每色最多 12 块，超出写 `omitted`，
  不要用字符串 `…另有 N 块` 让 agent 再解析。
- 气数必须按**整块**唯一气点计算，不能按单颗重复计数。
- 只给事实：气数、坐标、块大小、提子；不给“该逃/该弃/哪块死了”的结论。
- 9×9 全量重算足够快，不需要增量结构；G8 用 60 手局面测 ≤4000 字符。

### 5.3 SERVER_INSTRUCTIONS 分段

开头写“先读 `state.game`”，然后分两段：

**gomoku**：保留现有 v0.4 的防守优先级（win/open4/double/four）。

**go**：

1. 每次落子前先看 `groups` 里自己气=1 的块和对手气=1 的块；气数自己再数一遍；
2. 不要填自己的真眼；不要在没价值时自紧气；
3. `koPoint` 非空时不得立即回提；
4. 没有有价值的落子时再 `pass`；连续两次 pass 进入 scoring，不要为了不终局而乱下；
5. scoring 阶段用 `mark_dead` 标死子、`confirm_score` 确认；不同意就 `resume_play`；
6. `captures` 不是分数；面积分看 `scorePreview`，且预览不是终局。

工具描述要与 instructions 同步，不能只改一处。

## 6. MCP 工具（M2）

工具集合并共存，共 10 个：

| 工具 | 参数 | 说明 |
|---|---|---|
| `new_game` | `roomId, game?, boardSize?, komi?, koRule?, agentColor?` | `game` 默认 `gomoku`；go 默认 9 / 7.5 / simple / white |
| `get_state` | `roomId` | 全量视图；按 `game` 返回不同字段 |
| `wait_for_turn` | `roomId, timeoutMs` | 增加 `reason='scoring'` |
| `place_stone` | `roomId, row, col` | 按当前游戏校验；go 错误 `KO/SUICIDE/CELL_OCCUPIED` |
| `pass` | `roomId` | 仅 go；gomoku → `WRONG_GAME` |
| `mark_dead` | `roomId, row, col` | 仅 go + scoring；toggle 整块 |
| `confirm_score` | `roomId` | 仅 go + scoring；双方确认 |
| `resume_play` | `roomId` | 仅 go + scoring |
| `resign` | `roomId` | 两游戏通用；scoring 中也允许 |
| `say` | `roomId, text` | 通用 |

错误码新增：`SUICIDE`、`KO`、`WRONG_GAME`、`NOT_SCORING`、`INVALID_DEAD_STONE`、
`UNSUPPORTED_RULE`。错误响应仍带 `{state, history}`。
传输接口 `ArenaApi` 建议改名 `GameApi`（保留 `ArenaApi` 类型别名以免一次性改太多），
并新增 `pass / markDead / confirmScore / resumePlay`；`InProcessApi` 与 `HttpApi` 同步。

`new_game` 的兼容性：不传 `game` 时等同于现在的五子棋行为；旧客户端不需要改。
但 `new_game` 的 tool description 不能再写死“15×15 五子棋”，要按 `game` 分支描述。

## 7. 服务端、REST 与 Web

### 7.1 Room / REST

`GameRoom` 继续独占权威状态，但公共方法要分派：

- `newGame({game, agentColor, boardSize, komi, koRule})`；
- `moveBy` / `passBy` / `resignBy` / `markDeadBy` / `confirmScoreBy` / `resumePlayBy`；
- `history: AnyMove[]`；`StateChangeCause` 增加 `pass | mark_dead | confirm_score | resume`；
- `getSummary` 增加 `game`。

REST 新增：

```text
POST /api/rooms/:id/games          { game?, agentColor?, boardSize?, komi?, koRule? }
POST /api/rooms/:id/moves          { row, col, actor? }
POST /api/rooms/:id/pass           { actor? }
POST /api/rooms/:id/dead-stones    { row, col, actor? }
POST /api/rooms/:id/score/confirm  { actor? }
POST /api/rooms/:id/score/resume   { actor? }
POST /api/rooms/:id/resign         { actor? }
GET  /api/rooms/:id/wait-for-turn  ?actor=&timeoutMs=
```

所有 mutation 继续返回 `{ state, history }`；错误也带 `state/history`。

### 7.2 Web（M4）

- 开局区先选“五子棋 / 围棋”，再选执黑/执白；`new_game` 带上 `game`。
- 五子棋继续用现有 `Board`；Go 用独立 `GoBoard`（9 路、星位 (2,2)(2,6)(4,4)(6,2)(6,6)），
  不要硬改 15 路组件的星位逻辑。
- Go 控件：`pass`、`resign`；scoring 阶段点击棋子 toggle 死子、`confirm_score`、
  `resume_play`、显示 `scorePreview` 与双方确认状态。
- `StatusBar`/`ResultOverlay` 要处理 `status='scoring'` 与 `endReason='scored'`；
  当前 `endReason` 分支会把 scored 误显示成“五连”。ResultOverlay 还要显示 `score` 的
  黑白总分、komi 与 margin，而不是只显示“你赢了/五连”。
- M2 必须先把 web 的类型收窄到能编译（旧五子棋 UI 可暂不显示围棋入口）；
  M4 再补完整入口和棋盘，不要把 web 构建留到最后才修类型。

## 8. 里程碑（修订）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | 类型契约：`game` 判别、`AnyGameState`、`GoState`、`AnyMove`、`WaitReason`、错误码；五子棋 fixture 更新 | `pnpm typecheck` 通过；106 五子棋行为测试绿 |
| M1 | `go.ts` 规则引擎 + 纯函数测试 | G1–G5, G9–G13 全绿 |
| M2 | room/REST/MCP 分派 + `GoAgentStateView` + instructions 分段 + web 类型收窄 | G7/G8/G17；MCP 两 transport 冒烟；五子棋回归绿 |
| M3 | scoring 全流程（mark/confirm/resume/scorePreview/wait） | G6, G14–G16 + 一盘完整 scoring 脚本 |
| M4 | Web：开局选择 + GoBoard + pass/scoring 交互 | 完整人机对局一盘（含 pass、标死子、数子） |
| M5 | 可选：5/7/13 路、superko、字母坐标显示 | 不影响 v1 契约 |

总验收：用户与 GLM 通过 web + MCP 完整下一盘 9 路，终局以面积法出分；
五子棋现有行为不回归；Go 视图热路径 ≤4000 字符。

## 9. 待定夺（评审结论）

1. **koRule**：v1 只实现 `simple`；`superko` 在 `new_game` 直接返回 `UNSUPPORTED_RULE`，
   M5 再做。不要接受一个没实现的配置。
2. **komi**：默认 **7.5**（白方加），按国际比赛公平补偿白方后手；7.5 对白有利是设计目的，
   不是“黑方吃亏”的 bug。若显式降低 komi，那是 handicap，不属于公平规则；v1 不做让子，
   UI 必须注明“贴目给白方”。
3. **mark_dead 协议**：toggle 整块 + 双方 confirm + `resume_play` 兜底可行；
   但必须补 `deadStones` / `scoreConfirmed` 字段、确认重置、scoring wait 语义。
4. **boardText 坐标**：用数值 0–8，与工具参数一致；字母坐标（跳过 I）只在 UI 显示，
   不进 MCP 数据，避免 agent 转换。
5. **合并形态**：`new_game` 加 `game` + 房间当前局绑定 game 可行；但用
   `GameState`（五子棋）+ `GoState` + `AnyGameState` 的低风险 union，不要把现有
   `GameState` 直接改成“所有游戏”的 union 再全仓库修。
6. **Web 排期**：M4 完整做可以；M2 必须先做类型收窄，否则 `pnpm build` 过不了。

## 10. 分工

- **GLM 实现**：M0–M4；先做 M0 类型契约，再写 M1 引擎；每个里程碑单独 commit。
- **DeepSeek 评审**：M0 类型设计、M1 提子/劫/数子、M3 scoring wait、G6/G11 测试；
  评审意见直接改本文件或提交 PR 评论。
- 本文档通过后，把 §3–§7 的契约增补进 `overview.md` 作为围棋规范章节；
  不要把本文件直接当实现文档，规则细节以增补后的 `overview.md` 为准。
