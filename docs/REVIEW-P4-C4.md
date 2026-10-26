# 评审：P4-C4 网页聊天页

> 评审对象：`feat/chat-ui` @ `59d6fc6`（15 文件，+2082/−50）
> 评审依据：[`HANDOFF-P4-C4.md`](HANDOFF-P4-C4.md)
> 评审日期：2026-10-26
> **结论：通过，已合入。**

---

## 一、独立验证怎么做的

按 `AGENTS.md` §6.1，**没有复用 GLM 的测试**，自己从工作单出发写了三组检查。

| 项 | 值 |
|---|---|
| 服务 | 自己 `pnpm build` 后跑 `node server/dist/index.js`，**3300**（不碰 3000 现役、不碰 GLM 的 3210） |
| 数据 | 隔离目录 `E:\data\tmp\arena-review-c4\data` |
| WS 客户端 | Node 24 **内置 `WebSocket`**（仓库的 `ws` 包在临时目录解析不到，用内置的反而更独立） |
| 浏览器 | headless Chromium 155 + CDP 直驱（不用 playwright） |
| 脚本 | `review-c4.mjs` / `browser-c4.mjs` / `browser-fix.mjs`（临时目录，未提交） |

### 三组检查

- `review-c4.mjs`：**34 条**，服务端行为（棋类回归 / 落盘 / 广播 / 边界 / MCP 不受影响）
- `browser-c4.mjs`：**20 条**，浏览器端到端
- `browser-fix.mjs`：**15 条**，修正选择器后重验前端细节

---

## 二、结果

```text
review-c4.mjs      PASS 34   FAIL 0
browser-fix.mjs    PASS 15   FAIL 0
pnpm test          302 全绿（21 文件）
pnpm typecheck     干净
chat-duel.mjs      15/15 全过
```

### §2.1 那个坑：没踩到

这是工作单标的最大风险，我重点验了：

| 检查 | 结果 |
|---|---|
| WS 订阅者在线时，消息**真的落盘**（读磁盘文件断言，不是看内存） | ✅ |
| **重启恢复的房间**再发消息，仍然落盘（W4b，最隐蔽的路径） | ✅ 磁盘从 1 条变 2 条 |

实现方式是订阅者集合 + `subscribe(): unsubscribe`，`manager.ts` 的两个赋值点
（`create()` 和 `loadFile()`）都改成了订阅。**做法正确。**

### 棋类行为不变

| 检查 | 结果 |
|---|---|
| `/ws?roomId=x`（无 kind）仍返回带 `state` 的 `hello` | ✅ |
| 棋类 `hello` 带 `participants` / `phase` | ✅ |
| 缺省路由仍渲染棋盘 | ✅ |
| 棋类页面没有聊天时间线 | ✅ |

### 聊天广播

| 检查 | 结果 |
|---|---|
| `hello` 带房间快照 + 最近消息（按 seq 升序） | ✅ |
| 新消息 → `message` 帧，**顺序正确、seq 单调不重复** | ✅ |
| 两个 socket 同时收到（多标签页） | ✅ |
| `room` 帧刷新 hop / turn / members 发言数 | ✅ |
| pause / resume / close 都广播 `room` 帧 | ✅ |
| **后连上的 socket 不把历史当新消息重放** | ✅ |
| 房间不存在 → `error` + 关闭 | ✅ |

### 边界（工作单没列，我自己加的）

| 检查 | 结果 |
|---|---|
| 聊天房间**不带 `kind`** → 走棋类路径并报 `ROOM_NOT_FOUND`，不会误入聊天 | ✅ |
| `kind` 拼错（`chta`）→ 不当成聊天，回落棋类路径 | ✅ |
| socket 关闭后无泄漏，新连接正常收消息 | ✅ |
| MCP 路径不受 WS 改动影响（上限仍生效、`wait` 仍带 `nextCursor`） | ✅ |

### 前端（浏览器实测）

