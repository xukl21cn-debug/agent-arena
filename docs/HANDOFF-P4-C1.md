# 工作单：P4-C1 · 聊天室模型 + REST + /chat/mcp

> 面向：GLM
> 状态：P3 围棋 + P3.5 持久化已完成（258 测试全绿）
> 分支：从最新 main 新建 `feat/chat`
> 预计：1.5–2 天
> 规范来源：`docs/proposals/PROPOSAL-AGENT-CHAT.md`

---

## 0. 已拍板的决策（用户确认）

| 问题 | 决定 |
|---|---|
| MCP 端点 | **独立 `/chat/mcp`**，与棋类 `/mcp` 完全分离 |
| 默认策略 | **`relay` 接力** |
| 范围 | **只做 C1 + C2**（模型 / REST / MCP / 长轮询），网页 UI 留给 C4 |
| presence | **不复用** `PresenceRegistry`（原因见 §3） |

---

## 1. 这次做什么

```text
✅ 做：ChatRoom / Message 模型（纯领域对象）
✅ 做：REST /api/chat/rooms/*
✅ 做：/chat/mcp 端点 + 4 个工具
✅ 做：长轮询 wait_for_messages
✅ 做：持久化（复用 P3.5 的落盘思路）
✅ 做：单测 + 两个 mock agent 对聊的端到端脚本
❌ 不做：网页聊天 UI（C4）
❌ 不做：runner（C3）
❌ 不做：WS 推送（先用长轮询，见 §7）
❌ 不做：改现有棋类任何代码
```

---

## 2. 硬约束

### 2.1 不要动棋类代码

```text
❌ 不改 server/src/rooms/room.ts
❌ 不改 server/src/rooms/room-manager.ts
❌ 不改 server/src/mcp/tools.ts
❌ 不改 server/src/core/presence.ts
❌ 不改 shared/src/game.ts
```

聊天室是**独立的领域对象**，提案 §3 原文：

> **不复用**：`GameState`、`GameRoom`、棋类规则。聊天室是独立的 `ChatRoom` 领域对象。

`git diff --stat` 应该只有新增文件 + `app.ts`（挂载路由）+ `index.ts`（初始化）。

### 2.2 为什么 presence 不复用

`PresenceRegistry` 的接口**全部按 seat 索引**：

```ts
attachSession(roomId: string, seat: StoneColor, sessionId: string, ...)
beginWait(roomId: string, seat: StoneColor)
snapshot({ seats: Record<StoneColor, PlayerSpec>, ... })
```

而聊天室成员**没有座位**。硬复用要么伪造 `seat`（`'black'` 当第一个人？），
要么大改 `PresenceRegistry`（违反 §2.1）。

**决定**：聊天室自己管在线状态，一个简单的 `Map<participantId, lastSeenAt>` 就够。

P1b 的硬性约束「presence 信号键按座位」是棋类的基础，不要去动它。

---

## 3. 数据模型

提案 §4。简化版（去掉 C3 才需要的字段）：

```ts
// server/src/chat/model.ts

export type ChatPhase = 'open' | 'paused' | 'closed';
export type ChatMode = 'relay' | 'mentions' | 'free';

export interface ChatPolicy {
  mode: ChatMode;
  maxHops: number;              // 默认 16
  maxMessagesPerMember: number; // 默认 8
  turnTimeoutMs: number;        // 默认 120_000
  maxMessageChars: number;      // 默认 4000
}

export interface ChatMember {
  id: string;          // participantId
  name: string;
  kind: 'human' | 'agent';
  joinedAt: string;
  /** 已发言数，用于 maxMessagesPerMember */
  messages: number;
  /** 在线证据：最后一次调工具的时间戳（毫秒） */
  lastSeenAt: number;
  client?: string;
}

export interface ChatMessage {
  seq: number;          // 房间内单调递增，从 1 开始
  id: string;
  roomId: string;
  from: string;         // participantId
  fromName: string;     // 冗余，方便渲染不用查名册
  to?: string;          // 指定下一位
  kind: 'chat' | 'event' | 'system';
  text: string;
  replyTo?: string;
  hop: number;          // human/system 为 0
  at: string;
}

export interface ChatRoomSnapshot {
  id: string;
  title: string;
  phase: ChatPhase;
  policy: ChatPolicy;
  seq: number;
  hop: number;
  turn: { participantId: string; name: string; expiresAt: number } | null;
  members: ChatMember[];
  createdAt: string;
}
```

### 3.1 为什么 `fromName` 冗余存

渲染转录时不用回查名册（成员可能已离开）。提案 §4.2 没有这个字段，
但实测下来会很有用——**建议加**，如果觉得多余可以去掉。

### 3.2 `ChatPhase` 和棋类的 `RoomPhase` 不同

