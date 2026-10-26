# 工作单 P5A：棋谱归档 + 回放（可单步前进/后退）

> 面向：GLM
> 状态：`main` 干净，302 测试全绿（`c9ec38c`）
> 分支：从最新 main 新建 `feat/replay`
> 预计：2–2.5 天
> **先读 [`DESIGN-P5.md`](DESIGN-P5.md) §一之二（归档）和 §2（回放）**——
> 回放方案已用原型验证过，照着做

---

## 0. 边界

**做**：

1. **归档**：开新局前把旧棋谱存到 `data/archive/`，每房间保留最近 N 局
2. `GET /api/archive` —— 历史对局列表
3. `GET /api/rooms/:roomId/replay` —— 当前局回放
4. `GET /api/archive/:archiveId/replay` —— 归档局回放
5. 回放页：棋盘 + 单步前进/后退 + 跳到首/末 + 进度条 + 键盘

**不做**（做了返工）：

| 不做 | 原因 |
|---|---|
| ❌ 大厅 | P5B |
| ❌ 回放时重跑 AI | 那是「重演」不是「回放」 |
| ❌ 把认输/数子写进 `history` | 改契约语义，AGENTS §4.1 |
| ❌ 每手存快照 | 文件膨胀几十倍 |
| ❌ 归档全量加载进内存 | 按需读取 |
| ❌ 聊天室回放 | 聊天是消息流，不是棋谱 |

---

## 1. 第一部分：归档

### 1.1 为什么必须做

**不归档的话，回放只能看当前这一局。** `GameRoom.newGame()`（`room.ts:539`）：

```ts
this.history = [];        // ← 开新局就清空
this.commentaryLog = [];
this.save();              // ← 立刻覆盖落盘文件
```

实测：`data/rooms/default.json` 现在是 `history: 0`、`gameId: ""`——
之前下过的对局已经被覆盖，**永久丢失**。

### 1.2 ⚠️ 归档时机（最容易写错的地方）

`newGame()` 的实际执行顺序：

```text
L508  const prev = this.state;        ← 旧 state 在这里
L518  this.state = startGoGame(...)   ← 已经换成新局
L533  this.state = startGame(...)
L539  this.history = [];              ← 历史在这里才清空
```

**必须在 `L508` 拿到 `prev` 之后、`L518` 之前归档。**
在 `L539` 附近归档太晚——那时 `this.state` 已经是新局了。

> **这个判断已用原型验证**（15 条检查全过）。关键证据：
> `newGame()` 之后取 `this.history` 是**空的**——
> 如果在 L539 附近归档，归档到的棋谱就是空的，`state` 也是新局。
> 必须用 `prev`。

```ts
const prev = this.state;

// Archive the game we are leaving, before any of it is overwritten.
// A room that never started (gameId === '') has nothing to archive.
if (prev.gameId !== '' && this.history.length > 0) {
  this.repository.archive({
    id: this.id,
    state: prev,
    history: [...this.history],
    commentary: [...this.commentaryLog],
  });
}

// ... then the existing startGoGame / startGame calls
```

⚠️ **两个条件都要判**：
- `prev.gameId !== ''` —— `idle` 房间的 `gameId` 是空字符串
- `this.history.length > 0` —— 只开局没落子的空对局不值得占位

### 1.3 文件布局

```text
<dataDir>/archive/<roomId>__<gameId>.json
```

⚠️ **用 `__` 分隔，不要用 `-`**。`roomId` 本身允许 `-`
（`ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/`），用 `-` 会解析歧义。

⚠️ **`archiveId` 校验**：`^[a-zA-Z0-9_-]{1,80}$`。
文件名从 id 拼出来，这是**唯一的路径穿越攻击面**。

### 1.4 保留最近 N 局

| 项 | 值 |
|---|---|
| 默认 N | **20** |
| 配置 | `ARENA_ARCHIVE_LIMIT`（照 `config.ts` 的 `readInteger` 模式） |
| 范围 | 1–500，超范围钳制 |
| 粒度 | **按房间分别保留**，不是全局 |
| 清理时机 | 每次归档后，扫该房间的归档，按 mtime 删最旧的 |

⚠️ **按房间算**：全局 N 会让一个活跃房间挤掉所有其他房间的历史。

⚠️ **清理失败不能让开新局失败**：归档是旁路，删旧文件失败**只记日志**。

### 1.5 归档不参与启动恢复

`restoreAll()` **不加载归档**。归档是只读历史，按需读取。
归档文件损坏时：**跳过、记日志、文件留磁盘**（AGENTS §7.3）。

---

## 2. 第二部分：回放

### 2.1 重放算法（已验证，照抄）

`DESIGN-P5.md` §2.2 的方案已用原型跑通 22 条检查。**复用真实引擎，
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

### 2.2 三个必须做对的细节

