# 系统架构

agent-arena 是一个本机运行的 TypeScript 模块化单体。浏览器和 MCP 客户端可以看同一盘棋、同一场对话或同一项开发任务。运行时由一个 Node / Express 进程持有权威状态，React 页面负责输入与展示。pnpm 工作区分为 `shared`、`server`、`web`。[工作区声明](../../pnpm-workspace.yaml) · [启动与恢复](../../server/src/index.ts) · [路由装配](../../server/src/app.ts)

| 领域 | 状态与规则由谁负责 | 外部如何访问 |
|---|---|---|
| 棋类 | `game/engine/` 的五子棋、围棋引擎处理合法手和终局。房间编排座位、准备、落子、等待与解说。棋谱回放逐手调用真实引擎。 | 网页用 `/api/rooms` 与 `/ws`，agent 用 `/game/mcp`。[房间](../../server/src/game/rooms/room.ts) · [回放](../../server/src/game/engine/replay.ts) · [MCP 适配器](../../server/src/game/mcp/api.ts) |
| 聊天 | `ChatRoom` 管成员、消息、relay 轮次、预算和让出轮次。`ChatManager` 管恢复，后台 sweep 结算到期轮次。聊天成员记录最后活动时间。 | 网页用 `/api/chat` 与 `/ws?kind=chat`，agent 用 `/chat/mcp` 进房、等消息、发言、让出或读转录。[房间](../../server/src/chat/chat-room.ts) · [聊天 MCP](../../server/src/chat/mcp.ts) |
| 开发任务 | `WorkStore` 管一个任务的执行、复审、返工、收工和放行。有领取租约、异常接管和合并证据。实际 Git 操作由统筹客户端执行。 | 回环监听时挂载 `/work/mcp`、`/api/work`。工作看板用 REST 操作，用 `/ws?kind=work` 接收更新。[存储](../../server/src/work/store.ts) · [看板路由](../../server/src/work/http.ts) · [任务契约](../../shared/src/work.ts) |

## 沿一次操作读代码

- **人落一手棋。** 页面发 REST 请求，房间调用对应引擎并更新状态，已挂起的对手等待得到结果，浏览器通过 WS 收到新盘面。网页取二维棋盘，MCP 返回便于模型阅读的 `boardText`、走子记录及该棋种的事实字段。五子棋有 `hotPoints`，围棋有棋块和气。互动解说单独广播。[棋类路由](../../server/src/game/http/routes.ts) · [工具定义](../../server/src/game/mcp/tools.ts) · [前端棋局状态](../../web/src/store/room.ts)
- **agent 等下一条聊天消息。** 房间按成员、游标和轮次决定何时唤醒。消费方沿 `nextCursor` 续读积压消息。网页用 WS 接收聊天更新。修改聊天轮转时应从聊天领域入手，保留棋类按座位的 presence 语义。[聊天模型](../../server/src/chat/model.ts) · [WS 分派](../../server/src/ws.ts)
- **用户放行合并。** 工作页的按钮调用本机 REST，存储检查执行者已确认收工，记录批准时间并唤醒统筹。统筹执行合并、跑测试后登记结果。看板下载附件时按工作区内的路径和 SHA-256 核验原件。[网页状态](../../web/src/store/work.ts) · [文件引用](../../server/src/work/model.ts)

## 恢复与兼容

默认数据根锚定仓库，`rooms/` 存棋局、`archive/` 存历史棋谱、`chat/` 存聊天快照、`work/` 存任务与轮次。服务重启可恢复落盘记录。MCP transport 和会话绑定存在内存里，恢复任务或座位时需建立新会话并按原名加入。[配置](../../server/src/config.ts) · [棋谱存储](../../server/src/game/rooms/repository.ts)

共享 wire 类型在 `shared/src/`。页面路由在 `web/src/App.tsx`：`/` 是跨域大厅，`/games[/:roomId]`、`/chats[/:roomId]`、`/work`、`/replay[/:archiveId]`、`/games/:roomId/replay` 各自成页，未知路径回大厅。顶栏与三域 Tab 由 `AppShell` 渲染，页面只负责自己的紧凑头栏。大厅可以新建房间（服务端发 `game-` / `chat-` 开头的 id），房间页可以删除，但进行中的对局与未关闭的聊天会被拒绝；聊天室的 hop 预算、每人上限与发言租约可在房间里随时调。改造前的 query 地址（`?room=`、`?kind=chat`、`?view=replay`、`?view=work`、`?archive=`）由 `/` 上的兼容层一次性跳到新路径，旧书签照常工作。样式按域拆在 `web/src/styles/*.scss`，由 `index.scss` 汇总（`@use` 顺序有约束）；只有被重写的组件才迁 CSS Modules，外壳是当前唯一一个。变更持久化格式、身份或跨域契约前先查相应条目。[页面入口](../../web/src/App.tsx) · [外壳](../../web/src/components/layout/AppShell.tsx) · [样式入口](../../web/src/styles/index.scss) · [兼容与领域约束](constraints.md) · [决策理由](decisions.md)
