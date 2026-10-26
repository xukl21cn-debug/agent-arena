# 工作单：修聊天室两个服务端缺陷

> 面向：GLM
> 状态：P4-C1/C2 已合入 main（282 测试全绿），两个 bug 待修
> 分支：从最新 main 新建 `fix/chat-cursor-and-limit`
> 预计：2–3 小时
> 来源：[`OBSERVE-CHAT-REAL-MODELS.md`](OBSERVE-CHAT-REAL-MODELS.md) §3

---

## 0. 先说清楚

这两个 bug 是**用真实模型聊了一轮**发现的，不是看代码猜的。
两个都有实测复现，见 §5。

**做完这两个就停**，不要顺手改别的。C4 网页是下一份工作单。

---

## 1. Bug A：`maxMessagesPerMember` 完全失效

### 现象

房间策略 `maxMessagesPerMember: 2`，成员 `a1` 成功发出第 **3** 条。

```text
policy: maxMessagesPerMember=2
a1 第1句 -> sent #1
a2 第1句 -> sent #2
a1 第2句 -> sent #3      ← 已达上限
a2 第2句 -> sent #4
a1 第3句 -> sent #5      ← 应该 MEMBER_LIMIT_REACHED，实际成功
```

落盘文件里 `a1.messages` 仍然是 **0**。

### 根因

`server/src/chat/mcp.ts:249-269` 的 `memberOf()`：

```ts
const member = room.snapshot().members.find((item) => item.id === participantId);
```

`ChatRoom.snapshot()` 返回**深拷贝**（`chat-room.ts:501`：`members.map(m => ({...m}))`）。
于是 `sendMessage()` 里的：

```ts
member.messages += 1;   // chat-room.ts:247
```

加在**副本**上。真实的 `this.members.get(id)` 对象永远不变。

`sendMessage()` 的 `member.messages >= policy.maxMessagesPerMember` 判断
因此永远拿到 0，永远不触发。

### 要做什么

给 `ChatRoom` 加一个**返回真实引用**的成员查询，`memberOf()` 用它。

建议形状（名字你定，但要说明为什么不是 `snapshot()`）：

```ts
/** The live member record, not a copy — callers that mutate counters need this. */
memberRef(participantId: string): ChatMember | undefined
```

⚠️ **不要**改成「`snapshot()` 返回浅拷贝」或「返回内部 Map」——
那会让外部代码能改到内部状态，副作用面更大。加一个明确命名的方法。

⚠️ `join_room` 里 `room.snapshot().members.find(...)`（`mcp.ts:292`）
只读不写，**可以不动**。但如果改起来更自然，也可以一起换。

---

## 2. Bug B：`wait_for_messages` 静默丢消息

### 现象

客户端游标在 `seq=0`，房间有 20 条新消息。
`wait_for_messages` 只返回 **12 条**（`#9`–`#20`），`#1`–`#8` **静默消失**：

```text
messages: [ "#9 ...", "#10 ...", ..., "#20 ..." ]
```

**没有 `omitted`，没有 `hasMore`，没有 `nextCursor`。**

### 根因

`server/src/chat/mcp.ts:391`：

```ts
const fresh = room.messagesAfter(cursor, CHAT_RECENT_LIMIT);   // 12
```

`messagesAfter`（`chat-room.ts:511`）内部 `.slice(-limit)`——
**从尾部截断，丢的是前面的**。

而且返回值里没有任何字段告诉客户端「你漏了」。

### 为什么严重

agent 会以为「这段时间没有新消息」，基于残缺上下文继续发言，**永远不会知道**。
违反 AGENTS §7.3「失败要可诊断」。

### 要做什么

`wait_for_messages` 的返回值**加字段**（只增不改）：

| 字段 | 含义 |
|---|---|
| `nextCursor` | 客户端下次该传的 `afterSeq`（= 本次返回的最后一条 seq；没有新消息时 = 传入的 cursor） |
| `hasMore` | 是否还有没返回的消息（本次被截断时为 `true`） |
| `omitted` | 本次因截断而没返回的条数（与 `get_transcript` 的 `omittedEarlier` 同语义） |

**关键行为**：`omitted > 0` 或 `hasMore === true` 时，**必须让 agent 能拿到剩下的**。
两种做法，**二选一，在提交信息里说明理由**：

- **方案 1（推荐）**：`hasMore` 为真时，客户端用 `nextCursor` 继续调 `wait`，
  下一次 `wait` 会立刻返回（因为 `seq > cursor` 成立），直到 `hasMore=false`。
  → 这要求 `wait` 在「有新消息」时**立刻返回**，现在的 `hasWakeup()` 已经是这个语义，应该天然成立。
