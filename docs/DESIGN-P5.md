# 设计：P5 大厅 + 棋谱回放

> 状态：设计稿（2026-10-26）
> 前置：[`SESSION-HANDOFF.md`](SESSION-HANDOFF.md) §3.4、[`ROADMAP.md`](ROADMAP.md) P5
> 本文回答**怎么做**；工作单见 [`HANDOFF-P5A.md`](HANDOFF-P5A.md) / [`HANDOFF-P5B.md`](HANDOFF-P5B.md)
>
> **§2 的重放方案已用原型验证**（22 条检查全过，含围棋提子/ko/连续 pass）。
> 验证方法见 §2.6。

---

## 一、范围

P5 原列三件事，C4 已把「WS 统一」做掉，剩两件：

| 项 | 内容 | 工作单 |
|---|---|---|
| **大厅** | 三类房间统一入口：五子棋 / 围棋 / 聊天 | P5A |
| **棋谱回放** | 对局列表 + **可单步前进/后退**的回放页 | P5B |

用户明确要求：**回放要能单步前进后退**，不是只读播放。

---

## 二、回放的核心设计

### 2.1 为什么不能只存快照

单步后退要求**任意一手都能重建棋盘**。落盘文件（`data/rooms/<id>.json`）只有：

```json
{ "id": "...", "state": { 最终状态 }, "history": [ 全部走子 ], "commentary": [...] }
```

`state` 是**最终**状态，没有中间态。所以：

- ❌ **不能**存「每手一份快照」——一盘 300 手的围棋，快照会让文件膨胀几十倍
- ✅ **必须**从初始态逐手重放

### 2.2 重放路径（关键：复用真实引擎，不重写规则）

**不要自己实现「在棋盘上放子/提子」的逻辑。** 现有引擎已经是纯函数，
接受完整 state、返回新 state，规则（提子/劫/自杀/五连）全在里面：

| 游戏 | 开局 | 落子 | 停一手 | 认输 |
|---|---|---|---|---|
| 五子棋 | `startGame(prev, seats, options)` | `applyMove(state, color, row, col, now)` | — | `resignGame` |
| 围棋 | `startGoGame(prev, seats, options)` | `applyGoPlacement(state, color, row, col, now)` | `applyGoPass(state, color, now)` | `resignGoGame` |

**重放算法**：

```text
1. 从落盘的最终 state 里取「不变的那部分」：
   gameId / rules / seats / roomId
2. 用开局函数造初始态（**gameId 必须沿用**，否则对不上）
3. for 每一手 in history:
     按 move.kind 分派到 applyMove / applyGoPlacement / applyGoPass
     把返回的 state 压进 frames[]
4. frames[i] = 第 i 手之后的状态；frames[-1] = 初始态
```

⚠️ **`now` 参数要传 `move.at`**，否则时间戳是「现在」，回放里显示的时间就错了。

⚠️ **`checkTurn` 会校验轮次**。历史是按顺序记录的，正常对局重放必然通过；
但**认输/数子之后如果还有手**（不该发生），重放会失败。
→ **重放失败要报错并保留证据**（AGENTS §7.3），不要静默截断。

### 2.3 边界：认输、数子、终局

`history` 只记**落子和停一手**，不记认输/标死子/确认分数。所以：

| 情况 | 处理 |
|---|---|
| 认输终局 | `history` 里没有「认输」这一手。回放到最后一手，棋盘是对的，但 `status` 会是 `playing` 而非 `finished` |
| 围棋数子 | 标死子/确认分数不在 `history` 里。回放到最后，棋盘是对的，但 `deadStones`/`score` 是空的 |
| 连续 pass 进数子 | **这个在 history 里**（两手下 `GoPassMove`），重放会自动进 `scoring` |

**结论**：回放只保证**棋盘和走子**正确，**不保证**复现终局判定。
回放页要**明确标注**「回放只重演落子，不含认输与数子」，并且：

- 最后一帧如果落盘的最终 `state.status === 'finished'`，显示终局结果（从落盘 state 读，不从重放推）
- 围棋最后一帧如果是 `scoring`，可以只显示「进入数子」

⚠️ **不要试图把认输/数子塞进 history**——那会改变 `history` 的语义，
影响 `MoveRecord` 契约（AGENTS §4.1：类型只增不改）。

### 2.4 复杂度与性能

| 项 | 估算 |
|---|---|
| 五子棋一局 | ≤ 225 手（15×15 满盘），重放 < 10ms |
| 围棋一局 | ≤ 300 手左右，每手 `blockAt` 泛洪，重放 < 50ms |
| 内存 | 每帧一个 board 拷贝：15×15 或 9×9，300 帧约 1–3MB |

**做法**：服务端一次性算出**全部 frames**返回，前端在内存里前进/后退。
不做「按需请求某一手」——那会让单步操作变成网络往返，手感很差。

