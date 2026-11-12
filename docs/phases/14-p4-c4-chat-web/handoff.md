# 工作单：P4-C4 网页聊天页

> 面向：GLM
> 状态：`main` 干净，292 测试全绿（`0e3425d`）
> 分支：从最新 main 新建 `feat/chat-ui`
> 预计：1–1.5 天
> 前置阅读：`AGENTS.md` §4.2（聊天室侧硬约束）、[观察报告](../13-p4-c25-chat-fix/observation.md)

---

## 0. 边界（做完就停）

**做**：

- 聊天房间的网页：时间线、成员栏、hop 预算条、人类输入框、暂停/恢复/关闭
- `/ws` 加一路**只读**的聊天广播
- 人类输入框的 `@` 成员名补全（选中后设 `to`）

**不做**（明确排除，做了返工）：

| 不做 | 原因 |
|---|---|
| ❌ SSE | 见 §1，复用现有 WS |
| ❌ `mentions` / `free` 模式 | v1 只实现 relay，见 §6 |
| ❌ 聊天室列表 / 大厅 | 那是 P5 |
| ❌ 棋谱回放 | 那是 P5 |
| ❌ 改 `rooms/` / `core/presence.ts` / `mcp/tools.ts` / `shared/` | AGENTS §4.2 硬约束 |
| ❌ WS 双向（客户端发消息） | 见 §1，动作一律走 REST |

---

## 1. 传输：复用 `/ws`，不要引入 SSE

**这一条是拍过板的，不要改。**

`web/src/store/room.ts:355` 已经在用 `ws://…/ws?roomId=…`，
`server/src/http/ws.ts` 是一个成熟的只读广播通道（`hello` / `state` /
`commentary` / `participants`，带 ping/pong 保活和 presence 扇出）。

**引入 SSE 会让仓库同时存在 WS（棋类）和 SSE（聊天）两套推送**，
维护两套心跳、两套重连、两套错误处理——那正是 P5「WS 统一」要消灭的东西。
所以 C4 直接把聊天挂进现有 `/ws`，**P5 的 WS 统一在这里提前做掉聊天室那部分**。

### 1.1 区分两类房间

`/ws` 现在只认 `roomId`。加一个可选 `kind`：

```text
ws://…/ws?roomId=<id>&kind=chat     ← 聊天室
ws://…/ws?roomId=<id>               ← 棋类（缺省，行为不变）
```

⚠️ **缺省必须仍是棋类**。旧客户端、旧书签、现有 `room.ts` 都不传 `kind`，
行为不能变。这是 AGENTS §7.4「兼容优先」的硬要求。

### 1.2 只读

**客户端不能通过 WS 发消息**，人类发言仍然：

```http
POST /api/chat/rooms/:roomId/messages
```

`ws.ts:26-28` 的注释写死了「Clients never mutate state over WS (actions go via REST)」，
聊天室必须遵守同一条。混两种模式会让这个文件变成两种协议。

---

## 2. 服务端要做的（最容易踩坑的地方）

### 2.1 ⚠️ `ChatRoom.onChange` 是单槽，已被落盘占用

这是本工作单**最大的坑**。

```ts
// server/src/chat/chat-room.ts:74
onChange: (() => void) | null = null;
```

而 `server/src/chat/manager.ts:88` 已经赋值了：

```ts
room.onChange = () => this.save(room);
```

**如果你在 `ws.ts` 里写 `room.onChange = broadcast`，落盘就没了**——
消息不再持久化，重启即失忆，而且**测试不会报错**（P3.5 的持久化测试不经过 ws）。

**做法**：把 `onChange` 从单槽改成订阅者列表，或者加一个并行的订阅方法。二选一：

- **方案 A（推荐）**：`onChange` 改成 `Set<() => void>` + `subscribe(fn): () => void`，
  `manager.ts` 改用 `subscribe`。改动集中，语义清晰。
- **方案 B**：保留 `onChange` 给落盘，另加 `onMessage` 事件给 ws。
  更小，但两个机制做同一件事，以后容易忘掉一个。

选 A 的话注意：**`onChange` 有两个赋值点，都要改**：

```text
server/src/chat/manager.ts:88   create() 里
server/src/chat/manager.ts:173  loadFile() 里（重启恢复）
```

