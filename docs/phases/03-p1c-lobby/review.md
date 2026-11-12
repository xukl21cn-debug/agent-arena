# 评审：P1c 大厅 / 准备 / 房间阶段

> 评审人：DSH
> 对象：`feat/lobby` @ `d898fee`（21 文件，+826/−28）
> 结论：**通过，合入 main**（附一个设计缺口，见 §5）

---

## 1. 结论

| 项 | 结果 |
|---|---|
| 范围 | ✅ `server/src/core/` 零改动 |
| `GameStatus` | ✅ 一字未动，只加了 `phase` 字段 |
| 测试 | ✅ 206 全绿（193 现有 + 13 新增，零破坏） |
| 类型 / 构建 | ✅ typecheck 通过，web 构建通过 |
| 端到端实测 | ✅ 真实服务 26 项 REST/MCP 检查 + 真实 Chromium 点击，全部通过 |
| 判定 | **通过** |

---

## 2. 关键约束核验

### 2.1 `GameStatus` 确实没动

```text
shared/src/game.ts
+ import type { RoomPhase } from './participant.js';
+ phase: RoomPhase;          // RoomView
+ phase: RoomPhase;          // RoomSummary
```

`GameStatus` 定义（`idle/playing/finished`）完全没有出现在 diff 里。✅

这是工作单里标为「踩了就返工」的第一条，做对了。

### 2.2 旧流程仍然立即开局（R5）

实测：

```text
1. 建房间，一个 agent 入座黑，未 ready
   → phase = lobby ✅

2. POST /api/rooms/legacy-test/games { agentColor: 'black' }
   → state.status = playing ✅
   → phase = playing，全程没有任何 ready 调用 ✅
   → 已入座者被自动标 ready ✅
```

最后一条是实现里额外加的，很关键：**进行中的对局不能读成「还在集合」**。

### 2.3 `phase` 是派生值，不落库

GLM 的选择：`playing`/`finished` 由对局状态回答，否则看有没有人 ready。

这个设计比「存一个 phase 字段」更稳——**不存在同步问题**，也不会因为漏更新而漂移。
代价是每次 `getPhase()` 要遍历 roster，但 9×9 的房间最多几个人，可以忽略。

---

## 3. 端到端实测（我做的）

我在真实服务（3000 端口，当前构建）上跑了一遍完整流程，**覆盖 GLM 说自己没测到的部分**。

### 3.1 REST 流程

| 检查 | 结果 |
|---|---|
| R1 新房间 `phase=lobby` | ✅ |
| R2 一方 ready → `waiting`，对局未开始 | ✅ |
| R3 双方 ready → `playing`，黑先 | ✅ |
| R3 开局后座位身份保留（`seats.black.name`） | ✅ |
| R4 取消 ready → 回 `lobby` | ✅ |
| R5 旧 `new_game` 立即 `playing` | ✅ |
| R6 `RoomView` / `RoomSummary` 都带 `phase` | ✅ |

### 3.2 MCP 路径

| 检查 | 结果 |
|---|---|
| `join_game` 带 `ready: true` 入座即武装 | ✅ |
| 只有白 ready → `waiting` | ✅ |
| 黑也 ready → `playing` | ✅ |
| 工具列表未变（没新增独立 ready 工具） | ✅ |

### 3.3 网页按钮链路（GLM 未实测的部分）—— 我用真实 Chromium 补测了

GLM 说浏览器自动化通道发不出真实点击。我改用 **CDP 直接驱动 Chromium**
（`--remote-debugging-port` + WebSocket，不需要 playwright 包），做了真实点击：

| 检查 | 结果 |
|---|---|
| 页面渲染出「准备」按钮 | ✅ |
| 真实 `btn.click()` 触发 | ✅ |
| 按钮立刻翻成「取消准备」 | ✅ |
| 服务端记录 ready，`phase → waiting` | ✅ |
| 再点一次 → 按钮回「准备」 | ✅ |
| 服务端清空 ready，`phase → lobby` | ✅ |
| 双方 ready → 开局，棋盘渲染 | ✅ |

页面加载后的实际文案（截图级证据）：

