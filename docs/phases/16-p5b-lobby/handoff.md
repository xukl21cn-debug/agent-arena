# 工作单 P5B：大厅（三类房间 + 历史对局入口）

> 面向：GLM
> 状态：`main` 干净，302 测试全绿（`c9ec38c`）
> 分支：从最新 main 新建 `feat/lobby`
> 预计：1–1.5 天
> 前置：[`p5-lobby-replay.md`](../../architecture/p5-lobby-replay.md) §3
>
> ⚠️ **依赖 P5A 的 `GET /api/archive`**（历史对局列表）。
> **可以并行开工**，但「历史对局」那一块要等 P5A 合入后再接。
> 先做三类房间的大厅，不阻塞。

---

## 0. 边界

**做**：

- 首页改成大厅：三类房间（五子棋 / 围棋 / 聊天）统一卡片列表
- **历史对局入口**（读 P5A 的 `GET /api/archive`）
- 修复聊天室 `updatedAt` 是假时间的问题（见 §2，**必须先修**）
- 路由改动（见 §3）

**不做**：

| 不做 | 原因 |
|---|---|
| ❌ 回放页本身 | 那是 P5A，大厅只链接过去 |
| ❌ 归档逻辑 | 那是 P5A |
| ❌ 合并两个列表端点 | 领域对象不同，合并出的类型谁都不满意 |
| ❌ 在大厅里建房 | 现有建房入口已经够用 |
| ❌ 大厅实时推送（WS） | 轮询即可，大厅不需要实时 |
| ❌ 聊天室显示「在线」 | 聊天室没有 presence，AGENTS §4.2 |

---

## 1. 数据来源：并行请求两个端点

**不合并端点。** 前端并行请求，在渲染层合并：

```ts
const [games, chats] = await Promise.all([
  fetch('/api/rooms').then(r => r.json()),        // RoomSummary[]
  fetch('/api/chat/rooms').then(r => r.json()),   // ChatRoomSummary[]
]);
```

理由（`p5-lobby-replay.md` §3.1）：两个领域对象不同，合并会让 `shared`
出现「union of two summaries」这种谁都不满意的类型。

### 现有形状（已实测确认）

**`GET /api/rooms` → `RoomSummary[]`**：

```jsonc
{
  "roomId": "default",
  "game": "gomoku",              // "gomoku" | "go"
  "status": "idle",
  "phase": "lobby",
  "gameId": "",
  "moveCount": 0,
  "version": 0,
  "updatedAt": "2026-10-26T14:44:33.903Z",   // ← 真实时间
  "participants": [
    { "seat": "black", "kind": "human", "label": "你",
      "presence": "unknown", "lastSeenAt": null,
      "waiting": false, "isTurn": false }
  ]
}
```

**`GET /api/chat/rooms` → `ChatRoomSummary[]`**：

```jsonc
{
  "id": "lobby",
  "title": "MCP 的未来",
  "phase": "open",
  "memberCount": 3,
  "agentCount": 2,
  "messageCount": 11,
  "hop": 5,
  "maxHops": 16,
  "updatedAt": "..."             // ← ⚠️ 假的，见 §2
}
```

⚠️ **注意字段名不一致**：棋类是 `roomId`，聊天是 `id`。**渲染层要归一化**，
不要让这个差异漏到组件 props 里。

---

## 2. ⚠️ 必须先修：聊天室的 `updatedAt` 是假时间

**这是本工作单的前置修复，不修的话大厅的「最后活动」和排序全是错的。**

`server/src/chat/manager.ts:122`：

```ts
updatedAt: new Date().toISOString(),   // ← 每次请求都返回「现在」
```

对照棋类（`server/src/rooms/room.ts` 的 `getSummary()`）：
`updatedAt: this.state.updatedAt`——真实的对局更新时间。

**修法**：让 `ChatRoomSummary.updatedAt` 返回**真实最后活动时间**。

`ChatRoom` 里没有 `updatedAt` 字段，但有可用的数据：

- `messages[messages.length - 1]?.at` —— 最后一条消息的时间
- 成员 `lastSeenAt` —— 最后活动（epoch ms）
- `createdAt` —— 兜底