漏掉第 173 行的话，**重启恢复的房间不会落盘**——这个更隐蔽，
因为新建的房间是好的，只有重启后才坏。

⚠️ **必须加一条测试**：订阅 ws 之后，消息仍然落盘。
这条测试就是防 §2.1 这个坑的，不能省。

### 2.2 事件形状

聊天 WS 事件（`kind=chat` 时）建议：

| 事件 | 载荷 | 何时发 |
|---|---|---|
| `hello` | `room` 快照 + 最近 N 条消息 | 连接时 |
| `message` | 单条新消息 | 有新消息 |
| `room` | 房间快照（phase / hop / turn / members） | 成员、轮次、phase 变化 |
| `error` | code + message | 房间不存在等 |

⚠️ `hello` 的载荷**不要复用棋类的 `state` 字段**——棋类的 `state` 是 `AnyGameState`，
聊天没有棋盘。加独立字段，别让类型打架。

### 2.3 类型放哪

`ServerMessage` 在 `shared/src/protocol.ts:145`。

⚠️ **AGENTS §4.2 说「`ChatErrorCode` 不进 `shared`」**——那是错误码。
但 WS 消息类型是**传输契约**，聊天和棋类共用同一个 `/ws`，
所以新增的 chat 事件类型**放 shared 是对的**，只要不把聊天的领域类型
（`ChatRoom`、`ChatPolicy` 等）搬进去。

建议：只放**线格式**（`{type:'message', roomId, message:{seq,from,fromName,text,at,kind}}`），
不放 `ChatPolicy` 那种领域对象。

---

## 3. 前端要做的

### 3.1 入口

现在 `App.tsx` 只渲染棋类。加一个分流：

```text
?room=<id>&kind=chat   → 聊天页
?room=<id>             → 棋类（不变）
```

⚠️ 和 WS 一样：**缺省是棋类**。

### 3.2 时间线

- 每条消息：作者名、时间（`at` 取 `HH:MM`）、正文
- 区分 `kind`：`chat` 正常气泡、`system` 斜体居中、`event` 次要色
- 自己的消息（`from === 'human'`）右对齐，agent 左对齐
- **作者颜色要稳定**：同一个成员每次渲染同色（用 name 或 id 做哈希，别用索引）
- 新消息自动滚到底，但**用户手动上滚时不抢滚动位置**

### 3.3 成员栏

每个成员显示：

- 名字 + `kind`（human / agent）
- **发言数**（`member.messages`）← C2.5 修好了，现在可信
- 是否轮到他（`turn.participantId === member.id`）

⚠️ **不要显示「在线/离线」**。聊天室**没有 presence**（AGENTS §4.2：
「不复用 `PresenceRegistry`，聊天成员无座位」）。只有 `lastSeenAt` 时间戳。
显示「最后活动：3 分钟前」是可以的，显示「在线」是**编造**。

### 3.4 hop 预算条

`hop / policy.maxHops`，快满时变色（比如 >80% 变黄，满了变红并显示「已暂停」）。

### 3.5 输入框 + `@` 补全

**`@` 补全的准确含义**（这一点评审方之前没说清，这里定义死）：

- 用户输入 `@` 时，弹出**成员名列表**（只列 agent，因为 `to` 只能指向 agent）
- 选中后，把该成员设为这条消息的 `to`，**并把 `@name` 从正文里去掉**（或保留，但要一致）
- 效果等价于「强制把轮次交给这个人」

⚠️ **这不是 `mentions` 模式**。`mentions` 是「只有被 @ 的人被唤醒」，
v1 没实现（`model.ts:20`：`v1 implements relay only`）。
C4 做的只是 **relay 下点名交棒的 UI 快捷方式**，不要改 `ChatRoom` 的轮次逻辑。

⚠️ 不发 `@` 时，`to` 省略，走 relay 的默认轮转。

### 3.6 主持人控件

- 暂停 / 恢复 / 关闭（调已有 REST：`POST /api/chat/rooms/:id/{pause,resume,close}`）
- 关闭前**二次确认**（不可逆）

---

## 4. 硬约束（踩了就返工）

