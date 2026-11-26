# SQLite 持久化迁移

**状态：S1–S3 实现完成，四域均已切到 SQLite；S4 收尾中，待独立评审与用户验收。** 分支：`feat/sqlite-persistence`。基线：`main` @ `e19dc7b`。

## 1. 背景

服务端现在的权威状态全部落在 `data/` 下的 JSON 文件：棋局房间 `rooms/`、聊天室 `chat/`、开发任务 `work/`、历史棋谱 `archive/`。这是本地单进程阶段的取舍（[决策](../architecture/decisions.md) §6），但用户希望后端使用 SQLite，避免“没有数据库、全是文件”的状态。

本 Proposal 只替换 server 的持久化层；runner 自己的 `stateFile`（任务轮次、DSH sessionId、命令游标）仍留在 runner 本地，不进入 server 数据库。

## 2. 目标与非目标

### 目标

- 使用一个 SQLite 数据库保存 server 的权威状态：rooms、archives、chat rooms、work tasks。
- REST、WebSocket、MCP 工具和工作域状态机行为不变；只替换存储实现。
- 启动时支持从现有 `data/**/*.json` 一次性导入；导入失败或损坏的单条记录不能拖垮启动。
- 数据库写入使用事务；开启 WAL 和合理 busy timeout。
- 提供 schema 版本与迁移入口，后续新增字段/表有固定路径。

### 非目标

- 不把每个领域模型完全拆成关系表；第一阶段允许把领域快照作为 JSON payload 存入 SQLite，并用索引列支持列表查询。
- 不做多实例共享数据库或远程数据库；仍是本机单进程。
- 不把 runner 的本地 session/command cursor 搬进 server DB。
- 不改变现有 API 的 wire shape、状态机或文件附件校验规则。

## 3. 方案

### 3.1 库

采用 Node 内置 `node:sqlite`（`DatabaseSync`），不引入原生第三方依赖；`node:sqlite` 从 Node 22.13 起免 `--experimental-sqlite` 旗标可用，因此 Node 下限提高到 22.13。`better-sqlite3` 仍作为备选，仅在未来需要 Node 20 兼容或更成熟 API 时重新评估。

### 3.2 表结构（草案）

```sql
schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)

rooms(
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)

archives(
  archive_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  payload TEXT NOT NULL
)
CREATE INDEX archives_played_at ON archives(played_at DESC);

chat_rooms(
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)

work_tasks(
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL
)
CREATE INDEX work_tasks_status ON work_tasks(status, updated_at DESC);

-- v4：一次性导入标记（导入过什么、导入过没有）
meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

`payload` 是现有领域快照的 JSON；这样不用重写每个领域模型，也不会改变现有校验。后续要做查询/统计时再逐步抽取列。

v4 把时间戳统一成 epoch 毫秒：`rooms.updated_at` 原来声明 INTEGER 却写进了领域层的 ISO 字符串，`chat_rooms.updated_at` 原来声明 TEXT；迁移会把旧值逐行转成毫秒（在 JS 里转，`strftime('%s', …)` 会截断到秒）。

### 3.3 存储边界

```text
server/src/db/database.ts        # 打开 DB、PRAGMA、schema migration、事务
server/src/db/migrate-json.ts    # 从 data/**/*.json 一次性导入
server/src/game/rooms/repository.ts
  FileRoomRepository             # 只作导入器与测试夹具，运行时不启用
  SqliteRoomRepository           # 新实现，保持 RoomRepository 接口