棋类是 `lobby | waiting | playing | paused | finished`，
聊天是 `open | paused | closed`。

**不要**硬塞进同一个枚举。聊天室没有「开局」「轮次」的概念。

---

## 4. 轮次逻辑（relay）

这是核心，也是容易写错的地方。

### 4.1 谁该发言

```text
1. 房间有 turn 且未过期 → 就是那个人
2. turn 为空 → 按成员加入顺序，找下一位
3. human 发言不占 turn，发完立即把 turn 给 to（或按顺序下一位）
```

### 4.2 human 是特殊成员

提案 §2.2：

> 人类是特殊参与者 `human`：发言不消耗预算、可以打断、可以 `@` 指定下一位、可以暂停/关闭房间。

```ts
// human 发言
hop 不变
maxMessagesPerMember 不检查
turn 立即交给 to（或下一位）
```

### 4.3 turn 过期

```text
turn 过期 → 发一条 system 消息「X 超时，跳过」
         → turn 交给下一位
         → 同一成员连续两次超时 → phase = 'paused'
```

「连续两次」需要一个计数：

```ts
consecutiveTimeouts: Map<participantId, number>
```

成功发言后清零。

### 4.4 hop 预算

```text
agent 每发言一次 hop += 1
hop >= maxHops → 发 system 消息 → phase = 'paused'
human 发言不加 hop
```

---

## 5. MCP 工具（`/chat/mcp`）

提案 §6.1。**4 个工具**（`list_rooms` 可以后加）：

| 工具 | 入参 | 出参 |
|---|---|---|
| `join_room` | `roomId, name?` | `participantId`, 房间快照, 最近转录 |
| `send_message` | `roomId, text, to?, replyTo?` | `message`, 房间快照 |
| `wait_for_messages` | `roomId, afterSeq?, timeoutMs?` | `messages[]`, `timedOut`, `yourTurn`, 快照 |
| `get_transcript` | `roomId, limit?, afterSeq?` | 转录文本 + 快照 |

### 5.1 身份绑定

**复用现有的 `sessionContext` + `SessionBindings`**（`server/src/core/session-context.ts`）。

这两个是通用的（sessionId → participantId），不依赖座位：

```ts
bindings.bind(sessionId, roomId, participantId)
bindings.participantOf(sessionId, roomId)
```

**可以直接复用**，不需要改。

### 5.2 `wait_for_messages` 的返回

```ts
{
  messages: ChatMessage[],   // afterSeq 之后的新消息
  timedOut: boolean,
  yourTurn: boolean,         // 是否轮到你
  room: ChatRoomSnapshot,
  hint: string               // 「轮到你了」「等 X 发言」等
}
```

**`hint` 很重要**：agent 需要知道「现在该干什么」。P2 的教训是错误信息要可操作。

示例：

```text
yourTurn=true  → "轮到你了，用 send_message 发言"
yourTurn=false → "等 dsh 发言，继续 wait_for_messages"
phase=paused   → "房间已暂停，等主持人恢复"
phase=closed   → "房间已关闭"
```

### 5.3 长轮询

```text
默认 20s，上限 30s（压在客户端 60s 工具超时之下）
```

实现方式：跟 `room.waitForSeat` 一样的模式——存一个 `Set<Waiter>`，
新消息/轮次变化时 `resolve`。

**不要**做成轮询循环，要真的挂起。

---

## 6. REST

提案 §6.2：

```text
POST /api/chat/rooms                     { roomId?, title, policy? }
GET  /api/chat/rooms                     列表
GET  /api/chat/rooms/:id                 房间 + 最近 N 条
POST /api/chat/rooms/:id/messages        { text, to? }   ← 强制 from=human
POST /api/chat/rooms/:id/pause
POST /api/chat/rooms/:id/resume
POST /api/chat/rooms/:id/close
GET  /api/chat/rooms/:id/transcript?format=md
```

### 6.1 房间 id 校验

复用 `assertRoomId`（`server/src/rooms/room-manager.ts` 里）。

⚠️ **但不要改那个文件**——可以把校验函数复制到 chat 模块，
或者如果它已经导出就直接 import（import 不算改）。

---

## 7. 不做 WS，先用长轮询

提案 §6.3 说复用 `/ws`。但现有 `ws.ts` 绑死 `GameRoom`：

```ts
const room = manager.get(roomId);   // GameRoom
room.onState(...)
room.onPhase(...)
room.onCommentary(...)
```

要支持聊天室得改 `RoomManager` 和 `ws.ts`，**违反 §2.1**。

**决定**：C1/C2 不做 WS。网页（C4）用轮询或长轮询即可。

WS 统一留给 **P5 大厅**——那时候本来就要把两类房间统一入口。

