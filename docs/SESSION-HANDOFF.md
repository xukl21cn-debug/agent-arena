# 会话交接 · 2026-10-26

> **先读 [`AGENTS.md`](../AGENTS.md)**——通用约定（分工、硬约束、验证方法、设计原则）都在那里，
> 本文只写「从哪继续」和「这一轮学到的新东西」。
>
> 上一份交接（P1b 时代）已被本文取代，历史内容见 git 记录。

---

## 一、当前状态（一句话）

**`main` 分支干净，282 个测试全绿。P4 聊天室的服务端已完成，网页 UI 未开始。**

| 项 | 值 |
|---|---|
| 项目路径 | `E:\code\fun\agent-arena` |
| 分支 | `main`（干净） |
| 最新提交 | `d89ab8a docs: review the chat policy fix` |
| 测试 | **282 全绿** |
| 服务 | 3000 端口运行中（`scripts/dev-isolated.ps1 -Only live`） |
| 数据 | 对局落盘在 `data/`（P3.5 完成） |

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

**P3 围棋已实战验收**：用户与 AI 下完一整盘，反馈「感觉很不错」。

---

## 三、下一步（从这里继续）

### 3.1 推荐：先看真实模型在聊天室的表现

**在 C4（网页聊天页）之前，先让两个真实模型聊一轮。**

理由：`scripts/chat-duel.mjs` 是 mock 客户端，真实模型的行为没观察过——
会不会抢话、会不会跑题、轮次遵守得怎么样，全都不知道。

**这和 P2 的教训一样：协议对不等于模型对。**

怎么做：

```text
1. 起服务
   pwsh -File scripts/dev-isolated.ps1 -Only live

2. 建聊天室
   POST http://127.0.0.1:3000/api/chat/rooms
   { "roomId": "lobby", "title": "MCP 的未来" }

3. 两个 agent 通过 MCP 接入
   /chat/mcp → join_room(name="dsh") / join_room(name="claude")
   → 循环 wait_for_messages → send_message

4. 人类在网页或用 REST 插话
   POST /api/chat/rooms/lobby/messages { "text": "你们聊聊..." }
```

### 3.2 然后：P4-C4 网页聊天页

工作单**还没写**。需要写 `docs/HANDOFF-P4-C4.md`，内容参考：

- 时间线（作者颜色、气泡）
- 成员栏（在线状态 + 发言数）
- hop 预算条
- 人类输入框（`@` 补全）
- 暂停 / 关闭 / 导出

⚠️ **聊天室没有 WS**（C1/C2 刻意跳过了），网页要用轮询或长轮询。
统一 WS 留给 P5。

### 3.3 之后：P5 大厅

包含三件事（用户已确认）：

| 项 | 说明 |
|---|---|
| 大厅 | 三类房间统一入口（五子棋 / 围棋 / 聊天） |
| **棋谱回放** | P3.5 已落盘，做列表 + 回放页面 |
| WS 统一 | `RoomManager` 装两类房间，`ws.ts` 按 kind 分发 |

### 3.4 可选：P4-C3 runner

把 CLI 包成常驻成员（`codex exec` / `claude -p`），不依赖模型耐心循环调用。
优先级低于 C4——交互式客户端已经能用。

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

### 4.2 `tsx watch` 是重启进程，不是热替换

实测：`pid` 从 26884 变 7324，内存计数器归零。

所以 `pnpm dev` 下改一行代码，对局就没了。**用双端口脚本。**

### 4.3 聊天室的 scoring 类操作没有轮次

围棋数子阶段**双方并行确认**，不是轮流。`wait_for_turn` 的 `scoring` 判断
必须在 `turn` 判断之前。

聊天室同理：`wait_for_messages` 按成员分派，不按轮次。

### 4.4 评审方自己反复犯的四个错

见 `AGENTS.md` §6.2。**写审计脚本前对照一遍**，这一轮又犯了其中两个。

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
| `scripts/dev-isolated.ps1` | 双端口启停（**日常用这个**） |
| `scripts/e2e-go-web.mjs` | 围棋端到端（REST 人类 + MCP agent） |
| `scripts/chat-duel.mjs` | 两个 MCP 客户端聊天 |
| `scripts/smoke-go-white.mjs` | 围棋白方冒烟 |
| `server/scripts/duel.mjs` | 两个 MCP 客户端下五子棋（`pnpm duel`） |

> `scripts/` 下还有几个历史调试脚本（`demo-agent-view.mjs` / `measure-payload.mjs` /
> `replay-game2.mjs`），不是日常流程的一部分。

### 文档

见 `AGENTS.md` §10 的文档地图。

---

## 六、服务怎么起

```powershell
cd E:\code\fun\agent-arena

# 对局服务（3000）
pwsh -File scripts/dev-isolated.ps1 -Only live

# 开发服务（3100，改代码时用）
pnpm build
pwsh -File scripts/dev-isolated.ps1 -Only dev

# 都停
pwsh -File scripts/dev-isolated.ps1 -Stop
```

⚠️ **改完 server 代码必须 `pnpm build`**——`pnpm start` 读 `dist/`。

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
