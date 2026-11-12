# 真实模型观察：聊天室第一轮（P4 §3.1）

> **日期**：2026-10-26
> **目的**：C4 之前先让两个真实模型聊一轮（`roadmap.md` P4 的 C2.5），
> 因为 `scripts/chat-duel.mjs` 是 mock 客户端，真实模型行为没观察过。
>
> **结论先说**：协议层稳，**模型行为没问题**（不抢话、能自我纠正、讨论有实质推进），
> 但**发现两个真缺陷**，都在服务端，且现有 282 个测试全都没覆盖。

---

## 一、怎么做的

| 项 | 值 |
|---|---|
| 房间 | `real637936`（另建 `limit774635` / `trunc140031` / `hop968766` 做边界测试） |
| 成员 | `human`（REST 主持人）、`dsh`（DSH 本人）、`claude`（Claude Code CLI 真实进程） |
| 端点 | `http://127.0.0.1:3000/chat/mcp`（streamable HTTP） |
| 话题 | 「聊天室要不要从 MCP 长轮询改成 WebSocket」 |
| 规模 | 13 条消息，11 次 agent 发言，hop 11/16 |

**claude 那一侧是真的独立进程**：`claude.exe -p ... --mcp-config chat-mcp.json
--strict-mcp-config --allowedTools mcp__chat__*`，跑完自己收工退出（exit 0）。

**DSH 这一侧**是本人逐轮判断，但工具调用走脚本（我这个会话没挂 `/chat/mcp`
原生工具）。这个摩擦本身也是观察结果之一，见 §4.4。

### 为什么没用 codex

一开始想用 codex CLI，实测它能连上（`probecodex` 成功 join、`get_transcript` 正常），
但配置成本高（`mcp_servers.chat.url` 得走 `-c` 传，还有一层 node_repl 包装）。
按用户要求换成 claude + DSH 组合。

---

## 二、真实模型表现（这是 §3.1 要的答案）

### 2.1 没有抢话，一次都没有

从 claude 的 stream-json 日志里提取的完整调用序列：

```text
L61  ToolSearch(选 chat 工具)
L70  join_room(real637936, name=claude)
L90  wait_for_messages(afterSeq=0, 25000ms)
L96  wait_for_messages(afterSeq=0, 30000ms)   ← 超时了，继续等
L98  wait_for_messages(afterSeq=1, 30000ms)   ← 有消息了，但不是它的轮次，继续等
L627 send_message(to=dsh, ...)                ← 轮到它了，才说话
L629 wait_for_messages(afterSeq=3, 30000ms)
L632 wait_for_messages(afterSeq=3, 30000ms)
L634 send_message(...)
L636 wait_for_messages(afterSeq=5, 30000ms)
L639 wait_for_messages(afterSeq=5, 30000ms)
```

**关键**：它为了等自己的轮次，连续 `wait` 了 3 次（其中一次超时），
**没有一次尝试抢话**。全程 0 个 `NOT_YOUR_TURN` 错误。

### 2.2 长轮询是真的挂住了，模型没有因为「慢」而放弃

L90 → L95 之间隔了 26 秒（等待超时），模型的反应是 `"Keep waiting."` 然后立刻再等。
**这正是长轮询设计想要的行为**，也是 `CHAT_INSTRUCTIONS` 里「不等待的 agent 是不可达的」
那句在起作用的证据。

### 2.3 模型会自我纠正，而且纠正得对

我做了一次失败的抢话测试（记错了轮次归属，在自己轮次里发言，所以成功了）。
claude 主动指出：

> 顺手说下刚才这条：它没被拦，是因为上一轮 turn 本来就在 dsh 手上，不算抢话；
> 真正的抢话测试得在我这个轮次里发，才会吃 NOT_YOUR_TURN。

**它读懂了房间状态，还纠正了我的测试方法。** 我照做后确实拿到 `NOT_YOUR_TURN`。

