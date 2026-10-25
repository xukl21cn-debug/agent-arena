# 会话交接 · 2026-10-25

> 给下一个会话用。上个会话从「智谱免费额度」聊起，最终做完了 agent-arena 的 P1a + P1b，并改名。

---

## 一、当前状态（一句话）

**`E:\code\fun\agent-arena` 在 `feat/p2-dual-ai` 分支，166 个测试全绿，P2 待开始。**

| 项 | 值 |
|---|---|
| 项目路径 | `E:\code\fun\agent-arena` |
| 当前分支 | `feat/p2-dual-ai`（干净，无未提交改动） |
| 最新提交 | `b5e5d3a feat(scripts): duel — two MCP clients play a full game` |
| 测试 | 166 个全绿 |
| arena 服务 | 正在跑，端口 3000（pid 34100） |
| DSH MCP 配置 | 已配好（`insert:` 写法），服务名 `arena` |

---

## 二、这个项目是什么

原本是「人类 vs 一个 AI」的五子棋（`gomoku-mcp`），现在扩展成**给 AI Agent 玩的本地竞技场**：

- 房间里可以有**两个 AI 互相对弈**，人类观战
- 每个参与者有**稳定身份**（id、名字、座位），同名重连能拿回座位
- **在线状态可见**：等待中 / 思考中 / 在线 / 已断开
- 通过 MCP 暴露给任意标准客户端（DSH、Claude Code、ZCode 等）
- 未来规划：围棋（P3）、聊天室（P4）、大厅（P5）

---

## 三、这次会话做了什么

### 3.1 智谱 GLM 接入（早期，已完成）

把 ZCode 的 coding plan key 解密出来，接到 DSH 的 pi-ai 适配器：

- 配置在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `llm-pi-ai`（**后来用户改成了 magpie 路由，这段已被覆盖**）
- 结论：赠送额度无法从外部 API 使用，只能用订阅额度

### 3.2 P1a：在线状态（已合入 main）

**问题**：点「执黑开局」后只能干等，不知道 AI 是没连上还是在长考。

**做法**：presence 由**传输层信号**决定，不靠「多久没动静」猜：

| 信号 | 含义 |
|---|---|
| 浏览器 WS 连接 | 人类座位在线 |
| MCP 会话 | agent 座位在线 |
| 挂起的长轮询 | 最强证据 → `waiting` |
| 回合状态 | → `thinking` |
| 传输层断开 | → `disconnected` |

**踩过的三个 bug**（都已修）：
1. 观众绑到「连接时的座位」，执白开局后错位
2. `watchedAt` 在断开时也刷新，关标签页后仍显示在线
3. 座位换人时旧的活动记录残留，AI 座位误判在线

### 3.3 P1b：参与者模型（已合入 main）

**核心**：座位有了身份，两个 agent 才能共存。

```ts
// 旧：只能按 kind 找，两个 agent 歧义
moveBy('agent', 7, 7)

// 新：按 id 找
moveAs({ participantId: black.id }, 7, 7)
```

关键设计：
- `PlayerSpec.id` **可选**（旧快照没有，设必填编译不过）
- **同名 join = 重连**，拿回原 id 和座位
- **占座会驱逐**原占座者（"添加 AI 对手"需要）
- 旧 `actor` 路径保留，两个 agent 时明确报 `AMBIGUOUS_ACTOR`
- **`join_game` 绑定会话身份**，模型不用传 id，也无法冒充

**GLM 完成的部分**（我审过，质量很好）：
- `f2d7942` ParticipantView 暴露 `participantId`
- `6a2f741` Web 双 AI 观战布局
- `d65b152` **修复：开着的标签页收不到掉线推送**（sweep 跳过有 viewer 的房间，`watchedAt` 删除后这个 skip 只剩副作用）
- `6663ba6` 文档收尾

### 3.4 改名 gomoku-mcp → agent-arena（已完成）

**为什么现在改**：MCP 服务名会进工具名（`mcp__<name>__tool`），客户端配好后再改要重新配。

| 层次 | 改动 |
|---|---|
| 包作用域 | `@gomoku/*` → `@arena/*` |
| MCP 服务名 | `gomoku` → `arena` |
| 环境变量 | `GOMOKU_SERVER_URL` → `ARENA_SERVER_URL` |
| 身份头 | `X-Gomoku-Participant` → `X-Arena-Participant` |
| 接口 | `GomokuApi` → `ArenaApi` |

**保留**：`game: 'gomoku'` 和 `RoomKind: 'gomoku'` 是游戏类型不是项目名；棋盘标题仍是「五子棋」。

### 3.5 duel 脚本（刚完成）

`server/scripts/duel.mjs`，两个 MCP 客户端自动对弈，不需要模型：

```bash
pnpm duel                    # 31 手，黑胜
pnpm duel --strategy hot     # 9 手，走热点雷达
```

**实测通过**，能验证：各自占座、按身份路由、presence 切换、终局判定。

---

## 四、DSH 的 MCP 配置（重点，踩过坑）

