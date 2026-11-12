# 文档索引

> 项目是什么、怎么干活 → [`../AGENTS.md`](../AGENTS.md)（先读那个）。
> 这份文件只回答一件事：**文档放在哪、现在该读哪份。**

---

## 1. 怎么组织的

文档分五类，**不要混**：

| 位置 | 是什么 | 会变吗 |
|---|---|---|
| 本层（`docs/*.md`） | **现行文档**：路线图、开发流程 | 持续更新 |
| `architecture/` | **系统设计与长期约束**：长什么样、为什么这么定 | 慢。结构变了才改 |
| `proposals/` | **提案**：还没变成代码的想法 | 采纳后沉进 roadmap / architecture |
| `phases/` | **过程档案**：每一轮工作的原始记录 | **只增不改** |
| `archive/` | **作废**但有实验结论的文档 | 冻结 |
| `assets/` | 被现行文档引用的图片 | 按需 |

一条规则贯穿全部：**能改的放上面，不能改的放下面。** `phases/` 和 `archive/` 是证据，不是草稿——发现了错误就在评审里写，别回头改历史。

---

## 2. 我想干什么 → 读哪份

| 我想… | 读 |
|---|---|
| 知道项目是什么、硬约束有哪些、评审怎么做 | [`../AGENTS.md`](../AGENTS.md) |
| 知道现在做到哪、之后能做什么 | [`roadmap.md`](roadmap.md) §11（也可直接看 [`../AGENTS.md`](../AGENTS.md) §9） |
| 知道为什么按这个顺序做、P/M/G 编号怎么对 | [`roadmap.md`](roadmap.md) |
| 看懂系统怎么搭的 | [`architecture/overview.md`](architecture/overview.md) |
| 起服务、双端口调试 | [`dev-workflow.md`](dev-workflow.md) |
| 查某条硬约束的**来龙去脉**（谁在哪一轮踩的） | [`architecture/constraints.md`](architecture/constraints.md) |
| 查某个设计**为什么这么定**、当时放弃了什么 | [`architecture/decisions.md`](architecture/decisions.md) |
| 看某一轮具体做了什么 | [`phases/`](phases/) 下的对应目录 |
| 找围棋规则、数子、ko 的原始提案 | [`proposals/go-mcp.md`](proposals/go-mcp.md) |
| 找聊天室为什么是独立领域对象 | [`proposals/agent-chat.md`](proposals/agent-chat.md) |
| 找参与者 / presence / 准备态的模型 | [`proposals/participants.md`](proposals/participants.md) |

---

## 3. 阶段档案（按顺序）

编号 = 真实工作顺序。**P1c 排在 P3a 前面**是因为它确实先做完，不是笔误——`roadmap.md` 里 P1c 本来是"可以延后"的那一项。

