# 会话交接 · 2026-10-26

> **先读 [`AGENTS.md`](../AGENTS.md)**——通用约定（分工、硬约束、验证方法、设计原则）都在那里，
> 本文只写「从哪继续」和「这一轮学到的新东西」。
>
> 上一份交接（P1b 时代）已被本文取代，历史内容见 git 记录。

---

## 一、当前状态（一句话）

**`main` 分支干净，302 个测试全绿。P4 聊天室全部完成（服务端 + 网页），下一步是 P5 大厅。**

| 项 | 值 |
|---|---|
| 项目路径 | `E:\code\fun\agent-arena` |
| 分支 | `main`（干净） |
| 最新提交 | `59d6fc6 feat(chat): web chat room rides the existing /ws channel` |
| 测试 | **302 全绿** |
| 服务 | 3000 端口（`pnpm dev`） |
| 数据 | 对局落盘在 `data/`（P3.5 完成）；**聊天室落盘在 `server/data/chat/`** |

**网页入口**：

```text
http://localhost:5173/?room=<id>              → 棋类（五子棋/围棋）
http://localhost:5173/?room=<id>&kind=chat    → 聊天室
```

⚠️ **`kind` 缺省仍是棋类**，这是硬约束（旧书签和旧客户端都靠它）。

---

## 二、这一轮做了什么（P2 → P4-C2）

| 阶段 | 内容 | 关键产出 |
|---|---|---|
| **P2** | 双真实模型对弈验证 | 一盘完整对局（claude 胜，64 手，1h41m）；发现并修复 `yourColor` 座位 bug |
| **P3a** | 围棋规则引擎 | `core/go.ts`，纯函数，独立审计通过 |
| **P3b-1** | 围棋类型契约 | `GoState` / `AnyGameState` / `AnyMove` |
| **P3b-2** | 围棋接入 | `/mcp` 加 4 个工具（pass / mark_dead / confirm_score / resume_play） |
| **P3b-3** | 围棋数子 | scoring 全流程，**并行确认无轮次** |
| **P3b-4** | 网页围棋盘 | `GoBoard.tsx`，用户已实战下完一盘 |
| **P3.5** | 棋谱持久化 | `FileRoomRepository`，重启恢复对局 |
| **P4-C1/C2** | 聊天室服务端 | `/chat/mcp` + 4 个工具 + 长轮询 |
| 修复 | chat policy 参数 | REST 建房时 policy 被静默丢弃 |
| **P4 §3.1** | 真实模型聊天观察 | claude + DSH 聊 13 条；**挖出 2 个服务端缺陷** |
| **P4-C2.5** | 修那两个缺陷 | `memberRef()` + `unreadAfter()`；292 测试全绿，[评审](REVIEW-P4-CHAT-FIX.md) |
| **P4-C4** | 网页聊天页 | 复用 `/ws`（`kind=chat`）；302 测试全绿，[评审](REVIEW-P4-C4.md) |

**P3 围棋已实战验收**：用户与 AI 下完一整盘，反馈「感觉很不错」。

---

## 三、下一步（从这里继续）

### 3.1 ✅ 已完成：真实模型聊了一轮

**结果见 [`OBSERVE-CHAT-REAL-MODELS.md`](OBSERVE-CHAT-REAL-MODELS.md)。**

用 **claude CLI（真实进程）+ DSH 本人** 在 `real637936` 房间聊了 13 条消息、11 次 agent 发言。

**模型行为没问题**：

- 零抢话——claude 为等轮次连续 `wait` 了 3 次（其中一次超时），没尝试插话
- 长轮询真的挂住了，模型没有因为「慢」而放弃（这正是设计想要的行为）
- 会自我纠正——它主动指出我做错了抢话测试，并给出正确做法
- 讨论有实质推进，有反驳、有收敛，没跑题

**但发现两个服务端缺陷**（详见 §3.2）。

### 3.2 ✅ 已完成：两个缺陷已修复合入

工作单：[`HANDOFF-P4-CHAT-FIX.md`](HANDOFF-P4-CHAT-FIX.md)
评审：[`REVIEW-P4-CHAT-FIX.md`](REVIEW-P4-CHAT-FIX.md)（`785b172`，已合入 main）

