# agent-arena

给 AI Agent 玩的本地竞技场：房间里有棋盘、参与者和在线状态，通过 MCP 把同一局棋暴露给任意标准 MCP 客户端。

当前支持**五子棋**：人类 vs AI，或两个 AI 互相对弈、人类观战。围棋与聊天室在规划中（见 [`docs/ROADMAP.md`](docs/ROADMAP.md)）。

## 状态

P1a + P1b 完成：参与者模型（稳定 id、同名重连、会话绑定身份）、双 AI 对弈、在线状态（等待中 / 思考中 / 已断开）、观战布局。**166 个测试**，含双 agent 端到端集成用例。

下一步是 P2（真实模型对弈验证），见 [`docs/HANDOFF-P2.md`](docs/HANDOFF-P2.md)。

## Agent 视图：LLM 友好的棋盘表达

实测发现 LLM 逐格数 15×15 嵌套数组会出错（漏看斜线跳四）。因此 MCP 响应不再返回 `state.board` 数组，改为三件套：

- `state.boardText`：等宽棋盘图（`X`=黑 `O`=白 `.`=空，小写=最新一手，`#`/`@`=五连），行号两位补零、列号空白分隔，任何数字都不会黏连；
- `state.moves`：走子记录。`wait_for_turn` / `place_stone` / `resign` / 错误只带最近 8 手并用 `movesOmitted` 标注省略了多少（`get_state` 永远全量）；历史不可得时 `movesOmitted = moveCount`，不伪装成空历史；
- `state.hotPoints`：双方所有"落子即成威胁"的点，分级 `win`（落子成五）> `open4`（落子成开四双杀）> `four`（冲四，`fiveAt` 即成五/必挡点）> `open3`（活三，参考级，有数量上限）。`win` 与 `fiveAt` 均经规则引擎 `findWinLine` 校验，`overlineWin` / `winLength` 变体语义一致。`double` 表示同一手制造两个独立必应威胁（`four+open3` 或双活三），`open3At` 给出活三拆点；同方向的 four+three 不合并。

payload 实测（100 手中盘）：热路径 2470 字符（全量历史版本为 6600，旧裸 `GameState` 为 1732）。防守纪律已写入 SERVER_INSTRUCTIONS 与工具描述：对手 open4 候选点必须本手直接占掉该点本身；对手 double 本手优先占点（four+open3 可拆，双活三必须占点）；对手 four 本手挡 `fiveAt`。演示：`node scripts/demo-agent-view.mjs`（第一局决定胜负的那一步）与 `node scripts/replay-game2.mjs`（第二局 25 手，含 `(4,7)` 四三杀）。

## 界面预览

![五子棋界面：木色棋盘、交叉点落子与 AI 互动面板](docs/ui-preview.png)

## 快速开始

要求 Node.js ≥ 20、pnpm ≥ 10。

### 开发模式

```bash
pnpm install
pnpm dev
```

- 网页：<http://localhost:5173/?room=default>
- 后端 REST / MCP：<http://127.0.0.1:3000>
- `pnpm dev` 会同时启动 `shared` 增量编译、后端 `tsx watch` 与 Vite（`/api`、`/ws` 已代理到 3000）

### 生产模式

```bash
pnpm build
pnpm start
```

打开 <http://127.0.0.1:3000/>。单进程同时提供页面静态资源、REST / WebSocket 与 MCP HTTP。

### 测试与检查

```bash
pnpm test        # 引擎、房间、HTTP/WS/MCP 集成测试
pnpm typecheck   # server + web 类型检查
```

### 双 AI 自测

不用模型也能验证双 agent 协议：两个 MCP 客户端各占一色，自动下完一盘。

```bash
pnpm duel                    # 两个机器人对弈，约 31 手
pnpm duel --strategy hot     # 走服务器的热点雷达，约 9 手结束
pnpm duel --room duel2 --keep
```

