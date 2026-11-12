# 决策记录

> 只记**当时有多个选项、最后选了一个**的判断，写清被放弃的选项和理由。
> 单一路径的实现细节不记——那些看代码就行。
>
> 硬性规则（踩了就返工）在 [`constraints.md`](constraints.md)。

---

## 0. 阶段顺序

| 决策 | 放弃的选项 | 为什么 | 出处 |
|---|---|---|---|
| **先做「参与者」这一层**（P1），再做双 AI / 围棋 / 聊天 | 先做双 AI，临时造一套 agent 身份；或先做聊天，再造一套 member/presence | 三件事缺的是同一个东西。做三次再合并，比一开始抽一层贵得多 | [roadmap §1](../roadmap.md) |
| **P3.5 持久化插在 P3 和 P4 之间** | 按原计划直接进 P4 | P3 实战验收时刚下完的一盘棋随服务重启没了。P4 的对话记录会同样丢失——这是基础设施缺口，不是「不方便」 | [roadmap §0](../roadmap.md) |
| **P3a 只做纯函数引擎，集成（P3b）等 P1c 定下来** | 引擎和 `new_game` 集成同时推进 | 两边都要改 `new_game`，同时做必冲突 | [P3a 工作单 §1](../phases/05-p3a-go-rules/handoff.md) |
| **P3b 拆成四份工作单，严格按顺序** | 一份工作单做完类型 + 接入 + 数子 + 网页 | 类型是地基：第 2 份要给 `new_game` 加 `game`，第 3 份要给 `wait_for_turn` 加 `scoring`，都要动类型。一次改完类型，后面只写逻辑，冲突面最小 | [roadmap §3](../roadmap.md) |
| **C4 网页直接复用现有 `/ws`，不引入 SSE** | 聊天单独走 SSE 或轮询 | 否则仓库同时存在两套推送，要维护两套心跳、重连、错误处理——正是 P5「WS 统一」要消灭的东西。这也让 P5 的「WS 统一」缩水：聊天那部分提前在 C4 做掉 | [C4 工作单 §1](../phases/14-p4-c4-chat-web/handoff.md) |

---

## 1. 身份与在线

| 决策 | 放弃的选项 | 为什么 | 出处 |
|---|---|---|---|
| **身份靠会话绑定**（`join_game` 记 sessionId → participantId），模型从不传 id | 让模型每次传 `participantId`；或用 HTTP header 传身份 | 模型从不传 id，所以不会传错、也无法冒充。header 那套只给 stdio 桥用 | [P1b 工作单 §2.4](../phases/02-p1b-participants/handoff.md) · [P2 工作单 §3.1](../phases/04-p2-real-models/handoff.md) |
| `resolve` 保留**降级链**：有 id 直查；只有 `actor` 时「恰好一个」才成功，两个报 `AMBIGUOUS_ACTOR`，零个退回旧座位 | 只认 `participantId`，砍掉旧 `actor` 路径 | 要兼容没有 roster 的房间和还在用旧路径的脚本 | [P1b 工作单 §2.3](../phases/02-p1b-participants/handoff.md) |
| `new_game` 的座位**优先从 roster 取**（`seatSpecOf()`），`agentColor` 只兜底 | 继续按 `agentColor` 重建座位 | 原写法把 join 建立的 id/name 抹掉，agent 丢身份 | [P1b 工作单 §2.6](../phases/02-p1b-participants/handoff.md) |
| `phase` 做成**派生值**（`getPhase()` 现算），不落库 | 存一个 `phase` 字段、每次变更时更新 | 不存在同步问题，也不会因为漏更新而漂移；代价只是每次遍历 roster，可忽略 | [P1c 评审 §2.3](../phases/03-p1c-lobby/review.md) |
| 开局后再调 `ready` 是**幂等空操作**，不报错 | 报错或拒绝 | press ready twice is a client hiccup, not a rule violation | [P1c 工作单 §4.4](../phases/03-p1c-lobby/handoff.md) |
| presence sweep **不再跳过带 viewer 的房间** | 保留「跳过 watched 房间」的旧语义 | `watchedAt` 删掉后它不再保护任何东西，唯一效果是阻止过期 agent 会话 emit，页面永远收不到「已断开」 | [P1b 工作单 §2.11](../phases/02-p1b-participants/handoff.md) |