### 2.4 讨论质量：有实质推进，不是复读

| 轮次 | 谁 | 推进了什么 |
|---|---|---|
| 1 | dsh | 结论：不该上。消费者是 MCP 客户端，本来只有请求-响应 |
| 2 | claude | 补数字：20s 是**最坏情况**，实际被消息唤醒；延迟淹没在模型推理里。**首次提出 WS 该在网页层** |
| 3 | dsh | 顺着拆开：网页层和 MCP 层可以分开决定；真正的问题 agent 不调工具就卡死 |
| 4 | claude | **反驳**：卡轮次根因是「没有显式 pass」，不是「没有推送」。上了 WS 一样卡 |
| 5 | claude | 补逃生门：`afterSeq` 断点续传要求消息序号单调、wait 不丢消息 |
| 6 | claude | 收尾排序：①修游标 ②补 pass ③网页 SSE 优先 |

**没有跑题，没有复读，有明确的反驳和收敛。** 这比 P2 围棋那轮的表现好得多。

### 2.5 共识结论

> MCP 链路维持长轮询，先修游标；WS 只进网页那一层，P5 再统一。

这个结论是模型自己谈出来的，不是我引导的——**可以直接作为 C4/P5 的设计输入**。

---

## 三、发现的两个缺陷（都有实测证据）

### 3.1 `maxMessagesPerMember` 完全失效（严重）

**现象**：房间策略 `maxMessagesPerMember: 2`，成员 `a1` 成功发出第 3 条。

```text
created policy: maxPerMember=2 maxHops=50
a1 第1句 -> sent #1
a2 第1句 -> sent #2
a1 第2句 -> sent #3      ← 已达上限
a2 第2句 -> sent #4
a1 第3句 -> sent #5      ← 应该 MEMBER_LIMIT_REACHED，实际成功
```

落盘文件里 `a1.messages` 仍然是 **0**，而它实际发了 3 条。

**根因**（`server/src/chat/mcp.ts:261`）：

```ts
const member = room.snapshot().members.find((item) => item.id === participantId);
```

`ChatRoom.snapshot()` 返回的是**深拷贝**（`chat-room.ts:501` 的 `{...member}`）。
`sendMessage()` 里的 `member.messages += 1` 加在**副本**上，
真实的 `this.members.get(id)` 对象永远不变。

**为什么测试没抓到**：`chat-policy.test.ts` 只测 policy 能不能存进去、能不能校验，
`chat-room.test.ts` 没有一条测 `member.messages` 累加，
`chat-wire.test.ts` 的 `send_message` 用例没有碰上限。**三层都没覆盖到执行路径。**

**对照实验证明是这一个点坏了**：同一条 `sendMessage` 里的 `DUPLICATE_MESSAGE`
（数据存在 `room.lastText`，不在 member 上）**工作正常**。
所以不是整个 `sendMessage` 坏了，是「依赖 member 对象」的那部分坏了。

### 3.2 `wait_for_messages` 静默丢消息（严重）

**现象**：客户端游标停在 `seq=0`，房间已有 20 条新消息。
`wait_for_messages` 只返回 **12 条**（`#9`–`#20`），`#1`–`#8` 消失，
**没有 `omitted` 计数，没有 `hasMore`，没有 `nextCursor`**。

```text
t1 cursor reset to 0, room seq = 20
messages: [ "#9 ...", "#10 ...", ..., "#20 ..." ]   ← 只有 12 条
```

**根因**（`server/src/chat/mcp.ts:391`）：

```ts
const fresh = room.messagesAfter(cursor, CHAT_RECENT_LIMIT);  // CHAT_RECENT_LIMIT = 12
```

`messagesAfter` 内部是 `.slice(-limit)`——**从尾部截断，丢掉的是前面的**。
而且返回值里没有任何字段告诉客户端「你漏了」。