⚠️ **上限保护**：如果 `history.length > 1000`（异常文件），拒绝并报错，
不要尝试渲染。防止损坏文件把浏览器拖死。

### 2.5 API 形状

```http
GET /api/rooms/:roomId/replay
```

返回：

```json
{
  "roomId": "default",
  "game": "go",
  "gameId": "uuid",
  "rules": { "boardSize": 9, "komi": 7.5 },
  "seats": { "black": {...}, "white": {...} },
  "frames": [
    { "index": 0, "state": { 初始态 }, "move": null },
    { "index": 1, "state": { 第一手后 }, "move": { "color": "black", "row": 2, "col": 2, "at": "..." } }
  ],
  "final": { 落盘的最终 state },   // 用于终局标注，不参与单步
  "commentary": [...],
  "truncated": false
}
```

⚠️ **`frames` 只增字段，不改现有 `/api/rooms/:id` 的返回**。
回放是**新增端点**，不碰旧契约（AGENTS §7.4）。

### 2.6 原型验证结果（写工作单之前就验过）

**没有验证过的方案不写进工作单。** 用 `tsx` 跑了一个原型，直接调真实引擎：

| 用例 | 结果 |
|---|---|
| 五子棋 9 手到五连 | 每一帧棋盘与真实对局一致；`gameId` 沿用；时间戳保留 |
| **围棋提子**（黑围死白子） | 每一帧一致；`captures` / `lastCaptured` 都正确重建；**提子前一帧白子还在** |
| 围棋连续 pass 进数子 | 重放也进 `scoring`，`consecutivePasses = 2` |
| 损坏 history（错误轮次） | **抛错并带手数**，不静默截断 |

```text
PASS 22   FAIL 0
REPLAY DESIGN VERIFIED
```

原型脚本是临时的，已删除（按 AGENTS §6.3 不提交）。
关键结论：**重放不需要自己实现任何规则**，`applyGoPlacement` /
`applyGoPass` / `applyMove` 全部是纯函数且接受完整 state，
提子、劫、自杀、五连判定都由引擎负责。

---

## 三、大厅设计

### 3.1 数据来源

现有两类列表端点：

| 端点 | 返回 |
|---|---|
| `GET /api/rooms` | 棋类房间（`RoomSummary[]`） |
| `GET /api/chat/rooms` | 聊天房间（`ChatRoomSummary[]`） |

**不合并成一个新端点**——两个领域对象不同，合并会让 `shared` 出现
「union of two summaries」这种谁都不满意的类型。大厅前端**并行请求两个**，
在渲染层合并成统一卡片。

### 3.2 卡片显示什么

| 字段 | 棋类来源 | 聊天来源 |
|---|---|---|
| 类型 | `game`（gomoku / go） | 固定「聊天」 |
| 状态 | `status` + `phase` | `phase` |
| 参与者 | `participants[].label` | `members[].name` |
| 最后活动 | `updatedAt` | `updatedAt` |
| 规模 | `moveCount` 手 | `messageCount` 条 / `hop` |

⚠️ **聊天室没有 presence**（AGENTS §4.2），**不要显示「在线」**。

### 3.3 路由

```text
/                        → 大厅（新首页）
/?room=<id>              → 棋类（不变）
/?room=<id>&kind=chat    → 聊天（不变）
```

⚠️ **这是本次唯一的破坏性变更**：`/` 从「默认棋类房间」变成「大厅」。
但 `?room=` 路径完全不变，**旧书签照常工作**。

替代方案是 `/lobby` 新路径、`/` 保持默认房间。**不选**，因为大厅就是首页才合理，
而 `?room=` 已经覆盖了「直达某个房间」的需求。

---

## 四、拆分

| 工作单 | 内容 | 依赖 |
|---|---|---|
| [`HANDOFF-P5A.md`](HANDOFF-P5A.md) | 回放 API + 回放页（含单步控制） | 无 |
| [`HANDOFF-P5B.md`](HANDOFF-P5B.md) | 大厅页 + 路由改动 | 无 |

**A 和 B 互不依赖**，可以并行，也可以串行。建议**先 A**——回放是技术难点，
大厅是纯展示。A 做完如果发现重放有坑，B 不受影响。

---

## 五、明确不做

| 不做 | 原因 |
|---|---|
| ❌ 回放时重新跑 AI | 那是「重演」不是「回放」 |
| ❌ 把认输/数子写进 `history` | 改契约语义 |
| ❌ 每手存快照 | 文件膨胀 |
| ❌ 回放支持编辑/分叉 | 那是棋谱编辑器 |
| ❌ 合并两个列表端点 | 领域对象不同 |
| ❌ 聊天室回放 | 聊天是消息流，不是棋谱 |
