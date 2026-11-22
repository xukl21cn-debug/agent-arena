# 后端领域目录归拢（含 stdio 适配层下线）

> 设计提案 · 2026-11-21（第二版，合并外部评审意见）
> 状态：**已实现，后端复审通过，待用户验收**（5 个提交见 §6）
> 基线：`cf3b53b`（`main` 为 `34bd7ef`，两者差异只在部署脚本、README 与 `server/src/index.ts` 一行），383 项测试全绿
> 范围：`server/src/` 的物理结构与 import 路径、`server/test/` 的静态与动态 import、根目录 `scripts/*.mjs` 对编译产物的引用、文档里的源码链接与接入说明，外加**下线棋类 stdio 适配层**。
> ⚠️ **本提案含一处破坏性变更**：stdio 接入方式下线（§2.3）。除此之外的步骤都是纯移动，函数签名、端点路径、`shared/` 类型、落盘格式一律不动。
> 兄弟提案：[前端 SPA 外壳与样式现代化](frontend-spa-and-styles.md)。两者互不依赖，各自分支、各自合入。

---

## 1. 需求确认

### 1.1 实际场景

1. **新 agent 按架构地图找代码会被目录名误导。** 从 [overview.md](../architecture/overview.md) 找「围棋规则在哪」，看到根级 `core/`、`rooms/`、`mcp/`、`http/`，直觉上会当成跨域公共层；读进去才发现它们只服务五子棋和围棋，而 `chat/`、`work/` 各自内聚。同一个仓库两套组织方式，认知负荷全落在「哪些目录是公共的」这个判断上。
2. **误导会自己加固。** 给聊天加东西时看到 [chat/mcp.ts:17](../../server/src/chat/mcp.ts) 引 `../core/session-context.js`，很容易得出「`core/` 是共享基础设施」的结论，于是新的跨域工具也往 `core/` 放——错误结构因此被复制。
3. **stdio 适配层已经没人用，却还在影响结构。** 仓库自己的 [.mcp.json](../../.mcp.json) 配的是三个 Streamable HTTP 地址，[duel.mjs](../../server/scripts/duel.mjs) 也走 HTTP。棋类却还多一个 stdio 桥，让三个域的接入形式不统一；它同时是根级 `mcp/` 目录和 `package.json` 里 `bin` 契约的唯一来源。
4. **已经配置好的 HTTP 客户端不能坏。** `/game/mcp`、`/chat/mcp`、`/work/mcp`、`/api/*` 的路径与报文是外部 AI 客户端（DSH、Codex、ZCode）依赖的，本次一个都不动。

### 1.2 当前与期望

| 维度 | 当前 | 期望 |
|---|---|---|
| 棋类 | 散在根级 `core/` `rooms/` `mcp/` `http/`，名字像公共层 | 收进 `game/`，四个子目录名就是职责 |
| 跨域基础设施 | `core/session-context.ts` 藏在「棋类」目录里，被三域共用 | 提到根级，名字与作用一致 |
| 装配与进程 | `app.ts` `config.ts` `index.ts` 在根级，`ws.ts` 在 `http/` 里 | 全部留在根级，根级只剩「装配 + 进程 + 共享设施」 |
| 外部接入 | 棋类多一个 stdio 桥，另有 `bin` 与 `dist/mcp/stdio.js` 契约；聊天与工作只有 HTTP | 三个域统一 Streamable HTTP，没有 stdio、没有 `bin` |
| 三域 | `chat/`、`work/` 已内聚 | 保持不动 |

### 1.3 范围

- **改**：删除棋类 stdio 适配层及其唯一依赖（`resolveServerUrl`、`bin`、只测 `HttpApi` 的 S-03，并补一个走 MCP 的 `InProcessApi.callerSeat` 回归用例）；`server/src/` 下文件的物理位置与 import 路径；`server/test/` 的静态与动态 import；根目录 3 个脚本对 `server/dist/core/*` 的引用；`docs/architecture/*.md` 与 README 里对应的链接、路径文本和接入说明。
- **不改**：任何函数的入参/返回值/错误码、`/api/*` 与 `/game/mcp` `/chat/mcp` `/work/mcp` 的路径与报文、`shared/` 任何类型、`data/` 下任何落盘格式、`shared/src/game.ts` 的名字（[constraints.md:17](../architecture/constraints.md)：`GameState` 继续指五子棋）。