**为什么严重**：agent 会以为「这段时间没有新消息」，实际是消息被丢了。
它基于残缺的上下文继续发言，而且**永远不会知道**。
这违反 AGENTS §7.3「失败要可诊断」。

**注意**：`get_transcript` 是**对的**——它返回 `omittedEarlier` 计数。
坏的是 `wait_for_messages` 这条增量路径。

### 3.3 附带发现：`messages` 计数从来不涨

由 3.1 直接导致。`room.snapshot().members[].messages` 永远是 0，
所以网页成员栏想显示「发言数」（C4 工作单里列的）**现在显示不出来**。

---

## 四、顺带验证了没问题的部分

| 行为 | 结果 |
|---|---|
| `NOT_YOUR_TURN` 拒绝 | ✅ 在别人轮次发言被拒，错误信息带 `hint` |
| `DUPLICATE_MESSAGE` 拒绝 | ✅ 同一句重复发被拒 |
| hop 预算耗尽自动暂停 | ✅ `maxHops=2` 发满后 `phase=paused` |
| 暂停后 agent 发言被拒 | ✅ `ROOM_PAUSED` |
| 人类随时插话 | ✅ 不消耗 hop、不打断现有轮次 |
| 人类点名下一位 | ✅ `to=claude` 立即改轮次 |
| 点名不存在成员 | ✅ `MEMBER_NOT_FOUND`（chat-duel 已覆盖） |
| 长轮询真挂起/真唤醒 | ✅ 26 秒超时、发消息立即唤醒 |
| 落盘（P3.5） | ✅ 消息、hop、phase 都在 `server/data/chat/*.json` |
| 关闭房间 | ✅ `wait` 带回 `closed` + hint |

### 4.4 一个设计层面的观察（不是 bug）

agent 是**靠「调用 wait 时挂住」才可达的**。一旦它决定不再调工具
（claude 发满 6 条就收工退出），轮次就卡在它身上，只能等 `turnTimeoutMs`（默认 120s）
超时跳过，连续两次超时才暂停房间。

claude 自己在对话里给出了修法建议：**给 `send_message` 加显式 `pass`/`yield`**，
或者 runner 在 agent 本轮结束时主动交还轮次，超时降到 10s 只做兜底。

这对应 ROADMAP 里 P4-C3（runner），但**pass 机制可以独立于 runner 先做**。

---

## 五、下一步建议

**C4（网页聊天页）之前，先修 §3 的两个缺陷。** 理由：

1. C4 的成员栏要显示发言数，而计数是坏的（3.3 是 3.1 的直接后果）
2. 网页如果用 `wait` 做长轮询，会踩同一个丢消息的坑（3.2）
3. 两个都是服务端小改动，比在 UI 层做规避便宜

工作单见 [`handoff.md`](handoff.md)。

修完之后 C4 再上，那时成员栏和长轮询都是可信的。

---

## 六、复现方式

观察脚本在临时目录（未提交，按 AGENTS §6.3）：

```text
E:\data\tmp\arena-chat-observe\
├── chat.mjs              # 单次 MCP 调用，状态存 .state-<name>.json
├── launch-claude.mjs     # 起一个真实的 claude 进程当成员
├── chat-mcp.json         # --mcp-config 用
└── run\claude-*.log      # stream-json 完整日志（含 thinking）
```

```powershell
# 复现 3.1（上限失效）
POST /api/chat/rooms { roomId, policy: { maxMessagesPerMember: 2, maxHops: 50 } }
node chat.mjs join <room> a1 ; node chat.mjs join <room> a2
# a1/a2 交替发，a1 发到第 3 条仍然成功
```

```powershell
# 复现 3.2（静默丢消息）
# 建 maxHops=100 的房间，两个 agent join
# 人类连发 20 条，然后把某 agent 的游标重置为 0
node chat.mjs wait <room> <agent> 5000
# 只返回 12 条，前面的静默消失
```
