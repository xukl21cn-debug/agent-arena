# 硬约束

> 这些是「踩了就返工」的规则。`AGENTS.md` §4 是**速查表**（只列约束本身），这里是**完整版**：每条都带「为什么」和「谁在哪一轮踩的」。
>
> 新增约束的流程见 [`../README.md`](../README.md) §4。

---

## 1. 契约与类型

| 约束 | 为什么 | 出处 |
|---|---|---|
| `GameStatus` 只有 `idle/playing/finished`，**不加任何新值**；房间阶段另立 `RoomPhase`，围棋数子阶段另立 `GoStatus` | 它被 MCP 契约和整套测试直接读，加值会连锁崩。P1c 需要 lobby/waiting、围棋需要 scoring，两次都选择了「另立类型」而不是「扩它」 | [P1c 工作单 §3.1](../phases/03-p1c-lobby/handoff.md) · [P3b-1 工作单 §2.1](../phases/06-p3b-1-go-types/handoff.md) |
| `RoomView` / `RoomSummary` **只增字段**，不改现有字段的类型或名字 | 网页和旧客户端都在读 | [P1c 工作单 §3.2](../phases/03-p1c-lobby/handoff.md) |
| `ChatRoomSnapshot` 与聊天 MCP 返回值同样只增字段 | 旧脚本客户端 `chat-duel.mjs` 不能坏 | [C2.5 工作单 §3](../phases/13-p4-c25-chat-fix/handoff.md) |
| `PlayerSpec.id` 保持**可选** | engine 默认值和持久化旧快照只有 `kind`，改成必填编译不过。这是刻意的 | [P1b 工作单 §2.2](../phases/02-p1b-participants/handoff.md) |
| `GameState` 这个名字继续指**五子棋**，不得改名成 union | 改名要全仓库找编译错误，动遍所有五子棋文件，零收益 | [P3b-1 工作单 §2](../phases/06-p3b-1-go-types/handoff.md) |
| 共享类型只上提到 `shared` 一次，引擎文件里不得留副本 | 两处都定义会产生「类型不兼容」的诡异错误 | [P3b-1 工作单 §2.3](../phases/06-p3b-1-go-types/handoff.md) |
| `ChatErrorCode` 不进 `shared`，且尽量不新增错误码 | 棋类 `ErrorCode` 契约一动就是全量返工；`pass_turn` 整个功能一个码都没加 | [C1 评审 §8](../phases/11-p4-c1-chat-server/review.md) · [pass_turn 评审 §4](../phases/17-chat-pass-turn/review.md) |
| `schemaVersion` 升级必须带迁移，不得丢弃旧快照 | v1→v2 补 `game:'gomoku'`；「直接不兼容」会丢数据 | [P3b-1 工作单 §2.2](../phases/06-p3b-1-go-types/handoff.md) |

---

## 2. 兼容：旧路径不许死

| 约束 | 为什么 | 出处 |
|---|---|---|
| 旧 `actor` 路径保留，`moveBy` / `resignBy` 不得删 | ZCode 驱动脚本、旧 MCP 客户端还在用 | [P1b 工作单 §5](../phases/02-p1b-participants/handoff.md) |
| `new_game` 不传 `game` 时等同五子棋，且**立即开局** | 旧客户端零改动；变成「双方 ready 才开局」会让所有现有脚本和测试全挂。新行为必须是显式选择 | [P3b-2 工作单 §2.1](../phases/07-p3b-2-go-integration/handoff.md) · [P1c 工作单 §3.3](../phases/03-p1c-lobby/handoff.md) |
| `yourColor` 按会话绑定解析（`callerSeat`）；**未 join 的旧路径**才回退 `getAgentSeat()` | 双 AI 时两个座位 `kind` 都是 `'agent'`，白方被告知自己执黑，presence 还串到黑座 | [P2 结果 §3.3](../phases/04-p2-real-models/result.md) |
| `?room=` 行为完全不变；只有 URL 里**没有** `room` 参数才进大厅 | 「非法 room 也进大厅」直觉上自然，但会破坏旧书签 | [P5B 评审 §4](../phases/16-p5b-lobby/review.md) |
| `/ws` 的 `kind` 缺省必须是**棋类**，缺失或拼错都回落到棋类 | 缺省当 chat 会让现有棋类页面全坏 | [C4 评审 §4](../phases/14-p4-c4-chat-web/review.md) |
| 协议层能跑就别改协议，验证发现问题**优先改提示词** | `dual-agent.test.ts` 已证明协议能跑；P2 要验的是模型行为，不是协议 | [P2 工作单 §7](../phases/04-p2-real-models/handoff.md) |