| 细节 | 为什么 |
|---|---|
| **`gameId` 沿用落盘的** | `startGame` / `startGoGame` 会新生成一个，不覆盖就对不上 |
| **`now` 传 `move.at`** | 否则每帧时间戳都是「现在」 |
| **重放失败要抛错带手数** | 不要静默截断到出错前 |

---

## 3. API 契约

### 3.1 归档列表

```http
GET /api/archive
```

```jsonc
[
  {
    "archiveId": "default__4d3f7280",
    "roomId": "default",
    "game": "go",
    "gameId": "4d3f7280-...",
    "moveCount": 42,
    "winner": "white",           // "black" | "white" | "draw" | null
    "endReason": "scored",       // "resign" | "scored" | "draw" | null
    "playedAt": "2026-10-26T07:50:08.458Z",   // 最后一手的时间
    "seats": { "black": {...}, "white": {...} }
  }
]
```

排序：`playedAt` 降序。

⚠️ `winner` / `endReason` 从归档的 `state` 里读，**不要自己推**。

### 3.2 两个回放端点

```http
GET /api/rooms/:roomId/replay        → 当前局
GET /api/archive/:archiveId/replay   → 归档局
```

**返回同一个结构**：

```jsonc
{
  "roomId": "default",
  "archiveId": null,               // 归档局时为 "default__4d3f7280"
  "game": "go",
  "gameId": "uuid",
  "rules": { "boardSize": 9, "komi": 7.5, "koRule": "simple" },
  "seats": { "black": { "kind": "human", "label": "你" }, "white": {...} },
  "frames": [
    { "index": 0, "state": { /* 开局 */ }, "move": null },
    { "index": 1, "state": { /* 第一手后 */ },
      "move": { "color": "black", "row": 2, "col": 2, "index": 1, "at": "..." } }
  ],
  "final": { /* 落盘/归档的最终 state，用于终局标注 */ },
  "commentary": [ /* Commentary[] */ ]
}
```

### 3.3 错误

| 情况 | 状态码 | code |
|---|---|---|
| 房间不存在 | 404 | `ROOM_NOT_FOUND` |
| 归档不存在 | 404 | `ARCHIVE_NOT_FOUND` |
| `archiveId` 格式非法 | 400 | `INVALID_REQUEST` |
| 没有进行过对局（`history` 空且 `status === 'idle'`） | 400 | `NO_MOVES` |
| `history.length > 1000` | 400 | `REPLAY_TOO_LONG` |
| 重放失败（数据损坏） | 500 | `REPLAY_FAILED`，message 带手数 |

⚠️ **`REPLAY_TOO_LONG` 不是静默截断**——拒绝并说明原因（AGENTS §7.3）。

---

## 4. 前端

### 4.1 路由

```text
/?room=<id>&view=replay    → 当前局回放
/?archive=<archiveId>      → 归档局回放
```

⚠️ **用 `view=replay`，不要用 `kind=replay`**——`kind` 已被聊天占用。

### 4.2 控件

| 控件 | 行为 |
|---|---|
| ⏮ | `index = 0` |
| ◀ | `index -= 1`，到 0 停 |
| ▶ | `index += 1`，到 `frames.length - 1` 停 |
| ⏭ | `index = frames.length - 1` |
| 进度条 | 拖动直接跳 |

**键盘**：`←` / `→` 上下一手，`Home` / `End` 首末。

⚠️ **单步是纯内存操作**，不要再请求服务端。

### 4.3 复用棋盘

**复用现有 `Board.tsx` / `GoBoard.tsx`**。它们是交互式的，需要只读模式：

- 如果已有 `readOnly` / `disabled` 之类的 prop，直接用
- 没有的话**加一个可选 prop**（只增不改）

⚠️ **不要复制棋盘组件**——星位、坐标、提子标记会有两处要维护。

### 4.4 显示

| 区域 | 内容 |
|---|---|
| 棋盘 | `frames[index].state.board` |
| 手数 | `第 {index} / {frames.length - 1} 手` |
| 当前手 | `黑 (2,2) · 12:34` / 「开局」/ 「白 pass」 |
| 提子标记 | `state.lastCaptured`（围棋） |

### 4.5 终局标注（重要）

**回放只重演落子，不含认输与数子。**

- `final.status === 'finished'` 时，最后一手显示胜负：
  - 五子棋：`黑胜 · 五连`
  - 围棋：`白胜 · 数子` / `黑胜 · 认输`
- **棋盘来自 `frames`，胜负文字来自 `final`**

⚠️ **页面必须标注**「回放只重演落子，不含认输与数子」。

### 4.6 数子阶段

重放中途进 `scoring`（连续两手 pass）时：显示「进入数子」，棋盘照常。
**不要**显示 `deadStones`（回放里没有标死子记录）。

---

## 5. 硬约束

