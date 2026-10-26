# 路线图：参与者模型 → 双 AI → 围棋 → 聊天室

> 状态：草案 v0.1（2026-10-24），**P3 及以前已完成**（2026-10-26 更新）
> 回答一个问题：**双 AI、围棋、聊天室三件事，按什么顺序做，才不会互相重复、互相踩？**
>
> 📖 **先读 [`AGENTS.md`](../AGENTS.md)**（通用约定）和 [`SESSION-HANDOFF.md`](SESSION-HANDOFF.md)（从哪继续）。
> 本文只讲**顺序和依赖**，不讲怎么干活。

---

## 0.0 编号对照（P / M / G 三套，互不相关）

项目里有三套编号，来自三份不同文档，**数字相同不代表有关系**：

| 前缀 | 出处 | 含义 | 例子 |
|---|---|---|---|
| **P** | 本文件 | **项目阶段**，跨功能 | `P2` 双 AI 对弈 |
| **M** | `PROPOSAL-GO-MCP.md` | **围棋内部里程碑** | `M1` 围棋规则引擎 |
| **G** | `PROPOSAL-GO-MCP.md` §3.7 | **围棋引擎测试用例** | `G3` 自杀非法 |

层次关系：

```text
P（项目阶段）  ⊃  M（围棋里程碑）  ⊃  G（测试用例）

P3a  =  M1  ，由 G1–G5 / G9 / G11–G13 验收
P3b  =  M0 + M2 + M3（+ M4 的 web 部分）
```

所以 `P2`、`M2`、`G2` 三个「2」**毫无关系**。引用时请带前缀，别只说「第 2 阶段」。

---

## 0. 一句话顺序

```text
P0 文档与决策
 → P1 参与者地基（身份 / 在线 / 准备 / 按人等待）
 → P2 双 AI 对局（五子棋先验证）
 → P3 围棋（引擎现在就能并行开工，集成等 P1）
 → P3.5 持久化（棋谱落盘，P4 的地基）
 → P4 聊天室（只依赖 P1，可与 P3 并行）
 → P5 大厅 / 房间列表（三类房间统一入口）
```

核心判断：**先做「参与者」这一层，双 AI、在线准备、聊天室都变成它的消费者。**

> **P3.5 为什么插进来**：P3 实战验收时，用户与 AI 下完一盘棋，服务一停棋谱就没了。
> `MemoryRoomRepository` 是纯内存的，重启即失忆。这不是「不方便」，而是
> 基础设施缺口——P4 的对话记录会同样丢失。详见 [`HANDOFF-PERSIST.md`](HANDOFF-PERSIST.md)。

---

## 1. 为什么是这个顺序

三件事看起来分散，缺的是同一个东西：

| 需求 | 现在缺什么 |
|---|---|
| 双 AI 对局 | 座位只有 `kind: 'human' \| 'agent'`，两个 agent 无法区分，`moveBy('agent')` 有歧义 |
| 在线 / 准备 | 没有 presence，没有 ready，点完「准备」只能干等 |
| 聊天室 | 需要成员、在线、轮流发言——和上面是同一套 |

如果先做双 AI，会临时造一套「agent 身份」；先做聊天，会再造一套「member/presence」；围棋再抄一遍。**三次重复之后合并，比一开始抽一层贵得多。**

所以 P1 一次做完，后面三个功能各写各的领域逻辑（棋局 / 消息），共享身份与等待。

---

## 2. 依赖图

```text
                    P0 三份文档 + 决策
                            │
                            ▼
                 ┌── P1 参与者地基 ──┐
                 │  P1a presence     │
                 │  P1b participants │
                 │  P1c lobby/ready  │
                 └───────┬───────────┘
                         │
        ┌────────────────┼─────────────────┐
        ▼                ▼                 ▼
  P2 双 AI 五子棋   P3 围棋集成        P4 聊天室
        │                ▲                 │
        │                │                 │
        │        P3a 围棋引擎（纯函数，可立即并行）
        └────────────────┼─────────────────┘
                         ▼
                  P5 大厅 / 房间列表
```

`P3a`（`go.ts` + 规则测试）不依赖 P1，GLM 现在就能开工；`P3`（接进房间/REST/MCP）必须等 P1，否则又会造一套座位模型。

---

## 3. 各阶段

### P0 文档与决策（本周）

- 三份文档：本文件、[PARTICIPANTS](proposals/PROPOSAL-PARTICIPANTS.md)、[AGENT-CHAT](proposals/PROPOSAL-AGENT-CHAT.md)。
- 拍板第 8 节的 5 个决策。
- 约定：P1 合入前，`shared` 的 Participant/GameState 相关类型冻结，别人只加不改。