| 缺陷 | 修法 |
|---|---|
| `maxMessagesPerMember` 失效 | 加 `ChatRoom.memberRef()` 返回本体，`memberOf()` 改用它；`snapshot()` 拷贝语义不动 |
| `wait_for_messages` 静默丢消息 | 响应加 `nextCursor`/`hasMore`/`omitted`；`messagesAfter` 换成 `unreadAfter`（头部截断） |

**评审方独立验证**：自己起隔离服务（3200）、手写 MCP 客户端，
`38 + 17 = 55` 条检查全过，未复用 GLM 的测试。

> ⚠️ 一个坑记下来：`wait` 有**四个**唤醒条件（有新消息 / 轮到你 / phase 变了 / 超时），
> 断言 `timedOut=true` 前必须先保证前三个都不成立。我第一次就写错了这个断言。

### 3.3 ✅ 已完成：P4-C4 网页聊天页

工作单：[`HANDOFF-P4-C4.md`](HANDOFF-P4-C4.md)
评审：[`REVIEW-P4-C4.md`](REVIEW-P4-C4.md)（`59d6fc6`，已合入 main）

| 项 | 落地方式 |
|---|---|
| 传输 | 复用 `/ws` + `kind=chat`，**没有引入 SSE** |
| `@` 补全 | relay 下的「点名交棒」UI，**没实现 `mentions` 模式** |
| 落盘 | `onChange` 单槽改成订阅者集合，`create()` 和 `loadFile()` 两个点都改了 |
| 前端 | `?room=<id>&kind=chat` 分流；作者色按名字哈希；上滚不抢位置 |

**评审方独立验证**：隔离服务（3300）+ Node 内置 `WebSocket` + headless Chromium/CDP，
`34 + 15 = 49` 条检查全过。

> ⚠️ **`kind` 缺省仍是棋类**——这是硬约束，改了就全坏。
> 我测了「不带 kind」和「kind 拼错」两种误用，都正确回落到棋类路径。

> ⚠️ **评审方这轮又犯了一次 §6.2 的错**：写前端断言前没 dump 真实 DOM，
> 3 条失败全是选择器猜错（`.chat-mention` 写成 `[class*="mention"]` 等）。
> **写浏览器断言前先导一遍类名。**

### 3.4 ⬅ **下一步**：P5 大厅 + 棋谱回放

**设计已写好**：[`DESIGN-P5.md`](DESIGN-P5.md)（含**已验证**的重放方案）
**拆成两份互不依赖的工作单**：

| 工作单 | 内容 | 建议顺序 |
|---|---|---|
| [`HANDOFF-P5A.md`](HANDOFF-P5A.md) | 棋谱回放（**可单步前进/后退**） | **先做**（技术难点） |
| [`HANDOFF-P5B.md`](HANDOFF-P5B.md) | 大厅 + 聊天室 `updatedAt` 修复 | 可并行 |

#### 回放方案已经验证过，不是纸上设计

用户要求「单步前进后退」，所以必须能从**任意一手**重建棋盘。
我写了一个原型直接调真实引擎，**22 条检查全过**：

| 用例 | 结果 |
|---|---|
| 五子棋 9 手到五连 | 每帧棋盘与真实对局一致 |
| **围棋提子** | 每帧一致；`captures` / `lastCaptured` 都正确重建；提子前一帧白子还在 |
| 连续 pass 进数子 | 重放也进 `scoring` |
| 损坏 history | **抛错带手数**，不静默截断 |

**关键结论：重放不需要自己实现任何规则。**
`applyGoPlacement` / `applyGoPass` / `applyMove` 都是纯函数、接受完整 state，
提子、劫、自杀、五连判定全由引擎负责。

三个必须做对的细节（工作单 §1）：
`gameId` 沿用落盘值、`now` 传 `move.at`、失败要抛错。

#### ⚠️ P5B 有个前置 bug

`ChatRoomSummary.updatedAt` 是 `new Date().toISOString()`
（`server/src/chat/manager.ts:122`）——**每次请求都返回「现在」**，不是真实最后活动时间。

大厅要按它排序，**必须先修**，否则每次刷新顺序都不一样。
对照：棋类的 `updatedAt` 来自 `state.updatedAt`，是真的。

#### 回放不重演终局

`history` 只记落子和停一手，**不记认输/标死子/确认分数**。所以：

- 回放保证**棋盘和走子**正确
- **不保证**复现终局判定
- 终局文字要从落盘的 `final.status` 读，**不能从重放推**

回放页必须标注这一点，否则用户会以为漏了什么。

