# 评审：`pass` / `yield`

> 评审对象：`feat/chat-pass` @ `99aa214`（3 文件，+500）
> 评审依据：[`HANDOFF-CHAT-PASS.md`](HANDOFF-CHAT-PASS.md)
> 评审日期：2026-10-27
> **结论：通过，已合入。**

---

## 一、独立验证怎么做的

| 项 | 值 |
|---|---|
| 服务 | 自己 `pnpm build` 后跑 `node server/dist/index.js`，**3700** |
| 数据 | 隔离目录 `E:\data\tmp\arena-review-pass\data` |
| 客户端 | 手写 MCP 客户端打真实 `/chat/mcp` |
| 脚本 | `review-pass.mjs`（43 条）/ `review-edges.mjs`（15 条） |

### 结果

```text
review-pass.mjs     PASS 43   FAIL 0
review-edges.mjs    PASS 15   FAIL 0
pnpm test           351 全绿（24 文件）
pnpm typecheck      干净
chat-duel.mjs       15/15 全过
```

**58 条检查首跑全绿。**

---

## 二、核心行为

| 检查 | 结果 |
|---|---|
| **P16** `pass_turn` 在 `tools/list` 里 | ✅ |
| **P16** instructions 提到 `pass_turn` | ✅ |
| P16 instructions 说明「不消耗预算」 | ✅ |
| **P1** pass 后轮次交给下一位 | ✅ |
| **P2/P15** hop 不变 | ✅ |
| **P3** 不产生 `chat` 消息 | ✅ |
| **P4** 产生一条 `system` 消息，提到让出轮次 | ✅ |
| pass 不增加成员发言计数 | ✅ |
| **P8** `to` 指定下一位生效，文案写明交给谁 | ✅ |

### 拒绝与残留

**所有拒绝都发生在状态变更之前**，实测确认无残留：

| 检查 | 结果 |
|---|---|
| **P7** 无轮次时 `INVALID_REQUEST` | ✅ |
| **P7b** pause/resume 后轮次被清空，pass 被拒 | ✅ |
| **P6** 不是自己轮次 `NOT_YOUR_TURN` | ✅ |
| **P9** `to` 指向 human 被拒 | ✅ |
| **P9b** `to` 指向不存在成员 `MEMBER_NOT_FOUND` | ✅ |
| **P10** `to` 指向自己被拒 | ✅ |
| **P11** 暂停时 `ROOM_PAUSED` | ✅ |
| **P12** 关闭时 `ROOM_CLOSED` | ✅ |
| 连续四次拒绝后 seq / hop / turn **全部不变** | ✅ |

### P13：立刻唤醒（关键）

| 检查 | 结果 |
|---|---|
| dsh 挂起 10 秒超时的 `wait`，codex pass | ✅ |
| **2 秒内返回**（实测远小于 10 秒） | ✅ |
| 返回 `yourTurn: true` | ✅ |
| 带回系统消息 | ✅ |

### P5：pass 清超时计数（带对照组）

这条是工作单 §1.3 特意警告的时序陷阱。我的做法：

1. **主房间**：beta 超时一次 → alpha 发言把轮次交回 beta → **beta 自己 pass** →
   beta 再超时一次 → 房间**仍是 open**
2. **对照房间**：同样结构，**中间不 pass** → 连续两次超时 → 房间**暂停**

| 检查 | 结果 |
|---|---|
| 主房间：pass 后超时重新从 1 计，不暂停 | ✅ |
| **对照房间：不 pass 时确实暂停**（证明主房间的断言不是空洞通过） | ✅ |

**对照组是关键**——没有它，「没暂停」可能只是因为测试时序写错了。

---

## 三、我额外测的边界（工作单没列）

