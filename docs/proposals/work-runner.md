# 开发任务 Runner

**状态：P1 实现完成（待验收），P2 管理面实现完成（待独立评审）。** 分支：`feat/work-runner`。基线：`main` @ `bbb5b6e`。

## 1. 背景

工作域 `/work/mcp` 已经能保存任务、领取执行、提交回报、复审和合并证据，但“把任务送进某个 agent 会话”和“把它的最终结果自动回报”仍由人手动完成。Runner 是补上这一段的本机执行器：它领取工作域交接，启动或续接 agent CLI，采集结果后回报。

聊天域的常驻成员形态（P4-C3）不再做；聊天轮次已由 `pass_turn`、租约 sweep 和“会话断开自动交还”覆盖。本 Proposal 只处理**开发任务自动回投**。

术语：runner 是 agent 的**执行器/适配器**，不是 agent 本身。它没有模型推理和任务决策，只负责把工作域的任务送到 DSH/Codex 等 agent 会话，再把会话的最终结果带回工作域。

## 2. 目标与非目标

### 目标

- 新 runner 作为本地常驻进程运行，不嵌入 Web 服务。
- Runner 通过 `/work/mcp` 领取执行任务，按目标客户端启动或续接会话。
- 采集最终回复、退出状态和结构化结果，调用 `submit_work_result` 回报。
- Runner 重启后能恢复未完成的任务绑定，不重复执行。
- 第一个适配器是 DSH：`dsh --profile headless --json ...` 一次性进程；`sessionId` 是对话续接标识，不是进程启动参数：无 ID 时新开会话，有 ID 时续接同一会话（从 `--json` 的 `session` 事件取并记录）。

### 非目标

- 不向已打开的 DSH Web GUI 会话注入新一轮；现有 DSH 能力不支持，需另做 web 插件桥接。
- 不做聊天常驻成员 runner。
- 不在第一阶段支持 Codex / AGY / ZCode；先留适配器接口，后续按真实场景接入。
- 不改变工作域的状态机和 MCP 契约；Runner 只作为工作端客户端。

## 3. 用户场景

1. 统筹在工作看板创建任务，指定工作目录、分支和验收标准；runner 首次执行时自动创建并记录会话 ID。
2. 用户在本机启动 runner。
3. Runner 连接 `/work/mcp`，以执行者身份领取任务。
4. Runner 启动 `dsh --profile headless --json --session-id <id> - < handoff.txt`，读取 NDJSON 事件直到 `final`。
5. Runner 把最终回复、提交、测试和文件清单通过 `submit_work_result` 写回工作域；任务进入 `pending_review`，统筹收到唤醒。
6. Runner 进程退出后，工作域保留任务；再次启动时不会重复执行同一轮。

## 4. 模块与边界

```text
runner/
  package.json          # @arena/runner
  src/index.ts          # CLI/常驻入口、配置读取
  src/work-client.ts    # /work/mcp 客户端与轮次处理
  src/adapters/dsh.ts   # DSH headless 适配器
  src/session-store.ts  # 任务 ↔ 客户端会话 ID 的本地记录
  test/

server/src/runner/      # RunnerRegistry、命令队列、REST/WS 适配
shared/src/runner.ts    # Web / server / runner 共用的管理面类型
```

- 新增第四个 pnpm workspace 包 `runner/`，与 `shared`、`server`、`web` 平级。
- `runner` 只依赖 `shared` 的公开类型和 MCP 客户端库，不 import `server/src` 内部模块。
- 与 server 的通信只走 `/work/mcp`（后续可能需要 `/chat/mcp`，另行提案）；不新增 server 进程内执行路径。
- Runner 配置（server URL、工作目录、客户端可执行文件、凭据环境变量名）使用本地配置文件；不把 token 写进仓库。
- 第一阶段单进程、单任务顺序执行；并发和 worktree 隔离放到后续阶段。

## 5. 管理与观测面

Web 只通过 REST/WS 请求 server，不直接访问 runner。server 内部增加 `RunnerRegistry`，保存 runner 注册信息、心跳、当前任务和短期事件；网页新增 `/runners` 页面展示列表、状态、最近任务和日志，并提供基本管理动作（启动/停止 runner 进程由用户负责，页面只发任务级命令）。

协议分两层：

- **任务生命周期**复用现有 MCP Streamable HTTP：runner 作为 MCP 客户端连接 `/work/mcp`，调用 `join_work`、`wait_for_work`、`renew_claim`、`submit_work_result` 等工具。任务状态和证据以工作域为准，不另造一套。
- **Runner 管理与观测**用 JSON REST + 长轮询：`POST /api/runners/register`、`POST /api/runners/:id/heartbeat`、`GET /api/runners/:id/commands?afterSeq=&timeoutMs=`、`POST /api/runners/:id/events`；网页读 `GET /api/runners`。长轮询复用了工作域 `wait_for_work` 的成熟模式，比新增 WebSocket 更容易测试离线与重连；Web UI 的实时刷新仍由 server 通过现有 `/ws` 广播。
- 不新开 gRPC、消息队列或独立 runner 控制服务。

通信方向以 **runner 主动连 server** 为准：