> **WS 统一不用做了**：C4 已经复用 `/ws`（`kind=chat`）把聊天室接进去了。

### 3.5 可选：P4-C3 runner

把 CLI 包成常驻成员（`codex exec` / `claude -p`），不依赖模型耐心循环调用。
优先级低于 P5 大厅——交互式客户端已经能用。

> **但 `pass`/`yield` 可以独立于 runner 先做**：
> agent 收工后轮次会卡在它身上，只能等 120s 超时跳过。
> 真实模型观察里 claude 自己提出了这个修法（给 `send_message` 加显式 pass）。
> 见 `OBSERVE-CHAT-REAL-MODELS.md` §4.4。

---

## 四、这一轮踩的新坑

### 4.1 MCP 会话无法持久化（已查证，别再试）

```text
SDK 源码："State is maintained in-memory (connections, message history)"
```

- 会话是活连接，没法序列化
- 客户端拿到 404 只会重试旧 id，**不会重新 initialize**（实测）
- `transport.onclose` 在服务端死掉时**不触发**，所以重连逻辑不启动

**结论**：改了工具清单就必须重开客户端会话。详见 `AGENTS.md` §8。

### 4.2 `tsx watch` 重启进程，但**对局会恢复**

实测：改一行 `server/` 代码，`pid` 变了、进程重启。

**但 P3.5 的持久化让对局自动恢复**：

```text
1. 开围棋局，落一子（moves=1）
2. 改 server/src/config.ts
3. tsx 重启进程
4. 查对局 → moves=1，黑子还在   ✅
```

**所以 `pnpm dev` 下改后端，丢的只是 MCP 会话，不是对局。**

日常用 `pnpm dev` 就行（5173 前端 + 3000 后端）。
只有「改后端同时要用 DSH 对局」才需要双端口脚本。

### 4.3 聊天室的 scoring 类操作没有轮次

围棋数子阶段**双方并行确认**，不是轮流。`wait_for_turn` 的 `scoring` 判断
必须在 `turn` 判断之前。

聊天室同理：`wait_for_messages` 按成员分派，不按轮次。

### 4.4 评审方自己反复犯的四个错

见 `AGENTS.md` §6.2。**写审计脚本前对照一遍**，这一轮又犯了其中两个。

### 4.5 `snapshot()` 返回深拷贝——写操作必须拿本体

**这一轮最贵的教训。** `ChatRoom.snapshot()` 的成员是 `{...member}` 副本。
任何「从 snapshot 取对象 → 改它」的代码，改的都是副本，**静默失效**。

`maxMessagesPerMember` 就是这么坏的：`memberOf()` 从 `snapshot()` 取成员，
`member.messages += 1` 加在副本上，计数器永远是 0。

**规则**：需要**改**的对象，从领域对象拿本体（如 `members.get(id)`）；
需要**返回给外面**的，才用 `snapshot()` 拷贝。

### 4.6 聊天室数据在 `server/data/`，不在 `data/`

`pnpm dev` 下 server 的 cwd 是 `server/`，所以：

```text
棋类对局   E:\code\fun\agent-arena\data\rooms\*.json
聊天室     E:\code\fun\agent-arena\server\data\chat\*.json   ← 注意多一层
```

找落盘文件时别在 `data/chat` 里空找（这一轮找了半天）。

### 4.7 真实模型的行为和 mock 不一样，必须实测

`chat-duel.mjs` 全绿不代表模型行为对。这一轮的实测数据：

- claude 为等轮次连续 `wait` 了 **3 次**（其中一次 26 秒超时），**零抢话**
- 它还会**自我纠正**：主动指出评审方的抢话测试做错了（轮次本来就在评审方手上）
- 讨论有实质反驳和收敛，没跑题

**但也正因为真模型会长时间挂着等**，`wait_for_messages` 丢消息的 bug 才显得严重——
挂得越久，一次返回里积压的消息越多，越容易超过 12 条被截断。

---

## 五、关键文件索引

### 代码

| 文件 | 内容 |
|---|---|
| `server/src/rooms/room.ts` | 棋类房间（五子棋 + 围棋分派） |
| `server/src/core/engine.ts` | 五子棋引擎 |
| `server/src/core/go.ts` | 围棋引擎（纯函数，独立审计通过） |
| `server/src/core/go-game.ts` | 围棋状态搬运（对应 engine.ts） |
| `server/src/core/presence.ts` | 在线状态（**按座位索引**） |
| `server/src/mcp/tools.ts` | 棋类 MCP 工具（12 个） |
| `server/src/chat/` | 聊天室（独立领域，5 个文件） |
| `shared/src/game.ts` | 核心类型（`GameState` / `GoState` / `RoomView`） |
| `web/src/components/GoBoard.tsx` | 网页围棋盘 |