```text
还没有开局
点「准备」，双方就绪后自动开局

你 · 黑    在线    ○
ui-ai · 白  未连接  ○

[准备]  双方都准备好后自动开局
```

**结论：按钮链路完全正常。** GLM 的自动化通道限制不影响功能正确性。

---

## 4. 一个我自己的误判（记录）

我第一版检查里断言「人类按 ready 后 `participants[].ready === true`」，失败了。

查下来是**我测的时机错了**：我先 `new_game` 再按 ready，此时对局已 `playing`，
`setReady` 按设计是幂等空操作（"press ready twice is a client hiccup, not a rule
violation"）。**引擎行为正确**。

在真正的 lobby 阶段（无对局）测，人类 ready 立刻生效 ✅

---

## 5. 设计缺口：空 lobby 里点准备会卡住

这是**唯一一个实质问题**，但它不是 bug，是设计没覆盖到。

### 5.1 现象

```text
1. 建一个空房间（无对局、无 AI 入座）
   → phase = lobby

2. 人类点「准备」
   → 服务端自动把人类安置到黑座，ready = true
   → phase = waiting
   → 但 gameId = ''，state.status = idle   ← 没有对局

3. 白座没有人，永远等不到「双方 ready」
   → 用户看到「等待对方准备」，60 秒后看到「AI 可能还没接入」
```

### 5.2 为什么不算 bug

- 60 秒提示**正好是为这种情况设计的**，用户会被告知「AI 可能还没接入，检查 MCP 配置」
- 工作单 §7 要求的就是这个行为
- 真实流程里，人类通常在**有 AI 入座后**才点准备（AI 先 `join_game` 占座）

### 5.3 但值得改进

空 lobby 里点准备，语义上应该更像「我先坐好，等 AI 来」，而不是「我在等一个不存在的对手」。

两个可选方向（**本轮不做**，留给后续）：

| 方案 | 说明 |
|---|---|
| A | 人类 ready 时若白座无人，提示改为「已就座，等 AI 接入」（比「等对方准备」更准） |
| B | 允许人类 ready 时立即 `new_game`，AI 后加入直接接管白座 |

A 更简单，且不动状态机。建议后续做 A。

---

## 6. 一个既有的小瑕疵（不是 P1c 引入）

网页人类的座位卡标签显示成英文 `human`，而不是「你」。

原因：`participant-roster.ts` 的 `defaultName()` 在没传 `name` 时用
`'human'` 作为默认名，而 `seatLabel()` 优先用 `spec.name`，于是中文「你」被覆盖了。

这是 **P1b 就有的行为**，不是 P1c 引入的（P1c 只是让它更显眼，因为准备阶段
座位卡变成主要信息源）。修法很简单：`defaultName` 对人类返回空串，
让 `seatLabel` 回落到「你」。**本轮不改**，留作后续小任务。

---

## 7. 合入后要做的

```text
[x] 合并到 main
[x] 真实 Chromium 点击验证（已做，见 §3.3）
[ ] 修 §6 的 `human` 标签（后续小任务）
[ ] 按 §5.3 方案 A 改「等 AI 接入」文案（后续）
```

---

## 8. 代码质量

| 维度 | 评价 |
|---|---|
| phase 派生 | ✅ 不落库，无同步问题 |
| 事件汇聚 | ✅ 所有变更走 `emitState` → `notifyPhase`，一处检测变化 |
| 幂等性 | ✅ 对局中 ready 是空操作，不报错 |
| 兼容 | ✅ 旧路径完整保留，新路径 opt-in |
| 注释 | ✅ 解释了「为什么派生」而不是「存一个字段」 |

值得肯定的设计：`getParticipants()` 把 presence 和 ready 合并时，明确写了
「presence 管连接，readiness 是房间事实，谁都不该拥有对方」——职责边界清楚。

---

## 9. 合入

```text
git checkout main
git merge --ff-only feat/lobby
pnpm test        # 206 全绿
```

已合入。**P3b（围棋集成）可以开始**，它和 P1c 都要改 `new_game`，现在 P1c 已落地。