---

## 2. Agent 视图

| 决策 | 放弃的选项 | 为什么 | 出处 |
|---|---|---|---|
| 热路径只带最近 **8 手** + `movesOmitted`，`get_state` 永远全量 | 全量 `moves`；或改用紧凑 `movesText` **替代**结构化 `moves` | 100 手 6920 → 2470 字符，压进 4000 预算；且省略有显式标注 | [Agent 视图评审 §3 P0-2](../phases/01-agent-view/review.md) |
| 删除 `three` 分级，只留 `win/open4/four/open3`（open3 参考级、cap 10） | 把 `three` 改名 `potential`；或收紧判定 | 取最低成本方案：`X..XX`（两格空隙）本来就不是眠三；实测热区条目 13/12 → 7/6 | [整改回执 §2 P1-2](../phases/01-agent-view/review-result.md) |
| `AgentStateView` **不加** `defense` 派生字段，先靠提示词 | 加 `defense: { mustBlockWin, mustOccupyOpen4, mustBlockFour }` | 会增加类型/传输改动，先做提示词版本 | [Agent 视图评审 §3 P0-1](../phases/01-agent-view/review.md) |
| 防守优先级写成**硬阶梯**，且要求「对手 open4 候选点必须**本手**占掉该点本身」 | 只写 `SERVER_INSTRUCTIONS`；或把对手 four 当成可延后到挡 `fiveAt` 的普通威胁 | 有些客户端不展示 server instructions；第⑤条没写「本手」，白方当可延后，下了 (8,10) 输棋 | [实战棋谱 §2.3](../phases/01-agent-view/game-record.md) |
| `HotPoint` 只**加可选字段** `double` / `open3At`，且只有**不同方向**的 four + live three 才算 double | 见多个威胁就合并；或同方向的 four+three 也合并 | 同一方向对手一手挡 `fiveAt` 就同时拆掉三，合并会把 T3 白 (5,5) 误报 | [实战棋谱 §4.2](../phases/01-agent-view/game-record.md) |
| **不给** `hotPoints` 加 `ifOpponentPlays` 字段 | 加字段直接写明「这格让对手落下会变成什么」 | 信息已全，模型也已把三个点念出来；再加等于替模型做推理，「测的就不是模型能力，而是工具功能」 | [P2 结果 §5.6](../phases/04-p2-real-models/result.md) |

---

## 3. 围棋

| 决策 | 放弃的选项 | 为什么 | 出处 |
|---|---|---|---|
| `GameState` 保留名字当五子棋状态，另加 `GoState` + `AnyGameState` union | 把现有 `GameState` 直接改名成 union，再全仓库找编译错误 | 改名会动遍所有五子棋文件，没有收益 | [P3b-1 工作单 §2](../phases/06-p3b-1-go-types/handoff.md) |
| 围棋 `scoring` 放独立 `GoStatus` | 给公共 `GameStatus` 加 `'scoring'` | `GameStatus` 被 MCP 契约和整套测试引用，加值会连锁 | [P3b-1 工作单 §2.1](../phases/06-p3b-1-go-types/handoff.md) |
| v1 快照读到 `schemaVersion: 1` 时补 `game:'gomoku'` 升到 v2 | 方案 B：直接不兼容、旧快照丢弃 | 丢弃旧快照会丢数据 | [P3b-1 工作单 §2.2](../phases/06-p3b-1-go-types/handoff.md) |
| 迁移用 `schemaVersion === 1` 判别 | 用 `game === undefined` 判别 | 显式版本标记比「字段缺失」可靠 | [P3b-1 评审 §4.1](../phases/06-p3b-1-go-types/review.md) |
| 非 9 路 / 非 `simple` ko 返回 `UNSUPPORTED_RULE` | 静默接受传入值照跑 | v1 只做 9 路，先拒绝而不是静默接受 | [P3b-2 工作单 §2.1](../phases/07-p3b-2-go-integration/handoff.md) |
| 新建 `core/go-game.ts` 承接围棋状态搬运 | 塞进 `engine.ts`；或在房间层重写规则 | 保持「五子棋引擎」与「围棋状态搬运」边界清晰、职责对等 | [P3b-2 评审 §8](../phases/07-p3b-2-go-integration/review.md) |
| scoring 阶段禁止落子时答 **`NOT_SCORING`** | `GAME_NOT_PLAYING` | 后者会让 agent 以为对局结束了，前者明确告诉它「现在是数子阶段」 | [P3b-3 评审 §5.2](../phases/08-p3b-3-go-scoring/review.md) |
| `dead-stones` **先做状态检查再做点位检查** | 先校验点位合法性 | 已结束的对局，不管点位合不合法都该先答「你现在不该做这个」 | [P3b-3 评审 §5.3](../phases/08-p3b-3-go-scoring/review.md) |
| 围棋用独立 `GoBoard` 组件，只复用 CSS class | 硬改 15 路 `Board.tsx` 的星位逻辑 | 9 路要 5 个固定星位、无 winLine、要标死子，硬改会让两套规则纠缠 | [P3b-4 工作单 §4.2](../phases/09-p3b-4-go-web/handoff.md) |
| 网页镜像一份 `scorePreview` 算法，终局分只读权威 `state.score` | 不做预览；或用预览当终局分 | 服务端冻结的前提下这是唯一可行解——「预览可以近似，终局必须权威」 | [P3b-4 评审 §4、§9](../phases/09-p3b-4-go-web/review.md) |
| 大厅保留「游戏选择 + 直接开局」按钮 | 只留 ready 流 | ready 流开局固定五子棋且服务端冻结，只留准备按钮则新房间永远开不出围棋 | [P3b-4 评审 §5](../phases/09-p3b-4-go-web/review.md) |

