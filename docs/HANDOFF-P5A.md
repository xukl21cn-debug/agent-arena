# 工作单 P5A：棋谱回放（可单步前进/后退）

> 面向：GLM
> 状态：`main` 干净，302 测试全绿（`b6e0463`）
> 分支：从最新 main 新建 `feat/replay`
> 预计：1–1.5 天
> **先读 [`DESIGN-P5.md`](DESIGN-P5.md) §2**——方案已经用原型验证过，照着做

---

## 0. 边界

**做**：

- 新增 `GET /api/rooms/:roomId/replay` 端点
- 回放页：棋盘 + 单步前进/后退 + 跳到首/末 + 进度条
- 回放页显示每手的时间、颜色、坐标

**不做**（做了返工）：

| 不做 | 原因 |
|---|---|
| ❌ 大厅 | 那是 P5B，独立工作单 |
| ❌ 回放时重跑 AI | 那是「重演」不是「回放」 |
| ❌ 把认输/数子写进 `history` | 改契约语义，AGENTS §4.1 |
| ❌ 每手存快照 | 文件膨胀几十倍 |
| ❌ 聊天室回放 | 聊天是消息流，不是棋谱 |
| ❌ 改 `/api/rooms/:id` 的返回 | 新增端点，不碰旧契约 |

---

## 1. 核心：重放算法（已验证，照抄）

`DESIGN-P5.md` §2.2 的方案已用原型跑通 22 条检查。**直接复用真实引擎，
不要自己实现提子/劫/五连判定。**

```ts
// 五子棋
let state = startGame({ roomId, version: 0, rules }, seats, { rules });
state = { ...state, gameId };            // ⚠️ 必须沿用落盘的 gameId
frames.push(state);
for (const move of history) {
  const r = applyMove(state, move.color, move.row, move.col, move.at);
  if (!r.ok) throw new ReplayError(move.index, r.code, r.message);
  state = r.state;
  frames.push(state);
}

// 围棋
let state = startGoGame({ roomId, version: 0 }, seats, { rules, gameId });
frames.push(state);
for (const move of history) {
  const r = move.kind === 'pass'
    ? applyGoPass(state, move.color, move.at)
    : applyGoPlacement(state, move.color, move.row, move.col, move.at);
  if (!r.ok) throw new ReplayError(move.index, r.code, r.message);
  state = r.state;
  frames.push(state);
}
```

### 三个必须做对的细节

| 细节 | 为什么 |
|---|---|
| **`gameId` 沿用落盘的** | `startGame` / `startGoGame` 会新生成一个，不覆盖就对不上 |
| **`now` 传 `move.at`** | 否则每帧时间戳都是「现在」，回放里显示的时间全错 |
| **重放失败要抛错，带手数** | AGENTS §7.3「失败要可诊断」。**不要静默截断到出错前** |

---

## 2. API 契约

```http
GET /api/rooms/:roomId/replay
```

**成功 200**：

```jsonc
{
  "roomId": "default",
  "game": "go",                    // "gomoku" | "go"
  "gameId": "uuid",
  "rules": { "boardSize": 9, "komi": 7.5, "koRule": "simple" },
  "seats": { "black": { "kind": "human", "label": "你" }, "white": {...} },
  "frames": [
    {
      "index": 0,
      "state": { /* 开局状态 */ },
      "move": null
    },
    {
      "index": 1,
      "state": { /* 第一手之后 */ },
      "move": { "color": "black", "row": 2, "col": 2, "index": 1, "at": "..." }
    }
  ],
  "final": { /* 落盘的最终 state，用于终局标注 */ },
  "commentary": [ /* 现有 Commentary[] */ ],
  "truncated": false,
  "limitReason": null              // "TOO_LONG" 时有值
}
```

**错误**：

| 情况 | 状态码 | code |
|---|---|---|
| 房间不存在 | 404 | `ROOM_NOT_FOUND` |
| 没有进行过对局（`history` 为空且 `status === 'idle'`） | 400 | `NO_MOVES` |
| `history.length > 1000` | 400 | `REPLAY_TOO_LONG` |
| 重放失败（数据损坏） | 500 | `REPLAY_FAILED`，message 带手数 |

⚠️ **`REPLAY_TOO_LONG` 不是 `truncated: true` 静默截断**——
拒绝并说明原因，别给一半的棋谱（AGENTS §7.3）。

---

## 3. 前端

### 3.1 路由

```text
/?room=<id>&view=replay    → 回放页
```

⚠️ **用 `view=replay`，不要用 `kind=replay`**——`kind` 已经被聊天占用（`kind=chat`），
复用它会让 `ws.ts` 的分派逻辑变模糊。

### 3.2 控件

| 控件 | 行为 |
|---|---|
| ⏮ 第一手 | `index = 0` |
| ◀ 上一手 | `index -= 1`，到 0 停 |
| ▶ 下一手 | `index += 1`，到 `frames.length - 1` 停 |
| ⏭ 最后一手 | `index = frames.length - 1` |
| 进度条 | 拖动直接跳到任意手 |

**键盘**：`←` / `→` 上下一手，`Home` / `End` 首末。

⚠️ **单步是纯内存操作**，不要再请求服务端。`frames` 一次性拿全。

### 3.3 棋盘复用

**复用现有 `Board.tsx` / `GoBoard.tsx`**，但它们是交互式的（点击落子）。
需要确认它们支持只读模式：