### P1 参与者地基（1.5–2 天）

| 子阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| P1a | presence + `RoomView.participants` + WS 事件（**不改座位**） | 网页能看到「等待中 / 思考中 / 未连接」 | ✅ **已完成** |
| P1b | Participant 替换 PlayerSpec；按 id 落子/等待；兼容层 | 旧客户端不返工 + 双 AI 可跑 | ✅ **已完成** |
| P1c | lobby/ready/phase + 前端准备态 | 双方 ready 才开局；60s 未齐给提示 | ⬅ **下一步**，工作单 [`HANDOFF-P1C.md`](HANDOFF-P1C.md) |

P1a + P1b 已合入 main，**193 个测试全绿**（P2 修 bug +1，P3a 引擎 +26）。

P1b 交付的能力：

- `ParticipantRoster` 名册（同名重连、占座驱逐）
- `PlayerSpec.id`（可选，兼容旧快照）
- `room.resolve/moveAs/resignAs` 按身份路由
- `join_game` / `leave_room` 工具 + **会话绑定身份**（模型不需要传 id）
- REST `/participants` 端点
- presence 暴露 `participantId`；双 AI 观战页（只读棋盘、无开局按钮）
- 掉线推送修复（开着的标签页能收到「已断开」）
- 双 AI 端到端集成测试（两个真实 MCP 会话打完一盘）

**P1c 可以延后**：它改的是开局流程，和 P2 的真实模型验证不冲突，可以等 P2 结论出来再决定怎么做。

### P2 双真实模型对弈（0.5–1 天）← **已完成**

- **目标**：验证真实大模型接入后的行为，不是协议
- 两个客户端：**DSH（deepseek）+ Claude Code**
- 验证 6 个问题：会不会 join、会不会 wait、会不会替对手下、能否理解 yourColor、重连能否拿回座位、报错能否自我修正

**结果见 [`P2-RESULT.md`](P2-RESULT.md)**。一盘完整对局：claude（白）64 手五连获胜，用时 1 小时 41 分。

**关键发现**：双 AI 时 `get_state` / `say` / `new_game` 的 `yourColor` 返回**第一个**
agent 座位，白方 agent 被告知自己执黑，而且它的 MCP 会话被挂到黑方座位上，
导致 presence 串座（黑方标签显示白方的客户端名、白方安静时黑方闪 `disconnected`）。
已修（`0c8a297`），167 测试全绿。

> 协议层已由 `dual-agent.test.ts` 验证通过。P2 只验证模型行为。

### P3 围棋（引擎 2–3 天并行，集成 2–3 天）—— ✅ **已完成**

- **P3a**（= M1）：`go.ts` 纯函数规则引擎 + 测试。✅ **已完成**，见 [`REVIEW-P3A.md`](REVIEW-P3A.md)
- **P3b**（= M0 + M2 + M3 + M4）：类型契约 → 接入 → scoring → 网页棋盘。✅ **已完成**

**实战验收通过**（2026-10-26）：用户与 AI 在网页下完一整盘 9 路，
体验「很不错」。围棋功能链路完整：开局 → 落子 → 提子 → pass → 数子 → 出分。
- 对现有 GO 提案的修改见第 5 节。

P3b 拆成四份工作单，**必须按顺序做**（后一份依赖前一份的类型/接口稳定）：

| 顺序 | 工作单 | 内容 | 状态 |
|---|---|---|---|
| 1 | [`HANDOFF-P3B-1.md`](HANDOFF-P3B-1.md) | 类型契约（M0） | ✅ **已完成**，[评审](REVIEW-P3B-1.md) |
| 2 | [`HANDOFF-P3B-2.md`](HANDOFF-P3B-2.md) | 接入 room/REST/MCP（M2） | ✅ **已完成**，[评审](REVIEW-P3B-2.md) |
| 3 | [`HANDOFF-P3B-3.md`](HANDOFF-P3B-3.md) | scoring 全流程（M3） | ✅ **已完成**，[评审](REVIEW-P3B-3.md) |
| 4 | [`HANDOFF-P3B-4.md`](HANDOFF-P3B-4.md) | 网页围棋盘 + 端到端（M4） | ⬅ **下一步** |

> **围棋服务端已完整**（P3b-1/2/3 全部合入，249 测试全绿）。
> P3b-4 是纯前端 + 端到端验收，**服务端不该再改**。
>
> ⚠️ **为什么要拆**：类型是地基。第 2 份要给 `new_game` 加 `game` 参数、
> 第 3 份要给 `wait_for_turn` 加 `scoring` 原因，两者都要动类型。
> 一次改完类型，后面几份只写逻辑，冲突面最小。
>
> P1c 已合入，`new_game` 的改动窗口已经空出来，P3b 可以开始了。
>
> **P3a 不受这个约束**：它只写 `go.ts` + 测试，不碰 `new_game`、不碰座位、
> 不碰 `shared` 类型，所以 P2 一完成就能开工。P3a 期间 `git diff --stat`
> 应该只出现两个新文件。

