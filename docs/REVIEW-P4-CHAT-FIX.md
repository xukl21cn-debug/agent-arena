# 评审：聊天室两个缺陷的修复

> 评审对象：`fix/chat-cursor-and-limit` @ `785b172`（单个提交）
> 评审依据：[`HANDOFF-P4-CHAT-FIX.md`](HANDOFF-P4-CHAT-FIX.md)、[`OBSERVE-CHAT-REAL-MODELS.md`](OBSERVE-CHAT-REAL-MODELS.md)
> 评审日期：2026-10-26
> **结论：通过，已合入。**

---

## 一、独立验证怎么做的

按 `AGENTS.md` §6.1，**没有复用 GLM 的测试**，自己从工作单需求出发写了两组检查。

### 环境

| 项 | 值 |
|---|---|
| 服务 | 自己 `pnpm build` 后 `node server/dist/index.js`，跑在 **3200**（不碰 GLM 的 dev server） |
| 数据 | 隔离目录 `E:\data\tmp\arena-review-chat-fix\data`（不污染仓库 `data/`） |
| 脚本 | `E:\data\tmp\arena-review-chat-fix\review-fix.mjs` / `review-edges.mjs`（临时目录，未提交） |
| 客户端 | 手写 MCP 客户端打真实 `/chat/mcp`，不用 mock |

### 两组脚本

- `review-fix.mjs`：**38 条**，直接对应工作单 §5 的 A/B/边界/回归
- `review-edges.mjs`：**17 条**，工作单没列、我自己找的接缝

---

## 二、结果

```text
review-fix.mjs     PASS 38   FAIL 0
review-edges.mjs   PASS 17   FAIL 0
pnpm test          292 全绿（20 文件）
chat-duel.mjs      15/15 全过
```

### Bug A 实证

| 检查 | 结果 |
|---|---|
| `maxMessagesPerMember=2` 时第 3 条被拒 `MEMBER_LIMIT_REACHED` | ✅ |
| 被拒后消息没落库 | ✅ |
| 被拒后 hop 没增加 | ✅ |
| `members[].messages` 计数 = 2（**不再是 0**） | ✅ |
| 被拒后轮次已转走，不停在被拒者身上 | ✅ |
| 重启后计数恢复为 1（不是 0），上限仍生效 | ✅ |

### Bug B 实证

| 检查 | 结果 |
|---|---|
| 游标 0、20 条未读 → 首轮 `omitted=8`、`hasMore=true` | ✅ |
| 首轮**从最旧的 #1 开始**（原 bug 是返回 #9–#20） | ✅ |
| 按 `nextCursor` 循环 → 20 条**全部**拿到，`#1..#20` 无缺失 | ✅ |
| 循环必然终止（`nextCursor` 严格前进） | ✅ |
| 无新消息时 `nextCursor` = 传入 cursor（不是 0） | ✅ |
| 恰好 12 条 → `hasMore=false`；13 条 → `omitted=1` | ✅ |
| 60 条积压 → 5 轮取全 | ✅ |
| `hasMore === (omitted > 0)` 全程自洽 | ✅ |

### 回归

| 检查 | 结果 |
|---|---|
| `get_transcript` 仍是尾截断 + `omittedEarlier` | ✅ |
| `afterSeq` 缺省不重放历史 | ✅ |
| 旧客户端 `chat-duel.mjs` 15/15 | ✅ |

### 禁改清单

```text
shared/                     0 改动
server/src/rooms/           0 改动
server/src/core/presence.ts 0 改动
server/src/mcp/tools.ts     0 改动
get_transcript              未触碰
```

---

## 三、我额外找的接缝（工作单没列）

这 17 条里比较有价值的三条：

1. **`nextCursor` 能原样回传且不重复投递**——否则客户端会陷入「拿到重复消息」或「永远差一条」。
2. **系统消息也进未读窗口**——`MEMBER_LIMIT_REACHED` 会 `postSystemMessage`，如果未读窗口跳过它们，`seq` 就会跳号。实测 `seq` 连续，没跳。
3. **`hasMore` 与 `omitted` 全程自洽**——每轮都断言 `hasMore === (omitted > 0)`，25 条分 3 轮，最后一轮 `omitted=0`。

---

## 四、评审方自己犯的错（记录，别重踩）

第一次跑 `review-fix.mjs` 有 1 条失败：「无新消息时 `timedOut=true`」。

**是我的断言写错了。** 那个场景里人类发消息会种下轮次，轮次恰好落在被测 agent 身上，
`hasWakeup()` 判定「轮到你」→ `wait` 立即返回（`timedOut=false, yourTurn=true`）。

核实 `hasWakeup` 在本次修复中**零改动**（`git diff` 为空），是既有设计。
我改成「先让主持人把轮次交给别人，再测挂起」，才真正测到超时路径。

**教训**：`wait` 有四个唤醒条件（有新消息 / 轮到你 / phase 变了 / 超时），
断言 `timedOut=true` 前必须先保证前三个都不成立。这和 `AGENTS.md` §6.2
「断言字段名猜错」是同一类错误——**对被测系统的状态机想当然了**。

---

## 五、对实现的评价

### 做得好的

1. **`memberRef()` 而不是改 `snapshot()`**——正确取舍。让通用视图继续返回拷贝，
   把「要改就用这个」表达成一个命名明确的方法，副作用面最小。
2. **发现 `messagesAfter` 的尾截断必须一起换**——这是工作单没明说但绕不开的点。
   尾截断 + 前进游标 = 永远拿不到被丢的头部，续读循环会假报 `hasMore=false`。
   GLM 主动识别并换成了 `unreadAfter`（头部截断），这个判断是对的。
3. **选方案 1 而不是把上限提到 100**——理由写清了：「提高上限只是把截断点往后推，
   真实积压仍会溢出，失败模式会回来」。这个理由成立。
4. **测试真的走 MCP 层**（`StreamableHTTPClientTransport` 打 `/chat/mcp`），
   并且先红后绿有实证（A3 红在「第 3 条没被拒」，B1 红在「首条返回 seq=9」）。
5. **删掉 `messagesAfter` 是安全的**——我全仓库搜过（含 `web/`、`scripts/`），零外部引用。

### 可以更好的（不阻塞）

1. `unreadAfter` 用 `filter` 全量扫一遍再 `slice(0, limit)`。
   消息量大时是 O(n)。当前房间上限 1000 条，无影响，但可以留个注释说明这个前提。
2. `hasMore` 和 `omitted` 语义重叠（`hasMore === omitted > 0` 恒成立）。
   两个字段都留着是对的（一个给机器判断、一个给人看数字），但值得在类型注释里写死这个不变式，
   免得以后有人只改一个。

---

## 六、合入

```powershell
git checkout main
git merge --ff-only fix/chat-cursor-and-limit
git branch -d fix/chat-cursor-and-limit
```

合入后 `pnpm test` 应为 **292 全绿**。

---

## 七、下一步

- C4 网页聊天页可以开工了——成员栏的发言数现在是可信的，网页长轮询也不会丢消息。
- `pass`/`yield` 机制仍未做（见 `OBSERVE-CHAT-REAL-MODELS.md` §4.4），
  agent 收工后轮次仍会卡到 120s 超时。建议作为独立工作单，优先级低于 C4。
