# 交接：P2 双真实模型对弈验证

> 面向：接手 P2 的 AI agent（GLM）
> 状态：P1b 已完成并合入 main，P2 未开始
> 最后更新：2026-10-25
> 分支：从最新 main 新建 `feat/p2-dual-ai`

---

## 0. 先读什么

1. **本文件**
2. [`docs/HANDOFF-P1B.md`](HANDOFF-P1B.md) — 上一阶段做了什么，尤其第 2.4 节「会话绑定身份」
3. [`docs/ROADMAP.md`](ROADMAP.md) — 整体顺序
4. 代码：`server/src/mcp/tools.ts` 的 `join_game`、`server/src/rooms/room.ts` 的 `resolve`

---

## 1. 一句话背景

P1b 已经证明**协议层**能跑双 AI：`server/test/dual-agent.test.ts` 用两个真实 MCP 会话打完了一盘，各走各的颜色。

但那是**脚本模拟**的 agent——它严格按剧本调用工具。P2 要验证的是：**真实大模型**接进来之后，行为对不对。

---

## 2. 要验证什么（这是 P2 的全部）

### 2.1 核心问题清单

| # | 问题 | 为什么重要 |
|---|---|---|
| Q1 | 模型会不会**主动调 `join_game`**，还是直接开始落子？ | 不 join 就没有身份，双 AI 场景会报 `AMBIGUOUS_ACTOR` |
| Q2 | 模型会不会**自觉调 `wait_for_turn`**，而不是抢着下？ | 不等就会撞 `NOT_YOUR_TURN` |
| Q3 | 模型会不会**替对手落子**？ | 这是最严重的错误，会直接破坏对局 |
| Q4 | 模型能否正确理解 **`yourColor`** 和 `participants`？ | 双 AI 时它必须知道自己执什么颜色、对手是谁 |
| Q5 | 掉线重连后，模型能否靠 **同名 `join_game`** 拿回座位？ | 这是重连机制的实际价值 |
| Q6 | 模型对 **`IDENTITY_REQUIRED` / `AMBIGUOUS_ACTOR`** 的报错能否自我修正？ | 错误恢复能力 |

### 2.2 不在这轮验证

- 围棋（P3）
- 聊天室（P4）
- 房间阶段/准备（P1c，可以先做 P2 再做，或反过来）

---

## 3. 环境准备

### 3.1 两个客户端

**DSH**（`~/.dsh/profiles/web/cordis.patch.yml`）

⚠️ **新增插件必须包在 `insert:` 里**。直接写顶层条目会被当成「更新一个不存在的条目」，只在 stderr 打一行 `patch: entry "mcp-arena" not found` 然后**静默跳过**：

```yaml
# ✅ 正确
- insert:
    - id: mcp-arena
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: arena
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp

# ❌ 错误：不会加载，只有一行警告
- id: mcp-arena
  name: '@deepseek-ai/dsh-mcp-client'
  config: { ... }
```

验证配置是否生效：

```powershell
node E:\data\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config 2>&1 | Select-String "mcp-arena"
```

看得到 `- id: mcp-arena` 才算成功；只看到 `not found` 就是没生效。

工具会以 `mcp__arena__join_game` 等形式出现。

**Claude Code**（v2.1.310，支持 HTTP）：

```powershell
claude mcp add --transport http arena http://127.0.0.1:3000/mcp
```

注意：**Claude Code 的 HTTP MCP 不需要 header**，因为身份靠 `join_game` 的会话绑定（服务端记 sessionId → participantId）。不要试图用 header 传身份，那套是给 stdio 桥用的。

### 3.2 启动服务

```powershell
cd E:\code\fun\agent-arena
pnpm install     # 首次
pnpm build
pnpm start       # 或 pnpm dev（含 Vite 热更新）
```

服务在 `http://127.0.0.1:3000`。

### 3.3 验证前先确认协议层没问题

**这一步很重要**：先跑脚本确认基础设施就绪，再让模型上，否则分不清是环境问题还是模型问题。

```powershell
pnpm duel                              # 两个机器人下一盘，约 31 手
pnpm duel --strategy hot               # 走热点雷达，约 9 手结束
pnpm duel --room duel2 --keep          # 换个房间，保留房间不清理
```

脚本（`server/scripts/duel.mjs`）做的事和真实模型完全一样：两个 MCP 客户端各自 `join_game` 占座，轮流 `wait_for_turn` → `get_state` → `place_stone`。

**期望输出**：