### 1.4 可观察的验收条件

1. `pnpm test` **383 项全绿**（383 − 1 删掉测 `HttpApi` 的 S-03 + 1 补 `InProcessApi.callerSeat` 的回归用例，账在 §2.3）。
2. 清空旧产物后 `pnpm typecheck && pnpm build` 通过；`server/src`、`server/test`、`scripts/` 里不存在指向旧路径的静态或动态 import。
3. 三个 MCP 端点手工连通：`/game/mcp`、`/chat/mcp`、`/work/mcp`，外加 `/api/rooms`。
4. `server/package.json` 里没有 `bin`；全新构建产物里没有 `server/dist/mcp/stdio.js`，也没有 `server/dist/core/`。
5. `node server/scripts/duel.mjs` 仍能下完一盘；根目录 3 个辅助脚本（`scripts/replay-game2.mjs`、`scripts/measure-payload.mjs`、`scripts/demo-agent-view.mjs`）能正常加载模块。
6. `docs/architecture/overview.md` 的源码链接可以点开，`constraints.md`、`decisions.md` 里的路径文本与新结构一致。
7. `node scripts/deploy.mjs` 仍能产出 `deploy-dst`。

---

## 2. 方案设计

### 2.1 目标结构

```text
server/src/
├── game/                      # 🎮 棋牌域
│   ├── engine/                # 规则与推演：纯函数，无 I/O
│   │   ├── gomoku.ts          # 原 core/engine.ts（五子棋引擎）
│   │   ├── rules.ts           # 五子棋威胁与胜负判定
│   │   ├── go.ts              # 围棋规则（独立审计过，不得重写）
│   │   ├── go-game.ts         # 围棋状态搬运
│   │   ├── insights.ts        # 面向 agent 的状态视图
│   │   └── replay.ts          # 棋谱回放（复用真实引擎）
│   ├── rooms/                 # 房间编排与持久化
│   │   ├── room.ts
│   │   ├── room-manager.ts
│   │   ├── repository.ts
│   │   ├── participant-roster.ts
│   │   └── presence.ts        # 原 core/presence.ts，按座位索引
│   ├── mcp/                   # 棋类 MCP：tools / api / http（stdio 已下线）
│   └── http/                  # 棋类 REST（原 http/routes.ts）
│
├── chat/                      # 💬 不动
├── work/                      # 🛠️ 不动
│
├── app.ts                     # Express 装配
├── config.ts                  # 配置与环境变量
├── index.ts                   # 进程启动
├── ws.ts                      # 原 http/ws.ts，全局 WS 分派
└── session-context.ts         # 原 core/session-context.ts，跨域会话绑定
```

根级不再有 `mcp/` 目录：stdio 适配层下线后，`mcp/` 里剩下的三个文件全是棋类专属，整体搬进 `game/mcp/`。

### 2.2 命名决策

