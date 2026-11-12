# 评审：P3b-1 围棋类型契约（M0）

> 评审人：DSH
> 对象：`feat/go-types` @ `cd83c65`（18 文件，+494/−152）
> 结论：**通过，合入 main**

---

## 1. 结论

| 项 | 结果 |
|---|---|
| 测试 | ✅ 211 全绿（206 现有 + 5 新增，零破坏） |
| 类型 / 构建 | ✅ server / web / shared 全过 |
| `GameStatus` | ✅ 一字未动（仍是 `idle/playing/finished`） |
| `go.ts` 改动性质 | ✅ 纯类型搬迁，零逻辑改动（逐行核对） |
| 无 `as` 收窄 | ✅ `room.ts` 的 `gomoku()` 守卫成立 |
| 独立验证 | ✅ 我另写的迁移/MCP/回归检查全通过 |
| 判定 | **通过** |

---

## 2. 先认一个错：工作单自相矛盾

GLM 指出工作单 §7 与硬约束 2 冲突：

- **§7 自查**写「`git diff --stat` 里 `core/go.ts` 不该出现」
- **§2.3** 又要求把 `GoRules` / `GoScore` 等类型从 `go.ts` 搬到 `shared`

这两条**不可能同时满足**——搬类型必然要改 `go.ts`。

**这是我的疏忽。** §7 那句话是照抄 P3a 工作单的，而 P3a 时 `go.ts` 确实不该动；
到 P3b-1 搬类型时，它必然要动。

GLM 按硬约束 2 办是对的，且主动说明了冲突，处理得比我写工作单时更严谨。

正确的写法应该是：**「`go.ts` 只应有类型搬迁，不该有逻辑改动」**，而不是「不该出现」。

---

## 3. 关键验收：不用 `as` 就能收窄

工作单里定的硬性验收。实测：

```ts
// server/src/rooms/room.ts:696
private gomoku(): GameState {
  if (this.state.game !== 'gomoku') {
    throw new RoomError('UNSUPPORTED_RULE', 'Go is not wired into rooms yet.');
  }
  return this.state;   // ← 无 as，自动收窄
}
```

**收窄成立。** 这说明 union 的判别字段设计正确——TS 能从 `game` 字面量推断出具体分支。

如果这里需要 `as`，就说明 `GoState` 和 `GameState` 的结构让 TS 无法区分，
那才是设计问题。现在没有。

---

## 4. 独立验证（我做的）

### 4.1 v1 → v2 迁移（实测）

我构造了真实的 v1 快照（去掉 `game`、`schemaVersion` 改回 1），跑 `migrateSnapshot`：

| 检查 | 结果 |
|---|---|
| 迁移后 `game === 'gomoku'` | ✅ |
| 迁移后 `schemaVersion === 2` | ✅ |
| `roomId` / `id` 保留 | ✅ |
| `game` 不是 `undefined` | ✅ |
| v2 快照原样通过 | ✅ |
| 带历史的 v1 快照，history 完整保留 | ✅ |
| `gameId` 保留 | ✅ |

迁移用 `schemaVersion === 1` 做判别，而不是 `game === undefined`——这个选择更好：
`schemaVersion` 是显式的版本标记，比「字段缺失」更可靠。

### 4.2 五子棋端到端回归（实测）

真实服务上跑完整流程：

```text
建房间  → game=gomoku schema=2 phase=lobby   ✅
开局    → status=playing turn=black           ✅
落子    → moves=1 turn=white                  ✅
房间列表 → 带 game 字段                        ✅
```

MCP 侧：

```text
工具列表   → 仍是 8 个，没有 pass             ✅
join/new_game/get_state → 正常                ✅
state 带 game=gomoku                          ✅
boardText 正常（表头/X/小写最新手/18 行）      ✅
hotPoints 存在                                ✅
```

### 4.3 围棋状态暂时进不来（实测）

`engine.ts` 里**没有任何创建 `GoState` 的代码**，`newGame` 只产生五子棋状态。

所以 `toAnyAgentStateView` 里那个 `throw new Error('Go agent views are not
implemented yet')` 目前是**死代码**，不会触发。

这个安全网是合理的：宁可显式抛错，也不要把围棋状态渲染成五子棋视图。

---

## 5. GLM 主动说明的三件事

### 5.1 工作单矛盾 —— 已认（见 §2）

### 5.2 `GoState` 补了 `roomId` / `gameId`

提案 §4.1 的草图**确实漏了**这两个字段。但房间层依赖它们：

- `wait_for_turn` 的 waiter 要对比 `gameId` 判断是否开了新局
- commentary 归属要 `roomId`
- `RoomSummary` 要 `gameId`

补上是对的。**建议回头把提案 §4.1 的草图也修正**，免得以后照着草图实现又漏。

### 5.3 新增 `toAnyAgentStateView`

transport 层拿到的是 union，需要一个分发入口。设计合理：

```ts
if (state.game !== 'gomoku') {
  throw new Error('Go agent views are not implemented yet (P3b-2).');
}
return toAgentStateView(state, history, options);
```

`gomoku` 分支走原函数，`go` 分支显式 throw。**没有把围棋状态静默渲染成五子棋**，
这是对的。

---

## 6. 类型上提是否彻底

工作单 §2.3 要求「搬走后 `go.ts` 里不要留副本」。核对：

```text
上提到 shared（go.ts 改为 import）：
  GoRules / GoBoard / GoErrorCode / GoScore / GoGroupSummary / GoGroupsView   ✅

留在 go.ts：
  GoMoveResult / GoBoardTextOptions                                            ✅
```

`go.ts` 的 diff 只有「删除定义 + 替换 import + 头注释」，**没有逻辑改动**。
`go.test.ts` 跟着改了 import（3 行），符合预期。

---

## 7. 一个我自己的误判（记录）

MCP 检查里我写了 `bt.includes('X') === false`，期望开局后棋盘无黑子。
但这个断言写反了逻辑——它检查的是「不包含 X」，而实际开局后棋盘是空的，
确实不含 X，所以断言通过得莫名其妙；换成真实落子后又失败。

**是我的断言写错，不是引擎问题。** 用真实落子验证后：

```text
has header: true
has black X: true
has lowercase x (latest): true
lines: 18
```

`boardText` 完全正常。

---

## 8. 代码质量

| 维度 | 评价 |
|---|---|
| union 设计 | ✅ `GameState` 保名字，`GoState` 并排，判别字段清晰 |
| `GameStatus` 隔离 | ✅ 围棋 `scoring` 放 `GoStatus`，不污染公共类型 |
| 迁移 | ✅ 用 `schemaVersion` 判别，显式可靠 |
| web 收窄 | ✅ `state?.game === 'gomoku' ? state : null`，无 `as any` |
| 安全网 | ✅ 围棋视图显式 throw，不静默降级 |

值得肯定：`GoState.turn` 的注释写了「scoring 期间仍是"谁本应下一手"；
确认是并行的」——把 P3b-3 最容易踩的坑提前写进了类型定义里。

---

## 9. 合入

```text
git checkout main
git merge --ff-only feat/go-types
pnpm test        # 211 全绿
```

合入后 **P3b-2（接入）可以开始**。

---

## 10. 给 P3b-2 工作单的修正

合入前需要修一处，否则同样的矛盾会重演：

[P3b-2 工作单](../07-p3b-2-go-integration/handoff.md) 的完成标准里如果写了「`core/go.ts` 不该出现在 diff」，
要改成「`core/go.ts` 不该有**逻辑**改动」——P3b-2 会让 `go.ts` 被真正调用，
届时它的 diff 是预期的。

**已在合入时一并修正。**
