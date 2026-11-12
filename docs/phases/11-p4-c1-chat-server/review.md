# 评审：P4-C1/C2 聊天室服务端

> 评审人：DSH
> 对象：`feat/chat` @ `1a2a13b`（10 文件，+2389/−1）
> 结论：**通过，合入 main**（附一个必须修的小 bug，见 §5）

---

## 1. 结论

| 项 | 结果 |
|---|---|
| 测试 | ✅ 274 全绿（258 + 16 新增） |
| 类型 / 构建 | ✅ 全过 |
| **五个禁改文件** | ✅ 零触碰（逐文件验证） |
| 端点隔离 | ✅ `/chat/mcp` 与 `/mcp` 工具互不可见 |
| 独立验证 | ✅ 我用真实 MCP 客户端聊了一轮，核心行为全对 |
| 判定 | **通过**（§5 的 bug 建议本轮修或下一轮） |

---

## 2. 五个禁改文件：零触碰

工作单 §2.1 列了五个不能动的文件。逐个验证：

```text
OK  server/src/rooms/room.ts
OK  server/src/rooms/room-manager.ts
OK  server/src/mcp/tools.ts
OK  server/src/core/presence.ts
OK  shared/src/game.ts
```

棋类侧只有 `app.ts`（+13 行挂载）和 `index.ts`（+11 行初始化），符合预期。

**聊天室是真正独立的领域对象**，提案 §3 的要求做到了。

---

## 3. 端点隔离（我实测）

| 检查 | 结果 |
|---|---|
| `/chat/mcp` 只有 4 个聊天工具 | ✅ `join_room` / `send_message` / `wait_for_messages` / `get_transcript` |
| `/chat/mcp` 没有棋类工具 | ✅ 无 `place_stone` / `new_game` |
| `/mcp` 没有聊天工具 | ✅ 无 `send_message` |
| `/mcp` 仍是 12 个工具 | ✅ 数量未变 |

**双向隔离成功。** 这验证了「独立端点」这个决策的价值：两边的 instructions 不会互相污染。

---

## 4. 核心行为实测

用两个真实 MCP 客户端跑完整流程：

| 检查 | 结果 |
|---|---|
| 两个 agent 加入 | ✅ |
| 第一个 agent 发言 → hop+1 | ✅ |
| turn 自动轮到下一个 agent | ✅ |
| 轮到的 agent `wait` 立即返回（1ms） | ✅ |
| `yourTurn: true` | ✅ |
| 非轮到的 agent `wait` 挂起满超时 | ✅ 1511ms / 1500ms |
| `timedOut: true` | ✅ |
| `hint` 字段有内容 | ✅ |
| **非轮到时发言被拒** | ✅ `NOT_YOUR_TURN` |
| **挂起的 waiter 被新消息唤醒** | ✅ |
| 重复文本被拒 | ✅ `DUPLICATE_MESSAGE` |
| 超长消息被拒 | ✅ `MESSAGE_TOO_LONG` |
| human 随时能发言 | ✅ |
| human 指定下一位 | ✅ turn 正确转移 |
| 暂停时 agent 被拒 | ✅ `ROOM_PAUSED` |
| **暂停时 human 仍能发言** | ✅ |
| 恢复后 agent 能说话 | ✅ |
| 关闭后 agent 被拒 | ✅ `ROOM_CLOSED` |

**长轮询是真挂起**（1511ms 才返回），不是轮询循环。

---

## 5. 发现一个真 bug：REST 建房的 `policy` 参数被静默丢弃

### 5.1 现象

```http
POST /api/chat/rooms
{ "roomId": "x", "title": "t", "policy": { "turnTimeoutMs": 300 } }
```

返回：

```json
{"policy":{"mode":"relay","maxHops":16,"maxMessagesPerMember":8,
           "turnTimeoutMs":120000,"maxMessageChars":4000}}
```

**`turnTimeoutMs: 300` 被忽略了**，用的还是默认 120000。

### 5.2 根因

`server/src/chat/http.ts:97`：

```ts
const room = manager.create(roomId, title === undefined ? {} : { title });
```

只读 `title`，**整个 `http.ts` 里没有 `policy` 这个词**。

### 5.3 为什么测试没发现

GLM 的测试只在**领域层**验证了自定义 policy：

```ts
// chat-room.test.ts:145
policy: { ...DEFAULT_CHAT_POLICY, maxHops: 2 }
```

`new ChatRoom(id, title, policy)` 直接传，绕过了 REST 层。
**REST 的 policy 从未被测过。**

### 5.4 严重度：中

不影响主流程（默认值可用），但：

