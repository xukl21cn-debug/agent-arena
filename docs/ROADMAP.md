# 路线图：参与者模型 → 双 AI → 围棋 → 聊天室

> 状态：草案 v0.1（2026-10-24）
> 回答一个问题：**双 AI、围棋、聊天室三件事，按什么顺序做，才不会互相重复、互相踩？**

---

## 0. 一句话顺序

```text
P0 文档与决策
 → P1 参与者地基（身份 / 在线 / 准备 / 按人等待）
 → P2 双 AI 对局（五子棋先验证）
 → P3 围棋（引擎现在就能并行开工，集成等 P1）
 → P4 聊天室（只依赖 P1，可与 P3 并行）
 → P5 大厅 / 房间列表（三类房间统一入口）
```

核心判断：**先做「参与者」这一层，双 AI、在线准备、聊天室都变成它的消费者。**

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
| P1a | presence + `RoomView.participants` + WS 事件（**不改座位**） | 网页能看到「等待中 / 思考中 / 未连接」 | ✅ **已完成**（已合入 main） |
| P1b | Participant 替换 PlayerSpec；按 id 落子/等待；兼容层 | 旧客户端不返工 + 双 AI 可跑 | 🔄 **进行中，约 70%** |
| P1c | lobby/ready/phase + 前端准备态 | 双方 ready 才开局；60s 未齐给提示 | ⬜ 未开始 |

P1a 已合入 main（commit `ad9b870`），139 个测试全绿。

**P1b 进度详情见 [`HANDOFF-P1B.md`](HANDOFF-P1B.md)**，那里有剩余任务（presence 按参与者、Web 观战布局）和硬性约束。

P1b 已完成的部分：

- `ParticipantRoster` 名册（同名重连、占座驱逐）
- `PlayerSpec.id`（可选，兼容旧快照）
- `room.resolve/moveAs/resignAs` 按身份路由
- `join_game` / `leave_room` 工具 + 会话绑定身份
- REST `/participants` 端点
- 双 AI 端到端集成测试

剩余：presence 暴露 participantId、Web 双 AI 观战布局。

### P2 双 AI 五子棋（0.5–1 天）

- 两个 agent 各自 `join_game` + `wait_for_turn`，交替落子；
- 人类进入观战模式（不占座位）；
- 验收：两个 MCP client 自动下满 10 手，presence 全程正确，网页能看到双方状态。

> 协议层已由 `dual-agent.test.ts` 验证通过（两个真实 MCP 会话打完一盘）。P2 剩下的是**真实模型行为**验证：模型会不会自觉 wait、会不会替对手落子。

### P3 围棋（引擎 2–3 天并行，集成 1 天）

- **P3a**：`go.ts` 规则引擎 + G1–G6/G10/G11 测试（独立分支，随时开工）。
- **P3b**：接入 `game` 变体、`AgentStateView(go)`、MCP 工具、scoring（等 P2）。
- 对现有 GO 提案的修改见第 5 节。

> ⚠️ **围棋必须等 P2 完成后再开始**：围棋要改 `new_game` 加 `game` 参数，而 P1c 也要改 `new_game` 加准备阶段，同时做必冲突。

### P4 聊天室（2–3 天，可与 P3 并行）

- C1 模型/REST → C2 `/chat/mcp` + 长轮询 → C3 runner → C4 Web。
- 只依赖 P1a/P1b，不依赖围棋。

### P5 大厅 / 房间列表（1 天）

- 首页按 kind 列出三类房间：五子棋 / 围棋 / 聊天；显示 phase、成员 presence、最后活动。
- 和围棋 M4 的「开局选择」入口合并做，省一次改版。
- 这一步之后，"三选一"的观感才真正消失。

---

## 4. 并行、分支与合并

| 分支 | worktree | 内容 | 状态 |
|---|---|---|---|
| `feat/participants` | `E:\code\fun\gomoku-mcp-participants` | P1a | ✅ 已合入 main |
| `feat/participants-model` | `E:\code\fun\gomoku-mcp-p1b` | P1b + P1c | 🔄 **当前工作分支** |
| `feat/agent-chat` | `E:\code\fun\gomoku-mcp-chat` | P4 聊天室 | ⬜ 只有文档 |
| `feat/go-mode`（待建） | — | P3 围棋 | ⬜ 等 P2 完成 |

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
