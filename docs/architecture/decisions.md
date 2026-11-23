# 决策记录

> 只记**当时有多个选项、最后选了一个**的判断，写清被放弃的选项和理由。
> 单一路径的实现细节不记——那些看代码就行。
>
> 硬性规则（踩了就返工）在 [`constraints.md`](constraints.md)。

---

## 1. 身份与在线

| 决策 | 放弃的选项 | 为什么 |
|---|---|---|
| **身份靠会话绑定**（`join_game` 记 sessionId → participantId），模型从不传 id | 让模型每次传 `participantId`；或用 HTTP header 传身份 | 模型从不传 id，所以不会传错、也无法冒充。header 那套只留给不走 MCP 会话的 REST 调用方 |
| `resolve` 保留**降级链**：有 id 直查；只有 `actor` 时「恰好一个」才成功，两个报 `AMBIGUOUS_ACTOR`，零个退回旧座位 | 只认 `participantId`，砍掉旧 `actor` 路径 | 要兼容没有 roster 的房间和还在用旧路径的脚本 |
| `new_game` 的座位**优先从 roster 取**（`seatSpecOf()`），`agentColor` 只兜底 | 继续按 `agentColor` 重建座位 | 原写法把 join 建立的 id/name 抹掉，agent 丢身份 |
| `phase` 做成**派生值**（`getPhase()` 现算），不落库 | 存一个 `phase` 字段、每次变更时更新 | 不存在同步问题，也不会因为漏更新而漂移；代价只是每次遍历 roster，可忽略 |
| 开局后再调 `ready` 是**幂等空操作**，不报错 | 报错或拒绝 | press ready twice is a client hiccup, not a rule violation |
| presence sweep **不再跳过带 viewer 的房间** | 保留「跳过 watched 房间」的旧语义 | `watchedAt` 删掉后它不再保护任何东西，唯一效果是阻止过期 agent 会话 emit，页面永远收不到「已断开」 |

---

## 2. Agent 视图

| 决策 | 放弃的选项 | 为什么 |
|---|---|---|
| 热路径只带最近 **8 手** + `movesOmitted`，`get_state` 永远全量 | 全量 `moves`；或改用紧凑 `movesText` **替代**结构化 `moves` | 100 手 6920 → 2470 字符，压进 4000 预算；且省略有显式标注 |
| 删除 `three` 分级，只留 `win/open4/four/open3`（open3 参考级、cap 10） | 把 `three` 改名 `potential`；或收紧判定 | 取最低成本方案：`X..XX`（两格空隙）本来就不是眠三；实测热区条目 13/12 → 7/6 |
| `AgentStateView` **不加** `defense` 派生字段，先靠提示词 | 加 `defense: { mustBlockWin, mustOccupyOpen4, mustBlockFour }` | 会增加类型/传输改动，先做提示词版本 |
| 防守优先级写成**硬阶梯**，且要求「对手 open4 候选点必须**本手**占掉该点本身」 | 只写 `SERVER_INSTRUCTIONS`；或把对手 four 当成可延后到挡 `fiveAt` 的普通威胁 | 有些客户端不展示 server instructions；第⑤条没写「本手」，白方当可延后，下了 (8,10) 输棋 |
| `HotPoint` 只**加可选字段** `double` / `open3At`，且只有**不同方向**的 four + live three 才算 double | 见多个威胁就合并；或同方向的 four+three 也合并 | 同一方向对手一手挡 `fiveAt` 就同时拆掉三，合并会把 T3 白 (5,5) 误报 |
| **不给** `hotPoints` 加 `ifOpponentPlays` 字段 | 加字段直接写明「这格让对手落下会变成什么」 | 信息已全，模型也已把三个点念出来；再加等于替模型做推理，「测的就不是模型能力，而是工具功能」 |

---

## 3. 围棋