---

## 3. 领域边界：聊天 ≠ 棋类

| 约束 | 为什么 | 出处 |
|---|---|---|
| 聊天不碰 `rooms/room.ts`、`rooms/room-manager.ts`、`mcp/tools.ts`、`core/presence.ts`、`shared/src/game.ts` | 复用棋类对象会把两套契约绑死。棋类侧只允许在 `app.ts` 挂路由、`index.ts` 初始化 | [C1 评审 §2](../phases/11-p4-c1-chat-server/review.md) |
| `/chat/mcp` 与 `/mcp` 双向不可见，聊天工具不挂到 `/mcp` | 共享端点会让两边 instructions 互相污染，只下棋的 agent 也会看到聊天工具 | [C1 评审 §3](../phases/11-p4-c1-chat-server/review.md) |
| 不复用 `PresenceRegistry`；聊天界面**不得显示**「在线 / 离线」 | 它全部按 seat 索引，聊天成员没有座位。伪造 seat 会污染棋类 presence，大改又违反禁改；没有 presence 却显示在线就是编造 | [C1 工作单 §2.2](../phases/11-p4-c1-chat-server/handoff.md) · [C4 评审 §2](../phases/14-p4-c4-chat-web/review.md) |
| `ready` 只能放房间层，不得塞进 `GameState.seats` | 座位是游戏状态，ready 是房间状态 | [P1c 工作单 §4.3](../phases/03-p1c-lobby/handoff.md) |
| presence 信号键保持**按座位**，不得整体改成按 `participantId` | 会牵动 `rebindSeats` 等一堆逻辑，收益为零；只在 `ParticipantView` 加可选 `participantId` | [P1b 工作单 §3](../phases/02-p1b-participants/handoff.md) |

---

## 4. 围棋规则

| 约束 | 为什么 | 出处 |
|---|---|---|
| 落子顺序：检查空点/越界/ko → 副本落子 → 提掉**所有**无气敌块 → 己方块仍无气才判自杀 | 顺序反了会把「提子解围」的合法手误判成自杀，这是围棋引擎最常见的错误 | [P3a 工作单 §3.1](../phases/05-p3a-go-rules/handoff.md) |
| 气按**整块**去重（`blockAt().liberties.size`），不按单颗累加 | 共享的气会被重复计数，活棋看起来气数翻倍 | [P3a 工作单 §3.2](../phases/05-p3a-go-rules/handoff.md) |
| ko 必须同时满足：恰提一子 + 提子方是独立一子 + 唯一气正好是被提点 | 只判「棋块一气」会把多子块提单子的普通反提误判成劫 | [P3a 工作单 §3.3](../phases/05-p3a-go-rules/handoff.md) |
| 面积法：黑=子+地，白=子+地+komi（7.5 给白）；`captures` 只展示，不进总分 | 提子计入总分「看起来合理但是错的」；komi 是补偿后手，不是给黑方的优惠 | [P3a 工作单 §3.4–3.5](../phases/05-p3a-go-rules/handoff.md) |
| `boardSize ≠ 9` 或 `koRule ≠ 'simple'` 返回 `UNSUPPORTED_RULE`，不静默接受 | 静默接受会让不支持的规则照跑，结果无意义 | [P3b-2 工作单 §2.1](../phases/07-p3b-2-go-integration/handoff.md) |
| 规则只在 `core/go.ts`，房间层只搬状态，不得重写规则 | 引擎已过独立审计，二次实现会造成规则分叉 | [P3b-2 评审 §2](../phases/07-p3b-2-go-integration/review.md) |
| 进 scoring 时 `turn` 保持「下一手本应落子的一方」，不切换、不置 null；`wait_for_turn` 里 **scoring 判断必须在 turn 判断之前** | 数子阶段没有轮次、双方并行确认；用 turn 判「轮到谁」会让已确认方永远收不到唤醒 | [P3b-3 工作单 §2.1、§6](../phases/08-p3b-3-go-scoring/handoff.md) |
| `mark_dead` 按**整块** toggle；任何标记变化必须重置双方 `scoreConfirmed` | 按单颗 toggle 会只标半块；一方确认后又改死子，原确认不该作数 | [P3b-3 工作单 §3](../phases/08-p3b-3-go-scoring/handoff.md) |
| 网页读 `GoState.board` 二维数组，**不得解析** `boardText` | `boardText` 是给 LLM 的字符画，不是前端数据源 | [P3b-4 工作单 §3](../phases/09-p3b-4-go-web/handoff.md) |

