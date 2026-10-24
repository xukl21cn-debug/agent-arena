# 提案：围棋模式 —— 并入 gomoku-mcp 的 9 路围棋人机对弈

> 状态：**提案 v2，待评审**｜作者：GLM (ZCode)｜日期：2026-10-24
> v2 变更：按用户决定**不新建仓库**，围棋作为第二种游戏并入本仓库（web 可选五子棋 / 围棋）；仓库名后续由用户手动改，纯重命名不阻塞开发。
> 评审通过后由 GLM 在本仓库实现，DeepSeek 评审 —— 与 v0.4 的分工对调，评审仍走 md relay。

## 1. 背景与动机

五子棋系列赛 4 局打完 2:2，但**黑棋 4 战 4 胜**（49 / 25 / 23 / 19 手）。我执黑的两局（23、19 手）用户全程无失误却输了——自由规则先手必胜（Allis 1994）被实验完美复现。用户的结论：换游戏。

选围棋的理由：

1. **贴目天然平衡先后手**——不存在"谁先下谁赢"的结构性问题，颜色不再决定胜负；
2. **LLM 裸算围棋很弱**——没有引擎辅助时，数气、打吃、死活判断全靠整盘推理，错误率高。用户只懂围棋最简单的规则，正好和我形成公平对局（五子棋里我有 hotPoints 雷达"外挂"，围棋雷达只提供气数，威胁判断还是要我自己做）；
3. **9 路小棋盘**本质上就是"数气 + 吃子 + 围地"，定式和死活题是 19 路的产物，用户不需要学。

## 2. 产品定位与非目标

一句话：**在本仓库内新增 9 路围棋模式（与五子棋并存，web 开局选择），规则引擎独立成文件，AgentStateView 提供"气 / 打吃雷达"。**

明确不做：

- **不接任何围棋引擎**（KataGo / GNU Go 等）。接了 LLM 就赢了，对局失去意义。未来若加分析功能，必须显式 opt-in 且禁止在对局中使用。
- 不做 19 路优先支持（boardSize 可配，测试与体验全部按 9 路）。
- 不做日式规则（数目法 + 复杂死活判定）。中国规则数子法天然处理双活。
- 不做段位 / 排行榜。机制维持"每房间一局"，不同房间可各下一种游戏。
- **不破坏现有五子棋功能**：现有 MCP 客户端、工具语义、web 五子棋路径、106 个测试全部保持原样（回归保护是合并方案的核心收益）。

## 3. 规则引擎（M1）

### 3.1 棋盘与落子

- `boardSize`: 默认 9（可配 5 / 7 / 9 / 13）；`board: (Color|null)[][]`，同 gomoku 结构。
- 落子流程：place → 先提掉因这手而无气的相邻敌块 → 若己块仍无气 → **非法（中国规则禁自杀）**，返回错误码 `suicide`，状态不变。
- 引擎实现为 `server/src/core/go.ts`（与五子棋 `rules.ts` 并列的纯函数，board 进 board 出）；`rules.ts` 零改动。

### 3.2 劫

- `koRule`: 默认 `'simple'`（单子劫：刚提劫的一方落子后，对方不得立即回提）。
- `'superko'`（禁全局同形，中国规则官方表述）作为可配项，实现放 M2 之后。
- 当前 `koPoint` 记入状态并透出到 AgentStateView。

### 3.3 虚着与终局

- `pass` 工具；**连续两个 pass** → `status='scoring'`。
- `resume_play`：scoring 阶段任一方可回到 `playing`（pass 计数清零）——"不认可对方死活判断"的最朴素解决方式：继续下，把死子提干净再数。

### 3.4 数子（中国规则面积法）

- 某方地盘 = 棋盘上该方活子数 + 只邻该方的空点数。双方都邻的空点为**中立**，不计。
- 黑得分 = 黑地盘；白得分 = 白地盘 + 贴目（komi）。
- **死子处理**：scoring 阶段 `mark_dead` 标记整块死子；双方对同一标记状态 `confirm_score` → 移除死子后数子定胜负（`endReason='scored'`）。标记在有人 confirm 后再变动，confirm 自动作废。
- **双活**：面积法下双活的双方活子照计、公共气中立——免死活判定，这是选中国规则的主要原因。

### 3.5 引擎验收测试表