| 决策 | 放弃的选项 | 为什么 |
|---|---|---|
| `GameState` 保留名字当五子棋状态，另加 `GoState` + `AnyGameState` union | 把现有 `GameState` 直接改名成 union，再全仓库找编译错误 | 改名会动遍所有五子棋文件，没有收益 |
| 围棋 `scoring` 放独立 `GoStatus` | 给公共 `GameStatus` 加 `'scoring'` | `GameStatus` 被 MCP 契约和整套测试引用，加值会连锁 |
| v1 快照读到 `schemaVersion: 1` 时补 `game:'gomoku'` 升到 v2 | 方案 B：直接不兼容、旧快照丢弃 | 丢弃旧快照会丢数据 |
| 迁移用 `schemaVersion === 1` 判别 | 用 `game === undefined` 判别 | 显式版本标记比「字段缺失」可靠 |
| 非 9 路 / 非 `simple` ko 返回 `UNSUPPORTED_RULE` | 静默接受传入值照跑 | v1 只做 9 路，先拒绝而不是静默接受 |
| 新建 `game/engine/go-game.ts` 承接围棋状态搬运 | 塞进 `gomoku.ts`；或在房间层重写规则 | 保持「五子棋引擎」与「围棋状态搬运」边界清晰、职责对等 |
| scoring 阶段禁止落子时答 **`NOT_SCORING`** | `GAME_NOT_PLAYING` | 后者会让 agent 以为对局结束了，前者明确告诉它「现在是数子阶段」 |
| `dead-stones` **先做状态检查再做点位检查** | 先校验点位合法性 | 已结束的对局，不管点位合不合法都该先答「你现在不该做这个」 |
| 围棋用独立 `GoBoard` 组件，只复用 CSS class | 硬改 15 路 `Board.tsx` 的星位逻辑 | 9 路要 5 个固定星位、无 winLine、要标死子，硬改会让两套规则纠缠 |
| 网页镜像一份 `scorePreview` 算法，终局分只读权威 `state.score` | 不做预览；或用预览当终局分 | 服务端冻结的前提下这是唯一可行解——「预览可以近似，终局必须权威」 |
| 大厅保留「游戏选择 + 直接开局」按钮 | 只留 ready 流 | ready 流开局固定五子棋且服务端冻结，只留准备按钮则新房间永远开不出围棋 |

---

## 4. 聊天室

| 决策 | 放弃的选项 | 为什么 |
|---|---|---|
| 聊天单独一个 `/chat/mcp` 端点 | 与棋类共用 `/mcp` | 两边 instructions 不必互相解释，只玩棋的 agent 永远看不到聊天工具 |
| 聊天自己管在线状态，一个 `Map<participantId, lastSeenAt>` 就够 | 硬复用 `PresenceRegistry`（伪造 `seat`）或大改它 | 它全部按 seat 索引，聊天成员没有座位；伪造会破坏棋类 presence，大改又违反禁改 |
| 网页聊天复用 `/ws`，MCP 用长轮询唤醒 agent | 聊天网页另开 SSE 或轮询通道 | 网页可以复用心跳和重连。MCP 客户端挂起等待，服务端在消息或轮次变化时返回 |
| `onChange` 改成订阅者集合 + `subscribe()`（方案 A） | 保留 `onChange` 给落盘，另加 `onMessage` 给 ws（方案 B） | 方案 B 更小，但两个机制做同一件事，以后容易忘掉一个；方案 A 改动集中、语义清晰 |
| `wait` 丢消息用 **`nextCursor` 续读**（方案 1） | 把单次返回上限从 12 提到 100（方案 2） | 提高上限只是把截断点往后推，真实积压仍会溢出，失败模式会回来 |
| 加 `memberRef()` 返回成员本体 | 让 `snapshot()` 返回浅拷贝或内部 Map | 那会让外部代码能改到内部状态，副作用面更大 |
| 新增独立 **`pass_turn`** 工具 | 给 `send_message` 加 `yield` 参数 | 加 `yield` 参数会让一个工具干两件事 |
| `turnTimeoutMs` 默认 **300 秒**（2026-11-23 由 120 秒上调） | 保持 120 秒；降到 10 秒 | 模型服务拥堵时，两次工具调用之间经常超过 2 分钟；120 秒会把「慢」误判成「死」，连续两次就暂停房间。10 秒更不可能 |
| `pass_turn` 可 `to: "human"` 交还主持人；单人让出即 `turn = null`；连续 **6** 次让出且无人发言则暂停 | 让 human 进轮转；只靠提示词约束 | 轮次只属于 agent、human 随时能说，把 human 放进轮转等于等一个不会发言的人；只靠提示词时两个 agent 会无限互让——pass 不耗 hop、不触发超时，没有任何硬约束 |
| 修懒结算用 `ChatManager.sweep()` + `index.ts` 定时器 | 让 `snapshot()` 结算；或给 `ChatRoom` 自己加定时器 | 让读有副作用会牵连网页轮询、WS 广播、回放；领域对象不该有生命周期 |
| 定时器抽成 **`chat/sweep.ts`** | 内联在 `index.ts` | `index.ts` 一导入就跑 `main()`，内联定时器没法被测试导入，而「unref 生效」「clearInterval 真的停了」最容易被静默改丢 |
| sweep 间隔 **15 秒**，与 `PRESENCE_SWEEP_MS` 一致 | 1 秒或 60 秒 | 太密无意义地扫全部房间；太疏在 300 秒租约下最多再等 60 秒才结算 |

