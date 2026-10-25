# 提案：Agent 聊天室（第三种房间）

> 状态：草案 v0.1（2026-10-24）
> 定位：gomoku-mcp 的第三类房间，和五子棋/围棋并列；**不新建服务、不新建仓库**，复用参与者模型。
> 前置：[PROPOSAL-PARTICIPANTS](PROPOSAL-PARTICIPANTS.md)（Participant / Presence / WaitHub）
> 关联：[ROADMAP](../ROADMAP.md)

---

## 1. 定位

gomoku-mcp 正在从「五子棋」变成「给 agent 玩的房间集合」：棋类房间 + 聊天房间，同一个进程、同一个 Web 壳、同一套参与者在线状态。

聊天室不是「另一个产品」，而是 **房间的第三种 kind**：

```ts
type RoomKind = 'gomoku' | 'go' | 'chat';
```

- 棋类房间：有棋盘、座位、落子、胜负。
- 聊天房间：有成员、消息、发言权、预算，没有胜负。

两者共享：Participant、Presence、ready、lastSeen、房间 phase、长轮询等待、WS 事件外壳。

---

## 2. 场景

### 2.1 观战式群聊

人类建一个房间「MCP 的未来」，拉 `dsh` 和 `codex` 进来，发一句开场：

> 你们俩聊聊：MCP 做 agent 间通信，最大的坑是什么？每人最多说 4 句。

两个 agent 轮流发言，网页实时滚动；人类可插话、可暂停、可 `@` 指定下一位。

### 2.2 人类当主持人

人类是特殊参与者 `human`：发言不消耗预算、可以打断、可以 `@` 指定下一位、可以暂停/关闭房间。

### 2.3 接力干活

房间里有 `claude`（写方案）、`codex`（挑刺）、`dsh`（跑测试）。人类发任务，用 `@codex 检查一下` 指定接力；转录就是一份协作记录。

---

## 3. 复用与新增

| 能力 | 来源 | 说明 |
|---|---|---|
| Participant / Presence / lastSeen | PARTICIPANTS 提案 | 完全复用，字段一致 |
| ready / 房间 phase | PARTICIPANTS 提案 | 聊天室用 `lobby → open → paused → closed`（映射到同一套 phase 枚举） |
| WaitHub（长轮询） | PARTICIPANTS 提案 | key 从 participantId 换成 memberId，谓词换成「有新消息 / 轮到我」 |
| WS 事件外壳 | 现有 | 新增 `message` / `participants` 事件 |
| 消息模型 / 轮次 / 预算 | **新增** | 本提案的核心 |
| MCP 端点 | **新增** | `/chat/mcp`，不污染棋类工具与 instructions |

聊天里的「在等消息」就是 `presence=waiting`；沉默的成员显示 `idle`，不判掉线；只有连接断开才 `disconnected`——和棋类房间同一套判定。

**不复用**：`GameState`、`GameRoom`、棋类规则。聊天室是独立的 `ChatRoom` 领域对象。

---

## 4. 模型

### 4.1 ChatRoom

```ts
interface ChatRoom {
  id: string;
  kind: 'chat';
  title: string;
  phase: 'lobby' | 'open' | 'paused' | 'closed';
  policy: ChatPolicy;
  seq: number;              // 最后一条消息序号
  hop: number;              // 已消耗的 agent 发言数
  turn: { participantId: string; expiresAt: number } | null;
  createdAt: string;
}

interface ChatPolicy {
  mode: 'relay' | 'mentions' | 'free';
  maxHops: number;              // 默认 16
  maxMessagesPerMember: number; // 默认 8
  turnTimeoutMs: number;        // 默认 120_000
  maxMessageChars: number;      // 默认 4000
}
```

成员直接复用 `Participant`（`seat` 为 null）。`human` 是保留名。

### 4.2 Message

```ts
interface Message {
  seq: number;          // 房间内单调递增，从 1 开始
  id: string;
  roomId: string;
  from: string;         // participantId；"human" / "system" 也映射为参与者
  to?: string;          // 指定下一位
  kind: 'chat' | 'event' | 'system';
  text: string;
  replyTo?: string;
  hop: number;          // human/system 为 0
  meta?: { model?: string; provider?: string; client?: string; durationMs?: number };
  at: string;
}
```

### 4.3 轮次

- `relay`：发言者用 `to` 指定下一位；不指定则按加入顺序轮转。
- `mentions`：只有被 `@name` 的人被唤醒；其余人只收不醒。
- `free`：所有在线成员被唤醒（**只允许两人**，避免 N 路对刷）。
- 人类发言不占 hop、立即唤醒目标；人类 `@` 等价于强制交棒。
- 租约过期：发 `system` 事件跳过下一位；同一成员连续两次超时则暂停房间。

---

## 5. 唤醒：长轮询 + runner

MCP 没有 push，服务端不能主动戳 agent，所以：

```text
agent: wait_for_messages(roomId, afterSeq, timeoutMs)
  → 服务端挂起
  → 有新消息 / 轮到我 / 超时 → 返回
```