| 决策 | 放弃的选项 | 为什么 |
|---|---|---|
| 棋牌域叫 `game/` | `games/`、`board/` | 这个域的对象是「一盘对局」，单数；且与现有端点 `/game/mcp`、文档里的「棋类域」用词一致 |
| **`core/` → `engine/`** | 保留 `core`；改叫 `rules/`、`logic/`、`kernel/` | `core` 的问题不是长短，而是它**听起来是全局的**——这正是本次要消灭的误判。剔除 `session-context` 与 `presence` 后，剩下的 6 个文件全是「给定状态算出结果」的纯函数（规则、引擎、agent 视图、回放），`engine` 是文档里已经在用的词（「复用真实引擎」「棋类引擎」）。`rules/` 装不下 `insights` 与 `replay`；`logic/` 和 `core` 一样空泛 |
| `engine.ts` → `gomoku.ts` | 保留 `engine.ts` | 目录已经叫 `engine`，文件再叫 `engine` 就是 `game/engine/engine.ts`，读 import 时口吃。**已确认要做**；只改文件名，`GameState` 类型名不动（constraints §1 约束的是类型名，不是文件名） |
| `presence.ts` → `game/rooms/presence.ts` | 留在 `engine/` | presence 按**座位**索引（constraints §3），座位归房间；它只 import `shared`，不依赖 engine 任何文件，跟着 engine 走属于名不副实 |
| `session-context.ts` → 根级 | 放进 `game/`；或新建 `infra/` | 它被 chat、work、game 三域和 `app.ts` 共同引用，是**跨域基础设施**。放 `game/` 会让 `chat/mcp.ts` 反向依赖棋牌域，正好制造本提案要消灭的问题 |
| **stdio 适配层直接删除** | 移进 `game/mcp/` 并保留一个兼容壳 | 它是棋类专属实现、产品级命名，而且已经无人使用（§2.3）。保留它就得一直维护 `bin` 契约与兼容壳，收益为零 |
| 装配与进程文件留在 `server/src/` 根 | 新建 `infra/` 目录 | 只剩 5 个文件（`app` / `config` / `index` / `ws` / `session-context`），都只被入口或各域以 `../x.js` 引用。再套一层 `infra/` 会把「整个服务的装配入口」变成 `infra/app.ts`，读代码多跳一次，收益只是整齐 |

### 2.3 下线 stdio 适配层（唯一的破坏性变更）

#### 为什么可以删

stdio 桥不是独立服务：它启动后把每个工具调用转成 REST 请求，打给**已经在跑的同一个后端**。没有后端它一样跑不起来，所以它没有增加任何能力，只多出三样东西：

- 一个额外进程和一份额外的启动方式（`node .../dist/mcp/stdio.js`）；
- 一套 `bin` 契约（`package.json` 的 `bin`、README 的绝对路径、部署包里的路径）；
- 一套「客户端只认 stdio」的兼容面。

现在三个域都是 Streamable HTTP，仓库自己的 [.mcp.json](../../.mcp.json) 与 [duel.mjs](../../server/scripts/duel.mjs) 也都走 HTTP，stdio 已经是纯历史包袱。

#### 这个入口是棋类专属的

先澄清一个容易搞混的点：`stdio.ts` 名字像通用入口，实现上只服务棋类。

| 检查点 | 结果 |
|---|---|
| [api.ts](../../server/src/game/mcp/api.ts) 的 `ArenaApi` 接口 | 全部是棋类方法：`joinGame` / `placeStone` / `passGame` / `markDead` / `confirmScore` / `resumePlay` / `resign` / `say`，没有任何聊天或工作的方法 |
| [tools.ts](../../server/src/game/mcp/tools.ts) 注册的工具 | `join_game` / `leave_room` / `new_game` / `get_state` / `wait_for_turn` / `place_stone` / `pass` / `mark_dead` / `confirm_score` |
| `SERVER_INSTRUCTIONS` 第一句 | 「你是棋类对弈 Agent。」 |
| 聊天与工作 | 只有 HTTP 端点（`/chat/mcp`、`/work/mcp`），**没有 stdio 桥** |

所以真身跟着 `game/` 走是准确的。但**名字确实是产品级的**：`bin` 叫 `agent-arena`、路径叫 `mcp/stdio`，这是项目最初只做五子棋时留下的（[gomoku-design.md](../archive/gomoku-design.md) 那套设计里棋类就是全部）。这也是为什么它看起来像「整个产品的入口」——而现在直接删掉，这个误导源就彻底消失了。

如果以后想让 stdio 桥也暴露聊天工具，那是一次产品级变更：重新建入口、改 `bin`、改 README、通知所有客户端，与本次归拢无关。

#### 删除清单