- **方案 2**：把 `wait` 的返回上限从固定 12 提到「单次最多 100」，够不到再靠 `hasMore`。
  → 简单，但没解决「无限增长」的根。

⚠️ **`hint` 也要跟着改**：`hasMore` 为真时，hint 必须明确告诉 agent
「还有 N 条没读，用 nextCursor 继续 wait」，否则模型看到 hint 就去做别的了。

⚠️ **不要动 `get_transcript`**：它已经返回 `omittedEarlier`，是对的。

---

## 3. 硬约束（踩了就返工）

| 约束 | 原因 |
|---|---|
| **不改 `shared/`** | 聊天是独立领域对象，`ChatErrorCode` 不进 shared |
| **不改 `rooms/` / `core/presence.ts` / `mcp/tools.ts`** | 棋类契约不动 |
| **`ChatRoomSnapshot` 只增字段** | 网页和 REST 都依赖它 |
| **MCP 返回值只增字段** | 旧客户端（chat-duel.mjs）不能坏 |
| **错误码不新增** | `ChatErrorCode` 已够用 |
| **`get_transcript` 不动** | 它是对的 |

---

## 4. 易错点

| 坑 | 说明 |
|---|---|
| **以为改 `snapshot()` 就行** | 会让外部代码能改内部状态。加专门方法。 |
| **`memberRef` 返回副本** | 那就白改了。返回 `this.members.get(id)` 本体。 |
| **`nextCursor` 算错** | 没新消息时应该 = 传入的 cursor，不是 0。否则客户端会重读全部。 |
| **`hasMore` 恒为 true** | 用 `pool.length > kept.length` 判断，别硬编码。 |
| **改了 `wait` 的返回上限但没改 hint** | 模型会忽略 `hasMore`，白改。 |
| **测试只测返回值不测行为** | 见 §5——必须验证「第 3 条真的被拒」和「20 条真的能全拿到」 |

---

## 5. 测试清单

**每一条都要能独立复现原 bug（先红后绿）。**

### Bug A

| # | 测试 | 断言 |
|---|---|---|
| A1 | 领域层：`ChatRoom` 直接 `sendMessage` 到上限 | 第 N+1 次抛 `MEMBER_LIMIT_REACHED` |
| A2 | 领域层：`memberRef` 返回的是本体 | 改 `memberRef(id).messages` 后 `snapshot()` 能看到 |
| A3 | **MCP 层**：两个真实 MCP 会话，`maxMessagesPerMember=2`，交替发言 | 第 3 条被拒，错误码 `MEMBER_LIMIT_REACHED` |
| A4 | **MCP 层**：拒绝后**不留残留** | 消息数不变、hop 不变、轮次已转走（现有逻辑是「拒绝并跳过」） |
| A5 | 落盘：发 3 条后重载 | `member.messages === 3`（不是 0） |

> A3/A4 是核心。A1/A2 是单元层，但**不能只有 A1/A2**——
> 这个 bug 就是「领域层对、MCP 层错」，只测领域层会再次漏掉。

### Bug B

| # | 测试 | 断言 |
|---|---|---|
| B1 | 游标落后 20 条，调 `wait` | 返回 `omitted === 8`、`hasMore === true`、`nextCursor` 正确 |
| B2 | 用 `nextCursor` 继续 `wait` | 立刻返回剩下 8 条，`hasMore === false` |
| B3 | 没有新消息时调 `wait` | `nextCursor === 传入的 cursor`，`hasMore === false`，`omitted === 0` |
| B4 | `hasMore` 为真时 hint 可操作 | hint 里含「还有」或「nextCursor」之类的明确指令 |
| B5 | 恰好 12 条（不多不少） | `hasMore === false`，`omitted === 0`（边界） |
| B6 | 旧客户端不坏 | `scripts/chat-duel.mjs` 全绿 |

---

## 6. 验收标准

- [ ] `pnpm typecheck` 干净
- [ ] `pnpm test` 全绿（当前 282，加上新增的应该 >290）
- [ ] `node scripts/chat-duel.mjs` 全绿（旧客户端兼容）
- [ ] §5 的 A3/A4/B1/B2 是**新写的**，能证明原 bug 存在过
- [ ] 提交信息用英文，正文说**为什么**（不是做了什么）
- [ ] 两个 bug 一个提交，还是拆两个——你自己判断，说理由

---

## 7. 做完就停

**不要**顺手做这些（都是后续工作单）：

- ❌ C4 网页聊天页
- ❌ `pass` / `yield` 机制（§4.4 的设计观察，独立工作单）
- ❌ WS / SSE
- ❌ runner（P4-C3）

做完提 PR/分支，等评审。