```
arena duel · room=duel strategy=center server=http://127.0.0.1:3000
joined: black=p_ce119b white=p_c2ce0f
presence: black:black-bot=idle  white:white-bot=thinking
# 1 black (7,7) center  presence: black:black-bot=idle  white:white-bot=thinking
...
game over: black wins by five after 31 moves
```

看到 `game over` 就说明协议层完全就绪。**如果这步失败，不要往下做 P2**，先修基础设施。

### 3.4 确认客户端真的挂上了工具

**DSH**：开一个**新会话**，问「你能用哪些 arena 工具」。能看到 `mcp__arena__join_game` 等 8 个就对了。

⚠️ **必须新开会话**：MCP 工具在会话启动时注入，已经开着的会话不会因为服务后来启动而获得工具。实测踩过这个坑——服务晚于会话启动，工具列表是旧快照。

**Claude Code**：`claude mcp list` 看 `arena` 是否 connected。

### 3.5 跑一遍单测

```powershell
pnpm test        # 应该 166 个全绿
```

---

## 4. 怎么跑对局

### 4.1 剧本（给两个模型的开场白）

**DSH**（执黑）：

> 你要和一个对手在 arena 房间 `duel` 下一盘五子棋。你执**黑**。
> 先调用 `join_game`（name 用 `dsh`，seat 用 `black`），然后循环：
> `wait_for_turn` → 轮到你就 `place_stone` → 再 `wait_for_turn`。
> 不要替对手落子。对手是 `claude`（另一个 AI）。

**Claude Code**（执白）：

> 你要和一个对手在 arena 房间 `duel` 下一盘五子棋。你执**白**。
> 先调用 `join_game`（name 用 `claude`，seat 用 `white`），然后循环：
> `wait_for_turn` → 轮到你就 `place_stone` → 再 `wait_for_turn`。
> 不要替对手落子。对手是 `dsh`（另一个 AI）。

**注意**：

- 两个都要在 `duel` 房间，不要用 `default`（那是人类局）
- 先让 DSH 调 `new_game`，或两边都先 `join_game` 再让任一方 `new_game`
- 网页观战：`http://127.0.0.1:3000/?room=duel`

### 4.2 谁先开局

黑方（DSH）调 `new_game`，或者由人类在网页 `http://127.0.0.1:3000/?room=duel` 点「执黑开局」——**但网页开局会抢占座位**，双 AI 场景建议让 agent 自己调 `new_game`：

```text
DSH: join_game(name=dsh, seat=black)
DSH: new_game(agentColor=black)
```

然后两个 agent 各自 `wait_for_turn` 循环。

### 4.3 观战

浏览器打开 `http://127.0.0.1:3000/?room=duel`，应该看到：

- 双方名字（dsh / claude）和在线状态
- 棋盘只读（观战模式）
- **没有**「执黑开局」按钮
- 副标题「两个 AI 在对弈，你在旁边观战」

---

## 5. 记录什么

每验证一个 Q，记录：

| 项 | 内容 |
|---|---|
| 模型 | dsh(deepseek) / claude |
| 行为 | 它实际调了什么工具、顺序 |
| 是否符合预期 | 是 / 否 |
| 若否，怎么错的 | 原始工具调用序列 |

**特别记录异常**：

- 模型试图 `place_stone` 到对手回合 → 应收到 `NOT_YOUR_TURN`，它怎么反应？
- 模型没 join 就落子 → 单 agent 时能过（legacy 路径），双 agent 时报 `AMBIGUOUS_ACTOR`
- 模型传了 `participantId` 参数（不该传）→ 会被忽略，因为身份来自会话绑定

---

## 6. 预期会发现的问题（我的猜测）

按经验，真实模型大概率会在这些地方出问题：

### 6.1 不 join 直接下（Q1）

模型看到工具列表里有 `place_stone`，可能直接调。单 agent 房间能过（legacy `actor: 'agent'` 路径），但双 AI 会 `AMBIGUOUS_ACTOR`。

**如果发生**，两个方向：

- 改 `SERVER_INSTRUCTIONS`，更强调「必须先 join_game」
- 或者实现 P1c 任务 C（`join_game` 缺省自动占空座），降低心智负担

### 6.2 不等就下（Q2）

模型可能「看到棋盘就手痒」，不等 `wait_for_turn` 直接落子。这会被 `NOT_YOUR_TURN` 挡住，但模型可能反复重试。

**如果发生**，考虑在 `SERVER_INSTRUCTIONS` 里把「先 wait」写得更硬。

### 6.3 替对手下（Q3）