---

## 8. 持久化

复用 P3.5 的思路，但**不要复用 `RoomRepository`**（它是给 `PersistedRoom` 用的）。

新建：

```text
<dataDir>/chat/<roomId>.json
```

内容：

```json
{
  "id": "lobby",
  "title": "...",
  "phase": "open",
  "policy": { ... },
  "seq": 12,
  "hop": 5,
  "createdAt": "...",
  "members": [ ... ],
  "messages": [ ... ]
}
```

⚠️ **消息会无限增长**。要加限制：

```ts
// 只保留最近 N 条（比如 500）
// 或者按提案 §7「房间总消息超硬上限 → paused」
```

**建议**：落盘保留全部，但 `get_transcript` 默认只返回最近 12 条（提案 §7）。
内存里也全留（聊天室消息量不大）。

原子写：跟 P3.5 一样 `.tmp → rename`。

---

## 9. 防跑飞

提案 §7：

| 触发 | 动作 |
|---|---|
| `hop >= maxHops` | `system` 消息 + `phase=paused` |
| 成员发言数超限 | 拒绝，轮次跳过 |
| 同一成员连续两次超时 | `paused` |
| 同成员连续两条完全相同的文本 | `DUPLICATE_MESSAGE`，不计 hop |
| 单条超 `maxMessageChars` | 拒绝 |

**错误码新增**：

```ts
'MESSAGE_TOO_LONG'
'DUPLICATE_MESSAGE'
'MEMBER_LIMIT_REACHED'
'NOT_YOUR_TURN'
'ROOM_CLOSED'
'ROOM_PAUSED'
```

---

## 10. 测试

### 10.1 必须保持绿

```text
[ ] 258 个现有测试一个都不能挂
```

### 10.2 必须新增

| 编号 | 内容 |
|---|---|
| C1 | 建房 / 加入 / 快照正确 |
| C2 | relay 轮转：human 发言后 turn 交给指定人 |
| C3 | relay 轮转：不指定 to 时按加入顺序 |
| C4 | `wait_for_messages` 挂起，新消息到达时唤醒 |
| C5 | `wait_for_messages` 超时返回 `timedOut: true` |
| C6 | `yourTurn` 在轮到自己时为 true |
| C7 | hop 预算耗尽 → `paused` |
| C8 | 成员发言数超限 → 拒绝 |
| C9 | 重复消息 → `DUPLICATE_MESSAGE` |
| C10 | 超长消息 → `MESSAGE_TOO_LONG` |
| C11 | 暂停/恢复/关闭 |
| C12 | 转录格式正确（含省略标注） |
| C13 | 持久化：重启后房间和消息还在 |
| C14 | **两个 agent 对聊端到端**（mock agent 脚本） |

**C14 是关键**：写一个 `scripts/chat-duel.mjs`，两个 MCP 客户端
通过 `/chat/mcp` 真的聊几轮，验证长轮询、轮次、转录。

---

## 11. 完成标准

```text
[ ] ChatRoom / Message 模型
[ ] REST 7 个端点
[ ] /chat/mcp + 4 个工具
[ ] 长轮询真的挂起（不是轮询循环）
[ ] relay 轮次逻辑正确
[ ] hop 预算 + 防跑飞
[ ] 持久化 + 重启恢复
[ ] scripts/chat-duel.mjs 两个 agent 对聊通过
[ ] pnpm test 全绿（258 + 新增）
[ ] pnpm typecheck + build 通过
[ ] git diff --stat 不含棋类核心文件
```

### 自查

```powershell
cd E:\code\fun\agent-arena
pnpm test
pnpm typecheck
git diff --stat   # 不该出现 rooms/room.ts、core/presence.ts、mcp/tools.ts
```

---

## 12. 提交

```text
feat(chat): a chat room beside the games, on its own MCP endpoint

Chat is a third kind of room, not a third product: members, messages, a turn
policy and a hop budget, with no board and no result.

It gets /chat/mcp rather than sharing /mcp so neither instruction set has to
explain the other, and so an agent that only plays games never sees chat tools.

Presence is not reused. PresenceRegistry indexes everything by seat, and chat
members have no seat; faking one would either corrupt the games' presence or
force a rewrite of the model P1b depends on. Chat keeps its own lastSeenAt.

Wake-up is a parked long-poll, same shape as wait_for_seat: MCP has no push, so
an agent that is not waiting is simply not reachable.
```

---

## 13. 做完之后

C1+C2 完成后：

```text
C3  runner（把 CLI 包成常驻成员）
C4  网页聊天页
P5  大厅（统一入口 + WS + 棋谱回放）
```

**建议 C1/C2 合入后先手动试一次两个 agent 对聊**，确认模型行为正常，再做网页。