**建议**：取「最后一条消息时间」和「`createdAt`」的较大者。

```ts
// 建议形状（ChatRoom 上加一个方法，不要散在 manager 里）
/** Last activity: the newest message, else creation. */
lastActivityAt(): string {
  const last = this.messages[this.messages.length - 1];
  return last?.at ?? this.createdAt;
}
```

⚠️ **不要**改成 `new Date(0)` 或空字符串糊弄——大厅要按它排序。
⚠️ **不要**把 `lastSeenAt` 混进来：那是「谁看过」，不是「房间有什么变化」。
大厅显示的是房间活跃度。

**必须加测试**：建一个房间 → 记下 `updatedAt` → 等 1 秒 → 再查列表 →
`updatedAt` **没有变**（因为没有新消息）；发一条消息 → 再查 → `updatedAt` 变了。

---

## 3. 路由

```text
/                          → 大厅（新首页）
/?room=<id>                → 棋类（不变）
/?room=<id>&kind=chat      → 聊天（不变）
/?room=<id>&view=replay    → 当前局回放（P5A）
/?archive=<archiveId>      → 归档局回放（P5A）
```

⚠️ **`/` 从「默认棋类房间」变成「大厅」是唯一的破坏性变更**。

**但 `?room=` 路径完全不变**，旧书签照常工作。

替代方案（`/lobby` 新路径、`/` 保持默认房间）**不选**——大厅就是首页才合理。

### 现有路由代码

`web/src/App.tsx` 现在是：

```tsx
function roomIdFromLocation(): string {
  const candidate = new URLSearchParams(window.location.search).get('room');
  return candidate && ROOM_ID_PATTERN.test(candidate) ? candidate : DEFAULT_ROOM_ID;
}
```

**改法**：如果 URL 里**没有 `room` 参数**，渲染大厅；有的话走现有逻辑。

⚠️ **`?room=` 缺失才进大厅，不是 `room` 非法值也进大厅**。
非法 roomId 仍应回落到 `DEFAULT_ROOM_ID`（保持现有行为）。

⚠️ **`?archive=` 也要分流**：有 `archive` 参数时渲染归档回放页（P5A 的组件）。

---

## 4. 大厅 UI

### 4.1 卡片内容

| 字段 | 棋类来源 | 聊天来源 |
|---|---|---|
| 类型标签 | `game` → 「五子棋」/「围棋」 | 固定「聊天」 |
| 标题 | `roomId` | `title`（空则 `id`） |
| 状态 | `phase` + `status` | `phase` |
| 参与者 | `participants[].label` | `members` 只给了数量，显示「3 人」 |
| 最后活动 | `updatedAt` | `updatedAt`（**修好后**） |
| 规模 | `moveCount` 手 | `messageCount` 条 |
| 入口 | `?room=<roomId>` | `?room=<id>&kind=chat` |

### 4.2 分组与排序

**按类型分组**（三个 section），每组内**按 `updatedAt` 降序**（最近的在前）。

⚠️ 不要混在一起排——五子棋和聊天混排会让大厅很难扫。

### 4.3 空状态

- 某类没有房间 → 显示「暂无房间」+ 一句怎么开房的提示
- 全部为空 → 仍然显示三个分组，不要显示一个空白页

### 4.4 ⚠️ 不要显示「在线」

**聊天室没有 presence**（AGENTS §4.2）。`ChatRoomSummary` 里也没有 presence 字段。

棋类有 `participants[].presence`，可以显示「思考中 / 等待中 / 未连接」。
**但聊天室不能显示任何在线状态**——显示就是编造。

### 4.5 历史对局（读 P5A 的 `/api/archive`）

大厅除了三类房间，还有**历史对局**入口：

```http
GET /api/archive    →  ArchiveEntry[]
```

字段见 [`handoff.md`](../15-p5a-replay/handoff.md) §3.1。每张卡片显示：

| 字段 | 内容 |
|---|---|
| 棋种 | `game` → 「五子棋」/「围棋」 |
| 房间 | `roomId` |
| 手数 | `moveCount` |
| 胜负 | `winner` + `endReason` |
| 时间 | `playedAt` |
| 入口 | `?archive=<archiveId>` |

排序：`playedAt` 降序（P5A 已排好）。