| 文件 / 位置 | 动作 | 说明 |
|---|---|---|
| `server/src/mcp/stdio.ts`（327 行） | 删 | `HttpApi` + `createStdioServer` + `main()`，无其他模块引用 |
| `server/src/config.ts` 的 `resolveServerUrl()` | 删 | 唯一使用者是 stdio；`config.test.ts` 没测它。`DEFAULT_SERVER_URL` 保留（`loadConfig` 还在用） |
| `server/test/dual-agent.test.ts` 的 S-03（461-612 行） | **替换**为 `InProcessApi` 用例 | S-03 测的是 `HttpApi`，但其中多个 `yourColor` 边界在现有用例中**无替代覆盖**，需迁到 `/game/mcp`（见下面「测试账」） |
| `server/package.json` 的 `bin` | 删 | 包不再提供可执行命令 |
| README 第 79、81 行 | 删 | 接入表格的 stdio 行与那段说明 |
| README 第 155 行 | 改 | `ARENA_SERVER_URL` 仍被 Vite 代理使用，描述里去掉 stdio |
| [overview.md:7](../architecture/overview.md) | 改 | 删「棋类另有 stdio 进程，经 REST 调用同一后端」 |
| [decisions.md:14](../architecture/decisions.md) | 改 | 「header 那套只给 stdio 桥用」的理由需要换一个 |
| [constraints.md](../architecture/constraints.md) §5 的一行 | 改 | 「`InProcessApi` 与 `HttpApi` 必须返回同一份视图」只剩一个适配器，规则改写为「MCP 视图只由 `toAgentStateView()` 生成」 |
| `server/src/mcp/api.ts:18` 注释 | 改 | 去掉「两种实现」的说法 |
| `server/src/http/routes.ts:297-303` 注释 | 改 | **行为不动**，只改注释里「stdio bridge」的理由 |

`docs/archive/` 下的历史文档（如 [gomoku-design.md](../archive/gomoku-design.md) 里的 stdio 命令）**不动**——它们是归档，不是当前说明。

#### 测试账：383 − 1 + 1 = 383

直接删掉 S-03 会留下真实的覆盖缺口。逐项核查的结果：

| 现有用例 | 覆盖到哪 | 缺什么 |
|---|---|---|
| [room-identity.test.ts](../../server/test/room-identity.test.ts) | `GameRoom.resolve()` / `moveAs()` / `resignAs()` | 不断言任何 `yourColor`，也不经过 `InProcessApi.callerSeat()` |
| [http.test.ts:300-331](../../server/test/http.test.ts) | 「单白 AI、未 join」的 `new_game` 与 `wait_for_turn` | 没测 `get_state`，也没测单黑 AI |
| [lobby.test.ts:255-259](../../server/test/lobby.test.ts) | `POST /ready` 传 `body.participantId` 推 phase | 与 `yourColor` 无关 |
| [dual-agent.test.ts:232-272](../../server/test/dual-agent.test.ts) | 双 AI 的 `get_state.yourColor`（246、249 行） | 没测 `new_game.yourColor` |
| [dual-agent.test.ts:274-358](../../server/test/dual-agent.test.ts) | `wait_for_turn.yourColor` | 走 `room.resolve`，不经 `callerSeat` |

也就是说，S-03 独有覆盖的是 [mcp/http.ts:189-198](../../server/src/game/mcp/http.ts) 里 `callerSeat()` 的几个分支。所以**删 S-03 的同一次提交必须补 1 个走真实 `/game/mcp` 的回归用例**，覆盖：

1. **双 AI 的 `new_game` 与 `get_state`**：黑方与白方各自收到自己的 `yourColor`；
2. **旁观者（`join_game` 不传 seat）**：`get_state` / `new_game` 返回 `yourColor: null`，不得回退到 `black`；
3. **被顶掉座位（evicted）的 AI**：第三者抢占白座后，原白方调 `get_state` / `new_game` 返回 `yourColor: null`；
4. **被 REST `DELETE /participants/:id` 移除的参与者**：其 MCP session 仍持有旧 bindings 时，`get_state` / `new_game` 返回 `yourColor: null`；另补未 join 的旧客户端在单黑 AI 房回退 `getAgentSeat()` 的校验。