### P3.5 持久化（0.5–1 天）← **当前阶段**

- **问题**：`MemoryRoomRepository` 纯内存，服务重启棋谱全丢。
  P3 实战验收时用户刚下完的一盘棋就是这样没的。
- **做法**：`FileRoomRepository`（一房间一 JSON + 原子写）+ 启动时 `restoreAll()`。
- **接口已就绪**：`repository.ts` 的注释本来就写了「换实现只动这个文件」。
- **不做**：SQLite、棋谱回放 UI。
- **详见 [`HANDOFF-PERSIST.md`](HANDOFF-PERSIST.md)**。

> ⚠️ **roster 不持久化**：重启后连接已不存在，恢复「在线」是撒谎。
> agent 重连时用同名 `join_game` 拿回座位（P1b 已实现）。

### P4 聊天室（2–3 天）← **当前阶段**

- C1 模型/REST → C2 `/chat/mcp` + 长轮询 → C3 runner → C4 Web。
- 只依赖 P1a/P1b，不依赖围棋。
- **依赖 P3.5**：对话记录要能落盘，否则重启即失忆。

**已拍板的决策**（见 [`HANDOFF-P4-C1.md`](HANDOFF-P4-C1.md)）：

| 问题 | 决定 |
|---|---|
| MCP 端点 | **独立 `/chat/mcp`**，与棋类 `/mcp` 分离 |
| 默认策略 | **`relay` 接力** |
| presence | **不复用** `PresenceRegistry`（它按 seat 索引，聊天成员无座位） |
| WS | C1/C2 **不做**，用长轮询；统一留给 P5 |

**里程碑**：

| 阶段 | 内容 | 状态 |
|---|---|---|
| C1+C2 | 模型 + REST + `/chat/mcp` + 长轮询 | ✅ **已完成**，[评审](REVIEW-P4-C1.md) |
| C3 | runner（CLI 包成常驻成员） | ⬜ 可选（交互式客户端已能用） |
| **C2.5** | **修两个服务端缺陷** | ⬅ **下一步**，工作单 [`HANDOFF-P4-CHAT-FIX.md`](HANDOFF-P4-CHAT-FIX.md) |
| C4 | 网页聊天页 | ⬜ 等 C2.5 修完 |

> **C2.5 为什么插进来**：真实模型聊了一轮（[观察报告](OBSERVE-CHAT-REAL-MODELS.md)），
> 模型行为没问题，但挖出两个服务端缺陷——
> `maxMessagesPerMember` 完全失效（`snapshot()` 深拷贝导致计数器加在副本上）、
> `wait_for_messages` 静默丢消息（只返回最近 12 条，不给 `omitted`/`hasMore`）。
> **C4 依赖这两个修复**：成员栏要显示发言数，网页长轮询会踩同一个坑。

> **真实模型聊出来的设计输入**：MCP 链路维持长轮询，先修游标；
> WS 只进网页那一层，P5 再统一。网页端 SSE 优先于 WS（单向就够）。

> ⚠️ **聊天室是独立领域对象**，不改 `GameRoom` / `PresenceRegistry` / `mcp/tools.ts`。
> 提案 §3 明确要求「不复用 GameState、GameRoom、棋类规则」。

### P5 大厅 / 房间列表（1 天）

- 首页按 kind 列出三类房间：五子棋 / 围棋 / 聊天；显示 phase、成员 presence、最后活动。
- 和围棋 M4 的「开局选择」入口合并做，省一次改版。
- 这一步之后，"三选一"的观感才真正消失。
- **棋谱回放**（用户要求）：P3.5 已经在对局落盘了，做一个「对局列表 + 回放」
  页面就能看历史棋局。放在 P5 一起做，因为本来就要做房间列表。
- **WS 统一**：把 `RoomManager` 改成能装两类房间，`ws.ts` 按 kind 分发。
  聊天室 C1/C2 刻意没做 WS，这里补上。

---

## 4. 并行、分支与合并

**当前只有一个目录**：`E:\code\fun\agent-arena`（main 分支）。P1 阶段的 worktree 已全部清理合并。

| 分支 | 内容 | 状态 |
|---|---|---|
| `main` | P1a + P1b + P1c + P2 + P3（含 P3b-1/2/3/4）+ P3.5 + P4-C1/C2 | ✅ **282 测试全绿** |
| `fix/chat-cursor-and-limit`（待建） | P4-C2.5 修两个聊天室缺陷 | ⬅ **下一步** |
| `feat/chat-ui`（待建） | P4-C4 网页聊天页 | ⬜ 等 C2.5 合入 |