⚠️ **默认只显示最近 20 条**，多了给「查看更多」。
历史对局可能很多（每房间 N 局 × 房间数），**不要一次全渲染**。

⚠️ **P5A 没合入时**：`/api/archive` 会 404。
前端要**优雅降级**——这一块显示「暂无历史对局」，不要让整个大厅报错。

---

## 5. 硬约束

| 约束 | 原因 |
|---|---|
| **`?room=` 行为不变** | 旧书签、旧客户端 |
| **不合并列表端点** | 领域对象不同 |
| **不改 `RoomSummary` / `ChatRoomSummary` 的现有字段** | 只增不改 |
| **`updatedAt` 修好才能用** | 否则排序是错的 |
| **聊天室不显示在线状态** | 没有 presence |
| **不改 `rooms/` / `core/presence.ts` / `mcp/tools.ts`** | 硬约束 |
| **不动聊天 WS / 归档逻辑** | 那是别的阶段 |
| **`/api/archive` 404 要优雅降级** | P5A 可能还没合入 |

---

## 6. 易错点

| 坑 | 说明 |
|---|---|
| **直接用假 `updatedAt` 排序** | 会变成「按请求顺序」，每次刷新都不一样 |
| **`roomId` vs `id` 混用** | 棋类是 `roomId`，聊天是 `id`。归一化后再传 props |
| **非法 `room` 参数也进大厅** | 应该回落到 `DEFAULT_ROOM_ID`，保持现有行为 |
| **把 `lastSeenAt` 当房间活跃度** | 那是「谁看过」，不是「房间变了」 |
| **聊天室显示「在线」** | 没有 presence，是编造 |
| **`phase` 和 `status` 混为一谈** | 棋类两个都有：`phase` 是房间生命周期，`status` 是对局状态 |
| **大厅轮询太频繁** | 5–10 秒一次够用，别 1 秒一次 |

---

## 7. 测试清单

**服务端**：

| # | 测试 | 断言 |
|---|---|---|
| L1 | `updatedAt` 不随时间漂移 | 建房 → 查列表 → 等 1s → 再查，`updatedAt` 相同 |
| L2 | `updatedAt` 随新消息更新 | 发消息后 `updatedAt` 变了 |
| L3 | 空房间的 `updatedAt` = `createdAt` | 兜底正确 |
| L4 | 棋类 `updatedAt` 不受影响 | 回归，仍来自 `state.updatedAt` |

**前端**：

| # | 测试 | 断言 |
|---|---|---|
| L5 | `/` 渲染大厅 | 三个分组都在 |
| L6 | `/?room=default` 仍渲染棋盘 | 旧行为不变 |
| L7 | `/?room=<chat>&kind=chat` 仍渲染聊天 | 旧行为不变 |
| L8 | 非法 `?room=!!!` 回落默认房间 | 不进大厅 |
| L9 | 卡片按 `updatedAt` 降序 | 最近的在前 |
| L10 | 聊天室卡片无在线状态 | 没有「在线/离线」字样 |
| L11 | 点卡片跳到对应房间 | URL 正确 |
| L12 | **历史对局按 `playedAt` 降序** | 最近的在前 |
| L13 | **点历史对局跳 `?archive=`** | URL 正确 |
| L14 | **`/api/archive` 404 时优雅降级** | 大厅其余部分正常渲染 |
| L15 | 历史对局只渲染最近 20 条 | 超出的给「查看更多」 |

---

## 8. 验收标准

- [ ] `pnpm typecheck` 干净
- [ ] `pnpm test` 全绿（当前 302，新增后 >312）
- [ ] L1/L2 是核心：`updatedAt` 真的修好了
- [ ] L6/L7 回归：旧路由行为完全不变
- [ ] L14：P5A 没合入时大厅不能整个崩掉
- [ ] `node scripts/chat-duel.mjs` 仍全绿
- [ ] 手工验收：`/` 是大厅，点卡片能进三类房间，历史对局能进回放
- [ ] 提交信息用英文，正文说**为什么**

---

## 9. 做完就停

不要做回放页本身（P5A）、不要动聊天室 WS、不要改 `history` 语义、
不要写归档逻辑（P5A）。