这样测试总数保持 **383 全绿**，`callerSeat` 的约束也真正有回归保护。

#### 保留不动的东西

- **`actorRefOf` 的 header 分支（`x-arena-participant`）保留。** 它现在是 REST 层的显式身份入口，删它属于第二次契约变更；本次只改注释，不改行为。
- **`ARENA_SERVER_URL` 环境变量保留**：Vite 代理仍在读它，只是不再有 stdio 桥消费它。

#### 对已配置 stdio 的客户端

这是一次性的破坏：任何还在用 `node .../dist/mcp/stdio.js` 的配置都会失效。本仓库自己的 `.mcp.json` 已经是 HTTP，不受影响；如果其他机器上还有旧配置，需要在这次变更时一次性通知并改成 `http://127.0.0.1:3000/game/mcp`。

### 2.4 迁移顺序

每步单独提交、每步跑全量测试。第 4 步用 `git mv`，评审用 `git diff -M --stat` 确认只有重命名没有内容改动。

| 步 | 动作 | 触及面 | 验证 |
|---|---|---|---|
| **1** | 下线 stdio 适配层（§2.3 清单），并把 S-03 替换为 `InProcessApi.callerSeat` 回归用例 | `stdio.ts`、`resolveServerUrl`、`dual-agent.test.ts`、`bin`、README 与 3 篇架构文档的 stdio 段落 | **383 全绿** + `duel.mjs` 跑通 + `rm -rf server/dist && pnpm build` 后确认无 `dist/mcp/stdio.js` |
| **2** | `core/session-context.ts` → `src/session-context.ts` | **5 处 import**：`chat/mcp.ts:17`、`work/mcp.ts:8`、`mcp/http.ts:22`、`app.ts:6`、`test/dual-agent.test.ts:616`（动态 `await import`） | 383 全绿 |
| **3** | `http/ws.ts` → `src/ws.ts` | `index.ts` + 5 个测试文件（`chat-ws`、`http`、`presence-wire`、`lobby`、`work-mcp`） | 383 全绿 |
| **4** | `core/{engine→gomoku,rules,go,go-game,insights,replay}` → `game/engine/`；`core/presence.ts` → `game/rooms/presence.ts`；`rooms/*` → `game/rooms/`；`mcp/{api,http,tools}.ts` → `game/mcp/`；`http/routes.ts` → `game/http/routes.ts`；同步改根目录 3 个脚本 | `src/` 内 27 行 import + `test/` 内 52 行静态 import（`core` 14 / `rooms` 33 / `http` 5）+ `test/dual-agent.test.ts:615`（动态 `await import('../src/mcp/http')`）+ 3 个脚本：`scripts/replay-game2.mjs:12-13`、`scripts/measure-payload.mjs:1-2`、`scripts/demo-agent-view.mjs:1,6`（`../server/dist/core/*` → `../server/dist/game/engine/*`） | `rm -rf server/dist && pnpm typecheck && pnpm build` + 383 全绿 + 全仓检索零旧路径 + 三个 MCP 端点连通 |
| **5** | 文档：`overview.md` 4 条源码链接（第 7、13、14、19 行）、`constraints.md:41` 的模块清单、`constraints.md:59` 的 `core/go.ts`、`decisions.md:45` 的 `core/go-game.ts` 与 `engine.ts` | 4 个文件 | 链接可点、`pnpm build` 通过 |

**为什么不能只靠 `tsc` 兜第 4 步：** [server/tsconfig.json](../../server/tsconfig.json) 只配置了 `"include": ["src/**/*.ts"]`，所以 `tsc` **只检查 `src/` 内的 27 处 import，既不看 `server/test/` 也不看根目录 `scripts/*.mjs`**。实际要靠三层联合兜底：

1. `pnpm typecheck` / `pnpm build` 兜 `server/src/`（27 处）；
2. `pnpm test`（Vitest）兜 `server/test/`（52 处静态 import + 2 处受影响的动态 `import()`）；
3. **先 `rm -rf server/dist` 再 `pnpm build` + 全仓检索旧路径**，兜根目录 `scripts/*.mjs`，同时防止旧 `dist/` 残留造成「假绿」。