| # | 日期 | 阶段 | 内容 | 产出 |
|---|---|---|---|---|
| 01 | 10-23 | Agent 视图 | 威胁雷达、`boardText`、payload 瘦身（M1–M6） | [评审](phases/01-agent-view/review.md) · [整改回执](phases/01-agent-view/review-result.md) · [实战棋谱](phases/01-agent-view/game-record.md) |
| 02 | 10-25 | **P1b** | 参与者模型：稳定 id、同名重连、会话绑定身份 | [工作单](phases/02-p1b-participants/handoff.md) |
| 03 | 10-25 | **P1c** | 大厅 / 准备 / 房间阶段 | [工作单](phases/03-p1c-lobby/handoff.md) · [评审](phases/03-p1c-lobby/review.md) |
| 04 | 10-25 | **P2** | 双真实模型对弈验证 | [工作单](phases/04-p2-real-models/handoff.md) · [结果](phases/04-p2-real-models/result.md) |
| 05 | 10-25 | **P3a** | 围棋规则引擎（M1） | [工作单](phases/05-p3a-go-rules/handoff.md) · [评审](phases/05-p3a-go-rules/review.md) |
| 06 | 10-25 | **P3b-1** | 围棋类型契约（M0） | [工作单](phases/06-p3b-1-go-types/handoff.md) · [评审](phases/06-p3b-1-go-types/review.md) |
| 07 | 10-25 | **P3b-2** | 接入 room / REST / MCP（M2） | [工作单](phases/07-p3b-2-go-integration/handoff.md) · [评审](phases/07-p3b-2-go-integration/review.md) |
| 08 | 10-25 | **P3b-3** | 数子全流程（M3） | [工作单](phases/08-p3b-3-go-scoring/handoff.md) · [评审](phases/08-p3b-3-go-scoring/review.md) |
| 09 | 10-26 | **P3b-4** | 网页围棋盘 + 人机端到端（M4） | [工作单](phases/09-p3b-4-go-web/handoff.md) · [评审](phases/09-p3b-4-go-web/review.md) |
| 10 | 10-26 | **P3.5** | 棋谱持久化（`FileRoomRepository`） | [工作单](phases/10-p35-persistence/handoff.md) · [评审](phases/10-p35-persistence/review.md) |
| 11 | 10-26 | **P4-C1/C2** | 聊天室服务端 + `/chat/mcp` + 长轮询 | [工作单](phases/11-p4-c1-chat-server/handoff.md) · [评审](phases/11-p4-c1-chat-server/review.md) |
| 12 | 10-26 | 修 policy | `POST /api/chat/rooms` 的 `policy` 参数被静默丢弃 | [工作单](phases/12-chat-policy/handoff.md) · [评审](phases/12-chat-policy/review.md) |
| 13 | 10-26 | **P4-C2.5** | 真实模型聊一轮，挖出两个服务端缺陷并修 | [观察](phases/13-p4-c25-chat-fix/observation.md) · [工作单](phases/13-p4-c25-chat-fix/handoff.md) · [评审](phases/13-p4-c25-chat-fix/review.md) |
| 14 | 10-26 | **P4-C4** | 网页聊天页（复用 `/ws`，不引入 SSE） | [工作单](phases/14-p4-c4-chat-web/handoff.md) · [评审](phases/14-p4-c4-chat-web/review.md) |
| 15 | 10-26 | **P5A** | 棋谱归档 + 回放（可单步前进/后退） | [工作单](phases/15-p5a-replay/handoff.md) · [评审](phases/15-p5a-replay/review.md) |
| 16 | 10-27 | **P5B** | 大厅：三类房间统一入口 | [工作单](phases/16-p5b-lobby/handoff.md) · [评审](phases/16-p5b-lobby/review.md) |
| 17 | 10-27 | `pass_turn` | agent 主动让出轮次 | [观察](phases/17-chat-pass-turn/observation.md) · [工作单](phases/17-chat-pass-turn/handoff.md) · [评审](phases/17-chat-pass-turn/review.md) |
| 18 | 10-27 | 租约结算 | 定时结算死轮次，房间不再卡死 | [工作单](phases/18-chat-lease/handoff.md) · [评审](phases/18-chat-lease/review.md) |

**每轮的文件名是固定的四种**：

| 文件 | 什么时候有 |
|---|---|
| `handoff.md` | 一定有。开工前写，边界写死 |
| `review.md` | 一定有。做完后写，记录独立验证过程 |
| `observation.md` | 有实测才写（真实模型行为、缺陷证据） |
| `result.md` | 有验收结论才写（如 P2 的一盘完整对局） |

---

## 4. 新增一轮工作怎么做

```powershell
mkdir docs/phases/19-<主题>
# 写 docs/phases/19-<主题>/handoff.md      ← 开工前
# 实现完，写 docs/phases/19-<主题>/review.md
# 有实测再补 observation.md / result.md
```

然后：

1. 在 §3 的表格末尾加一行；
2. 到 [`roadmap.md`](roadmap.md) 标记该阶段状态；
3. 如果这轮定下了**新的硬约束**，加进 [`architecture/constraints.md`](architecture/constraints.md)；
4. 如果这轮做了**取舍决策**，加进 [`architecture/decisions.md`](architecture/decisions.md)。

编号只增不减，不要为了"插进去"重排历史。

---

## 5. 维护约定

- **`phases/` 只增不改。** 结论错了就在新一轮的评审里纠正，别回头改旧档案。
- **`handoff.md` 是开工前的合同。** 它写的时候还不知道答案，所以允许和最终实现不一致——`review.md` 里会记差异。
- **作废的工作单进 `archive/`**，顶部加醒目警告，实验结论保留。
- **链接用相对路径**，跨目录引用直接指到文件，不要只写文件名——同名文件太多了（`handoff.md`、`review.md`）。
