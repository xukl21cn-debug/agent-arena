# 工作单：工具清单指纹（MCP 工具变化可见化）

> 面向：GLM
> 状态：P4-C1/C2 已合入（274 测试全绿）+ 一个 policy bug 待修
> 分支：从最新 main 新建 `feat/tool-fingerprint`
> 预计：0.5 天
> 背景：用户昨天发现「改工具后 DSH 连不上」，实际是两个独立问题

---

## 0. 先搞清楚：这不是「会话持久化」

用户最初的设想是「把 MCP 会话存盘，重启后接上」。**技术上做不到**，已查证：

| 事实 | 依据 |
|---|---|
| MCP 会话是内存对象 | SDK 源码注释：`State is maintained in-memory (connections, message history)` |
| 会话无法序列化 | 包含传输连接、SSE 流，没有存盘的表示 |
| 客户端 404 后不重连 | DSH 客户端：工具调用失败只 `throw`，不触发 `onclose` 重连 |
| 服务端不发 `tools/list_changed` | 全仓库 grep 零命中 |

**所以本工作单做的是「让工具变化可见」，不是「让会话存活」。**

---

## 1. 要解决的真实痛点

```text
改完服务端（加了工具）
  → 重启服务
  → DSH 旧会话还连着，但工具列表是旧的
  → 模型调不到新工具，或者调用旧签名失败
  → 用户不知道发生了什么，只看到报错
```

用户昨天就是这样，最后自己写了个脚本客户端绕过。

**目标**：让「工具清单变了」这件事**一眼可见**，而不是靠猜。

---

## 2. 做什么

```text
✅ 做：工具清单指纹（排序后 hash）
✅ 做：启动日志打印指纹 + 工具数
✅ 做：MCP initialize 响应里带指纹（通过 server instructions 或 tool 描述）
✅ 做：客户端连上时对比本地缓存，不一致就警告
❌ 不做：会话持久化（做不到）
❌ 不做：服务端发 tools/list_changed（DSH 的 autoRefresh 是 false，先验证再说）
```

---

## 3. 服务端：工具指纹

### 3.1 集中工具清单

现在工具是逐个 `server.registerTool('name', ...)` 注册的，没有清单。
加一个导出常量：

```ts
// server/src/mcp/tools.ts

/** Every tool this server registers, sorted. The fingerprint below is built
 *  from this list, so adding a tool without updating it is a test failure. */
export const TOOL_NAMES = [
  'confirm_score', 'get_state', 'join_game', 'leave_room', 'mark_dead',
  'new_game', 'pass', 'place_stone', 'resign', 'resume_play', 'say',
  'wait_for_turn',
] as const;
```

⚠️ **不要手工维护**——用测试锁住：注册完工具后 `listTools()` 必须与
`TOOL_NAMES` 完全一致（现有 `http.test.ts` 已经有这个断言，复用即可）。

### 3.2 指纹

```ts
// server/src/mcp/tools.ts

/**
 * A short stable hash of the tool list. Two servers with the same tools report
 * the same fingerprint; any add/remove/rename changes it.
 *
 * Not a security measure — it exists so a stale client can notice that the
 * tools it holds are not the tools the server has.
 */
export const TOOL_FINGERPRINT = fingerprintOf(TOOL_NAMES);

function fingerprintOf(names: readonly string[]): string {
  // FNV-1a over the sorted, comma-joined list. Short, stable, dependency-free.
  let hash = 0x811c9dc5;
  for (const ch of [...names].sort().join(',')) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
```

**为什么用 FNV-1a**：零依赖、确定性、8 位十六进制足够人眼比对。
不需要密码学强度——这是给人和日志看的，不是防篡改。

### 3.3 暴露给客户端

三个地方：

| 位置 | 内容 | 用途 |
|---|---|---|
| 启动日志 | `[arena] tools 12 fp=3a7f21b0` | 人看 |
| MCP server instructions 开头 | `tools: 12 fp=3a7f21b0` | 模型能看到（它会读 instructions） |
| `get_state` 等工具返回 | 不需要 | 避免污染每次响应 |

⚠️ **instructions 里加一行就够了，不要在每个工具响应里塞**——那会浪费 token。

---

## 4. 客户端侧：连上时对比

DSH 的 MCP 客户端配置在 `~/.dsh/profiles/web/cordis.patch.yml`。

**但这一份工作单不改 DSH 的代码**（那是另一个仓库）。做法是：

### 4.1 提供一个自检脚本

```text
scripts/mcp-fingerprint.mjs
```

