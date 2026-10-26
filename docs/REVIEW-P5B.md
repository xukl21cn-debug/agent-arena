# 评审：P5B 大厅

> 评审对象：`feat/lobby` @ `c244287`（9 文件，+789/−19）
> 评审依据：[`HANDOFF-P5B.md`](HANDOFF-P5B.md)、[`DESIGN-P5.md`](DESIGN-P5.md) §3
> 评审日期：2026-10-27
> **结论：通过，已合入。**

---

## 一、独立验证怎么做的

这一轮我**先 dump 真实响应和 DOM，再写断言**——上一轮因为猜选择器犯了四次错。

| 项 | 值 |
|---|---|
| 服务 | 自己 `pnpm build` 后跑 `node server/dist/index.js`，**3600** |
| 数据 | 隔离目录 `E:\data\tmp\arena-review-p5b\data` |
| 浏览器 | headless Chromium 155 + CDP，**先 dump 类名再断言** |
| 降级测试 | 自建代理（只屏蔽 `/api/archive`，其余透传） |
| 脚本 | `review-p5b.mjs` / `browser-lobby.mjs` / `browser-degrade.mjs` / `browser-more.mjs` |

### 结果

```text
review-p5b.mjs        PASS 21   FAIL 0
browser-lobby.mjs     PASS 24   FAIL 0
browser-degrade.mjs   PASS  9   FAIL 0
browser-more.mjs      PASS  6   FAIL 0
pnpm test             336 全绿（23 文件）
pnpm typecheck        干净
chat-duel.mjs         15/15 全过
```

**60 条检查全过，一次通过。** 这是最近几轮第一次首跑全绿。

---

## 二、前置修复：`updatedAt` 真的修好了

这是 P5B 唯一的服务端改动，也是最容易糊弄的地方。

| 检查 | 结果 |
|---|---|
| **L1** 隔 1.1 秒再查，`updatedAt` 完全相同 | ✅ |
| L1 第三次读也相同（排除同秒巧合） | ✅ |
| L1 `updatedAt` 不是「现在」 | ✅ |
| **L2** 发消息后 `updatedAt` 变成**该消息的 `at`** | ✅ |
| **L3** 空房间 `updatedAt` = `createdAt` | ✅ |
| **L3** 三条消息时取**最新**一条，不是第一条 | ✅ |
| **L4** 棋类 `updatedAt` 仍等于 `state.updatedAt` | ✅ |
| L4 棋类不是「现在」 | ✅ |

`lastActivityAt()` 的实现比工作单要求的更稳：

```ts
return last.at > this.createdAt ? last.at : this.createdAt;
```

**取两者较大者**——恢复文件里数据异常时，房间不会显得比创建还老。这个防御是 GLM 自己加的，工作单没要求。

而且明确**不掺 `lastSeenAt`**（注释写清了理由：那是「谁看过」，不是「房间变了」），符合 `DESIGN-P5.md` §3.2 的要求。

---

## 三、大厅

| 检查 | 结果 |
|---|---|
| **L5** `/` 渲染大厅，四个分组（五子棋/围棋/聊天/历史对局） | ✅ |
| 每个分组都有卡片 | ✅ |
| **L10** 全页无「在线」「离线」「已连接」 | ✅ |
| 聊天卡片带 `kind=chat` 链接 | ✅ |
| 聊天卡片显示条数 + hop 预算 | ✅ |
| **L9** 组内按时间降序 | ✅ |
| **L11** 卡片 href 指向对应房间 | ✅ |
| **L13** 历史卡片进入回放页，回放页显示手数 | ✅ |

### 终局文案

我特意造了一盘**真正终局**的五子棋（`winner=black`、`endReason=five`）来验：

| 检查 | 结果 |
|---|---|
| 历史卡片显示「**黑胜 · 五连**」 | ✅ |
| 未终局的对局显示「未终局」 | ✅ |

> 注意：我前面那批归档全是「未终局」，因为它们是**中途开新局**归档的。
> 这是正确行为——`winner`/`endReason` 在归档里就是 `null`。
> 必须造一盘真终局的才能验到文案。

### 降级（L14）

自建代理只屏蔽 `/api/archive`：

| 检查 | 结果 |
|---|---|
| 代理确实拦截 `/api/archive`（500） | ✅ |
| 代理放行 `/api/rooms`（200） | ✅ |
| **大厅仍然渲染**，三个房间分组都在 | ✅ |
| 房间卡片正常显示 | ✅ |
| 历史区域显示降级提示 | ✅ |
| 页面没有整体报错 | ✅ |

