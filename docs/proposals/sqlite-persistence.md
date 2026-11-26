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
```

`payload` 是现有领域快照的 JSON；这样不用重写每个领域模型，也不会改变现有校验。后续要做查询/统计时再逐步抽取列。

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

1. 启动时打开 `data/arena.db`，执行 `schema_migrations`。
2. 如果数据库为空且存在旧的 `data/rooms|chat|work|archive` JSON：在事务中逐条解析并导入；单条损坏只警告并跳过，原文件保留。
3. 导入完成后数据库为权威源，服务不再写 JSON。旧 JSON 目录不会自动删除——删用户文件得用户自己决定；确认迁移无误后由用户手动清理，本地开发数据已于 2026-11-26 清理（见 §6）。
4. 提供 `ARENA_DB_PATH` 覆盖默认 `data/arena.db`，测试使用临时 DB 文件。
5. 若数据库打开/迁移失败，启动失败并打印明确错误，不静默退回 JSON（避免双写和状态分裂）。

### 3.5 分阶段

| 阶段 | 范围 | 验收 |
|---|---|---|
| S1 | DB 基础设施 + rooms/archives 的 `SqliteRoomRepository` + JSON 导入 | 棋局创建/落子/重启恢复/回放/归档全部通过；旧 JSON 可导入 |
| S2 | chat 的 `ChatStore` + SQLite 实现 | 聊天创建/消息/轮次/重启恢复通过 |
| S3 | work 的 `WorkRepository` + SQLite 实现 | 任务创建/领取/复审/返工/合并证据/重启恢复通过 |
| S4 | 文件实现只留导入/测试路径、更新部署与备份文档、全量回归 | 全量测试通过；`data/arena.db` 可由备份恢复 |

同一分支内按阶段提交，阶段之间不新建目录或按阶段拆 Proposal。

## 4. 验证

- 迁移前 server 37 文件 / 480 测试全部通过，迁移后 40 文件 / 488 测试全部通过；新增 SQLite repository、迁移、事务和重启测试。
- 手动走一遍：棋局落子 → 重启 → 回放；聊天发言 → 重启；工作看板新建 → runner 领取 → 复审 → 合并；旧 JSON 数据导入后行为一致。
- 部署验证：`pnpm bundle` 打出的 `deploy-dst` 在目标机（Node 22.13+、同 OS/arch）启动并读写 SQLite。

## 5. 开放问题

- 已定：使用 Node 内置 `node:sqlite`；Node 下限提高到 **22.13**，不再使用 `better-sqlite3` 的原生二进制。
- 已定：按 S1→S2→S3 分阶段推进；三阶段均已完成，四域共用 `data/arena.db`。
- 已定：迁移完成后数据库为唯一权威源，不做双写回退；旧 JSON 只作导入源，代码不自动删除，清理由用户手动做。
- 已定（S4）：`FileRoomRepository` 与各域的 JSON 读写路径只留给导入器和测试，运行时不启用；不为「删干净」拆掉升级路径。

## 6. 阶段记录

| 阶段 | 提交 | 测试 | 已知缺口 | 审核结论 |
|---|---|---|---|---|
| S1 rooms/archives | `e6a6e57`（整改 `7b4bc4f`） | server 38 文件 / 483 测试；新增 SQLite repository、重启恢复、归档裁剪和 legacy JSON 导入测试 | 旧 JSON 仍保留；chat/work 仍为 JSON；无迁移进度 UI | 独立评审：无阻塞；高优先级 Node 下限已修正为 22.13；低项留 S2/S4 |
| S2 chat | `4978532` | server 40 文件 / 488 测试；新增 chat 的 SQLite 重启恢复、legacy 导入、删除测试 | 消息仍整包存进房间 payload，没有按条分页的表 | 待独立评审 |
| S3 work | `4978532` | 同上；新增 work 任务 SQLite 恢复与 legacy 导入（非法任务跳过并警告） | 任务列表仍全量载入 payload，没有分页 | 待独立评审 |
| S4 收尾 | `ff5ecce` | 手动冒烟：真实 `pnpm dev` 重启后三域数据齐全；另用临时库目录（不含任何 JSON 目录）单独启动，日志 `rooms 1 restored` / `chats 2 restored`，REST 三域数据与库一致；新增 chat/work「SQLite 模式不再重建旧 JSON 目录」测试，server 40 文件 / 490 测试 | 文件实现未删除，只作导入/测试路径；WAL 热备份只写了「先停服或用 `VACUUM INTO`」，没有现成脚本 | 待独立评审 |

### 旧数据清理（2026-11-26，本地开发环境）

用户确认 SQLite 下三域数据齐全后，删除了 5 个旧 JSON 文件：`data/rooms/default.json`、`data/chat/chat-873d85.json`、`data/chat/smoke-ab1.json`、`data/work/2f8ae1de-….json`、`data/work/2fd2f015-….json`（`data/archive/` 为空）。删除前逐条与库内 payload 做了深度比对：棋局与两个聊天室完全一致，工作域那条库内更新（`pending_review` → `reviewing`），库为准。备份留在 `data/legacy-json-20261126-1535.zip`（`data/` 被 git 忽略，只在本地）。删除后运行中的服务与新建库目录的冷启动都正常。

删除时发现 `ChatManager` / `WorkStore` 每次启动都会 `mkdir` 自己的 JSON 目录，删掉的文件树会被重建成空目录；已在 `ff5ecce` 改成只在文件模式建目录。