| 约束 | 原因 |
|---|---|
| **`/ws` 缺省行为不变** | 棋类页面正在用，旧客户端也在用 |
| **不改 `rooms/` / `core/presence.ts` / `mcp/tools.ts` / `shared/src/game.ts`** | AGENTS §4.2 |
| **`onChange` 改成订阅式后，落盘必须仍然工作** | 见 §2.1，这是最容易静默坏掉的地方 |
| **不改 `get_transcript` / `wait_for_messages`** | C2.5 刚修好，别碰 |
| **不显示「在线/离线」** | 聊天室没有 presence，显示就是编造 |
| **不引入 SSE** | 见 §1 |
| **中文文案短句** | AGENTS §4.3 |

---

## 5. 易错点

| 坑 | 说明 |
|---|---|
| **覆盖 `onChange` 导致落盘失效** | §2.1。**必须写测试**：订阅后消息仍落盘 |
| **`kind` 缺省当成 chat** | 会让现有棋类页面全坏。**缺省必须是棋类** |
| **`hello` 复用棋类的 `state` 字段** | 聊天没有棋盘，类型会打架 |
| **成员颜色用索引** | 成员增减时颜色会跳。用 name/id 哈希 |
| **自动滚动抢用户滚动位置** | 用户上滚看历史时不该被拽到底 |
| **`@` 补全改成 mentions 模式** | §3.5，那是两件事 |
| **`to` 指向 human** | `resolveTarget` 会抛 `INVALID_REQUEST`（human 不持有轮次）。补全列表**只列 agent** |
| **hop 满了还在输入框里允许发** | 服务端会 `ROOM_PAUSED`，前端应提前禁用并提示 |

---

## 6. 关于 `mentions` / `free` 模式（背景，不要做）

`model.ts:19-21`：

```ts
export type ChatMode = 'relay' | 'mentions' | 'free';
/** v1 implements relay only; the other modes exist in the contract for C3+. */
```

REST 能接受 `mode: 'mentions'` 存进 policy，但 `ChatRoom` 的轮次逻辑
**只实现了 relay**——所有模式都按 relay 跑。

**C4 不要实现它们。** 真做 `mentions` 要改 `ChatRoom` 的轮次语义，
那是独立工作单，且需要先想清楚「只收不醒」怎么和长轮询配合。

---

## 7. 测试清单

| # | 测试 | 断言 |
|---|---|---|
| W1 | `/ws?roomId=x`（无 kind）行为不变 | 棋类 `hello` 仍带 `state`，现有 `room.ts` 能正常消费 |
| W2 | `/ws?roomId=x&kind=chat` | `hello` 带聊天房间快照 + 最近消息 |
| W3 | 新消息广播 | 发一条消息，所有 `kind=chat` 的 socket 都收到 `message` 事件 |
| W4 | **订阅 ws 后消息仍落盘** | §2.1 的坑。重启后消息还在 |
| W4b | **重启恢复的房间也仍落盘** | §2.1 的第二个赋值点（`manager.ts:173`）。新消息写进一个重启恢复的房间，再重启，消息还在 |
| W5 | 成员变化广播 | join / leave 触发 `room` 事件 |
| W6 | phase 变化广播 | pause / resume / close 触发 `room` 事件 |
| W7 | 房间不存在 | 返回 `error` 事件并关闭连接（对齐棋类行为） |
| W8 | 多标签页 | 两个 socket 同时收到同一条消息 |
| W9 | 断线重连 | 断开后重连，`hello` 能恢复完整状态（不丢消息） |

**前端**（手工验收即可，不用写自动化）：

- 打开两个浏览器标签，人类在 A 发言，B 应实时出现
- `@` 补全只列 agent，选中后消息带 `to`
- 用户上滚时不抢滚动位置
- 暂停后输入框禁用

---

## 8. 验收标准

- [ ] `pnpm typecheck` 干净
- [ ] `pnpm test` 全绿（当前 292，新增后应 >300）
- [ ] `node scripts/chat-duel.mjs` 仍全绿（**MCP 路径不能被 WS 改动影响**）
- [ ] 棋类页面手工验收：五子棋和围棋都还能正常下（`/ws` 改动不能伤到它们）
- [ ] 浏览器手工验收：两个标签页实时同步
- [ ] 提交信息用英文，正文说**为什么**

---

## 9. 做完就停

不要顺手做：大厅、聊天室列表、棋谱回放、`mentions` 模式、
runner（C3）、`pass`/`yield` 机制。

这些都有独立工作单。
