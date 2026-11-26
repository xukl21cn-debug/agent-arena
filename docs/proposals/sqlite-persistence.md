# SQLite 持久化迁移

**状态：S1 实现完成，待独立评审；S2/S3 待排期。** 分支：`feat/sqlite-persistence`。基线：`main` @ `e19dc7b`。

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

采用 Node 内置 `node:sqlite`（`DatabaseSync`），不引入原生第三方依赖；Node 下限提高到 22.5。`better-sqlite3` 仍作为备选，仅在未来需要 Node 20 兼容或更成熟 API 时重新评估。

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
  FileRoomRepository             # 保留到迁移完成，最终删除或仅在导入期使用
  SqliteRoomRepository           # 新实现，保持 RoomRepository 接口
server/src/chat/store.ts         # 从 ChatManager 的 fs 逻辑抽出 ChatStore 接口 + SqliteChatStore
server/src/work/store.ts         # 从 WorkStore 的 fs 逻辑抽出 WorkRepository + SqliteWorkRepository
```

`WorkStore`、`ChatManager`、`GameRoom` 的领域逻辑不动；文件路径和 JSON 解析只在 repository/导入器里。

### 3.4 迁移与切换

1. 启动时打开 `data/arena.db`，执行 `schema_migrations`。
2. 如果数据库为空且存在旧的 `data/rooms|chat|work|archive` JSON：在事务中逐条解析并导入；单条损坏只警告并跳过，原文件保留。
3. 导入完成后数据库为权威源；旧 JSON 目录保留为只读备份，不自动删除。
4. 提供 `ARENA_DB_PATH` 覆盖默认 `data/arena.db`，测试使用临时 DB 文件。
5. 若数据库打开/迁移失败，启动失败并打印明确错误，不静默退回 JSON（避免双写和状态分裂）。

### 3.5 分阶段

| 阶段 | 范围 | 验收 |
|---|---|---|
| S1 | DB 基础设施 + rooms/archives 的 `SqliteRoomRepository` + JSON 导入 | 棋局创建/落子/重启恢复/回放/归档全部通过；旧 JSON 可导入 |
| S2 | chat 的 `ChatStore` + SQLite 实现 | 聊天创建/消息/轮次/重启恢复通过 |
| S3 | work 的 `WorkRepository` + SQLite 实现 | 任务创建/领取/复审/返工/合并证据/重启恢复通过 |
| S4 | 删除文件实现、更新部署文档、全量回归 | 全量测试通过；`data/arena.db` 可由备份恢复 |

同一分支内按阶段提交，阶段之间不新建目录或按阶段拆 Proposal。

## 4. 验证

- 现有 server 37 文件 / 480 测试全部通过；新增 SQLite repository、迁移、事务和重启测试。
- 手动走一遍：棋局落子 → 重启 → 回放；聊天发言 → 重启；工作看板新建 → runner 领取 → 复审 → 合并；旧 JSON 数据导入后行为一致。
- 部署验证：`pnpm bundle` 打出的 `deploy-dst` 在目标机（Node 20+、同 OS/arch）启动并读写 SQLite。

## 5. 开放问题

- 已定：使用 Node 内置 `node:sqlite`；Node 下限提高到 **22.5**，不再使用 `better-sqlite3` 的原生二进制。
- 已定：按 S1→S2→S3 分阶段推进；S1 已完成 rooms/archives，chat/work 仍暂时使用 JSON。
- 已定：旧 JSON 保留为只读备份，不自动删除；迁移完成后数据库为唯一权威源，不做双写回退。

## 6. 阶段记录

| 阶段 | 提交 | 测试 | 已知缺口 | 审核结论 |
|---|---|---|---|---|
| S1 rooms/archives | 待提交 | server 38 文件 / 483 测试；新增 SQLite repository、重启恢复、归档裁剪和 legacy JSON 导入测试 | 旧 JSON 仍保留；chat/work 仍为 JSON；无迁移进度 UI | 待独立评审 |