- runner 启动后 `POST /api/runners/register`，定期心跳；通过长轮询 `GET /api/runners/:id/commands` 或现有 `/ws` 接收 server 排队的命令；
- `RunnerRegistry` 从一开始就按 `runnerId` 建 Map，允许同时注册多个实例；每个实例独立心跳、命令队列和事件游标。稳定 ID 由 runner 配置生成，重复 ID 视为重连或拒绝旧实例，需明确定义；
- server 不反向 dial runner，runner 离线时页面显示 `offline`，不会让 REST 请求挂住；
- 最小接口：`GET /api/runners`、`GET /api/runners/:id`、`GET /api/runners/:id/events`、`POST /api/runners/:id/commands`；
- **多实例注册不等于多任务并发**：工作域目前只有单一 worker 身份，两个 runner 不能各自独立 `join_work` 后无协调地抢任务。P1 先单 runner；P2 允许注册多个实例但只派发到一个；真正的多 runner 并发需要扩展工作域的 worker 身份和领取模型，放到 P4；
- 如果只做单实例 demo，也可以让 server 调 runner 的本地 HTTP 端口，但这会引入地址配置、进程生命周期和离线阻塞问题，不建议作为长期形态。

## 6. 分期

| 阶段 | 范围 | 验收条件 |
|---|---|---|
| P1 最小闭环 | `runner` 包骨架、DSH headless 适配器、`join_work`/`wait_for_work`/`submit_work_result`、任务与会话 ID 记录 | 一个真实工作单由 runner 领取并在 DSH headless 中执行，结果回到工作看板，任务进入 `pending_review`；不重复执行 |
| P2 管理与观测 | server `RunnerRegistry` + REST/WS、`/runners` 页面（列表、状态、当前任务、最近事件、基本命令） | 页面能显示在线/离线 runner 与当前任务；runner 离线时接口不阻塞；命令能排队并在 runner 重连后生效 |
| P3 可靠性与恢复 | runner 重启、租约续期、进程超时/取消、退出码与 `final` 校验、失败回报、待接管 | 任务执行中杀掉 runner，重启后能恢复或标记待接管；不出现双重提交；超时/失败有明确事件和回报 |
| P4 多客户端与并发 | 适配器接口抽象、Codex/AGY/ZCode 适配、任务队列与 worktree 串行规则 | 每增加一个适配器都先通过单客户端闭环；两个工作区并行任务互不覆盖 |
| 后续 | Web GUI 会话注入、聊天域集成、更细的 runner 编排 | 需另立 Proposal；不在本文件承诺 |

每一阶段都以“可体验的闭环 + 独立审核”结束，再进入下一阶段；阶段之间不新建目录或按阶段拆文档。

## 7. 文档记录方式

- 本文件是唯一主文档，需求确认、方案设计、各阶段实现回报和独立审核都追加在本文件对应章节。
- 每个阶段使用同一文件的「阶段记录」表记录：提交、测试、已知缺口、审核结论；不建立 `docs/proposals/runner-phase-1.md` 之类的多份文档。
- 工作域任务通过 `docs.brief` 引用本文件的已确认版本；返工沿用同一任务。
- 验收通过后按[开发工作流](../workflow.md)的收尾顺序归档本文件，并从功能分支移除，不随代码合入 `main`。

## 8. 开放问题

- P1 已按此默认实现：首轮从 `--json` 的 `session` 事件取并记录 `sessionId`；同一任务的返工轮沿用该 task 之前的 DSH 会话。P1 不提供从配置文件指定已有会话的入口；DSH Web GUI 会话不能由 headless 采纳。
- 已定：模型凭据由 DSH 自己读取启动环境、会话工作目录的 `.env` 或 `$DSH_HOME/.env`；runner 不保存或转发凭据。
- 已定：P1 的失败通道就是 `submit_work_result.unresolved`，不改工作域事件类型；agent 最终回复无法解析时同样回落为 `unresolved`。
- 已定：保留 `AgentAdapter` 接口，P1 只实现 DSH headless；Codex/AGY/ZCode 在 P4 接入。
- P2 已按此边界实现：`/runners` 显示注册表列表、在线/离线、当前任务和最近事件；页面只发任务级 `cancel` 命令，启动/停止 runner 进程仍由用户负责。
- 多 runner 并发是否需要扩展工作域的单一 worker 身份，还是多实例只作为同一 worker 的执行槽？

## 9. 阶段记录

| 阶段 | 提交 | 测试 | 已知缺口 | 审核结论 |
|---|---|---|---|---|
| P1 最小闭环 | `e63cde9`（P1）、`3dbfa10`（评审整改）、`7973284`（收尾） | `pnpm test`：server 33 文件 / 467 测试，runner 7 文件 / 29 测试；fake CLI 端到端覆盖领取→执行→提交；真实 DSH smoke：任务 `c65ac982-c027-422d-82be-5725d794a16c` 领取后由会话 `session-524b306c-6c1a-4d2c-b57b-a752eb7c41f3` 执行，临时 smoke 工作区提交 `68cd891650bfe7fc5a4868064796fd2840d7a779`（不在本仓库对象库），看板进入 `pending_review`。 | 本机 DSH 的 `workspace-write` 在 Windows ACL 授权处失败，真实验收改用 `danger-full-access`；需在 ACL 正常环境复验 workspace-write。断线重连、重启恢复、超时/取消的完整语义留给 P3。 | 独立评审：1 项阻塞与 2 项高优先级已整改，复审通过；待用户验收与 ACL 环境复验 |
| P2 管理与观测 | `272ea63` | server 36 文件 / 475 测试，runner 8 文件 / 31 测试；手动 `/runners` 在线、离线、命令排队与重连消费。 | 注册表在内存；server 重启后注册记录与命令队列清空，runner 进程启动/停止仍由用户负责。 | 待独立评审 |