---

## 5. 大厅与回放

| 决策 | 放弃的选项 | 为什么 |
|---|---|---|
| 归档归属用**文件内容**判断（`persisted.id !== roomId`） | 用文件名前缀匹配 | `roomId` 本身可含 `__`，文件名前缀不是归属证明 |
| 清理排序用对局自身 `playedAt`，mtime 只做 tiebreaker | 纯 mtime 排序 | 对局时间比文件时间更确定 |
| 列表端点只读 `state` 摘要，**不跑重放** | 为了显示摘要而执行整个引擎 | 职责分离；损坏只在真正 `/replay` 时暴露 |
| 大厅前端**并行请求** `/api/rooms` 与 `/api/chat/rooms`，渲染层归一化 | 合并成一个列表端点 | 两个领域对象不同，合并会让 `shared` 出现「union of two summaries」这种谁都不满意的类型 |
| 首页 `/` **直接改成大厅** | 新增 `/lobby` 路径、`/` 保持默认房间 | 大厅就是首页才合理；`?room=` 路径完全不变，旧书签照常工作 |

---

## 6. 持久化

| 决策 | 放弃的选项 | 为什么 |
|---|---|---|
| 持久化用 **JSON、一个房间一个文件** | SQLite | JSON 够用先简单；一房一文件则单房损坏不影响其他房间、方便手动查看删除 |
| `save()` 用**同步写**（一子一写），并在注释里写明取舍与升级路径 | 批量 / 异步写 | 响应发出前完成落盘，适合当前本地运行规模 |
| roster **不持久化**，重启后 agent 靠同名 `join_game` 拿回原座位 | 恢复参与者名册 / 在线状态 | 连接已不存在，恢复一个「在线」状态是撒谎 |
| 数据根目录**锚在代码文件位置**（`server/src/config.ts` → `<repo>/data`），不锚 `process.cwd()` | 继续用 cwd 相对路径；或要求每个入口自己设 `ARENA_DATA_DIR` | cwd 随启动方式变（`pnpm dev` 是 `server/`，直接 `node server/dist/index.js` 是仓库根），同一份代码会把数据分裂到两处；「记得每个入口都设环境变量」是靠纪律而不是靠结构。文件位置在 dev 与 build 两种形态下都稳定（`server/src` 与 `server/dist` 都上跳两级到仓库根） |
| 一个 `data/` 根目录 + 领域子目录（`rooms` / `chat` / `archive`） | 每个领域自己一个根目录（`data/` 与 `server/data/chat/`） | 领域已经分开（独立端点、独立模型），落盘却在两个树里，找数据要先知道它是哪一类。统一根目录 + 子目录，既保留领域边界又只有一处要找 |