---

## 4. 聊天室

| 决策 | 放弃的选项 | 为什么 | 出处 |
|---|---|---|---|
| 聊天单独一个 `/chat/mcp` 端点 | 与棋类共用 `/mcp` | 两边 instructions 不必互相解释，只玩棋的 agent 永远看不到聊天工具 | [C1 评审 §3](../phases/11-p4-c1-chat-server/review.md) |
| 聊天自己管在线状态，一个 `Map<participantId, lastSeenAt>` 就够 | 硬复用 `PresenceRegistry`（伪造 `seat`）或大改它 | 它全部按 seat 索引，聊天成员没有座位；伪造会破坏棋类 presence，大改又违反禁改 | [C1 工作单 §2.2](../phases/11-p4-c1-chat-server/handoff.md) |
| C1/C2 不做 WS，唤醒走**真挂起的长轮询** | 复用现有 `/ws` | `ws.ts` 绑死 `GameRoom`，要支持聊天得改 `RoomManager` 和 `ws.ts`，违反禁改；MCP 没有 push，不等待的 agent 本就不可达 | [C1 工作单 §7](../phases/11-p4-c1-chat-server/handoff.md) |
| `onChange` 改成订阅者集合 + `subscribe()`（方案 A） | 保留 `onChange` 给落盘，另加 `onMessage` 给 ws（方案 B） | 方案 B 更小，但两个机制做同一件事，以后容易忘掉一个；方案 A 改动集中、语义清晰 | [C4 工作单 §2.1](../phases/14-p4-c4-chat-web/handoff.md) |
| `wait` 丢消息用 **`nextCursor` 续读**（方案 1） | 把单次返回上限从 12 提到 100（方案 2） | 提高上限只是把截断点往后推，真实积压仍会溢出，失败模式会回来 | [C2.5 评审 §5](../phases/13-p4-c25-chat-fix/review.md) |
| 加 `memberRef()` 返回成员本体 | 让 `snapshot()` 返回浅拷贝或内部 Map | 那会让外部代码能改到内部状态，副作用面更大 | [C2.5 评审 §5](../phases/13-p4-c25-chat-fix/review.md) |
| 新增独立 **`pass_turn`** 工具 | 给 `send_message` 加 `yield` 参数 | 加 `yield` 参数会让一个工具干两件事 | [pass_turn 工作单 §2](../phases/17-chat-pass-turn/handoff.md) |
| `turnTimeoutMs` 保持 **120 秒**不动 | 降到 10 秒 | 10 秒对真实模型思考太短，会误判 | [pass_turn 工作单 §2](../phases/17-chat-pass-turn/handoff.md) |
| 修懒结算用 `ChatManager.sweep()` + `index.ts` 定时器 | 让 `snapshot()` 结算；或给 `ChatRoom` 自己加定时器 | 让读有副作用会牵连网页轮询、WS 广播、回放；领域对象不该有生命周期 | [租约工作单 §1.1](../phases/18-chat-lease/handoff.md) |
| 定时器抽成 **`chat/sweep.ts`**（偏离工作单的内联写法） | 内联在 `index.ts` | `index.ts` 一导入就跑 `main()`，内联定时器没法被测试导入，而「unref 生效」「clearInterval 真的停了」最容易被静默改丢 | [租约评审 §7](../phases/18-chat-lease/review.md) |
| sweep 间隔 **15 秒**，与 `PRESENCE_SWEEP_MS` 一致 | 1 秒或 60 秒 | 太密无意义地扫全部房间；太疏在 120 秒租约下最多再等 60 秒才结算 | [租约工作单 §1.2](../phases/18-chat-lease/handoff.md) |