第 1 步放最前面的原因：删掉 stdio 之后，`mcp/` 里只剩三个纯棋类文件，第 4 步就是一次干净的整体搬运，不需要兼容壳、不需要 `bin` 说明，也不会出现「根级 `mcp/` 里留了个壳」这种新的误导源。

第 4 步不拆成「先移 rooms 再移 core」的原因：两种拆法都会留下一段 import 路径别扭的中间态（`game/rooms/room.ts` 引 `../core/engine.js` 会解析到 `game/core/`），收益只有 bisect 粒度，代价是多一轮 60 多处 import 往返。合并成一步，由三层验证兜住。

**不要改的**：`constraints.md:94` 与 `README:157` 里的 `data/rooms/`、`data/chat/` 是**数据目录**，不是源码目录。

### 2.5 一个完整场景验证这套结构

「给围棋加一个数子相关的状态字段」：

1. 从 overview.md 的棋类行进 `game/`，四个子目录名直接对应职责，不用再判断哪个是公共的。
2. 规则改动 → `game/engine/go.ts`（constraints §4 要求规则只在这一个文件）。
3. 状态搬运 → `game/engine/go-game.ts`。
4. 房间层只搬状态 → `game/rooms/room.ts`。
5. 给 agent 的新字段 → `game/engine/insights.ts`（`toAgentStateView` 唯一出口）。
6. 工具 schema → `game/mcp/tools.ts`。
7. 网页字段 → `web/src/store/room.ts`，后端不需要动。

每一步的路径都能从目录名猜出来，且 `chat/`、`work/` 永远不会出现在这条链上——这正是当前结构给不出的保证。

---

## 3. 风险

| 风险 | 处置 |
|---|---|
| 已配置 stdio 的客户端失效 | 本提案唯一的破坏性变更，单独第 1 步、单独提交；变更时一次性通知（§2.3） |
| 删掉 S-03 导致 `yourColor` 边界失守 | 第 1 步同步补 1 个走 `/game/mcp` 的 `InProcessApi.callerSeat` 回归用例，覆盖双 AI / 旁观者 / 被顶掉 / 被移除 / 未 join 回退（§2.3 测试账） |
| `tsc` 不覆盖 `test/` 与 `scripts/*.mjs`，漏改 import | 三层兜底：`tsc` 查 `src/` + Vitest 查 `test/`（含动态 import）+ 清 `server/dist` 后重构建并全仓检索 |
| 旧 `server/dist/` 残留造成假绿 | 第 1 步与第 4 步验证前先 `rm -rf server/dist` 再 `pnpm build` |
| 大范围重命名让 review 看不出内容改动 | 全程 `git mv`，评审用 `git diff -M`，重命名文件的相似度应为 100% |
| 文档链接失效 | 第 1 步与第 5 步各管一半，验收项 6 逐条点开 |
| 中间态测试挂住 | 每步都跑全量，不攒到最后 |

## 4. 不改什么（防范围膨胀）

- 不合并、不重写任何函数；`go.ts` 已过独立审计，只换位置。
- 不给 `chat/`、`work/` 加任何新目录层级。
- 不动 `shared/`，包括 `GameState` 这个名字。
- 不顺手改端点路径（`/game/mcp` 保持单数）。
- 不删 `actorRefOf` 的 header 分支——那是第二次契约变更。
- 不引入路径别名（`@game/*`）——`NodeNext` 下要多配一套 `imports`/`paths`，收益不抵配置成本。

## 5. 已确认的取舍

| 议题 | 结论 |
|---|---|
| stdio 适配层 | **下线**，三个域统一 Streamable HTTP（§2.3） |
| S-03 的处置 | **删 `HttpApi` 用例，同提交补 1 个 `InProcessApi.callerSeat` 回归用例**，总数保持 383 |
| `core/` 的新名字 | `engine/` |
| `engine.ts` 的额外改名 | 做，改成 `gomoku.ts` |
| 棋牌域目录名 | `game/` 单数，不用 `games/` |
| 装配与进程文件的位置 | 留在 `server/src/` 根级，不新建 `infra/` |
| `session-context.ts` 的归属 | 提到根级，作为跨域基础设施 |