server/src/chat/store.ts         # 从 ChatManager 的 fs 逻辑抽出 ChatStore 接口 + SqliteChatStore
server/src/work/store.ts         # 从 WorkStore 的 fs 逻辑抽出 WorkRepository + SqliteWorkRepository
```

`WorkStore`、`ChatManager`、`GameRoom` 的领域逻辑不动；文件路径和 JSON 解析只在 repository/导入器里。

### 3.4 迁移与切换

1. 启动时打开 `data/arena.db`，执行 `schema_migrations`；库的版本高于程序支持的上限时拒绝启动。
2. 首次启动且 `meta` 里没有导入标记时，读取旧的 `data/rooms|chat|work|archive` JSON：在事务中逐条解析并导入；单条损坏只警告并跳过，原文件保留，坏记录不回滚整批。
3. 导入完成后写 `meta` 标记，数据库为权威源，服务不再写 JSON。标记而不是「表是否为空」决定要不要导入：否则删掉最后一个房间后重启会把刚删的数据导回来；表里已有数据时也直接记标记、不导入，避免旧 JSON 覆盖新数据。
4. 旧 JSON 目录不会自动删除——删用户文件得用户自己决定；确认迁移无误后由用户手动清理，本地开发数据已于 2026-11-26 清理（见 §6）。
5. 提供 `ARENA_DB_PATH` 覆盖默认 `data/arena.db`（相对路径按仓库根解析，不跟 cwd 走），测试使用临时 DB 文件。
6. 若数据库打开/迁移失败，启动失败并打印明确错误，不静默退回 JSON（避免双写和状态分裂）。

### 3.5 分阶段

| 阶段 | 范围 | 验收 |
|---|---|---|
| S1 | DB 基础设施 + rooms/archives 的 `SqliteRoomRepository` + JSON 导入 | 棋局创建/落子/重启恢复/回放/归档全部通过；旧 JSON 可导入 |
| S2 | chat 的 `ChatStore` + SQLite 实现 | 聊天创建/消息/轮次/重启恢复通过 |
| S3 | work 的 `WorkRepository` + SQLite 实现 | 任务创建/领取/复审/返工/合并证据/重启恢复通过 |
| S4 | 文件实现只留导入/测试路径、更新部署与备份文档、全量回归 | 全量测试通过；`data/arena.db` 可由备份恢复 |
| S5 | 独立评审整改：导入健壮性、事务助手、导入标记、关停、schema 版本与时间戳一致性 | 评审列出的阻塞/高优先级项全部关闭并有测试 |

同一分支内按阶段提交，阶段之间不新建目录或按阶段拆 Proposal。

## 4. 验证

- 迁移前 server 37 文件 / 480 测试全部通过，迁移后 41 文件 / 498 测试全部通过；新增 SQLite repository、schema 迁移、导入健壮性、事务和重启测试。
- 手动走一遍：棋局落子 → 重启 → 回放；聊天发言 → 重启；工作看板新建 → runner 领取 → 复审 → 合并；旧 JSON 数据导入后行为一致。
- 部署验证：`pnpm bundle` 打出的 `deploy-dst` 在目标机（Node 22.13+、同 OS/arch）启动并读写 SQLite。

## 5. 开放问题

- 已定：使用 Node 内置 `node:sqlite`；Node 下限提高到 **22.13**，不再使用 `better-sqlite3` 的原生二进制。
- 已定：按 S1→S2→S3 分阶段推进；三阶段均已完成，四域共用 `data/arena.db`。
- 已定：迁移完成后数据库为唯一权威源，不做双写回退；旧 JSON 只作导入源，代码不自动删除，清理由用户手动做。
- 已定（S4）：`FileRoomRepository` 与各域的 JSON 读写路径只留给导入器和测试，运行时不启用；不为「删干净」拆掉升级路径。
- 已知缺口（留整改单）：损坏 payload 行被同 id 重新创建时会被覆盖（与 JSON 模式行为一致，不是本次引入）；`createApp` 的 `chat`/`work` 仍是可选参数，漏传会静默回落到文件模式；`chat_rooms_updated_at`、`work_tasks_status` 两个索引暂时没有查询使用。

## 6. 阶段记录

| 阶段 | 提交 | 测试 | 已知缺口 | 审核结论 |
|---|---|---|---|---|
| S1 rooms/archives | `e6a6e57`（整改 `7b4bc4f`） | server 38 文件 / 483 测试；新增 SQLite repository、重启恢复、归档裁剪和 legacy JSON 导入测试 | 旧 JSON 仍保留；chat/work 仍为 JSON；无迁移进度 UI | 独立评审：无阻塞；高优先级 Node 下限已修正为 22.13；低项留 S2/S4 |
| S2 chat | `4978532` | server 40 文件 / 488 测试；新增 chat 的 SQLite 重启恢复、legacy 导入、删除测试 | 消息仍整包存进房间 payload，没有按条分页的表 | 待独立评审 |
| S3 work | `4978532` | 同上；新增 work 任务 SQLite 恢复与 legacy 导入（非法任务跳过并警告） | 任务列表仍全量载入 payload，没有分页 | 待独立评审 |
| S4 收尾 | `b7a2066` | 手动冒烟：真实 `pnpm dev` 重启后三域数据齐全；另用临时库目录（不含任何 JSON 目录）单独启动，日志 `rooms 1 restored` / `chats 2 restored`，REST 三域数据与库一致；新增 chat/work「SQLite 模式不再重建旧 JSON 目录」测试，server 40 文件 / 490 测试 | 文件实现未删除，只作导入/测试路径；WAL 热备份只写了「先停服或用 `VACUUM INTO`」，没有现成脚本 | 独立评审（第二轮）：1 阻塞 + 3 高，见 S5 |
| S5 评审整改 | 见本节下方 | server 41 文件 / 498 测试全绿；新增坏旧记录、事务 depth、导入一次性、schema 版本、时间戳迁移、归档按房间隔离、棋类不建目录等测试 | M1（损坏行会被同 id 新建覆盖）与 M7（`createApp` 的 chat/work 兜底仍是文件模式）留作后续整改单 | 待二审 |

### 第二轮独立评审的问题与处理

| 编号 | 问题 | 处理 |
|---|---|---|
| B1 | 棋类 legacy 导入没有逐条隔离，一条坏记录（缺 `state.updatedAt`、文件名非法）会让导入事务回滚，下次启动再撞同一条 → 服务永久起不来 | 导入前校验 id 与 payload 形状，逐条 try/catch 跳过并警告；新增「坏旧记录不影响导入」测试 |
| H1 | `transaction()` 在 `BEGIN` 抛错时泄漏深度计数，之后所有事务静默不开事务 | 计数改为在 `finally` 里复位；新增「BEGIN 失败后事务仍生效」测试 |
| H2 | 删除最后一个房间后表变空，下次启动会从旧 JSON 把已删数据导回来 | 改用 `meta` 表里的持久标记（迁移 v4），表非空时直接记标记不导入；chat/work 同步；各加一条「删除后不复活」测试 |
| H3 | `FileRoomRepository` 构造函数会 `mkdir` 旧目录，棋类首次启动仍会重建 `data/rooms`、`data/archive` | 加 `createDirs` 选项，导入器传 `false`；补棋类「不建旧目录」测试 |
| M2/M3 | `rooms.updated_at` 声明 INTEGER 却存 ISO 字符串；chat 导入用 `createdAt` 当更新时间 | v4 统一成 epoch 毫秒（JS 转换，避免秒截断）；chat 导入改用最后一条消息时间；保存路径同步 |
| M4 | schema 版本高于程序时不拒绝，回滚部署后旧代码照常写 | `CURRENT_SCHEMA` 上限校验，超限直接报错中止；补测试 |
| M5 | 关停时 `database.close()` 挂在 `server.close` 回调里，浏览器还开着就等到 3 秒强退，WAL 没合并 | `server.closeAllConnections()` + 强退分支里也关库 + 双击 Ctrl+C 不重复关；README 备份说明同步 |
| M6 | `ARENA_DB_PATH` 接受相对路径，落点跟 cwd 走 | 与 `ARENA_DATA_DIR` 一样按仓库根解析 |
| 低 | 配置注释过时、库打开报错不带路径、chat payload 为 `null` 不记日志、无用 getter、work 导入用 DO UPDATE、chat 导入不校验 id、`server/package.json` 缺 engines | 全部修掉；迁移失败时同时关闭连接（Windows 上否则删不掉库文件） |
| 额外 | 测试里 `loadConfig({})` 会把 `data/chat`、`data/work` 建到仓库真实数据目录 | 新增 `test/helpers/temp-data-dir.ts`，5 个测试文件改用临时数据目录 |

### 旧数据清理（2026-11-26，本地开发环境）

用户确认 SQLite 下三域数据齐全后，删除了 5 个旧 JSON 文件：`data/rooms/default.json`、`data/chat/chat-873d85.json`、`data/chat/smoke-ab1.json`、`data/work/2f8ae1de-….json`、`data/work/2fd2f015-….json`（`data/archive/` 为空）。删除前逐条与库内 payload 做了深度比对：棋局与两个聊天室完全一致，工作域那条库内更新（`pending_review` → `reviewing`），库为准。备份留在 `data/legacy-json-20261126-1535.zip`（`data/` 被 git 忽略，只在本地）。删除后运行中的服务与新建库目录的冷启动都正常。

删除时发现 `ChatManager` / `WorkStore` 每次启动都会 `mkdir` 自己的 JSON 目录，删掉的文件树会被重建成空目录；已在 `b7a2066` 改成只在文件模式建目录。

