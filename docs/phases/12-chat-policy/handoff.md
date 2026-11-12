# 工作单：修 chat policy 参数被丢弃

> 面向：GLM
> 状态：P4-C1/C2 已合入 main（274 测试全绿），本 bug 待修
> 分支：从最新 main 新建 `feat/chat-policy`
> 预计：1–2 小时
> 来源：[P4-C1 评审](../11-p4-c1-chat-server/review.md) §5

---

## 1. Bug 是什么

`POST /api/chat/rooms` 接受 `policy` 参数，但**静默丢弃**，总是用默认值。

### 复现

```http
POST /api/chat/rooms
{ "roomId": "x", "title": "t", "policy": { "turnTimeoutMs": 300 } }
```

返回：

```json
{"policy":{"mode":"relay","maxHops":16,"maxMessagesPerMember":8,
           "turnTimeoutMs":120000,"maxMessageChars":4000}}
```

**`turnTimeoutMs: 300` 被忽略**，没有报错。

### 根因

`server/src/chat/http.ts:97`：

```ts
const room = manager.create(roomId, title === undefined ? {} : { title });
```

只读 `title`。**整个 `http.ts` 里没有 `policy` 这个词。**

### 为什么测试没发现

`chat-room.test.ts` 只在**领域层**测了自定义 policy：

```ts
// chat-room.test.ts:145
policy: { ...DEFAULT_CHAT_POLICY, maxHops: 2 }
```

这是直接 `new ChatRoom(id, title, policy)`，**绕过了 REST 层**。

---

## 2. 要做什么

```text
✅ 解析 body.policy
✅ 逐字段校验
✅ 非法值报 INVALID_REQUEST
✅ 传给 manager.create
❌ 不要回退默认值（静默忽略正是这次 bug 的成因）
```

---

## 3. 校验规则

```text
mode            ∈ { 'relay', 'mentions', 'free' }
maxHops         正整数，1–1000
maxMessagesPerMember  正整数，1–1000
turnTimeoutMs   正整数，1000–600000   ← 和 MCP 的 timeoutMs 下限一致
maxMessageChars 正整数，1–100000
```

### 3.1 未知字段

**建议报错**，不要静默忽略。

理由：这次 bug 的本质就是「参数被静默丢弃」。如果未知字段也静默忽略，
下次有人拼错 `turnTimeoutsMs` 会同样无声无息。

### 3.2 部分字段

只传一部分字段时，缺的用 `DEFAULT_CHAT_POLICY` 补：

```ts
{ "policy": { "maxHops": 4 } }
// → { mode:'relay', maxHops:4, maxMessagesPerMember:8,
//     turnTimeoutMs:120000, maxMessageChars:4000 }
```

### 3.3 不传 policy

完全用默认值，**不要**改变现有行为。

---

## 4. 实现建议

```ts
// server/src/chat/http.ts

/** Parse and validate a policy override; every field is checked, and an
 *  unknown or out-of-range field is an error rather than a silent default —
 *  silently dropping `policy` was the bug this replaces. */
function chatPolicyOf(raw: unknown): Partial<ChatPolicy> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ChatError('INVALID_REQUEST', 'policy must be an object.');
  }
  const input = raw as Record<string, unknown>;
  const known = new Set(['mode', 'maxHops', 'maxMessagesPerMember', 'turnTimeoutMs', 'maxMessageChars']);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new ChatError('INVALID_REQUEST', `Unknown policy field "${key}".`);
    }
  }
  const out: Partial<ChatPolicy> = {};
  if (input.mode !== undefined) {
    if (input.mode !== 'relay' && input.mode !== 'mentions' && input.mode !== 'free') {
      throw new ChatError('INVALID_REQUEST', 'policy.mode must be relay, mentions or free.');
    }
    out.mode = input.mode;
  }
  // ... 其余字段同理，用 readIntRange 辅助
  return out;
}
```

然后：

```ts
const room = manager.create(roomId, {
  ...(title === undefined ? {} : { title }),
  ...(Object.keys(policy).length === 0 ? {} : { policy }),
});
```

