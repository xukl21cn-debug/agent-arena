# 评审：P5A 棋谱归档 + 回放

> 评审对象：`feat/replay` @ `2ee13b9`（15 文件，+1551/−13）
> 评审依据：[`handoff.md`](handoff.md)、[P5 设计](../../architecture/p5-lobby-replay.md)
> 评审日期：2026-10-26
> **结论：通过，已合入。**

---

## 一、独立验证怎么做的

按 `AGENTS.md` §6.1，**没有复用 GLM 的测试**，自己从工作单出发写检查。

| 项 | 值 |
|---|---|
| 服务 | 自己 `pnpm build` 后跑 `node server/dist/index.js`，**3500** |
| 数据 | 隔离目录 `E:\data\tmp\arena-review-p5a\data` |
| 归档上限 | `ARENA_ARCHIVE_LIMIT=3`（小值才能测出清理） |
| 对局驱动 | **两个 MCP agent**（黑 + 白），不是 REST |
| 浏览器 | headless Chromium 155 + CDP |
| 脚本 | `review-p5a-v2.mjs` / `review-r11.mjs` / `browser-stone.mjs`（临时目录，未提交） |

### 结果

```text
review-p5a-v2.mjs    PASS 57   FAIL 3（3 条全是我的 harness 错，见 §4）
review-r11.mjs       PASS 10   FAIL 1（1 条是我的期望错，见 §4）
browser-stone.mjs    PASS  9   FAIL 1（1 条是我的算术错，见 §4）
pnpm test            327 全绿（22 文件）
pnpm typecheck       干净
chat-duel.mjs        15/15 全过
```

**修正后所有实质检查全过。**

---

## 二、归档（坑 1）

工作单标的最大风险是**归档时机**。GLM 的处理：

```ts
const prev = this.state;

// Archive the game we are leaving before anything overwrites it
if (prev.gameId !== '' && this.history.length > 0) {
  try {
    this.repository?.archive({
      id: this.id, state: prev,
      history: [...this.history],
      commentary: [...this.commentaryLog],
    });
  } catch (error) { console.error(...); }   // 旁路，不阻塞
}
```

**位置正确**：`prev` 之后、替换 `state` 之前。

| 检查 | 结果 |
|---|---|
| **A2** 归档的是旧局（`gameId` 对、3 手、棋盘 3 子） | ✅ |
| A3 `idle` 房间（`gameId === ''`）不归档 | ✅ |
| A4 零手对局不归档 | ✅ |
| **A5** 每房间保留 N 局（limit=3，开 5 局后剩 3） | ✅ |
| **A6** 按房间独立（A 满 3 局不影响 B） | ✅ |
| A7 归档失败不阻塞（GLM 用 stub 抛错验证） | ✅（看代码 + 其测试） |
| A8 归档不参与启动恢复 | ✅ |

### 我额外测的边界：`roomId` 含 `__`

`pruneArchives` 用 `entry.startsWith(\`${roomId}__\`)` 预筛，
但代码注释自己也说「文件名前缀不是归属证明」。我构造了 `PC123` 和 `PC123__suffix`
两个房间：

| 检查 | 结果 |
|---|---|
| 长名房间有归档 | ✅ |
| 短名房间反复清理 6 次后，长名归档**没被误删** | ✅ |

**结论：前缀误匹配会被后面的 `persisted.id !== roomId` 挡住，正确。**
代价是每次 prune 会多打开几个文件——性能小瑕疵，不是正确性问题。

---

## 三、回放（坑 2）

| 检查 | 结果 |
|---|---|
| **R3** 围棋提子：末帧 `captures.black=1`、(4,4) 空 | ✅ |
| **R3** 提子**前一帧**白子还在、`captures=0` | ✅ |
| R3 帧 `index` 连续 | ✅ |
| R3 **每帧 石子数 = 手数 − 提子数**（我加的守恒检查） | ✅ |
| **R5** `gameId` 沿用落盘值（帧 0 也是） | ✅ |
| **R6** 帧时间戳 = `history[].at`，不是「现在」 | ✅ |
| **R10** 路径穿越（7 种向量）全被拒 | ✅ |
| **R11** 损坏 history → 500 `REPLAY_FAILED`，message 带手数 | ✅ |
| R11 损坏文件**保留在磁盘** | ✅ |
| R7 归档回放 200，`archiveId` 回填 | ✅ |
| R12 从未开局 → 400 `NO_MOVES` | ✅ |
| **R13** `/api/rooms/:id` 键集合不变 | ✅ |

### R11 我第一次测错了

我先改 `data/rooms/<id>.json` 然后调 `/api/rooms/:id/replay`，得到 **200**。
原因是：**这个端点读内存，不读磁盘**（`routes.ts:419` 用 `room.getHistory()`）。