脚本走的是和真实模型完全相同的路径（`join_game` → `wait_for_turn` → `place_stone`），
输出每手的坐标、走子理由和双方 presence。**接真实模型前先跑这个**，能区分「环境没配好」和「模型行为有问题」。

## 接入 MCP 客户端

先启动后端，再任选一种传输：

| 方式 | 配置 |
|---|---|
| Streamable HTTP | URL `http://127.0.0.1:3000/mcp` |
| stdio 桥接 | `node <项目目录>/server/dist/mcp/stdio.js` |

stdio 桥接本身不保存棋局，所有操作通过 REST 转给已启动的后端；可用 `ARENA_SERVER_URL` 指定后端地址（默认 `http://127.0.0.1:3000`）。后端未启动时工具会返回明确的连接错误。

仓库根目录的 `.mcp.json` 已按 HTTP 方式配好项目级 MCP。工具共 6 个：

| 工具 | 作用 |
|---|---|
| `new_game` | 开新局，指定 AI 执黑 / 白 |
| `get_state` | 读取完整棋局 |
| `wait_for_turn` | 长轮询，挂起直到 AI 该落子 / 结束 / 超时 |
| `place_stone` | AI 落子 |
| `resign` | AI 认输 |
| `say` | 对玩家说一句解说，网页实时展示 |

对 Agent 直接说：

> 用 arena 工具和我下一局五子棋。每步先用 say 评价我的落子，落子后再评论一下局势，输赢时给点反应。

## 对局流程

1. 网页点「执黑开局」或「执白开局」（AI 执另一种颜色）；
2. Agent 调用 `wait_for_turn` 等待人类落子；
3. 你落子后 Agent 被唤醒：`say` 评价 → `place_stone` → `say` 评论局势 → 再次 `wait_for_turn`；
4. 网页通过 WebSocket 实时同步落子与解说，断线后指数退避重连，并用 `hello` 恢复状态与最近解说；
5. 对局结束展示结果，可一键「再来一局」。

`wait_for_turn` 默认等待 20s（1s–60s 可调）。超时不是错误：Agent 会拿到 `reason=timeout` 并再次调用，等待成本留在服务端。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | HTTP / MCP 端口 |
| `HOST` | 127.0.0.1 | 监听地址，默认仅本机 |
| `WAIT_DEFAULT_MS` | 20000 | `wait_for_turn` 默认超时 |
| `WAIT_MAX_MS` | 60000 | `wait_for_turn` 上限 |
| `ARENA_SERVER_URL` | `http://127.0.0.1:3000` | stdio 桥接访问的后端地址，也用于 Vite 代理 |
| `DEFAULT_ROOM_ID` | default | 默认房间 |

## 架构

```
core/       纯规则与纯函数，零 I/O
rooms/      房间编排：状态、waiters、互动日志、历史
http/       REST + WebSocket
mcp/        ArenaApi 接口、6 个工具、HTTP 入口、stdio 桥接
web/        Vite + React，只依赖 shared 类型与 REST/WS 协议
```

- 棋局状态只有一份，在提供 Web 服务的后端进程里；
- HTTP MCP 与 REST/WS 同进程直接共享 `RoomManager`，stdio 桥接是独立进程但只做 REST 转发；
- 互动解说走独立 WS 事件，不改变棋局 `version`；
- v1 内存态，重启回到 idle；规则引擎、房间、传输彼此解耦，后续可换仓储或增加规则变体。

完整设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 已知限制（v1 范围）

- 无禁手、悔棋、计时器；15×15 黑先，五连（含长连）获胜；
- 无账号与鉴权，仅监听回环地址；
- 前端只使用 `default` 房间，多房间可经 REST / MCP 的 `roomId` 使用但暂无 UI；
- 解说出自模型主动调用 `say`，服务端不会生成假解说；
- 同一时间只让一个 Agent 操作 agent 座位。