## 7. 开发任务为何独立成域

开发任务有同一任务内返工、收工确认与合并放行。借用聊天室收件虽省了配置，却把任务生命周期绑到了房间轮次，用户也很难从界面判断到哪里派单。专用工作域让执行者按角色长轮询收件，用户在大厅看板看每一轮证据；代价是客户端需要单独连接工作端点，两个会话要在线收件。runner 与桌面会话自动续接保留为候选。

---

## 8. 目录与命名

| 决策 | 放弃的选项 | 为什么 |
|---|---|---|
| 棋牌域叫 `game/` | `games/`、`board/` | 这个域的对象是「一盘对局」，单数；且与端点 `/game/mcp`、文档里的「棋类域」用词一致 |
| **`core/` → `engine/`** | 保留 `core`；改叫 `rules/`、`logic/`、`kernel/` | `core` 的问题不是长短，而是它**听起来是全局的**——正是要消灭的那种误判。剔除 `session-context` 与 `presence` 后剩下的 6 个文件全是「给定状态算出结果」的纯函数；`rules/` 装不下 `insights` 与 `replay`，`logic/` 与 `core` 一样空泛 |
| `engine.ts` → `gomoku.ts` | 保留 `engine.ts` | 目录已叫 `engine`，文件再叫 `engine` 就成了 `game/engine/engine.ts`，读 import 时口吃。只改文件名，`GameState` 类型名不动 |
| `presence.ts` 放 `game/rooms/` | 留在 `engine/` | presence 按**座位**索引，座位归房间；它只 import `shared`，跟着 engine 走名不副实 |
| `session-context.ts` 放根级 | 放进 `game/`；或新建 `infra/` | 它被 chat、work、game 三域和 `app.ts` 共同引用，是跨域基础设施。放 `game/` 会让 `chat/mcp.ts` 反向依赖棋牌域 |
| **stdio 适配层删除** | 移进 `game/mcp/` 并保留一个兼容壳 | 它不是独立服务：只把工具调用转成 REST 打给已经在跑的同一个后端，没有增加任何能力，只多出额外进程、`bin` 契约和「客户端只认 stdio」的兼容面。三个域都统一 Streamable HTTP 后它是纯历史包袱，保留就得一直维护两套适配器 |
| 装配与进程文件留 `server/src/` 根 | 新建 `infra/` 目录 | 只剩 5 个文件，都只被入口或各域以 `../x.js` 引用；再套一层会把「整个服务的装配入口」变成 `infra/app.ts`，读代码多跳一次 |

---

## 9. 前端外壳与样式

| 决策 | 放弃的选项 | 为什么 |
|---|---|---|
| **页面标题由路由声明**（`usePageTitle`），`AppShell` 只负责渲染 | 在外壳里按 `location.pathname` 匹配一张标题表 | Router 会解码 `%72`、大小写不敏感、容忍尾斜杠，外壳另算一遍必然漂移：`/games/x/replay/`、`/GAMES/x/REPLAY`、`/games/x/%72eplay` 三次都是同一根因，最后整张表删掉 |
| 先换预处理器（2a）再谈作用域（2b） | 一步到位改成 CSS Modules | 2a 没有 JSX 改动，是纯文件搬运，可以单独验收「视觉零差异」，把风险与前后两批改造隔开 |
| 2b **只做增量**：新写或重写的组件从第一行就用 `Xxx.module.scss`，存量组件被重写时顺手迁 | 设一个「全站 module 化」的截止线 | 2a 之后「一个文件互相踩」已经解决，2b 剩下的只是类名作用域，边际收益低；全站迁移要改每个 `className` 外加 18 处动态类名，而前端零测试，回归面远大于收益 |
| 2b 排在路由与大厅改造**之后** | 先做 module 再改路由 | 两者都动同一批组件的 `className`，先做等于同一批代码改两遍 |