---

## 5. 大厅与回放

| 决策 | 放弃的选项 | 为什么 | 出处 |
|---|---|---|---|
| 归档归属用**文件内容**判断（`persisted.id !== roomId`） | 用文件名前缀匹配 | `roomId` 本身可含 `__`，文件名前缀不是归属证明 | [P5A 评审 §5](../phases/15-p5a-replay/review.md) |
| 清理排序用对局自身 `playedAt`，mtime 只做 tiebreaker | 纯 mtime 排序 | 对局时间比文件时间更确定 | [P5A 评审 §5](../phases/15-p5a-replay/review.md) |
| 列表端点只读 `state` 摘要，**不跑重放** | 为了显示摘要而执行整个引擎 | 职责分离；损坏只在真正 `/replay` 时暴露 | [P5A 评审 §3](../phases/15-p5a-replay/review.md) |
| 大厅前端**并行请求** `/api/rooms` 与 `/api/chat/rooms`，渲染层归一化 | 合并成一个列表端点 | 两个领域对象不同，合并会让 `shared` 出现「union of two summaries」这种谁都不满意的类型 | [P5B 工作单 §1](../phases/16-p5b-lobby/handoff.md) |
| 首页 `/` **直接改成大厅** | 新增 `/lobby` 路径、`/` 保持默认房间 | 大厅就是首页才合理；`?room=` 路径完全不变，旧书签照常工作 | [P5B 工作单 §3](../phases/16-p5b-lobby/handoff.md) |

---

## 6. 持久化

| 决策 | 放弃的选项 | 为什么 | 出处 |
|---|---|---|---|
| 持久化用 **JSON、一个房间一个文件** | SQLite | JSON 够用先简单；一房一文件则单房损坏不影响其他房间、方便手动查看删除 | [P3.5 工作单 §2、§3.1](../phases/10-p35-persistence/handoff.md) |
| `save()` 用**同步写**（一子一写），并在注释里写明取舍与升级路径 | 批量 / 异步写 | 响应发出前必须已落盘；9 路最多 81 手、每次几毫秒可接受 | [P3.5 工作单 §7](../phases/10-p35-persistence/handoff.md) |
| roster **不持久化**，重启后 agent 靠同名 `join_game` 拿回原座位 | 恢复参与者名册 / 在线状态 | 连接已不存在，恢复一个「在线」状态是撒谎 | [P3.5 工作单 §5.3](../phases/10-p35-persistence/handoff.md) |
| 数据根目录**锚在代码文件位置**（`server/src/config.ts` → `<repo>/data`），不锚 `process.cwd()` | 继续用 cwd 相对路径；或要求每个入口自己设 `ARENA_DATA_DIR` | cwd 随启动方式变（`pnpm dev` 是 `server/`，直接 `node server/dist/index.js` 是仓库根），同一份代码会把数据分裂到两处；「记得每个入口都设环境变量」是靠纪律而不是靠结构。文件位置在 dev 与 build 两种形态下都稳定（`server/src` 与 `server/dist` 都上跳两级到仓库根） | 2026-11-12 统一路径（`server/src/config.ts`） |
| 一个 `data/` 根目录 + 领域子目录（`rooms` / `chat` / `archive`） | 每个领域自己一个根目录（`data/` 与 `server/data/chat/`） | 领域已经分开（独立端点、独立模型），落盘却在两个树里，找数据要先知道它是哪一类。统一根目录 + 子目录，既保留领域边界又只有一处要找 | 2026-11-12 统一路径（`server/src/config.ts`） |