以上取舍已确认。实现过程中若发现前提失效（比如某个 import 无法消除），回到本文档追加，不要私自在实现里改方案。

## 6. 实施记录

分支 `feat/backend-and-frontend-refactor`，按 §2.4 的顺序分 5 个提交完成，每个提交后都跑过全量测试。

| 步 | 提交 | 内容 | 验证 |
|---|---|---|---|
| 1 | `e8090ed` | 下线 stdio：删 `stdio.ts`（327 行）、`resolveServerUrl`、`bin`；S-03 换成走 `/game/mcp` 的 `InProcessApi.callerSeat` 用例（覆盖双 AI / 旁观者 / 被顶掉 / 被移除 / 未 join 回退）；同步 10 处 stdio 注释与 4 篇文档 | 383 全绿；`rm -rf server/dist && pnpm build` 后无 `dist/mcp/stdio.js`；三端点 `initialize` 均 200；`duel.mjs` 下完一盘（31 手） |
| 2 | `2e77e8c` | `core/session-context.ts` → 根级 | 383 全绿；`git diff` 只有 5 行 import |
| 3 | `877ee49` | `http/ws.ts` → 根级 | 383 全绿；rename 识别 96% |
| 4 | `633a21c` | `core/`→`game/engine/`、`core/presence.ts`→`game/rooms/`、`rooms/`→`game/rooms/`、`mcp/`→`game/mcp/`、`http/routes.ts`→`game/http/`；`engine.ts`→`gomoku.ts`；3 个根目录脚本改指 `dist/game/engine/*` | 383 全绿；15 个文件全部识别为 rename（相似度 98–100%）；`dist/` 下无 `core/`；3 个辅助脚本 exit 0（`measure-payload` 热路径 2590 字符，仍在 4000 预算内） |
| 5 | 本提交 | 文档链接与路径文本；提案自身 4 条失效链接改指新位置 | 全仓 docs 链接 0 失效 |

**与计划的偏差：**

- §2.4 说「重命名文件的相似度应为 100%」。实际 98–99%：搬目录时 import 说明符必须改，内容必然有变。评审时按 `git diff -M` 看，改动的行全是 import。
- 第 4 步的 79 处 import 没有手改，而是用一个按「旧路径 → 新路径」映射重算相对路径的脚本一次性处理，再由 `tsc` + `vitest` 双向兜底。脚本第一次跑出过 `./rules.ts.js` 这类错误（路径未剥离 `.ts` 就补 `.js`），已回滚重跑。
- **`shared/src/presence.ts` 的注释也同步改了**（「the stdio bridge holds no session」→「an agent seat that never had an MCP session」）。§4 写的是「不动 `shared/`」，这属于越界：只动 JSDoc，`PRESENCE_STALE_MS` 与任何类型都没变。独立审核指出后在此登记；选择保留而不是回退——旧注释指向的 stdio 桥已经不存在了。

**遗留项：** 无。`docs/archive/` 下的历史文档按 §2.3 保留原样。


## 7. 独立审核

**审核者**：独立 subagent（未参与实现），基线 `4aa7b2c`。**结论：有条件通过 → 整改后通过。**

已独立复现的结论：

| 项 | 证据 |
|---|---|
| 383 项全绿 | `Test Files 28 passed (28) / Tests 383 passed (383)` |
| 清空 `server/dist` 后重建 | 无 `dist/mcp/stdio.js`、无 `dist/core/`、无 `dist/http/`；`package.json` 无 `bin` |
| 旧路径残留 | 只匹配 import 说明符的检查仅命中 5 条 `game/` **内部**相对路径，零残留 |
| 纯移动 | `ws.ts` 只有 7 行 import 变化；`routes.ts` 2 行 import + 5 段注释；`go.ts` / `rules.ts` 等 diff 为 0 行 |
| 三端点 + REST | `/game/mcp`、`/chat/mcp`、`/work/mcp` 的 `initialize` 均 200，`/api/rooms` 200 |
| `duel.mjs` | 31 手黑胜，exit 0 |
| 部署包 | `deploy.mjs` exit 0，产物无 `bin`、有 `dist/game/`，且能实际起服务 |
| **S-03 覆盖** | 用 5 个变异（退回 agent 座位 / null 时回退 / 查不到人回退 / 未 join 返回 null / 顶座不清旧持有者）逐一打红，§2.3 的 5 条要求全部有独立断言 |