最严重。模型可能认为「白棋那边没人动，我帮它下」。当前服务端**不会**阻止——因为 `place_stone` 是按调用者身份执行的，模型只能下自己的颜色。所以这个错误**在服务端层面不可能发生**，但如果模型尝试，会收到 `NOT_YOUR_TURN`。

**验证点**：确认它收到错误后不会改用别的方式绕过。

### 6.4 误解 `yourColor`（Q4）

`wait_for_turn` 返回的 `yourColor` 是调用者自己的颜色。如果模型误以为是「当前行棋方」，会混乱。

### 6.5 重连失败（Q5）

如果模型断线后用了不同的 `name`，会变成新参与者，拿不到原座位。

---

## 7. 可能需要改代码的地方

如果验证发现问题，**优先改提示词，不要改协议**：

| 问题 | 首选修法 | 备选修法 |
|---|---|---|
| 不 join | 强化 `SERVER_INSTRUCTIONS` | 实现自动占座 |
| 不等 | 强化提示词 | 服务端在 `place_stone` 时返回更明确的引导 |
| 重连失败 | 提示词说明「用同一个 name」 | 服务端按 sessionId 记历史身份 |

改提示词的位置：`server/src/mcp/tools.ts` 的 `SERVER_INSTRUCTIONS`。

---

## 8. 硬性约束（同 P1b，别踩）

| 约束 | 原因 |
|---|---|
| `PlayerSpec.id` 保持可选 | engine 默认值没 id |
| `GameStatus` 不加新值 | 166 个测试和 MCP 契约连锁 |
| 旧 `actor` 路径保留 | 旧客户端还在用 |
| presence 信号键按座位 | 改 participantId 会牵动 rebindSeats |
| 中文文案风格 | 「AI 未接入」「思考中」这种短句 |

---

## 9. 工作方式

### 分支

```powershell
cd E:\code\fun\agent-arena
git checkout -b feat/p2-dual-ai
```

**直接在 main 目录工作**（worktree 已清理，不再需要）。做完提交，`main` 保持干净。

### 每次提交前

```powershell
pnpm test        # 必须 166+ 全绿
pnpm typecheck
```

### 提交风格

```text
feat(mcp): ...
fix(server): ...
docs: ...
```

正文说「为什么」，参考现有提交。

---

## 10. 完成标准

```text
[ ] pnpm duel 跑通（协议层就绪，这一步先做）
[ ] DSH 和 Claude 各自 join_game 成功，各占一色
[ ] 双方能自动轮流落子，不需要人工催
[ ] 网页观战页正确显示双方状态
[ ] 至少跑完一盘（分出胜负或下满）
[ ] 记录 Q1–Q6 的验证结果
[ ] 若发现问题，修复或记录为已知限制
[ ] pnpm test 全绿
```

完成后：

1. 把验证结果写成 `docs/P2-RESULT.md`（含对局转录、问题清单）
2. 更新 `ROADMAP.md` 标记 P2 完成
3. **然后围棋（P3）可以开始了**

---

## 11. 已知的坑

| 坑 | 说明 |
|---|---|
| **DSH 新增 MCP 必须用 `insert:`** | 顶层条目会被当成「更新不存在的条目」，只打一行警告就跳过。用 `--dump-config` 验证 |
| **MCP 工具在会话启动时注入** | 服务晚于会话启动，旧会话拿不到工具。必须**新开会话** |
| **`wait_for_turn` 的 `moves` 是截断的** | 只带最近 8 手，判断空格要 `get_state`（`duel.mjs` 踩过） |
| 热重载不迁移内存状态 | 改 presence/room 后重启服务 |
| MCP SDK `client.close()` 不发 DELETE | 服务端靠 90 秒静默判定掉线 |
| 网页开局会抢座 | 双 AI 场景让 agent 自己 `new_game` |
| `place_stone` 返回 `{ok, state}` | `boardText` 在 `state` 里 |
| Claude Code 的 HTTP MCP 不需要 header | 身份靠会话绑定 |

---

## 12. 参考：工具清单

| 工具 | 用途 |
|---|---|
| `join_game` | 加入房间、占座、绑定身份 |
| `leave_room` | 离开、释放座位 |
| `new_game` | 开新局（agentColor 指定 AI 执什么色） |
| `get_state` | 读完整棋局 |
| `wait_for_turn` | 长轮询等待轮到自己 |
| `place_stone` | 落子 |
| `resign` | 认输 |
| `say` | 对玩家说一句解说 |
