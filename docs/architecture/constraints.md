# 硬约束

按改动领域查表，根据[架构地图](overview.md)定位实现。任务专用的限制留在任务材料里。变更边界的确认方式见[开发工作流](../workflow.md)。

---

错误信息应说明当前状态和可行的下一步。无效输入在写入前拒绝。恢复失败保留原文件和日志，以便诊断。给 agent 的视图提供可观察的事实，由模型选择行动。

## 1. 契约与类型

| 约束 | 为什么 |
|---|---|
| `GameStatus` 只有 `idle/playing/finished`，**不加任何新值**；房间阶段另立 `RoomPhase`，围棋数子阶段另立 `GoStatus` | 旧客户端依赖这三个状态。准备阶段和数子阶段各用独立类型表达 |
| `RoomView` / `RoomSummary` **只增字段**，不改现有字段的类型或名字 | 网页和旧客户端都在读 |
| 聊天快照与 MCP 返回值按兼容方式扩展。旧任务字段的兼容规则见工作域约束 | 保持旧聊天客户端和已有群聊行为可用 |
| `PlayerSpec.id` 保持**可选** | engine 默认值和持久化旧快照只有 `kind`，改成必填编译不过。这是刻意的 |
| `GameState` 这个名字继续指**五子棋**，不得改名成 union | 改名要全仓库找编译错误，动遍所有五子棋文件，零收益 |
| 共享类型只上提到 `shared` 一次，引擎文件里不得留副本 | 两处都定义会产生「类型不兼容」的诡异错误 |
| `ChatErrorCode` 不进 `shared`，且尽量不新增错误码 | 棋类 `ErrorCode` 契约一动就是全量返工；`pass_turn` 整个功能一个码都没加 |
| `schemaVersion` 升级必须带迁移，不得丢弃旧快照 | v1→v2 补 `game:'gomoku'`；「直接不兼容」会丢数据 |

---

## 2. 兼容：旧路径不许死

| 约束 | 为什么 |
|---|---|
| 旧 `actor` 路径保留，`moveBy` / `resignBy` 不得删 | ZCode 驱动脚本、旧 MCP 客户端还在用 |
| `new_game` 不传 `game` 时等同五子棋，且**立即开局** | 旧客户端零改动；变成「双方 ready 才开局」会让所有现有脚本和测试全挂。新行为必须是显式选择 |
| `yourColor` 按会话绑定解析（`callerSeat`）；**未 join 的旧路径**才回退 `getAgentSeat()` | 双 AI 时两个座位 `kind` 都是 `'agent'`，白方被告知自己执黑，presence 还串到黑座 |
| `?room=` 行为完全不变；只有 URL 里**没有** `room` 参数才进大厅 | 「非法 room 也进大厅」直觉上自然，但会破坏旧书签 |
| `/ws` 的 `kind` 缺省必须是**棋类**，缺失或拼错都回落到棋类 | 缺省当 chat 会让现有棋类页面全坏 |
| 改模型提示前，先用脚本客户端验证协议，再用真实模型重走目标场景 | 脚本可证明协议能跑，真实模型才能验证提示是否改变工具调用行为 |

---

## 3. 领域边界：聊天 ≠ 棋类

| 约束 | 为什么 |
|---|---|
| 聊天不碰 `game/rooms/room.ts`、`game/rooms/room-manager.ts`、`game/mcp/tools.ts`、`game/rooms/presence.ts`、`shared/src/game.ts` | 复用棋类对象会把两套契约绑死。棋类侧只允许在 `app.ts` 挂路由、`index.ts` 初始化 |
| `/chat/mcp` 与 `/game/mcp` 双向不可见，聊天工具不挂到棋类端点 | 共享端点会让两边 instructions 互相污染，只下棋的 agent 也会看到聊天工具 |
| 开发任务走 `/work/mcp` | 任务独立记录返工轮次、收工确认和用户放行 |
| 不复用 `PresenceRegistry`；聊天界面**不得显示**「在线 / 离线」 | 它全部按 seat 索引，聊天成员没有座位。伪造 seat 会污染棋类 presence，大改又违反禁改；没有 presence 却显示在线就是编造 |
| `ready` 只能放房间层，不得塞进 `GameState.seats` | 座位是游戏状态，ready 是房间状态 |
| presence 信号键保持**按座位**，不得整体改成按 `participantId` | 会牵动 `rebindSeats` 等一堆逻辑，收益为零；只在 `ParticipantView` 加可选 `participantId` |