审核未覆盖：没有对 9 个中间提交逐个 checkout 复跑「每步全绿」；`go.ts` 等文件依赖 `git diff -M` 的 0 行判定而非逐字节比对。

**审核提出的问题与处置**：`shared/` 越界（已登记，见 §6）；`web/index.html` 标题未改、README 与架构地图仍推旧 URL（已改，见前端提案 §6）。

### 2026-11-22 分支复审

复审范围为远端 `main` 的 `31471a4` 到 `9625d95`，共 11 个提交。实现提交的 Git 作者为 `xukeli`，执行 harness 和模型未记录。本轮由未参与本次重构实现的 Codex（GPT-6.2 Sol）复审。

**本轮复审退回整改。**

- **[P2] 增量部署会带上已下线的 stdio 和旧目录。** 临时 checkout 在 `31471a4` 编译服务端，切换到 `9625d95`，直接执行 `pnpm bundle`。打包成功，但 `deploy-dst/dist/mcp/stdio.js` 仍存在，包内还有旧 `core/`、`http/`、`mcp/`、`rooms/`。干净 checkout 的对照包没有这些旧文件。默认构建仅执行 `tsc`，打包随后复制整个 `dist`。在构建或打包入口清理服务端输出目录，并用同一 checkout 升级重打包验证删除结果。涉及 `e8090ed`、`633a21c`。[构建](../../server/package.json#L14) · [部署](../../scripts/deploy.mjs#L11)

完整分支通过 `pnpm typecheck`、`pnpm build` 和 `pnpm test`（28 个文件，383 项）。通过 MCP SDK 实际连接三个端点并列出工具（棋类 12、聊天 5、工作 11），`/api/rooms` 可用，双 agent 脚本下完 31 手，三个根目录辅助脚本均以状态 0 退出。核对了会话上下文、WebSocket 和棋类引擎搬迁的提交差异。本轮未逐提交重跑全量测试。

#### 整改（同日）

| 审查意见 | 处置 |
|---|---|
| P2 增量打包带上已下线的 stdio 与旧目录 | `scripts/deploy.mjs` 在 `pnpm build` 之前先 `rmSync` 掉 `server/dist` 与 `web/dist`——`tsc` 只增量写、不清理，旧产物会被原样打进包。复验方式与审查一致：在 `server/dist/mcp/stdio.js` 植入假文件后跑 `pnpm bundle`，产物里已无 `dist/mcp`，`dist/game` 正常 |

说明：清理放在**打包入口**而不是 `pnpm build` 本身，因为本地 `pnpm build && node server/dist/index.js` 的旧产物不影响交付；打包是唯一对外产物的出口。

#### 整改后复核（`d892f39`）

以远端 `main` 的 `31471a4` 为基线，本轮由未参与实现的 Codex 复核，执行方的 harness 与模型未记录。后端整改通过。

同一临时 checkout 先在 `31471a4` 构建真实旧产物，确认 `dist/mcp/stdio.js` 以及旧目录存在。切到 `d892f39` 直接执行 `pnpm bundle`，部署包只包含当前的 `chat/`、`game/`、`work/`，旧 `core/`、`http/`、`mcp/`、`rooms/` 均已移除。用部署包实际启动服务，房间 API、回放深链和打包后的前端资源均返回成功。

`pnpm typecheck`、`pnpm build` 和 `pnpm test` 通过（28 个文件，383 项）。用 SDK 连接三域 MCP 并核对工具数量。部署产物检查覆盖本机 Windows。