---

## 5. Agent 视图（payload 契约）

| 约束 | 为什么 | 出处 |
|---|---|---|
| `state.board` 不得回到 MCP 负载；`boardText` / `hotPoints` 不得移除 | 第一局 agent 就是读错 15×15 null 数组、漏看斜线双开四而败；但也不能为省 payload 删掉它们 | [Agent 视图评审 §5.2](../phases/01-agent-view/review.md) |
| 100 手时热路径响应 **≤ 4000 字符** | 全量 `moves` 让 100 手到 6920 字符，与省 token 的初衷相反 | [Agent 视图评审 §3 P0-2](../phases/01-agent-view/review.md) |
| 截断必须**显式标注**（`movesOmitted`），`get_state` 永远全量 | 不能悄悄截断，否则视图假装长局刚开始 | [Agent 视图评审 §3 P0-2](../phases/01-agent-view/review.md) |
| 错误响应里 `moves` 与 `moveCount` 必须一致，不伪装成空历史 | 46 手时返回 `moveCount: 46` 但 `moves: []`，模型据错误复盘时上下文断裂 | [Agent 视图评审 §3 P0-4](../phases/01-agent-view/review.md) |
| `boardText` 每个行列号必须可被**唯一解析**（不得出现 `9101112`） | 9/10/11 连成 `9101112`，模型可能读成 910、1112 | [Agent 视图评审 §3 P0-3](../phases/01-agent-view/review.md) |
| `win` 判定必须复用引擎 `findWinLine()` | `overlineWin:false` 时六连候选被报成 `win`，而引擎返回 `null` | [Agent 视图评审 §4 P1-1](../phases/01-agent-view/review.md) |
| `InProcessApi` 与 `HttpApi` 必须返回**同一份视图** | 两个适配器各写一份就会漂移，必须共用 `toAgentStateView()` | [Agent 视图评审 §5.2](../phases/01-agent-view/review.md) |
| 面向 agent 的字段只给**事实**，不给结论 | 见 `AGENTS.md` §7.1；P2 复盘确认加引导等于「测工具功能而不是模型能力」 | [P2 结果 §5.6](../phases/04-p2-real-models/result.md) |

---

## 6. 持久化与归档