- 提案 §6.2 明确写了 `POST /api/chat/rooms { id?, title, policy? }`
- 静默忽略参数比报错更糟——调用方以为生效了
- 未来调参（比如想让 agent 少说几句）会踩

### 5.5 建议修法

```ts
// http.ts
const policy = body.policy === undefined ? undefined : chatPolicyOf(body.policy);
const room = manager.create(roomId, {
  ...(title === undefined ? {} : { title }),
  ...(policy === undefined ? {} : { policy }),
});
```

`chatPolicyOf` 要做校验：数值范围、`mode` 枚举、非法值报 `INVALID_REQUEST`
（不要静默回退默认值）。

**如果本轮不修**，至少在 `HANDOFF-P4-C3/C4` 里记一笔。

---

## 6. GLM 说明的三处设计判断

### 6.1 relay 只在 agent 间轮转 —— **正确**

工作单 §4.1 写的是「按成员加入顺序找下一位」，GLM 改成只轮 agent，理由：

> 把 turn 轮给 human 会卡死（人不在打字，等满两次超时才暂停）。

**这个判断是对的，而且我验证了实现**：

```ts
nextSpeakerAfter(after?: string): ChatMember | null {
  const agents = [...this.members.values()].filter(m => m.kind === 'agent');
  ...
  return agents[(index + 1) % agents.length]!;
}
```

只有 agent 参与轮转，human 永远不持有 turn（但随时能说话）。

**这是工作单的疏忽**，GLM 按实际需求修正了，并在注释里写明了理由。

### 6.2 turn 租约惰性结算 —— **正确，但注释有个小错**

实现：`settleExpiredTurn(now)` 在 `sendMessage` 和 `wait` 里调用。

**我验证了领域层逻辑是对的**：

```text
租约 50ms，a 发言后 turn 给 b
settleExpiredTurn(now+100) → "b 超时，跳过"，turn 给 a
settleExpiredTurn(now+200) → "a 超时，跳过"，turn 给 b
```

**但注释说「settle on the next touch (send / wait / snapshot)」，而 `snapshot()` 实际没有调用它。**

影响有限：真正参与对话的 agent 会走 `send`/`wait`，都会结算。
只有「纯观察者」用 `get_transcript` 看不到超时。

**建议**：要么改注释（去掉 snapshot），要么在 `snapshot()` 里加结算。
我倾向**改注释**——`snapshot` 应该是纯读操作，不该有副作用。

### 6.3 `chat:<roomId>` 前缀隔离 SessionBindings —— **正确**

```ts
// 若棋类和聊天共用同名房间，同一 session 的两个身份会互相覆盖
bindings.bind(sessionId, `chat:${roomId}`, participantId)
```

**这是个真实的隐患**，GLM 发现了。前缀隔离后 `session-context.ts` 零改动，
一个 agent 能同时在同号棋房和聊天房有身份。

---

## 7. 一个我自己的误判（记录）

第一版审计报了 2 个 FAIL，都是我的问题：

| 我报的 FAIL | 真实情况 |
|---|---|
| 建房后 `turn` 应为第一个 agent | 初始 `turn` 是 `null`，第一次发言时才惰性设置。**合理设计** |
| human 发言后 hop 应保持 3 | 我算错了期望值（之前 agent 说了 4 次不是 3）。human 确实没占 hop |

另外我**第四次**踩了 `timeoutMs` 最小值 1000 的坑。

**教训**：调工具前先确认参数范围，这个错我已经犯了四次。

---

## 8. 代码质量

| 维度 | 评价 |
|---|---|
| 领域隔离 | ✅ 五个禁改文件零触碰，`chat/` 自成一体 |
| 端点隔离 | ✅ `/chat/mcp` 双向不可见 |
| 长轮询 | ✅ 真挂起，与 `waitForSeat` 同构 |
| 防跑飞 | ✅ 四件套齐全（hop/上限/重复/超长） |
| human 特权 | ✅ 不占 hop、不查上限、暂停也能说 |
| 错误码 | ✅ 独立 `ChatErrorCode`，不污染棋类契约 |

值得肯定：`ChatError` **没有塞进 `shared`**，棋类的 `ErrorCode` 契约完全没动。
这是正确的边界意识。

---

## 9. 合入

```text
git checkout main
git merge --ff-only feat/chat
pnpm test        # 274 全绿
```

§5 的 policy bug 建议下一轮修（或本轮补一个小 commit）。

---

## 10. 下一步

```text
C3  runner（CLI 包成常驻成员）
C4  网页聊天页
P5  大厅 + 棋谱回放 + WS 统一
```

**建议 C4 之前先手动试一次两个 agent 对聊**——GLM 的 `chat-duel.mjs` 是 mock，
真实模型的行为还没看过。这和 P2 的教训一样：协议对不等于模型对。