功能：

```text
1. 连 http://127.0.0.1:3000/mcp
2. 读 tools/list，算指纹
3. 读 <dataDir>/mcp-tools.json 里上次记录的指纹
4. 不一致 → 打印警告 + 差异（新增/删除的工具名）
5. 写回新指纹
```

输出示例：

```text
[arena] tools: 12 fp=3a7f21b0
[arena] previous: 12 fp=8b2c4419
[arena] WARNING: tool list changed since last connection
  + pass
  + mark_dead
  - (none removed)
  → restart your MCP client (DSH: new session) to pick up the new tools
```

### 4.2 也可以做成服务端启动时自检

服务端启动时读同一个记录文件，发现指纹变了就打日志：

```text
[arena] tools 12 fp=3a7f21b0 (changed since last start: +pass +mark_dead)
[arena] note: connected clients keep their old tool list until they reconnect
```

**这个更有用**——用户重启服务时立刻看到提示，不用等下次连。

---

## 5. 为什么要写这个

| 收益 | 说明 |
|---|---|
| 用户能看到 | 「工具变了，需要重开会话」不再是隐形的 |
| 我（评审）能看到 | 每次合入后跑一次，确认工具清单符合预期 |
| 文档能引用 | 交接文档里写「当前 fp=xxxx」，下次变化一眼看出 |

**成本很低**：一个常量 + 一个 hash 函数 + 一个启动日志 + 一个自检脚本。

---

## 6. 测试

| 编号 | 内容 |
|---|---|
| F1 | `TOOL_NAMES` 与实际注册的工具完全一致 |
| F2 | `TOOL_FINGERPRINT` 稳定（同输入同输出） |
| F3 | 增删一个工具名，指纹变化 |
| F4 | 顺序不同但集合相同，指纹相同（排序后计算） |
| F5 | 自检脚本能读能写记录文件 |
| F6 | 记录文件损坏时不崩溃（跟 P3.5 一样的容错） |

### 6.1 必须保持绿

```text
[ ] 274 个现有测试一个都不能挂
```

---

## 7. 顺带修：REST 建房的 policy 参数

评审 `REVIEW-P4-C1.md` §5 发现的 bug，用户要求本轮修掉。

```ts
// server/src/chat/http.ts:97 现在
const room = manager.create(roomId, title === undefined ? {} : { title });

// 应该
const policy = body.policy === undefined ? undefined : chatPolicyOf(body.policy);
const room = manager.create(roomId, {
  ...(title === undefined ? {} : { title }),
  ...(policy === undefined ? {} : { policy }),
});
```

校验规则：

```text
mode ∈ {relay, mentions, free}，否则 INVALID_REQUEST
maxHops / maxMessagesPerMember / turnTimeoutMs / maxMessageChars 必须是正整数
  合理范围：maxHops 1–1000，turnTimeoutMs 1000–600000
未知字段：报错（严格）——静默忽略是这次 bug 的同类问题
```

**校验失败必须报错，不要回退默认值**——那正是这次 bug 的成因。

---

## 8. 完成标准

```text
[ ] TOOL_NAMES 常量 + 与注册一致
[ ] TOOL_FINGERPRINT 稳定且对变化敏感
[ ] 启动日志打印指纹和工具数
[ ] instructions 开头带指纹
[ ] scripts/mcp-fingerprint.mjs 能对比并警告
[ ] REST policy 参数生效 + 校验
[ ] pnpm test 全绿（274 + 新增）
[ ] pnpm typecheck + build
```

---

## 9. 提交

```text
feat(mcp): fingerprint the tool list so a stale client is visible

Adding a tool used to be invisible: the server restarted, the client kept the
tool list it had at connect time, and calls to the new tool simply failed. There
is no way to persist an MCP session — the SDK keeps connections and message
history in memory — so the honest fix is to make the mismatch observable rather
than pretend it can be fixed silently.

The fingerprint is FNV-1a over the sorted tool names. It shows up in the boot log
and in the server instructions, and scripts/mcp-fingerprint.mjs compares it with
the last seen value to name the tools that changed.

Also fixes the chat policy bug from the P4-C1 review: POST /api/chat/rooms read
only `title` and silently dropped `policy`, so a caller asking for a shorter turn
timeout got the default and no error.
```

---

## 10. 做完之后

回到 P4：**C4 网页聊天页**，或先手动试一次两个真实模型对聊。

工具变化可见化之后，以后每次改工具我都能明确告诉你「指纹变了，重开会话」，
而不是让你猜。