⚠️ **`manager.create` 的签名要改**。现在（`chat/manager.ts:70`）：

```ts
create(roomId: string, options: { title?: string } = {}): ChatRoom {
  ...
  const room = new ChatRoom(roomId, options.title?.trim() || roomId, {
    // v1 implements relay; other modes are contract placeholders.
    mode: 'relay',
    maxHops: 16,
    maxMessagesPerMember: 8,
    turnTimeoutMs: 120_000,
    ...
  });
}
```

policy 是**硬编码**在这里的，`options` 里根本没有它。

要改成：

```ts
create(
  roomId: string,
  options: { title?: string; policy?: Partial<ChatPolicy> } = {},
): ChatRoom {
  ...
  const room = new ChatRoom(roomId, options.title?.trim() || roomId, {
    ...DEFAULT_CHAT_POLICY,
    ...options.policy,
  });
}
```

⚠️ **用 `DEFAULT_CHAT_POLICY` 而不是再写一遍字面量**——现在是手写的 16/8/120000，
和 `model.ts` 里的 `DEFAULT_CHAT_POLICY` 重复了。顺手合并掉，避免两处不一致。

⚠️ 这是 chat 模块内部，**不违反「不动棋类」**。

---

## 5. 测试

| 编号 | 内容 |
|---|---|
| P1 | REST 传完整 policy → 返回值全部生效 |
| P2 | REST 传部分 policy → 缺的用默认值 |
| P3 | REST 不传 policy → 全默认（不回归） |
| P4 | 非法 mode → `INVALID_REQUEST` |
| P5 | 超范围数值（如 `maxHops: 0`、`turnTimeoutMs: 10`）→ `INVALID_REQUEST` |
| P6 | 未知字段（如 `policy: { nope: 1 }`）→ `INVALID_REQUEST` |
| P7 | `policy` 不是对象（如 `policy: "x"`）→ `INVALID_REQUEST` |
| P8 | **自定义 `turnTimeoutMs` 真的生效**——建一个 1000ms 租约的房间，等 1.2 秒，确认 turn 被跳过 |

**P8 是关键**：这个 bug 的表现就是「参数没生效」，所以要验证**行为**而不只是返回值。

### 5.1 必须保持绿

```text
[ ] 274 个现有测试一个都不能挂
```

---

## 6. 完成标准

```text
[ ] REST 建房时 policy 生效
[ ] 非法值报 INVALID_REQUEST，不回退默认值
[ ] 未知字段报错
[ ] pnpm test 全绿（274 + 新增）
[ ] pnpm typecheck
```

### 自查

```powershell
cd E:\code\fun\agent-arena
pnpm test
pnpm typecheck
git diff --stat   # 只该出现 chat/http.ts、chat/manager.ts、测试
```

**不该出现**：`rooms/`、`core/presence.ts`、`mcp/tools.ts`、`shared/src/game.ts`。

---

## 7. 提交

```text
fix(chat): honour the policy passed to POST /api/chat/rooms

The handler read only `title`, so a caller asking for a shorter turn timeout got
the default 120000 and no error at all. Domain tests set policy through the
constructor, which is why the REST path was never exercised.

Every field is now validated and an unknown or out-of-range one is rejected with
INVALID_REQUEST: silently dropping the parameter is exactly the bug being fixed,
and silently dropping a misspelled field would be the same mistake again.
```

---

## 8. 顺带（可选）

`chat-room.ts` 的 `settleExpiredTurn` 注释写着：

> settle on the next touch (send / wait / snapshot)

但 `snapshot()` 实际**没有调用**它。

**建议改注释**，去掉 `snapshot`——`snapshot` 应该是纯读操作，不该有副作用。
（如果你更倾向于在 `snapshot()` 里加结算，也可以，但要在注释里说明为什么。）

这个不改也不影响功能，只是注释和实现不一致。

---

## 9. 做完之后

回到 P4：**C4 网页聊天页**。

或者先手动试一次两个真实模型在聊天室对聊（`chat-duel.mjs` 是 mock，
真实模型行为还没看过）。
