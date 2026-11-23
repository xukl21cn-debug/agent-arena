# 房间创建与生命周期

> 设计提案 · 2026-11-23（第一版）
> 状态：**已实现，待用户验收**（F1–F3 见 §5，命名与预算增量见 §6；§3 的四条取舍已确认）
> 范围：大厅的新建入口、`POST /api/rooms` 的默认 id、两个域的 `DELETE` 端点、聊天 MCP `join_room` 语义、房间页的删除入口与文案修正
> 不动：落盘格式、棋谱归档、MCP 工具签名（`join_room` 只加一个返回字段）、`default` 房间的启动预建

---

## 1. 需求确认

### 1.1 实际场景

1. 用户想开第二局，不想永远用 `default`，也不想为了开一间房去 agent 那边报房间号。
2. 打开 `/games` 点「新建对局」，直接进入一间新房；URL 可以收藏、可以贴给别人。
3. agent 拿到房间号后 `join_game` 进去，和用户在同一间房，而不是另开一间。
4. 一局下完，房间留着（有棋谱可回放），但大厅里能看出哪些是该清理的。
5. 想删掉一间试出来的空房，不必去翻 `data/rooms/` 目录。

### 1.2 当前行为（2026-11-23 实测）

| 路径 | 现状 |
|---|---|
| 前端 UI | **没有任何建房入口**。[api.ts](../../web/src/api.ts) 只有 `listRooms` / `listChatRooms` 与房间内动作 |
| 棋类 REST | `POST /api/rooms` 可建；省略 `roomId` 时取 `manager.defaultRoomId`，即 `default`，实际必然 409（[routes.ts:397](../../server/src/game/http/routes.ts#L397)） |
| 聊天 REST | `POST /api/chat/rooms` 可建；省略 `roomId` 时生成 `chat-<6 hex>`（[http.ts:176](../../server/src/chat/http.ts#L176)） |
| 棋类 MCP | `join_game` / `new_game` 走 `getOrCreateRoom`，**任意合法 id 会自动建房**（[mcp/http.ts:384](../../server/src/game/mcp/http.ts#L384)） |
| 聊天 MCP | `join_room` 走 `getOrThrow`，房间不存在直接 404（[mcp.ts:291](../../server/src/chat/mcp.ts#L291)） |
| 深链 `/games/<新名>` | 不建房。WS 用 `manager.get()`，回 `Room "x" not found`（[ws.ts:255](../../server/src/ws.ts#L255)） |
| 大厅文案 | 写着「打开 /games/<房间名> 即可开一间」，与实测不符（[LobbyPage.tsx:655](../../web/src/components/lobby/LobbyPage.tsx#L655)） |
| 删除 | 两个域都没有路由；`RoomManager.remove()` / `ChatManager.remove()` 只有一处测试在用，生产代码无人调用 |
| 磁盘 | `data/rooms/default.json` 一间，`data/chat/` 为空 |

三个结论：**人类侧只有 curl 能建房；agent 侧棋类能建、聊天不能；房间只增不减。**

### 1.3 期望行为

- 人类和 agent 都能建房，规则一致：先到者创建，后到者进已有房，不再有「谁能建」的分歧。
- 房间 id 可读、可复制、可深链；生成规则两个域统一。
- 能删除房间，但**不允许删掉正在进行的对局**。
- 删除房间**不删棋谱**：归档在 `data/archive/`，与房间文件无关。
- 大厅不再出现与实现不符的指引。

### 1.4 范围

改：`server/src/game/http/routes.ts`、`server/src/chat/http.ts`、`server/src/chat/mcp.ts`、`shared/src/`（新增一个错误码）、`web/src/api.ts`、`web/src/components/lobby/LobbyPage.tsx`、`web/src/components/game/GamePage.tsx`、`web/src/components/chat/ChatRoomPage.tsx`、`web/src/styles/lobby.scss`。

不改：持久化格式、`shared` 的 wire 类型、棋谱归档逻辑、`/api/rooms/:id` 的既有读写语义。

### 1.5 验收条件（可观察）

1. `/games` 点「新建对局」→ 进入 `/games/<新 id>`，页头显示房间号；刷新页面仍是同一间；大厅列表出现它。
2. `/chats` 点「新建聊天室」→ 进入 `/chats/<新 id>`，能发第一条消息。
3. 同一 id 重复创建 → 409，界面给出可读提示而不是白屏。
4. agent 用 `join_game({roomId: 刚建的那间})` → 进的是同一间房（人数/座位变化可见），不新建。
5. 删除一间 `lobby` 或 `finished` 的棋房 → 大厅消失、直接访问 URL 得 404、它的棋谱仍能在 `/replay` 打开。
6. 删除一间正在下棋的房间 → 409，界面提示「对局进行中」。
7. 聊天室：空房或 `closed` 可删；`open` 且已有消息 → 409。
8. 大厅不再出现「打开 /games/<房间名> 即可开一间」这类与实现不符的文案。

---

## 2. 方案设计

### 2.1 id 规则

| 项 | 决定 |
|---|---|
| 生成 | 服务端生成 `game-<6 hex>` / `chat-<6 hex>`，与聊天现有规则一致 |
| 校验 | 沿用 `ROOM_ID_PATTERN`（`^[a-zA-Z0-9_-]{1,32}$`） |
| 显式指定 | 仍接受 `roomId` 字段，便于脚本和 agent 用可读名 |
| 查重 | 生成后检查注册表，最多重试 5 次；仍冲突才把 409 暴露给调用方 |

**`POST /api/rooms` 省略 `roomId` 的语义从「默认房」改成「新房」**——这是本提案唯一的行为变更。已核查：没有测试、README 示例或脚本依赖旧语义（[http.test.ts:131](../../server/test/http.test.ts#L131) 传的是显式 id）。

### 2.2 端点契约

| 方法 | 路径 | 成功 | 失败 |
|---|---|---|---|
| `POST` | `/api/rooms` | 201 + `{state}` | 409 `ROOM_EXISTS`、400 `INVALID_ROOM_ID` |
| `DELETE` | `/api/rooms/:roomId` | 204 | 404 `ROOM_NOT_FOUND`、409 `ROOM_BUSY` |
| `POST` | `/api/chat/rooms` | 201 + `{room}`（不变） | 409 `ROOM_EXISTS` |
| `DELETE` | `/api/chat/rooms/:roomId` | 204 | 404 `ROOM_NOT_FOUND`、409 `ROOM_BUSY` |

新增错误码 `ROOM_BUSY`（409），进 `shared` 的 `ErrorCode` union 与 `statusForCode`。理由：现有码里 `GAME_NOT_PLAYING` 语义相反，`ROOM_EXISTS` 是重名，都不该借用。

### 2.3 删除的边界

| 域 | 允许删除 | 拒绝 |
|---|---|---|
| 棋类 | `phase` 为 `lobby`（没人准备）或 `finished`（上局已结束） | `waiting`（有人已准备）、`playing`（含围棋 `scoring`）→ 409 `ROOM_BUSY` |
| 聊天 | `messageCount === 0`（空房）或 `phase === 'closed'` | 其余 → 409 `ROOM_BUSY` |

删除动作只做两件事：从注册表移除、`repository.delete()` 删 `data/rooms/<id>.json`。**棋谱不删**（归档目录独立，`repository.delete` 只 unlink 房间文件）。

已连接的客户端不主动断开：棋类 WS 保持连接，下一次请求收到 `ROOM_NOT_FOUND`；agent 的 MCP 会话若再 `join_game` 同一 id，会按 2.4 的语义**重建**一间空房——这条写进 README 的注意事项，不做特殊处理。

### 2.4 聊天 MCP 的 `join_room`

改成 `getOrCreate`，与棋类对齐，并在返回里加 `created: boolean`，让模型知道自己刚建的房还是进的旧房。`SERVER_INSTRUCTIONS` 补一句「房间不存在时会自动创建」。

风险：模型打错房间号会静默造一间空房。缓解：`created` 字段 + instructions 提示；不做「只允许已存在的房」开关，那会退回今天的不对称。

### 2.5 前端

| 位置 | 改动 |
|---|---|
| `api.ts` | 新增 `createGameRoom()`、`createChatRoom()`、`deleteGameRoom(id)`、`deleteChatRoom(id)` |
| 大厅 | 每个分组标题右侧一个「+ 新建」按钮；创建中禁用；成功后 `navigate('/games/<id>')` / `/chats/<id>`；失败显示错误条 |
| 棋局页 | 页头加「删除房间」（`btn--danger` 二次确认，复用现有 `is-confirming` 模式）；`playing` / `waiting` 时禁用并说明原因 |
| 聊天页 | 同上，`open` 且有消息时禁用 |
| 文案 | 删掉两句错误指引，改成「点右上角新建，或让 agent 用房间号加入」 |

### 2.6 兼容与迁移

- 旧深链、旧 query 地址、`default` 房间全部不变。
- `POST /api/rooms` 省略 id 的行为变了，但只有 curl 用户会感知；README 没有相关示例。
- 已有房间文件不受影响；删除是新增能力，不需要迁移。

### 2.7 验证方法

1. **单测**：新增 `server/test/room-lifecycle.test.ts` —— 生成 id 的格式与查重、`DELETE` 的四种边界（lobby/finished 可删，waiting/playing 409）、删除后 `GET` 404 且归档仍可读、聊天空房与 closed 可删、`open` 有消息 409。
2. **浏览器**：CDP 脚本走完整场景——大厅点新建 → 进房 → 刷新仍在 → agent `join_game` 同一 id → 用户删除 → 大厅消失 → 直接访问 URL 404。
3. **回归**：`pnpm typecheck`、`pnpm build`、全量测试（当前 383 项，预计新增 8–12 项）。

---

## 3. 待确认的取舍

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 聊天 MCP 的 `join_room` 要不要自动建房 | **要**。否则「agent 一句话开局」在聊天域永远不成立；用 `created` 字段兜住误建的可见性 |
| 2 | 删除的边界（§2.3 两张表） | **按表执行**：棋类只在 `lobby`/`finished` 可删，聊天只在空房或 `closed` 可删 |
| 3 | 要不要做空房自动回收（TTL） | **第一版不做**。先看手动删除够不够；真需要时再加后台清理，和 `chat/sweep.ts` 同一形态 |
| 4 | 「新建」入口的形态 | **每个分组标题右侧一个按钮**；总览页三个分组各自有，不做全局「新建」浮层 |

> 2026-11-23 确认：第 1–3 条按建议执行；第 4 条实现时改为**按域放在页头**，理由见 §5 的偏差记录。

## 4. 实施计划（确认后）

| 阶段 | 内容 | 验证 |
|---|---|---|
| F1 | 后端契约：id 生成、两个 `DELETE`、`ROOM_BUSY`、单测 | 新用例全绿 + 既有 383 项不回归 |
| F2 | 前端入口：大厅新建、房间页删除、文案修正 | CDP 全场景 + 窄屏不溢出 |
| F3 | 聊天 MCP `join_room` 自动建房 + instructions | MCP 客户端实测建房与 `created` 标记 |

分支 `feat/room-lifecycle`，三个阶段各自提交；F3 可单独回退，不影响 F1/F2 的可用性。

---

## 5. 实施记录（2026-11-23）

分支 `feat/room-lifecycle`，三阶段各一个提交。

| 阶段 | 提交 | 内容 |
|---|---|---|
| F1 | `6db0b62` | `POST /api/rooms` 省略 id 时生成 `game-<6 hex>`；两个域新增 `DELETE`；新增 `ROOM_BUSY`；删除时解除持久化订阅 |
| F2 | `33d44fd` | 大厅新建按钮、房间页删除按钮、两句错误文案 |
| F3 | `2ae9650` | 聊天 `join_room` 自动建房 + `created` 标记 + instructions |

### 与方案的偏差

- **「新建」按钮按域放在页头，不是每个分组一个。** 房间的棋种要等第一局开始才定——新建的房间 `state.game` 是 `gomoku`，在「围棋」分组下建房会得到一张标着五子棋的卡片。所以 `/games` 只有一个「新建对局」，进房后再选棋种；总览页有两个按钮（对局 / 聊天室）。
- **删除时解除持久化订阅**（方案没写这条）。`GameRoom.dispose()` 与 `ChatManager` 保存的 unsubscribe：否则挂起的长轮询或进行中的请求可以在删除之后把旧状态写回磁盘，重启后房间复活。D5 / D8 就是这两个用例。
- **`ROOM_BUSY` 加在两处**：`shared` 的 `ErrorCode` 和聊天域自己的 `ChatErrorCode`。两个域本来就各自维护错误码，没有为此合并。

### 测试账

383 → **395**（+12）：C1–C3 创建与 id 规则，D1–D5 棋类删除（含棋谱保留、"删了不复活"），D6–D8 聊天删除，J1 聊天 MCP 建房与重连。

### 已验证

- `pnpm typecheck`、`pnpm build` 通过；`pnpm test` 29 个文件 **395 项全绿**。
- Chrome 实测（CDP，`ARENA_DATA_DIR` 指向临时目录）：`/games` 点「新建对局」→ `/games/game-73dccd` → 刷新仍是同一间 → 「删除房间」两步确认后回到 `/games`，卡片消失；开局中的房间删除按钮为禁用；`/chats` 新建 → 发一条消息后删除按钮禁用（服务端同样回 409 `ROOM_BUSY`）；聊天列表出现新建的房间。

### 未覆盖

- 窄屏（<640px）只做了结构检查，没有逐像素对照。
- 删除一间正被 WS 连接的房间时，浏览器端不会收到「房间已被删除」的推送，刷新后才 404。这是 §2.3 里写明的已知行为，不是缺陷。

---

## 6. 增量：房间命名与预算调整（2026-11-23）

用户验收时提出：新建聊天室要能预设名称和 hop 预算；预算用完但还想聊时，能在网页上加预算。三条取舍按建议确认——表单放名称 + hop 预算 + 每人发言上限；调高预算**自动恢复**（仅限因预算暂停的房间）；允许下调但不得低于已用 hop。

### 契约

| 项 | 内容 |
|---|---|
| 端点 | `POST /api/chat/rooms/:roomId/policy`，body `{ policy: { maxHops?, maxMessagesPerMember? } }` |
| 校验 | 复用创建时的 `chatPolicyOf`：未知字段、非整数、超出 1–1000 一律 400；空 patch 也拒绝 |
| 下调 | 不得低于已用 hop 或最忙成员的发言数，否则 400——否则下一次发言立刻又暂停 |
| 自动恢复 | 仅当暂停确实是预算耗尽（`hop ≥ 旧 maxHops`）且新预算够用时恢复；手动暂停的房间不受影响 |
| 审计 | 调整与恢复各留一条系统消息，时间线能自证 |

### 与方案的偏差

- **`ChatRoom.policy` 从 `readonly` 改成私有字段 + getter**，否则运行时调整无处落地。对外形状不变：`snapshot().policy` 仍是拷贝。

### 测试账

395 → **398**（+3）：P1 走 MCP 把预算花光再调高（房间恢复、hop 保留）；P2 两条「不能低于已用」的拒绝；P3 空 patch / 未知字段 / 越界 / 已关闭。

### 已验证

- `typecheck`、`build` 通过；398 项测试全绿。
- Chrome：新建表单填「预算演练 / 12 / 5」→ `/chats/chat-881a51` 标题为「预算演练」、预算 `0 / 12`；在房间里把预算改成 20 → 显示 `0 / 20`，时间线出现「主持人调整：hop 预算 12 → 20」。接口复查 `policy.maxMessagesPerMember === 5`。

### 未覆盖

- 每人发言上限只能在创建时设定，房间里暂时只能调 hop（用户只提了 hop）。接口已经支持两个字段，补一个输入框即可。
- 房间改名仍未支持。

---

## 7. 增量：房间号可见与可复制（2026-11-23）

用户验收时问：「右边这个是 room 的 id 吗？通知 agent 加入时是指定 id 还是名字？」

**名字只是标签，不是地址。** 房间的唯一寻址方式是 `roomId`：`join_room` / `join_game` 只认 id，名字既不唯一也解析不了。但原来的界面把这层信息藏住了——大厅卡片只显示名字，房间页的房间号要手动框选，复制靠拖。

- 房间页的房间号改为 `RoomChip`：一个「复制」按钮，写入剪贴板并回显「已复制」；非安全上下文写不进去时回显「复制失败」，而不是静默什么都不发生。
- 大厅卡片在名字与 id 不同时，meta 行显示 `chat-xxxx · N 条 · hop x/y`。

**已验证**：Chrome 里新建「项目测试 / 200」，房间页 chip 显示 `room / chat-942775`，点「复制」后按钮变为「已复制」、`navigator.clipboard.readText()` 读到 `chat-942775`；大厅卡片标题「项目测试」、meta 以 `chat-942775` 开头。

**未覆盖**：棋局页的 chip 同样换了组件，但没单独跑一遍复制（同一组件、同一路径）。