---

## 4. 围棋规则

| 约束 | 为什么 |
|---|---|
| 落子顺序：检查空点/越界/ko → 副本落子 → 提掉**所有**无气敌块 → 己方块仍无气才判自杀 | 顺序反了会把「提子解围」的合法手误判成自杀，这是围棋引擎最常见的错误 |
| 气按**整块**去重（`blockAt().liberties.size`），不按单颗累加 | 共享的气会被重复计数，活棋看起来气数翻倍 |
| ko 必须同时满足：恰提一子 + 提子方是独立一子 + 唯一气正好是被提点 | 只判「棋块一气」会把多子块提单子的普通反提误判成劫 |
| 面积法：黑=子+地，白=子+地+komi（7.5 给白）；`captures` 只展示，不进总分 | 提子计入总分「看起来合理但是错的」；komi 是补偿后手，不是给黑方的优惠 |
| `boardSize ≠ 9` 或 `koRule ≠ 'simple'` 返回 `UNSUPPORTED_RULE`，不静默接受 | 静默接受会让不支持的规则照跑，结果无意义 |
| 规则只在 `game/engine/go.ts`，房间层只搬状态，不得重写规则 | 引擎已过独立审计，二次实现会造成规则分叉 |
| 进 scoring 时 `turn` 保持「下一手本应落子的一方」，不切换、不置 null；`wait_for_turn` 里 **scoring 判断必须在 turn 判断之前** | 数子阶段没有轮次、双方并行确认；用 turn 判「轮到谁」会让已确认方永远收不到唤醒 |
| `mark_dead` 按**整块** toggle；任何标记变化必须重置双方 `scoreConfirmed` | 按单颗 toggle 会只标半块；一方确认后又改死子，原确认不该作数 |
| 网页读 `GoState.board` 二维数组，**不得解析** `boardText` | `boardText` 是给 LLM 的字符画，不是前端数据源 |

---

## 5. Agent 视图（payload 契约）

| 约束 | 为什么 |
|---|---|
| `state.board` 不得回到 MCP 负载；`boardText` / `hotPoints` 不得移除 | 第一局 agent 就是读错 15×15 null 数组、漏看斜线双开四而败；但也不能为省 payload 删掉它们 |
| 100 手时热路径响应 **≤ 4000 字符** | 全量 `moves` 让 100 手到 6920 字符，与省 token 的初衷相反 |
| 截断必须**显式标注**（`movesOmitted`），`get_state` 永远全量 | 不能悄悄截断，否则视图假装长局刚开始 |
| 错误响应里 `moves` 与 `moveCount` 必须一致，不伪装成空历史 | 46 手时返回 `moveCount: 46` 但 `moves: []`，模型据错误复盘时上下文断裂 |
| `boardText` 每个行列号必须可被**唯一解析**（不得出现 `9101112`） | 9/10/11 连成 `9101112`，模型可能读成 910、1112 |
| `win` 判定必须复用引擎 `findWinLine()` | `overlineWin:false` 时六连候选被报成 `win`，而引擎返回 `null` |
| MCP 视图只由 `toAgentStateView()` 生成 | 工具、REST 与错误响应各写一份就会漂移 |
| 面向 agent 的字段只给**事实**，不给结论 | 让模型根据棋盘和威胁信息自行判断落点 |

---

## 6. 持久化与归档