**DSH 没有 MCP 配置 GUI**，只能改 `C:\Users\59916\.dsh\profiles\web\cordis.patch.yml`。

**新增插件必须用 `insert:`**：

```yaml
# ✅ 正确
- insert:
    - id: mcp-arena
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: arena
        transport: streamable-http
        url: http://127.0.0.1:3000/mcp

# ❌ 错误：静默跳过，只有一行 stderr 警告
- id: mcp-arena
  name: "@deepseek-ai/dsh-mcp-client"
  config: { ... }
```

验证：
```powershell
node E:\data\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config 2>&1 | Select-String "mcp-arena"
```

**第二个坑**：MCP 工具在**会话启动时**注入。服务晚于会话启动，旧会话拿不到工具，**必须新开会话**。

---

## 五、下一步：P2

**P2 验证的是模型行为，不是协议**（协议已由 `duel.mjs` 和 `dual-agent.test.ts` 证明）。

要验证 6 个问题：

| # | 问题 |
|---|---|
| Q1 | 模型会不会主动 `join_game`，还是直接落子 |
| Q2 | 会不会自觉 `wait_for_turn`，还是抢着下 |
| Q3 | 会不会替对手落子 |
| Q4 | 能否理解 `yourColor` 和 `participants` |
| Q5 | 重连能否靠同名拿回座位 |
| Q6 | 报错能否自我修正 |

**两个客户端**：DSH（执黑，name `dsh`）+ Claude Code（执白，name `claude`），房间 `duel`。

**完整剧本、记录表、坑都在 `docs/HANDOFF-P2.md`**。

---

## 六、给下个会话的建议

### 如果用户说「继续 P2」

1. 先确认 `pnpm duel` 能跑通（协议层就绪）
2. 确认用户在**新会话**里能看到 `mcp__arena__*` 工具
3. 按 `docs/HANDOFF-P2.md` 第 4 节发剧本
4. 记录 Q1–Q6 结果，写 `docs/P2-RESULT.md`

### 如果用户问「能修 XX 吗」

先看 `docs/ROADMAP.md` 确认这属于哪个阶段，别跳步。

### 硬性约束（踩了就返工）

| 约束 | 原因 |
|---|---|
| `PlayerSpec.id` 保持可选 | engine 默认值没 id |
| `GameStatus` 不加新值 | 166 个测试和 MCP 契约连锁 |
| 旧 `actor` 路径保留 | 旧客户端还在用 |
| presence 信号键按座位 | 改 participantId 会牵动 rebindSeats |
| `RoomView`/`RoomSummary` 只增字段 | 网页和旧客户端依赖 |

### 已知的坑

| 坑 | 说明 |
|---|---|
| 热重载不迁移内存状态 | 改 presence/room 后重启服务 |
| **服务重启 = 所有 MCP 会话失效** | 会话表在内存里，重启后旧 `Mcp-Session-Id` 一律 404 `Session not found`；客户端不会自动重连（它只在传输层 onclose 时重连，而 404 只是普通错误）。**重启服务后必须新开客户端会话**，否则工具全部报错 |
| MCP SDK `client.close()` 不发 DELETE | 服务端靠 90 秒静默判定掉线 |
| `wait_for_turn` 的 `moves` 是截断的 | 只带最近 8 手，判断空格要 `get_state` |
| 网页开局会抢座 | 双 AI 场景让 agent 自己 `new_game` |
| 端口 3000 可能被占 | 上一轮的 node 进程可能没退干净 |
| 改完代码别急着重启 3000 | 有对局在跑时重启会杀掉它；要验证修复就在别的端口起独立实例（`$env:PORT=3100`） |

---

## 七、用户的工作方式偏好（观察所得）

- **喜欢串行推进**，不喜欢并行开太多分支（worktree 已清理，只用普通分支）
- **让 GLM 写代码**，我（DSH）负责设计、评审、文档
- **重视文档**，每个阶段都要交接文档
- **要求实测验证**，不接受「测试过了就行」
- 中文交流，界面文案也是中文短句风格
- 会自己动手验证（重启服务、点按钮），发现问题会详细描述现象

---

## 八、关键文件索引

| 文件 | 内容 |
|---|---|
| `docs/ROADMAP.md` | 整体路线、各阶段状态、围棋何时开始 |
| `docs/HANDOFF-P2.md` | **P2 工作单**（当前要做的） |
| `docs/HANDOFF-P1B.md` | P1b 历史记录和约束参考 |
| `docs/PROPOSAL-GO-MCP.md` | 围棋提案（P3 用） |
| `docs/proposals/PROPOSAL-PARTICIPANTS.md` | 参与者模型设计 |
| `docs/proposals/PROPOSAL-AGENT-CHAT.md` | 聊天室设计（P4） |
| `server/scripts/duel.mjs` | 双 AI 自测脚本 |
| `server/src/rooms/participant-roster.ts` | 参与者名册 |
| `server/src/core/presence.ts` | 在线状态注册表 |
| `server/src/core/session-context.ts` | 会话绑定身份 |
| `web/src/store/room.ts` | zustand 房间状态 |