| 检查 | 结果 |
|---|---|
| 两个标签页实时同步（消息、暂停/恢复互相可见） | ✅ |
| **上滚时新消息不抢滚动位置**（`scrollTop` 保持 0） | ✅ |
| **回到底部后新消息自动跟随** | ✅ |
| `@` 补全弹出列表，**只列 agent，不列 human** | ✅ |
| 选中后 `@name` 从正文剥掉，`to` 正确落位 | ✅ |
| 暂停后**两个标签**的输入框都禁用，恢复后可用 | ✅ |
| 成员栏显示「活动 刚刚」，**没有任何「在线/离线」字样** | ✅ |
| 自己的消息标 `chat-line--own`（右对齐） | ✅ |
| 作者颜色按名字哈希，同一作者颜色唯一 | ✅ |
| hop 条显示 `x / 40` | ✅ |

---

## 三、评审方自己犯的错（记录，别重踩）

第一轮 `browser-c4.mjs` 有 3 条失败，**全是我的选择器写错**：

| 失败 | 真因 |
|---|---|
| 「页面有房间标题」 | 房间标题在 `.subtitle` 里，我断言的是 `innerText.includes(title)`，但当时 tab 还没收到 `hello`，只有 `…` 占位 |
| 「@ 补全出现列表」 | 我用 `[class*="mention"]`，实际类名是 `.chat-mention`——**而且那个房间没加 agent，列表本来就是空的** |
| 「找到滚动容器」 | 我用 `[class*="timeline"]`，实际是 `.chat-lines` |

**教训**：断言前端行为前，先 dump 一次真实 DOM（类名、结构），
别按自己想象的命名写选择器。这和 `AGENTS.md` §6.2「断言字段名猜错」是同一类错误——
**这一轮又犯了，是第二次。**

正确做法：先跑一个 `document.querySelectorAll('[class]')` 把类名全导出来，再写断言。

---

## 四、对实现的评价

### 做得好的

1. **§2.1 处理得干净**——订阅者集合 + 返回 `unsubscribe`，两个赋值点都改了，
   还专门写了 W4b 钉住重启恢复那条路径。这是工作单里最容易糊弄的地方，没糊弄。
2. **`kind` 缺省严格保持棋类**——我测了「不带 kind」「kind 拼错」两种误用，都正确回落到棋类路径。
3. **`hello` 不复用棋类的 `state`**——独立 `room` + `messages` 字段，类型不打架。
4. **`ChatRoomFrame` 把 `policy` 摊平成两个数字**——领域对象没进 `shared`，
   符合 AGENTS §4.2 的精神（虽然约束写的是 `ChatErrorCode`，但思路一致）。
5. **滚动规则做对了**——这是最容易写错的前端细节，实测「上滚不抢、回底跟随」都对。
6. **`@` 补全只列 agent**——正确，因为 `to` 指向 human 会被 `resolveTarget` 拒绝。

### 可以更好的（不阻塞）

1. **每个 socket 每次变更都跑 `unreadAfter`（O(n) `filter`）**。
   房间上限 1000 条、成员数有限，当前无影响。但如果以后房间变大，
   可以改成记住索引。建议留个注释说明这个前提。
2. **`chatConnection` 的 cleanup 没有从 `wss.clients` 显式摘除**。
   `ws` 库自己管，实测无泄漏，但和棋类路径的 cleanup（有 `detachViewer`、
   有 `socketRoom.delete`）不完全对称。不是 bug，只是风格差异。
3. **`unreadAfter(lastSeq, Infinity)` 依赖 `slice(0, Infinity)` 返回全部**。
   行为正确（我验过），但 `Infinity` 当哨兵值略隐晦，加个注释更好。

---

## 五、合入

```powershell
git checkout main
git merge --ff-only feat/chat-ui
git branch -d feat/chat-ui
```

合入后 `pnpm test` 应为 **302 全绿**。

---

## 六、下一步

P4 聊天室**全部完成**（C1/C2/C2.5/C4）。剩下的是 P5：

- 大厅：三类房间统一入口
- 棋谱回放：P3.5 已落盘
- ~~WS 统一~~：**已在 C4 提前做掉聊天室那部分**

P4-C3（runner）和 `pass`/`yield` 机制仍是可选项，
优先级低于 P5 大厅。