| 约束 | 原因 |
|---|---|
| **不改 `/api/rooms/:id` 的返回** | 新增端点，旧契约不动 |
| **`archiveId` 必须校验格式** | 路径穿越的唯一攻击面 |
| **归档文件名用 `__` 分隔** | `roomId` 允许 `-` |
| **归档失败不阻塞开新局** | 旁路，只记日志 |
| **不改 `shared/src/game.ts` 现有类型** | 只增字段 |
| **不自己实现提子/劫/五连** | 复用引擎 |
| **重放失败要抛错** | 不静默截断 |
| **单步不发请求** | `frames` 一次拿全 |

---

## 6. 易错点

| 坑 | 说明 |
|---|---|
| **归档时机错（在 L539 附近）** | `this.state` 已是新局，归档的是新局。必须在 L508 后 |
| **忘了判 `gameId === ''`** | `idle` 房间会归档一个空对局 |
| **忘了判 `history.length > 0`** | 只开局没落子也占一个归档位 |
| **文件名用 `-` 分隔** | `roomId` 含 `-` 时解析歧义 |
| **`archiveId` 不校验** | 路径穿越 |
| **全局 N 而不是按房间 N** | 一个活跃房间挤掉所有历史 |
| **归档失败就 throw** | 开新局失败，用户莫名其妙 |
| **忘了覆盖 `gameId`** | `startGame` 会新生成 |
| **`now` 没传 `move.at`** | 时间戳全变「现在」 |
| **`frames[0]` 当第一手** | `frames[0]` 是**开局**，第 N 手是 `frames[N]` |
| **进度条上限用 `frames.length`** | 应该是 `frames.length - 1` |
| **`NO_MOVES` 用 500** | 数据问题不是服务错误，用 400 |
| **终局文字从 `frames` 推** | 认输/数子不在 history 里 |

---

## 7. 测试清单

**归档**：

| # | 测试 | 断言 |
|---|---|---|
| A1 | 开新局触发归档 | `data/archive/` 出现文件，内容等于旧局 |
| A2 | **归档的是旧局不是新局** | 归档里 `gameId` / `history` 是旧的 |
| A3 | `idle` 房间开新局不归档 | `gameId === ''` 时不产生文件 |
| A4 | 没落子的局不归档 | `history.length === 0` 时不产生文件 |
| A5 | 保留最近 N 局 | 开 N+1 局后，最旧的被删，剩 N 个 |
| A6 | **按房间分别保留** | 房间 A 满 N 局不影响房间 B |
| A7 | 归档失败不阻塞 | mock 写失败，`newGame` 仍成功 |
| A8 | 归档不参与启动恢复 | 重启后 `RoomManager` 里没有归档房间 |

**回放**：

| # | 测试 | 断言 |
|---|---|---|
| R1 | 五子棋完整对局 | `frames.length === history.length + 1` |
| R2 | 每帧棋盘正确 | 与逐步重放一致 |
| R3 | **围棋提子** | `captures` 正确；提子前一帧被提的子还在 |
| R4 | 连续 pass | 重放也进 `scoring` |
| R5 | `gameId` 沿用 | `frames[0].gameId === final.gameId` |
| R6 | 时间戳保留 | `frames[1].move.at === history[0].at` |
| R7 | 归档局回放 | 内容与归档文件一致 |
| R8 | 空房间 | 400 `NO_MOVES` |
| R9 | 房间/归档不存在 | 404 |
| R10 | **`archiveId` 非法** | 400 `INVALID_REQUEST`（试 `../`、`a/b`） |
| R11 | **损坏 history** | 500 `REPLAY_FAILED`，message 含手数 |
| R12 | 超长 history | 400 `REPLAY_TOO_LONG` |
| R13 | 不改旧端点 | `GET /api/rooms/:id` 结构不变 |

**前端**：

| # | 测试 | 断言 |
|---|---|---|
| F1 | 单步前进/后退 | 棋盘跟着变，`第 N / M 手` 正确 |
| F2 | 首末边界 | 第一手按「上一手」不动；最后一手按「下一手」不动 |
| F3 | 进度条 | 跳到对应手 |
| F4 | 键盘 ←/→ | 等价于按钮 |
| F5 | 提子正确显示 | 提子那手之后，被提位置变空 |
| F6 | 终局标注 | 最后一手显示胜负文字 |

---

## 8. 验收标准

- [ ] `pnpm typecheck` 干净
- [ ] `pnpm test` 全绿（当前 302，新增后 >325）
- [ ] **A2 / A5 / A6** 是归档核心：归档旧局、保留 N 局、按房间独立
- [ ] **R3 / R10 / R11** 是回放核心：提子、路径穿越、损坏数据
- [ ] `node scripts/chat-duel.mjs` 仍全绿
- [ ] 棋类正常对局不受影响
- [ ] 提交信息用英文，正文说**为什么**

---

## 9. 做完就停

不要做大厅（P5B）、不要动聊天室、不要改 `history` 语义。

> P5B 会读你的 `GET /api/archive`，所以那个端点的返回结构别改。