| 约束 | 为什么 | 出处 |
|---|---|---|
| 落盘必须原子写（`.tmp` → fsync → rename） | 写一半崩溃会留下损坏 JSON，整个房间读不出来 | [P3.5 工作单 §4](../phases/10-p35-persistence/handoff.md) |
| 损坏文件**不拖垮启动**，也**不被覆盖**、不恢复成空房间 | 把损坏房间列进 `list()` 会 `create()` 空房间再 `save()`，覆盖证据 | [P3.5 评审 §3](../phases/10-p35-persistence/review.md) |
| 归档必须取 `newGame()` 里的 `prev`，在替换 `state` **之前**完成，且两个条件都判（`prev.gameId !== ''`、`history.length > 0`） | 在 `history` 清空附近归档，归档到的是空棋谱加新局；`idle` 房间和零手对局会白占归档位 | [P5A 评审 §2](../phases/15-p5a-replay/review.md) |
| 归档是**旁路**：失败或清理失败只记日志，不阻塞开新局 | 归档坏了不能让人开不了新局 | [P5A 工作单 §1.4](../phases/15-p5a-replay/handoff.md) |
| 保留 N 局**按房间**分别算，不是全局 N | 全局 N 会让一个活跃房间挤掉所有其他房间的历史 | [P5A 工作单 §1.4](../phases/15-p5a-replay/handoff.md) |
| 归档文件名用 `__` 分隔；`archiveId` 必须校验格式 | `roomId` 本身允许 `-`，用 `-` 会解析歧义；文件名从 id 拼出来，是唯一的路径穿越面 | [P5A 评审 §5](../phases/15-p5a-replay/review.md) |
| 回放复用真实引擎，不自己实现提子/劫/五连；`gameId` 沿用落盘值，`now` 传 `move.at`，失败抛错带手数 | 新生成 `gameId` 会对不上；不传 `move.at` 时间戳全变「现在」；静默截断会把坏数据藏起来 | [P5A 评审 §3](../phases/15-p5a-replay/review.md) |
| roster 不持久化；重启后靠同名 `join_game` 拿回座位 | 连接已不存在，恢复一个「在线」状态是撒谎 | [P3.5 工作单 §5.3](../phases/10-p35-persistence/handoff.md) |

---

## 7. 聊天室运行时

| 约束 | 为什么 | 出处 |
|---|---|---|
| 增量路径不得静默丢消息：必须给 `nextCursor` / `hasMore` / `omitted`，且 `nextCursor` 严格**前进** | 尾截断 + 前进游标 = 永远拿不到被丢的头部，续读循环还会假报 `hasMore=false` | [C2.5 评审 §5](../phases/13-p4-c25-chat-fix/review.md) |
| `snapshot()` 保持**纯读**、返回拷贝；要改计数必须走 `memberRef()` | 让读有副作用会牵连网页轮询、WS 广播、回放；改计数加在副本上正是上限失效的根因 | [租约评审 §3](../phases/18-chat-lease/review.md) · [C2.5 评审 §5](../phases/13-p4-c25-chat-fix/review.md) |
| `onChange` 改订阅式后，**两个赋值点**（`create()` / `loadFile()`）都要接上 | 单槽被落盘占用时，WS 再赋值就把持久化顶掉，而且测试不会报错；漏掉 `loadFile` 只在重启后坏 | [C4 评审 §2](../phases/14-p4-c4-chat-web/review.md) |
| 定时器必须 `unref()`，关闭时必须 `clearInterval` | 不 `unref` 进程退不出、测试挂住；不清 interval 会在测试间泄漏 | [租约工作单 §3](../phases/18-chat-lease/handoff.md) |
| `pass` 不消耗 hop、不产生 `chat` 消息、必须清 `consecutiveTimeouts`，`turn === null` 时拒绝 | 不清超时计数，偶尔 pass 的 agent 会莫名触发暂停；占 hop 会让预算提前耗尽 | [pass_turn 评审 §2](../phases/17-chat-pass-turn/review.md) |
| REST 建房的非法 `policy` 或未知字段一律报 `INVALID_REQUEST`，不回退默认值；且**先校验后创建** | 静默丢弃参数正是这个 bug 的成因；校验放创建之后会留下一个用默认值建的空房间 | [policy 评审 §3.4](../phases/12-chat-policy/review.md) |
| 聊天室 `updatedAt` 必须是真实最后活动时间，不得掺 `lastSeenAt` | 每次返回「现在」会让大厅按请求顺序排序；`lastSeenAt` 是「谁看过」，不是「房间变了」 | [P5B 评审 §2](../phases/16-p5b-lobby/review.md) |