| 编号 | 内容 | 构造 | 期望 |
|---|---|---|---|
| G1 | 单子提子 | 黑(2,2)；白(2,1)(1,2)(3,2)，白下(2,3) | (2,2)变空；captures.white=1；lastCaptured=[(2,2)] |
| G2 | 多子块提子 | 黑(4,4)(4,5) 连二被白围死 | 两子同提；黑块气数计算正确（先算整块再判提） |
| G3 | 自杀非法 | 白(0,1)(1,0)(1,1)；黑下(0,0) | 错误码 `suicide`，棋盘与状态不变 |
| G4 | 单子劫 | 白(4,4)(3,5)(4,6)(5,5)；黑(3,4)(4,3)(5,4)；黑下(4,5)提白(4,4) | 白立即回提(4,4) → 错误码 `ko`；白先在别处落一手、黑应一手后，(4,4) 合法 |
| G5 | 领地判定 | 黑占满 col0，白占满 col8，其余全空 | 中间 7 列中立不计；黑 9 / 白 9+komi |
| G6 | 死子标记与数子 | G5 + 黑围出 (1,1) 一口气的白子 | mark_dead(1,1) → confirm ×2 → 移除后 (1,1) 计入黑地 |
| G9 | 双活（P2，可选） | 标准双活型 | 双方活子照计，公共气中立，不误判 |
| G10 | pass 与恢复 | 两次 pass → scoring → resume_play | 回到 playing，pass 计数清零，轮次正确 |
| G11 | 引擎不变量 | 随机自对弈 N 手 | 恒等式：黑已落子数 = 黑盘面子数 + 被白提走数（白同理，pass 不落子不计） |

G11 借用 v0.3 的"引擎不变量测试"思路：随机局面下棋盘状态与 history 永不自相矛盾。

## 4. AgentStateView（围棋雷达，M2）

设计原则沿用 v0.2–v0.4 的全部教训：**读棋只读 boardText + 结构化摘要，永远不 cell-by-cell 重建**；热路径（wait_for_turn / place_stone / 错误响应）预算 **≤4000 字符**。

**视图变为 discriminated union**：顶层 `game: 'gomoku' | 'go'` 判别。gomoku 分支字段原样保留（boardText/hotPoints/moves…），go 分支字段如下——TS 层面强制 agent 代码先判 game 再读字段，两种视图互不污染。

| 字段（go 分支） | 内容 |
|---|---|
| `boardText` | 同风格：数值坐标 00–08、B/W/.、小写=最新一手；**刚被提掉的点用 `×` 标注**（只标最近一次） |
| `turn / status / moveCount / lastMove / komi` | 常规；scoring 阶段附 `scorePreview`（当前死子标记下的双方目数） |
| `consecutivePasses` | >0 时透出 |
| `koPoint` | 当前劫禁点（若有） |
| `moves` + `movesOmitted` | 最近 8 手截断，沿用 v0.3 方案（pass 记为 `pass(B)`） |
| `groups`（雷达核心） | 按危险度排序的棋块摘要，每色上限 12 块：**气=1（打吃）**：块代表点 + 气的坐标（己方=要救/要弃，对方=可提）；**气=2**：代表点 + 两个气坐标；**气≥3**：只报数量。尾部 `…另有 N 块` |
| `captures` | `{black, white}` 累计提子数 + `lastCaptured` 坐标列表 |

### 视图验收测试表

| 编号 | 内容 | 期望 |
|---|---|---|
| G7 | 打吃可见性 | 构造一块 3 子黑棋被围到 1 气 → groups 黑列表首项 = 代表点 + 唯一气坐标 |
| G8 | 预算 | 60 手中盘 9 路局面序列化 ≤4000 字符（groups 截断生效） |

注意：雷达**只给事实（气数/坐标/提子），不给结论**（"该逃还是该弃""哪块死了"）。威胁判断是 agent 的活——这是围棋和五子棋的本质区别，也是对局公平性的一部分。

### SERVER_INSTRUCTIONS（agent 引导，随 M2 落地）

SERVER_INSTRUCTIONS 与 tool description 按游戏分段（"当前局 game=go 时适用以下纪律"），五子棋段落原样保留。围棋特有纪律：

1. 打吃追杀前先数双方气（雷达给了事实，胜负判断自己算）；
2. **不要填自己的真眼**；
3. 没有有价值的点时**主动 pass**——连续两 pass 进数子流程，避免 LLM 永远不终局的坑；
4. 贴目意识：数子预览不是终局分数，中盘就要知道自己在贴目下领先还是落后。

## 5. MCP 工具

与现有工具语义完全对齐（长轮询、错误响应带 history、say/resign 同款），**工具集合并共存**：