| # | 场景 | 结果 |
|---|---|---|
| 1 | **单人房间**：轮转绕回自己 | ✅ pass 后仍在自己 |
| 2 | **轮转跳过人类**：pass 后的目标不是 human | ✅ |
| 3 | **反复 pass 不耗尽 hop**：10 次 pass 后 hop 仍是 1 | ✅ |
| 4 | **pass 不影响个人发言上限**：上限 2，发 2 条 + 2 次 pass | ✅ 计数仍是 2 |
| 5 | **连续 pass 严格交替**：a5/b5/a5/b5 | ✅ |
| 6 | **系统消息文案**：无 `to` 是「X 让出轮次」，有 `to` 是「X 把轮次交给 Y」 | ✅ |
| 6b | 系统消息**不带内部 id**（`p_xxxxxxxx`） | ✅ |
| 7 | hop 用满房间已暂停时 pass 被拒 | ✅ `ROOM_PAUSED` |

第 6b 条值得一提：`ChatMember.id` 是 `p_xxxxxxxx` 格式，如果系统消息里漏了 id，
用户会看到一串乱码。实测文案干净。

---

## 四、实现评价

### 做得好的

1. **检查顺序与 `sendMessage` 完全一致**：`closed` → `paused` → `settleExpiredTurn`
   → 轮次校验 → 全部通过才动状态。我核对了两处的顺序，没有偏差。

2. **`turn === null` 的拒绝信息可操作**：
   ```
   'There is no live turn to yield; speak with send_message to claim one.'
   ```
   不只说「不行」，还告诉你怎么才能行——符合 `AGENTS.md` §7.2。

3. **`to` 指向自己时也拒绝**，文案写明了理由（「yielding to yourself changes nothing」）。
   工作单只说「拒绝或忽略」，GLM 选了拒绝并给了理由。

4. **P5 带了对照房间**。这是最重要的一点——工作单警告过时序陷阱，
   GLM 不但按纪律写了时序，还加了对照组证明断言不空洞。**这正是我原型第一次
   栽的那个坑。**

5. **P16 双保险**：既验 `tools/list`，又验 instructions 文本。
   工作单说过「不写进 instructions 等于白做」，这条钉住了。

6. **`ChatErrorCode` 一个没新增**，全用现有码。

### 可以更好的（不阻塞）

1. **`passTurn` 返回 `ChatTurn | null`，但实际永远不返回 `null`**
   （`nextSpeakerAfter` 至少会绕回自己，除非房间没有 agent）。
   MCP 层写的是 `turn?.name ?? null`，这个 `?? null` 目前是死分支。
   不是 bug，但类型可以更精确。

2. **`pass_turn` 的 `to` 参数描述是「接手的成员 name」**，
   而 `send_message` 的 `to` 描述是「下一位发言者的成员名」。
   两处措辞略有差异，不影响功能。

---

## 五、评审方这轮的表现

**首跑全绿，零返工。** 做法延续了上一轮：

```text
1. 先读实现，核对检查顺序
2. 先 dump tools/list 和 instructions，确认工具真的注册了
3. 写 P5 测试时严格按 §1.3 的时序纪律，并加对照组
4. 额外测 7 个工作单没列的边界
```

**P5 的对照组是这一轮最有价值的检查**——它区分了「代码正确」和
「测试恰好通过」。我上一轮原型就在这栽了，这次没重蹈。

---

## 六、合入

```powershell
git checkout main
git merge --ff-only feat/chat-pass
git branch -d feat/chat-pass
```

合入后 `pnpm test` 应为 **351 全绿**。

---

## 七、⚠️ 合入后要重开 DSH 会话

**这次改了工具清单**（`/chat/mcp` 多了 `pass_turn`）。

按 `AGENTS.md` §8：工具清单变了就必须重开客户端会话，
否则当前会话看不到新工具——**旧会话的 `tools/list` 是启动时的快照**。

重开后可以在真实对话里观察：agent 会不会在收工时主动 `pass_turn`，
而不是让房间干等 120 秒。这是 `OBSERVE-CHAT-REAL-MODELS.md` §4.4
提出问题的直接验证。

---

## 八、下一步

`pass`/`yield` 完成。剩下的可选项：

| 项 | 工作量 | 建议 |
|---|---|---|
| **P4-C3 runner** | 半天 | 下一个 |
| **`mentions` 模式** | 大（改轮次语义） | 最后 |

> **建议先观察一阵**：`pass_turn` 的真实效果要看 agent 会不会用它。
> 如果模型不主动 pass，说明 instructions 的措辞还需要调整——
> 那是**提示词问题**，不是代码问题。