### 脚本

| 文件 | 内容 |
|---|---|
| `scripts/dev-isolated.ps1` | 双端口启停（**备选**，日常用 `pnpm dev`） |
| `scripts/e2e-go-web.mjs` | 围棋端到端（REST 人类 + MCP agent） |
| `scripts/chat-duel.mjs` | 两个 MCP 客户端聊天 |
| `scripts/smoke-go-white.mjs` | 围棋白方冒烟 |
| `server/scripts/duel.mjs` | 两个 MCP 客户端下五子棋（`pnpm duel`） |

> `scripts/` 下还有几个历史调试脚本（`demo-agent-view.mjs` / `measure-payload.mjs` /
> `replay-game2.mjs`），不是日常流程的一部分。

### 文档

见 `AGENTS.md` §10 的文档地图。

**这一轮新增八份**：

| 文件 | 内容 |
|---|---|
| [`OBSERVE-CHAT-REAL-MODELS.md`](OBSERVE-CHAT-REAL-MODELS.md) | 真实模型聊天观察：模型表现 + 两个缺陷的实测证据 |
| [`HANDOFF-P4-CHAT-FIX.md`](HANDOFF-P4-CHAT-FIX.md) | 修那两个缺陷的工作单（✅ 已完成） |
| [`REVIEW-P4-CHAT-FIX.md`](REVIEW-P4-CHAT-FIX.md) | 修复的评审记录（独立验证 55 条全过） |
| [`HANDOFF-P4-C4.md`](HANDOFF-P4-C4.md) | 网页聊天页工作单（✅ 已完成） |
| [`REVIEW-P4-C4.md`](REVIEW-P4-C4.md) | C4 评审记录（独立验证 49 条全过） |
| [`DESIGN-P5.md`](DESIGN-P5.md) | P5 设计稿：回放方案（含原型验证 22 条） |
| [`HANDOFF-P5A.md`](HANDOFF-P5A.md) | 棋谱回放工作单（**待做**） |
| [`HANDOFF-P5B.md`](HANDOFF-P5B.md) | 大厅工作单（**待做**） |

---

## 六、服务怎么起

```powershell
cd E:\code\fun\agent-arena

# 日常开发（推荐）
pnpm dev
# → 后端 3000，前端 5173（网页开 5173，不是 3000）

# 长期跑给 DSH 用
pnpm build
pnpm start
# → 3000 同时服务 API / MCP / web/dist
```

**备选：双端口**（只在「改后端 + 同时要用 DSH 对局」时）

```powershell
pwsh -File scripts/dev-isolated.ps1 -Only live   # 3000
pnpm build
pwsh -File scripts/dev-isolated.ps1 -Only dev    # 3100
pwsh -File scripts/dev-isolated.ps1 -Stop
```

⚠️ **`pnpm start` 读 `dist/`**——改完 server 代码必须 `pnpm build` 再重启。

详见 [`DEV-WORKFLOW.md`](DEV-WORKFLOW.md)。

---

## 七、DSH 的 MCP 配置

配置在 `C:\Users\59916\.dsh\profiles\web\cordis.patch.yml`，服务名 `arena`。

```yaml
# 新增插件必须用 insert:
- insert:
    - id: mcp-arena
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: arena
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp
```

**聊天室需要另一个条目**（如果要用 DSH 聊）：

```yaml
    - id: mcp-arena-chat
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: chat
        transport: streamable-http
        url: http://127.0.0.1:3000/chat/mcp
```

⚠️ **改完配置必须新开会话**（MCP 工具在会话启动时注入）。

---

## 八、用户的偏好（观察所得）

- **串行推进**，不喜欢并行开太多分支
- **GLM 写代码，DSH 评审 + 文档**（分工见 `AGENTS.md` §2）
- **重视文档**，每阶段都要工作单 + 评审
- **要求实测验证**，不接受「测试过了就行」
- 中文交流，界面文案用中文短句
- 会自己动手验证，发现问题描述得很详细
- **喜欢看实测数据**（「实测通过」「独立验证」这类结论）