| 约束 | 为什么 |
|---|---|
| 落盘必须原子写（`.tmp` → fsync → rename） | 写一半崩溃会留下损坏 JSON，整个房间读不出来 |
| 损坏文件**不拖垮启动**，也**不被覆盖**、不恢复成空房间 | 把损坏房间列进 `list()` 会 `create()` 空房间再 `save()`，覆盖证据 |
| 归档必须取 `newGame()` 里的 `prev`，在替换 `state` **之前**完成，且两个条件都判（`prev.gameId !== ''`、`history.length > 0`） | 在 `history` 清空附近归档，归档到的是空棋谱加新局；`idle` 房间和零手对局会白占归档位 |
| 归档是**旁路**：失败或清理失败只记日志，不阻塞开新局 | 归档坏了不能让人开不了新局 |
| 保留 N 局**按房间**分别算，不是全局 N | 全局 N 会让一个活跃房间挤掉所有其他房间的历史 |
| 归档文件名用 `__` 分隔；`archiveId` 必须校验格式 | `roomId` 本身允许 `-`，用 `-` 会解析歧义；文件名从 id 拼出来，是唯一的路径穿越面 |
| 回放复用真实引擎，不自己实现提子/劫/五连；`gameId` 沿用落盘值，`now` 传 `move.at`，失败抛错带手数 | 新生成 `gameId` 会对不上；不传 `move.at` 时间戳全变「现在」；静默截断会把坏数据藏起来 |
| 棋类 roster 不持久化；重启后靠同名 `join_game` 拿回座位 | 连接已不存在，恢复一个「在线」状态是撒谎 |
| 落盘根目录**不得绑 `process.cwd()`**，必须锚在代码文件位置；唯一覆盖方式是 `ARENA_DATA_DIR` | `pnpm dev` / `pnpm start` 的 cwd 是 `server/`，直接 `node server/dist/index.js` 是仓库根——同一份代码因此把数据分裂到 `server/data/` 和 `data/` 两处，找对局时两边都要翻 |
| 数据按领域分子目录：`data/rooms/` `data/chat/` `data/archive/` `data/work/`，一个根目录 | 两个领域共用一个 `dataDir` 却因为 cwd 漂移落到不同位置；分目录才能一眼看出哪份数据属于谁 |

---

## 7. 聊天室运行时

| 约束 | 为什么 |
|---|---|
| 增量路径不得静默丢消息：必须给 `nextCursor` / `hasMore` / `omitted`，且 `nextCursor` 严格**前进** | 尾截断 + 前进游标 = 永远拿不到被丢的头部，续读循环还会假报 `hasMore=false` |
| `snapshot()` 保持**纯读**、返回拷贝；要改计数必须走 `memberRef()` | 让读有副作用会牵连网页轮询、WS 广播、回放；改计数加在副本上正是上限失效的根因 |
| `onChange` 改订阅式后，**两个赋值点**（`create()` / `loadFile()`）都要接上 | 单槽被落盘占用时，WS 再赋值就把持久化顶掉，而且测试不会报错；漏掉 `loadFile` 只在重启后坏 |
| 定时器必须 `unref()`，关闭时必须 `clearInterval` | 不 `unref` 进程退不出、测试挂住；不清 interval 会在测试间泄漏 |
| `pass` 不消耗 hop、不产生 `chat` 消息、必须清 `consecutiveTimeouts`，`turn === null` 时拒绝；`pass` 必须能交还主持人（`to: "human"`），单人让出不得把轮次还给同一人，连续 6 次让出且无人发言必须暂停 | 不清超时计数，偶尔 pass 的 agent 会莫名触发暂停；占 hop 会让预算提前耗尽；单 agent 自转会刷屏；两 agent 互让不耗预算也不触发超时，没有硬约束会无限空转 |
| REST 建房的非法 `policy` 或未知字段一律报 `INVALID_REQUEST`，不回退默认值；且**先校验后创建** | 静默丢弃参数正是这个 bug 的成因；校验放创建之后会留下一个用默认值建的空房间 |
| 聊天室 `updatedAt` 必须是真实最后活动时间，不得掺 `lastSeenAt` | 每次返回「现在」会让大厅按请求顺序排序；`lastSeenAt` 是「谁看过」，不是「房间变了」 |


## 8. 工作域