**这条是工作单的硬要求**（「`/api/archive` 404 要优雅降级」），实测通过。

### 查看更多（L15）

造了 25 局归档：

| 检查 | 结果 |
|---|---|
| 默认渲染 **20** 条 | ✅ |
| 有「查看更多」按钮 | ✅ |
| 按钮写着还剩多少局 | ✅ |
| 点开后显示全部 **25** 条 | ✅ |
| 展开后按钮消失 | ✅ |
| 展开后仍按时间降序 | ✅ |

---

## 四、路由（最危险的回归面）

| 检查 | 结果 |
|---|---|
| **L6** `?room=default` 仍渲染棋盘，不是大厅 | ✅ |
| **L8** `?room=!!!`（非法）回落默认房间，**不进大厅** | ✅ |
| **L7** `?room=x&kind=chat` 仍渲染聊天页 | ✅ |
| `?archive=<id>` 进入回放页 | ✅ |

**L8 是最容易写错的**：直觉上「非法 room → 大厅」很自然，但那会破坏旧书签的行为。
GLM 用 `!params.has('room')` 判断，非法值仍走棋类分支——正确。

分流顺序（`App.tsx`）：

```text
archive → view=replay → kind=chat → 无 room 参数才进大厅 → 棋类
```

**最具体的先判断**，符合工作单要求。

---

## 五、代码质量

### 做得好的

1. **`labels.ts` 抽出终局文案**，回放页和历史卡片共用一份——避免两处文案漂移。
   这是工作单没要求但做对了的重构。
2. **`timeAgo()` 处理了负数/非法时间**（`ms < 0` 时回退到 `HH:MM`），
   防御了时钟偏移和脏数据。
3. **渲染层一处归一化** `roomId` / `id` 的差异，卡片组件看不到这个区别——
   符合工作单「归一化后再传 props」的要求。
4. **`lastActivityAt()` 取 `max(最后消息, createdAt)`**，防御恢复文件的异常数据。
5. **禁改清单零触碰**：`shared/`、`rooms/`、`chat/mcp.ts`、`presence.ts`、`mcp/tools.ts` 全部 0 改动。

### 可以更好的（不阻塞）

1. **`endLabel` 的 `endReason` 类型是 `'five' | 'draw' | 'resign' | 'scored' | null`**，
   但 `EndReason` 在 `shared` 里可能是别的联合类型。目前 `web` 自己声明了一份，
   以后如果 `shared` 改了会静默不一致。建议后续 import 那个类型（只增不改）。

2. **8 秒轮询没有可见的「刷新中」提示**。工作单没要求，但轮询失败时用户看不出
   是「没数据」还是「请求挂了」。不阻塞。

---

## 六、评审方这轮的改进

上一轮我犯了四次同类错（猜字段、猜选择器、算术错）。这一轮的做法：

```text
1. 先 dump /api/rooms 和 /api/chat/rooms 的真实 JSON
2. 先 dump 大厅的所有 class 名和第一张卡片的 outerHTML
3. 确认棋子是 span.stone（不是 circle，circle 是星位）
4. 造数据时先确认 winner/endReason 真的是 null，再决定测什么
```

**结果：60 条检查一次通过，零返工。**

这条已写进 `SESSION-HANDOFF.md` §4.8 的规则里，以后照做。

---

## 七、合入

```powershell
git checkout main
git merge --ff-only feat/lobby
git branch -d feat/lobby
```

合入后 `pnpm test` 应为 **336 全绿**。

---

## 八、P5 完成情况

| 工作单 | 状态 |
|---|---|
| P5A 棋谱归档 + 回放 | ✅ 已完成（`2ee13b9`） |
| P5B 大厅 | ✅ 已完成（`c244287`） |

**P5 的两件事都做完了。** 路线图上的阶段全部完成：

```text
P1 参与者地基 → P2 双 AI → P3 围棋 → P3.5 持久化
→ P4 聊天室（C1/C2 · C2.5 · C4）→ P5 大厅 + 回放
```

剩下的可选项（都低于主线优先级）：

| 项 | 说明 |
|---|---|
| P4-C3 runner | 把 CLI 包成常驻成员 |
| `pass`/`yield` | agent 收工后轮次卡 120s 超时 |
| `mentions` 模式 | 目前只实现了 relay |