- 如果支持 `readOnly` 或 `disabled` 之类的 prop，直接用
- 如果不支持，**加一个可选 prop**（只增不改，AGENTS §4.1）

⚠️ **不要在回放页复制一份棋盘组件**。棋盘渲染逻辑（星位、坐标、提子标记）
复制一份就会有第二处要维护。

### 3.4 显示什么

| 区域 | 内容 |
|---|---|
| 棋盘 | `frames[index].state.board` |
| 手数 | `第 {index} / {frames.length - 1} 手` |
| 当前手 | `黑 (2,2) · 12:34` 或「开局」或「白 pass」 |
| 提子标记 | `state.lastCaptured`（围棋） |
| 终局标注 | 见 §3.5 |

### 3.5 终局标注（重要）

**回放只重演落子，不含认输与数子**（`DESIGN-P5.md` §2.3）。

- 如果 `final.status === 'finished'`，在最后一手时显示：
  - 五子棋：`黑胜 · 五连`
  - 围棋：`白胜 · 数子` 或 `黑胜 · 认输`
- 但**棋盘内容来自 `frames`，胜负文字来自 `final`**

⚠️ **必须标注**「回放只重演落子，不含认输与数子」，
否则用户会以为回放漏了什么。

### 3.6 围棋数子阶段的显示

如果重放中途进了 `scoring`（连续两手 pass），从那一帧起：

- 显示「进入数子」
- 棋盘照常显示
- **不要**显示 `deadStones`（回放里没有标死子记录）

---

## 4. 硬约束

| 约束 | 原因 |
|---|---|
| **不改 `/api/rooms/:id` 的返回** | 新增端点，旧契约不动 |
| **不改 `shared/src/game.ts` 的现有类型** | 只增字段 |
| **不改 `rooms/` / `core/presence.ts` / `mcp/tools.ts`** | 硬约束 |
| **不自己实现提子/劫/五连** | 复用 `core/go.ts` / `core/engine.ts` |
| **重放失败要抛错** | 不静默截断 |
| **`history.length > 1000` 拒绝** | 防损坏文件拖死浏览器 |
| **单步不发请求** | `frames` 一次拿全 |

---

## 5. 易错点

| 坑 | 说明 |
|---|---|
| **忘了覆盖 `gameId`** | `startGame` 会新生成，回放页显示的 gameId 和真实对局对不上 |
| **`now` 没传 `move.at`** | 每帧时间戳变成「现在」，回放里的时间全错 |
| **自己重算提子** | 必然和引擎有偏差（ko 的判定尤其容易错）。用 `applyGoPlacement` |
| **`frames[0]` 当成第一手** | `frames[0]` 是**开局**，第 N 手是 `frames[N]` |
| **回放页复制棋盘组件** | 会有两处要维护。加只读 prop |
| **进度条用 `frames.length` 当上限** | 应该是 `frames.length - 1`（最后一手的索引） |
| **`NO_MOVES` 用 500** | 那是数据问题，不是服务错误。用 400 |
| **终局文字从 `frames` 推** | 认输/数子不在 history 里，推不出来。用 `final` |

---

## 6. 测试清单

**服务端**（走真实 HTTP）：

| # | 测试 | 断言 |
|---|---|---|
| R1 | 五子棋完整对局 → replay | `frames.length === history.length + 1` |
| R2 | 每一帧棋盘正确 | 与逐步重放的真实状态一致 |
| R3 | **围棋提子** | `frames[k].captures` 正确；提子前一帧被提的子还在 |
| R4 | 围棋连续 pass | 重放也进 `scoring` |
| R5 | `gameId` 沿用落盘值 | `frames[0].gameId === final.gameId` |
| R6 | 时间戳保留 | `frames[1].move.at === history[0].at` |
| R7 | 空房间 | 400 `NO_MOVES` |
| R8 | 房间不存在 | 404 `ROOM_NOT_FOUND` |
| R9 | **损坏 history 报错** | 500 `REPLAY_FAILED`，message 含手数 |
| R10 | 超长 history | 400 `REPLAY_TOO_LONG` |
| R11 | **不改旧端点** | `GET /api/rooms/:id` 返回结构不变 |

**前端**（手工 + 浏览器脚本）：

| # | 测试 | 断言 |
|---|---|---|
| R12 | 单步前进/后退 | 棋盘跟着变，`第 N / M 手` 正确 |
| R13 | 首末边界 | 在第一手按「上一手」不动；最后一手按「下一手」不动 |
| R14 | 进度条拖动 | 跳到对应手 |
| R15 | 键盘 ←/→ | 等价于按钮 |
| R16 | 围棋提子在回放里正确显示 | 提子那一手之后，被提位置变空 |
| R17 | 终局标注 | 最后一手显示胜负文字 |

---

## 7. 验收标准

- [ ] `pnpm typecheck` 干净
- [ ] `pnpm test` 全绿（当前 302，新增后 >312）
- [ ] R3/R9 是**核心**：提子重放正确、损坏数据报错
- [ ] `node scripts/chat-duel.mjs` 仍全绿（不能伤到聊天）
- [ ] 棋类页面手工验收：正常对局不受影响
- [ ] 提交信息用英文，正文说**为什么**

---

## 8. 做完就停

不要做大厅、不要动聊天室、不要改 `history` 语义。
大厅是 P5B，独立工作单。