- 单项目、单统筹、单执行者。同一 checkout 串行写。旧聊天快照里的任务字段读取时忽略，旧版工作任务文件跳过并记录日志。这些记录来自测试，无需迁入当前看板。[聊天快照](../../server/src/chat/manager.ts) · [工作任务存储](../../server/src/work/store.ts)
- 复审退回时保留同一任务和各轮记录。执行者收工确认后才可由用户在看板放行；统筹登记实际合并结果，成功记录须有完整提交号和通过的合并后测试。[状态转换](../../server/src/work/store.ts)
- 看板仅对回环地址开放。引用文件必须位于已配置的工作区，下载时重新校验登记的路径和 SHA-256。[本机接口](../../server/src/work/http.ts) · [附件检查](../../server/src/work/model.ts)

## 9. 前端样式

| 约束 | 为什么 |
|---|---|
| 页面组件**不得自己渲染顶栏**（`.topbar`），也**不得自己猜标题**：外壳由 `AppShell` 渲染，标题用 `usePageTitle` 声明 | 改造前 `.topbar` 散在 5 个文件 7 处，拆一次要改七遍；按路径猜标题会被 Router 的解码/大小写/尾斜杠规则打穿，四轮复审各修一次 |
| 一个组件的类名**不得一半 module 一半全局**：迁移时整块搬进 `Xxx.module.scss`，全局表里的对应规则同一次提交删除 | 半迁状态两处都有同名类，谁生效取决于 import 顺序；改样式很容易改到那份不生效的 |
| 迁 module 之前必须把**动态类名**改成显式映射（查表取 key），不得用模板字符串拼 | 拼出来的 key 在 module 里不存在时**编译不报错，只是没样式**。全站共 18 处，迁移时逐处核对 |
| `web/src/styles/index.scss` 的 `@use` 顺序**不得重排** | `.btn--toggle` 与 `.btn` 特异度相同，`responsive.scss` 在 980px 查询里覆盖前者；换顺序会改变窄屏按钮样式，且没有任何测试能发现。[顺序说明](../../web/src/styles/index.scss) |
| 不顺手引入 `_breakpoints.scss` 之类的 mixin 层 | 抽 mixin 会改变媒体查询的产出形式，破坏「样式拆分前后产物字节级相同」这条验收基线；真要加需单独验收 |
| 新页面/新组件默认用 **Tailwind + `components/ui` 的 shadcn 组件**；存量页面继续用现有 SCSS。**同一个组件只能有一个样式来源**，不得把 shadcn 组件再套上全局 `.btn` / `.panel` 一类样式 | 两套体系叠在同一元素上时，谁生效取决于层级与 import 顺序，改一处样式会牵动另一套；新页面用 shadcn 是为了表格、对话框和表单不重复手写，存量页面不迁移是为了避免无测试的视觉回归 |
| `tailwind.css` **不得启用 preflight** | preflight 会重置标题边距、列表和表单控件，直接改变棋局、聊天与工作看板的现有排版；新组件需要的默认边框色已在 `@layer base` 里单独补齐 |

## 10. 房间生命周期

| 约束 | 为什么 |
|---|---|
| `POST /api/rooms` 省略 `roomId` 必须生成新 id（`game-<6 hex>`），**不得回落到 `default`** | `default` 启动时已存在，回落必然 409；大厅的新建按钮没有 id 可传 |
| 删除房间必须同时**解除持久化**（`GameRoom.dispose()` / `ChatManager.remove()` 的 unsubscribe），且删除**不得动归档** | 只删注册表和文件时，挂起的请求会在之后把旧状态写回，房间重启复活；归档是回放的唯一来源 |
| 棋类只在 `lobby` / `finished` 可删，聊天只在空房或 `closed` 可删；其余一律 `ROOM_BUSY`（409） | 进行中的对局有挂起的对手，未关闭的聊天有唯一转录；删除是唯一不可逆动作 |
| 房间的**地址只能是 `roomId`**（`^[a-zA-Z0-9_-]{1,32}$`）；显示名不进寻址、不参与 join | 名字可重名、不可解析；MCP 的 `join_room` / `join_game` 只接受 `roomId` |
| 运行时调 policy 时，`maxHops` / `maxMessagesPerMember` **不得低于已消费值** | 低于已用值时下一次发言立刻又触发同一个暂停，等于假装调整成功 |