**关于 worktree**：P1 时用了多个 worktree 并行开发，现在已不需要——串行开发直接在 main 目录建分支即可：

```powershell
cd E:\code\fun\agent-arena
git checkout -b feat/p2-dual-ai
# ... 工作 ...
git checkout main && git merge --ff-only feat/p2-dual-ai
git branch -d feat/p2-dual-ai
```

worktree 只在**需要同时打开多个分支**时才有价值（比如一边跑 P3 一边修 P1 的 bug）。串行开发用普通分支更简单。

- 冲突热点：`app.ts`（挂载）、`index.ts`（启动）、`web/src/App.tsx`（入口）、`shared/src/game.ts`（类型）。
- 约定：共享类型只增不改；围棋引擎只碰新文件（`go.ts` / `go-insights.ts` / 测试），冲突面接近零。
- 每个分支合并前 rebase 到最新 main，跑全量测试。

---

## 5. 围棋提案（PROPOSAL-GO-MCP）要改的三处

现有提案默认「人类 vs agent」，双 AI 需要：

1. **座位**：`new_game` 的 `agentColor` 扩成 `seats`（`{black, white}` 两方可以是 agent），`agentColor` 保留兼容；同时接受 `game: 'gomoku' | 'go'`。
2. **等待**：`wait_for_turn` 按参与者（participantId）等待，而不是「agent 座位」；双 AI 时两个 agent 各等各的。
   > ✅ **P1b 已完成**：`room.resolve()` + `join_game` 会话绑定已实现，围棋直接复用。
3. **视图**：`AgentStateView` 增加 `you: {participantId, seat, presence}` 和 `participants[]`；`wrongGame` 逻辑保留。

规则引擎、数子、scoring 章节不受影响。建议在 GO 提案里加一行「座位模型以 PARTICIPANTS 提案为准」，避免实现时跑偏。

---

## 6. 共享 vs 独立（防止重复）

| 能力 | 放在 | 谁用 |
|---|---|---|
| Participant / Presence / ready | `shared/src/participant.ts` | 棋类 + 聊天 |
| WaitHub（长轮询中心） | `server/src/core/wait-hub.ts` | `wait_for_turn` + `wait_for_messages` |
| RoomPhase | `shared/src/room.ts` | 三类房间 |
| Seat / 轮次 | 棋类房间 | 棋类（聊天用自己的 turn lease） |
| GameState / 规则 | 棋类专属 | 五子棋、围棋 |
| Message / Transcript | 聊天专属 | 聊天 |

判断标准：**「身份、在线、等待」共享；「棋盘、消息」各自独立。**

---

## 7. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| P1 重构面大 | 共享类型 + 106 测试动荡 | P1a 先合；P1b 加兼容层；旧脚本回归 |
| 双 AI 无限对局 | 烧钱、卡死 | 走子预算 + 每方思考超时 + 暂停 |
| 合并冲突 | 三个分支抢 `app.ts`/`App.tsx` | 先合 P1；挂载点只加行；共享文件冻结 |
| presence 误报 | 把「长考」误判成掉线，或把死连接显示成在线 | 连接级信号 + `thinking` 回合态；沉默不算掉线，TTL 只做兜底 |
| 范围膨胀 | 三件事都做不完 | P5 最后；先用 `?room=` 过渡 |

---

## 8. 本周行动

1. 评审三份文档（本文件 + 两份 proposal）。
2. 拍板下面的决策清单。
3. GLM 开 `feat/go-mode` 做 P3a（`go.ts` + 测试）。
4. 我方开 `feat/participants`，先做 P1a（presence），合入后再做 P1b/P1c。
5. P1 合入后，P2 和 P4 并行；P3b（围棋集成）也等 P1，但引擎 P3a 不受影响。

---

## 9. 决策清单（需要点头）

| # | 问题 | 我的倾向 |
|---|---|---|
| 1 | 双 AI 时人类角色 | 观战 + 裁判（暂停/判负），暂不做接管 |
| 2 | 同座冲突 | 同名重连复用，同座他人拒绝 |
| 3 | presence 判定 | 传输级信号 + 回合态（waiting / thinking / disconnected），TTL 只做 120s 兜底 |
| 4 | 聊天 MCP 端点 | 独立 `/chat/mcp` |
| 5 | 聊天默认策略 | `relay` 接力 |

---

## 10. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-24 | v0.1 | 初稿：依赖顺序、阶段拆分、分支策略、围棋提案三处修改 |