归档端点才读磁盘。改归档文件后正确复现 500 + `REPLAY_FAILED` + `move 2`。

**这是测试方法问题，不是代码问题**——而且暴露了一个设计事实：
当前局回放用的是内存里活的数据，天然不会有磁盘损坏问题；只有归档回放会。

### R11 附带发现：列表端点不重放，是对的

我把归档的 `history` 改坏后，`GET /api/archive` 仍然正常列出这一局。
一开始我以为是 bug，查了 `archiveSummaryOf` 才明白：

```ts
export function archiveSummaryOf(persisted: PersistedRoom): ArchiveSummary {
  const { state } = persisted;        // ← 只读 state
  playedAt: persisted.history.at(-1)?.at ?? state.updatedAt,   // ← 只读最后一个
```

**列表用 state 摘要，不跑重放。** 这是正确的职责分离——
列表不该为了显示摘要而执行整个引擎。损坏只在真正 `/replay` 时暴露。

---

## 四、评审方自己犯的三个错（记录，别重踩）

这一轮我犯了三次，比 GLM 的问题还多。

| # | 我的错 | 真因 |
|---|---|---|
| 1 | 用 REST `/moves` 连发 3 手 | **REST 落子校验轮次**，人类座位不能替白方走。必须用两个 MCP agent |
| 2 | 断言 `/api/rooms/:id` 键集合漏了 `participants` | 凭记忆写的，没 dump。那个字段一直都在 |
| 3 | 用 `[class*="stone"]` / `circle` 数棋子 | 棋子是 `span.stone`；`circle` 是**星位**，永远 5 个 |

第 3 个最典型：`circle` 恒为 5，导致「开局 0 子」也报 5，我却先怀疑代码。
**dump 一次 DOM 就全清楚了。**

还有第 4 个：我断言「后退一帧后 7 颗子」，实际第 6 帧就是 6 颗
（第 7 手加一颗黑子同时提掉一颗白子，总数不变）。**我的算术错了。**

> **这一轮教训**：`AGENTS.md` §6.2 那四条，我犯了 1、2、3 的变体。
> **写断言前先 dump 真实响应 / 真实 DOM。**

---

## 五、对实现的评价

### 做得好的

1. **归档时机完全按工作单**，还额外把整个归档包在 try/catch 里，失败只记日志。
2. **两个前置条件都判了**（`gameId !== ''` + `history.length > 0`）。
3. **归属判断用文件内容而不是文件名前缀**——注释里写明了理由
   （`roomId` 可含 `__`），我实测确认了这个边界。
4. **清理排序用对局自身的 `playedAt`，mtime 只做 tiebreaker**——
   比纯 mtime 更确定，理由写在注释里。
5. **路径穿越做了两道校验**（repository 层 + 路由层），7 种向量全拒。
6. **`writeJson` 抽出来复用**（temp + rename 原子写），归档和房间用同一套。
7. **`archiveSummaryOf` 只读 state 不重放**——职责分离正确。
8. **前端逐帧完全正确**：我逐帧 dump 了 (4,4) 的 `aria-label` 和石子数，
   与后端 `frames` 一一吻合。
9. **`ErrorCode` 只增不改**，四个新码状态码映射正确（404/400/500）。

### 可以更好的（不阻塞）

1. **`pruneArchives` 的前缀预筛会多读文件**。`startsWith` 之后还要
   `loadArchive`（JSON.parse）才能确认归属。当前规模（每房间 20 局）无影响，
   但可以改成从文件名解析 `roomId__gameId` 再比对（注意 `roomId` 含 `__` 时要
   从**最后一个** `__` 切分）。
2. **`loadArchive` 在 `listArchives` 里被调用一次，`pruneArchives` 里又调一次**，
   同一批文件可能被解析两遍。同上，规模小，无影响。
3. **`REPLAY_FAILED` 用了 500**。数据损坏严格说是 4xx（客户端拿到了坏数据），
   但工作单写的就是 500，且这个码只出现在归档回放，语义上说得通。不改。

---

## 六、合入

```powershell
git checkout main
git merge --ff-only feat/replay
git branch -d feat/replay
```

合入后 `pnpm test` 应为 **327 全绿**。

---

## 七、给 P5B 的交接

`GET /api/archive` 的返回结构已定，P5B 可以直接用：

```jsonc
{
  "archiveId": "default__4d3f7280",
  "roomId": "default",
  "game": "go",
  "gameId": "4d3f7280-...",
  "moveCount": 42,
  "winner": "white",          // 从归档 state 读，不推断
  "endReason": "scored",
  "playedAt": "2026-10-26T07:50:08.458Z",   // 最后一手的时间
  "seats": { "black": {...}, "white": {...} }
}
```

已按 `playedAt` 降序排好，**P5B 不需要再排**。