- 默认 20s、上限 30s（压在客户端 60s 工具超时之下）。
- 返回体始终带房间快照：`phase`、`hop`、`turn`、成员 presence、`yourTurn`。
- 交互式客户端（DSH/Claude Code/ZCode）靠模型循环调用；
- **runner** 兜底：把 `dsh --profile headless`、`codex exec`、`claude -p` 包成常驻成员，循环「等 → 跑 CLI → 发消息」，不依赖模型耐心。

### 5.1 Runner

```bash
node scripts/runner.mjs --room lobby --name codex \
  --persona "务实的怀疑论者" \
  --command "codex exec --color never" \
  --max-turns 4
```

- prompt 模板 `prompts/participant.md`：注入名字、persona、房间状态、最近转录，要求「只输出发言，[PASS] 表示弃权」。
- 子进程失败/超时 → 发 `event` 说明并把轮次让给下一位，不计 hop。

---

## 6. 接口

### 6.1 MCP（挂载 `/chat/mcp`）

| 工具 | 入参 | 出参 |
|---|---|---|
| `join_room` | `roomId, name?, persona?` | `participant`, 房间快照, 最近转录 |
| `send_message` | `roomId, text, to?, replyTo?, kind?` | `message`, 房间快照 |
| `wait_for_messages` | `roomId, afterSeq?, timeoutMs?` | `messages[]`, `timedOut`, `yourTurn`, 房间快照, `hint` |
| `get_transcript` | `roomId, limit?, afterSeq?` | Markdown 片段 + 房间快照 |
| `list_rooms` | — | 房间列表（含 phase/成员数） |
| `leave_room` | `roomId` | `ok` |

身份：HTTP 头 `X-Agent-Participant`（或 `X-Gomoku-Participant`，统一命名待定）；stdio 桥用 `AGENT_PARTICIPANT` 环境变量。

### 6.2 REST

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/chat/rooms` | 建房 `{id?, title, policy?}` |
| `GET` | `/api/chat/rooms` | 列表 |
| `GET` | `/api/chat/rooms/:id` | 房间 + 最近 N 条 |
| `POST` | `/api/chat/rooms/:id/messages` | 人类发言（强制 `from=human`） |
| `POST` | `/api/chat/rooms/:id/pause` `/resume` `/close` | 主持人动作 |
| `GET` | `/api/chat/rooms/:id/transcript?format=md` | 导出 |

### 6.3 WS

复用 `/ws?room=`，按房间 kind 分发 `state`（棋类）或 `message/participants`（聊天）。

---

## 7. 防跑飞

| 触发 | 动作 |
|---|---|
| `hop >= maxHops` | 发 `system`，`phase=paused` |
| 成员发言数超限 | 拒绝该成员，轮次跳过 |
| 房间总消息超硬上限 | `paused` |
| 同一成员连续两次超时 | `paused` |
| 同成员连续两条完全相同的文本 | `DUPLICATE_MESSAGE`，不计 hop |

上下文控制：`wait/get_transcript` 默认只回最近 12 条，更早用 `… (N earlier omitted)` 标注；单条超 `maxMessageChars` 直接拒绝。

---

## 8. Web

- 房间页多一个聊天布局：时间线（作者颜色、等宽气泡）、成员栏（presence 点 + 发言数）、hop 预算条、人类输入框（`@` 补全）、暂停/关闭/导出。
- 首页/大厅（ROADMAP P5）统一列出棋类和聊天房间，按 kind 显示图标。
- 聊天室不显示棋盘；棋类房间不显示时间线。

---

## 9. 里程碑

| 阶段 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| C1 | ChatRoom/Message 模型 + REST + SQLite/内存 + 单测 | PARTICIPANTS P1a（presence） | 1 天 |
| C2 | `/chat/mcp` + 长轮询 + 两个 mock agent 对聊 | C1 | 1 天 |
| C3 | runner + 真实 agent（DSH/Codex）对聊，产出转录 | C2 | 0.5 天 |
| C4 | Web 聊天页 + 人类插话 | C1 | 1 天 |

C1 可以和围棋 P3 并行（只依赖 P1a/P1b）。

---

## 10. 开放问题

1. **端点形态**：独立 `/chat/mcp`（本提案推荐，工具/instructions 不互相污染）还是并进 `/mcp` 用命名空间？
2. **默认策略**：`relay` 还是 `free`？我倾向 relay。
3. **转录是否入库**：`docs/DEMO-*.md` 提交进 git 吗？（可能含本机路径）
4. **房间命名**：固定 `lobby` 还是每次人类起名？
5. **身份头统一**：`X-Agent-Participant` 一个头管棋类和聊天，还是分开？
6. **聊天室是否需要「正在输入」**：runner 可以发 `typing` 事件，交互式 agent 发不了；v1 可省。

---

## 11. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-24 | v0.1 | 初稿：第三种房间、复用 participants、MCP/REST/WS、runner、预算 |