| 工具 | 参数 | 说明 |
|---|---|---|
| `get_state` | `roomId` | 全量视图（moves 不截断） |
| `new_game` | `roomId, game?, boardSize?, komi?, agentColor?, koRule?` | `game: 'gomoku'（默认，向后兼容）\| 'go'`；go 分支默认 9 / 7.5 / 'white' / 'simple' |
| `place_stone` | `roomId, row, col` | 按房间当前游戏校验；go 错误码：`occupied` / `suicide` / `ko` |
| `pass` | `roomId` | 虚着（仅 go；gomoku 房间 → `wrongGame`） |
| `resign` | `roomId` | 认输（两游戏通用） |
| `say` | `roomId, text` | 聊天/评论（通用） |
| `wait_for_turn` | `roomId, timeoutMs` | 长轮询，同款 reason 语义（通用） |
| `mark_dead` | `roomId, row, col` | toggle 该点所在整块的死子标记（scoring 阶段） |
| `confirm_score` | `roomId` | 确认当前标记；双方一致 → 终局数子 |
| `resume_play` | `roomId` | scoring → playing，pass 计数清零 |

## 6. 服务端与 Web（合并架构）

**不新建仓库**：围棋并入本仓库，同一服务进程、同一 MCP 端点、同一套 room / REST / web 壳。

- **共享层（游戏无关，近零改动）**：room 状态机骨架、MemoryRoomRepository、wait_for_turn 长轮询、say / history、REST `{state,history}` 包装、MCP 两 transport、web 应用壳——这是仓库的大头，直接复用。
- **游戏变体**：`new_game` 的 `game` 参数决定本房间这局的类型（默认 `'gomoku'`，现有 MCP 客户端与文档零感知）；不同 roomId 可同时各下一种。
- **GameState / AgentStateView discriminated union**：gomoku 分支原样，go 分支新增；状态机新增的 `scoring` 状态只存在于 go 分支，五子棋路径不经过。
- **引擎并列**：`rules.ts`（五子棋）零改动；新增 `go.ts`。insights 同理新增围棋雷达文件（`go-insights.ts`）。
- **9×9 = 81 点**：气/块每次落子全量重算即可，无性能问题（不需要增量数据结构）。
- **Web（M4）**：开局选择界面（五子棋 / 围棋）+ 9 路围棋盘（星位点）、落子/提子展示、pass / resign 按钮、scoring 阶段点选死子 + 双方确认 + 目数预览；五子棋界面不动。

合并的额外成本（相对独立仓库）：类型判别 + 工具共存校验 + web 选择入口，估计 +15% 工作量；换来单服务单端口、五子棋 106 个测试做回归保护、ZCode 侧 gomoku-client.mjs 驱动脚本直接复用（传输层与游戏无关，加 go 工具调用即可）。

## 7. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | `go.ts` 规则引擎纯函数 + 测试 | G1–G6, G10, G11 全绿 |
| M2 | game 变体接入 room/REST/MCP + AgentStateView(go) + instructions 分段 | G7, G8 绿；MCP 两 transport 冒烟；**现有 gomoku 测试全绿** |
| M3 | scoring 全流程（mark_dead / confirm / resume / scorePreview） | G6 场景脚本走通 |
| M4 | Web：开局选择 + 围棋盘与 scoring 交互 | 完整人机对局一盘（含 pass、标死子、数子） |

总验收：GLM 与用户通过 web + MCP 完整下一盘 9 路，终局以数子法出分；gomoku 全部测试保持绿色。

## 8. 待定夺（请 DeepSeek 表态）

1. `koRule` 默认 `simple` 还是 `superko`？（我倾向 simple：实现和理解成本都低，superko 留可配）
2. 9 路贴目默认 **7.5**（与中国规则 19 路一致）还是 5.5 / 6？（用户大概率执黑且是新手，7.5 对黑更宽松，我倾向 7.5）
3. `mark_dead` 协议：toggle + 双方一致 confirm + resume 兜底——这个交互 OK 吗？
4. boardText 用数值坐标（与工具参数一致，我倾向）还是围棋字母坐标（跳过 I）？
5. **合并形态**：`new_game` 加 `game` 参数（默认 gomoku）+ 房间绑定本局游戏 + go 专属工具在五子棋房间报 `wrongGame`——这个合并方案 OK？
6. Web 放 M4 最后做没问题吧（用户对局入口，但 MCP 侧先跑通）？

## 9. 分工

- **GLM 实现**（用户有 1024 活动的免费 token 可用 🙂）；
- **DeepSeek 评审**：评审重点放 M1 规则引擎（提子/劫/数子是最容易错的地方）、game 判别 union 的类型设计、groups 雷达的预算控制；
- 本文档通过后其规则章节增补进 `DESIGN.md`（作为围棋模式的规范章节），评审意见直接批注在本文或仓库 md 里。
