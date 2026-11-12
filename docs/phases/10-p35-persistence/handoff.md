# 工作单：棋谱持久化（P4 前置）

> 面向：GLM
> 状态：P3 围棋已完成并实战验证（用户与 AI 下完一盘，体验良好）
> 分支：从最新 main 新建 `feat/persist`
> 预计：0.5–1 天
> 背景：服务重启后对局**全部丢失**——用户刚下完的那盘棋已经没了

---

## 0. 为什么要做

用户实战下完一盘棋，反馈「感觉很不错」。但**服务一停，棋谱就没了**：

```text
MemoryRoomRepository  →  纯内存 Map
服务重启              →  所有对局、走子历史、解说 全部消失
```

这不只是「不方便」：

- 想回看自己下的好棋，没了
- 想拿一盘棋做分析，没了
- P4（聊天室）的对话记录会同样丢失
- 开发时每次重启服务，测试对局全丢

**这是基础设施缺口，应该在 P4 之前补上。**

---

## 1. 好消息：接口已经设计好了

`server/src/rooms/repository.ts` 的注释原文：

> Persistence seam. v1 ships with the in-memory implementation; **swapping in
> SQLite or JSON files later touches only this module.**

也就是说**只需要换实现，上层一行不用改**。`RoomRepository` 接口：

```ts
export interface RoomRepository {
  load(roomId: string): PersistedRoom | null;
  save(room: GameRoom): void;
  list(): RoomSummary[];
  delete(roomId: string): void;
}
```

`save()` 已经在所有变更点被调用（`room.ts` 里有 9 处），**不需要新增调用**。

---

## 2. 这次做什么

```text
✅ 做：FileRoomRepository（JSON 文件落盘）
✅ 做：启动时恢复所有已持久化房间
✅ 做：配置项（数据目录，可通过环境变量覆盖）
✅ 做：原子写（避免写一半崩溃损坏文件）
✅ 做：测试
❌ 不做：SQLite（JSON 够用，先简单）
❌ 不做：棋谱回放 UI（那是另一个功能）
❌ 不做：跨进程锁（单进程服务，不需要）
```

---

## 3. 落盘格式

### 3.1 一个房间一个文件

```text
<dataDir>/rooms/<roomId>.json
```

理由：

- 一个房间损坏不影响其他房间
- 方便手动查看/删除
- 不需要读写整个大文件

`roomId` 已经过 `assertRoomId` 校验（安全字符），可以直接做文件名。
**但仍要防御性检查**，防止路径穿越。

### 3.2 文件内容

直接写 `PersistedRoom`（已有类型）：

```json
{
  "id": "default",
  "state": { ... },
  "history": [ ... ],
  "commentary": [ ... ]
}
```

**不要**加版本号字段——`state.schemaVersion` 已经有了，`migrateSnapshot` 已经处理了 v1→v2。

### 3.3 目录位置

```text
默认：<repo>/data/rooms/
环境变量：ARENA_DATA_DIR
```

`config.ts` 加一项：

```ts
dataDir: env.ARENA_DATA_DIR?.trim() || path.join(process.cwd(), 'data')
```

⚠️ **`data/` 要加进 `.gitignore`**。对局数据不该进版本库。

---

## 4. 原子写（重要）

**不能直接 `writeFileSync`**——写到一半崩溃会留下损坏的 JSON，下次启动整个房间读不出来。

正确做法：

```text
1. 写到 <roomId>.json.tmp
2. fsync（可选，但推荐）
3. rename 到 <roomId>.json   ← rename 是原子的
```

`rename` 在同一文件系统内是原子操作，不会出现「半个文件」。

### 4.1 读取时的容错

```ts
load(roomId) {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return migrateSnapshot(parsed);     // 复用现有迁移
  } catch (error) {
    // 文件不存在 → null（正常）
    // JSON 损坏 → 记日志，返回 null，不要让整个服务起不来
  }
}
```

⚠️ **一个损坏的房间文件不能让服务启动失败。** 记 `console.error` 然后跳过。

---

## 5. 启动时恢复

这是**必须做**的一步，否则落盘了也没用。

`RoomManager` 现在启动时只建默认房间：

```ts
initializeDefaultRoom(): GameRoom {
  return this.get(this.defaultRoomIdValue) ?? this.create(...);
}
```

### 5.1 新增方法

```ts
/** Recreate every persisted room so a restart resumes where it left off. */
restoreAll(): void {
  for (const summary of this.repository.list()) {
    if (this.rooms.has(summary.roomId)) continue;
    this.create(summary.roomId);   // GameRoom 构造时自己会 restore
  }
}
```

**关键**：`GameRoom` 构造函数已经会从 repository 恢复（`this.restore(persisted)`），
所以 `create()` 就够了，不需要额外的恢复逻辑。

### 5.2 调用点

`server/src/index.ts` 里，`initializeDefaultRoom()` 之后调用 `restoreAll()`。

⚠️ **顺序**：先 `restoreAll()` 再 `initializeDefaultRoom()` 更好——
如果持久化里有 `default` 房间，`create` 会恢复它，`initializeDefaultRoom` 就是幂等的。
两种顺序都能工作，但要**确认不会重复创建**（`create` 有 `ROOM_EXISTS` 检查，
`initializeDefaultRoom` 用 `get() ?? create()` 已经防了）。

### 5.3 恢复后 roster 是空的

⚠️ **这是预期行为，不要试图恢复**：

`PersistedRoom` 里**没有 roster**（参与者名册）。所以重启后：

- 棋局、走子历史、解说 → **恢复**
- 谁坐在哪、谁 ready → **丢失**

这是对的：连接已经不存在了，恢复一个「在线」状态是撒谎。
`summarize()` 的注释也写了这点。

**agent 重连后需要重新 `join_game`**，同名会拿回原座位（P1b 已实现）。

---

## 6. 测试

### 6.1 必须新增

| 编号 | 内容 |
|---|---|
| F1 | `save` 后文件存在，内容是合法 JSON |
| F2 | `load` 能读回完整快照（state / history / commentary） |
| F3 | 重启模拟：新建 repository 实例能读到旧文件 |
| F4 | 损坏的 JSON 文件 → `load` 返回 null，不抛异常 |
| F5 | `delete` 删除文件 |
| F6 | `list` 返回所有房间摘要 |
| F7 | 原子写：`.tmp` 文件不会残留 |
| F8 | v1 快照文件能通过 `migrateSnapshot` 迁移 |
| F9 | `restoreAll` 后房间可查询，且状态正确 |

### 6.2 测试要用临时目录

⚠️ **不要在仓库的 `data/` 里跑测试**，会污染真实数据。

用 `fs.mkdtempSync(os.tmpdir() + '/arena-test-')`，测试后清理。

### 6.3 必须保持绿

```text
[ ] 249 个现有测试一个都不能挂
```

---

## 7. 一个要小心的点：`save` 的调用频率

`room.ts` 里有 9 处 `this.save()`，每落一子都写一次文件。

对 9 路围棋（最多 81 手）没问题，但要注意：

- **同步写会阻塞事件循环**。一子一写、写几十次，每次几毫秒，可以接受
- 但如果以后加大棋盘或高频操作，要考虑批量/异步

**本轮用同步写即可**（简单、不会丢数据），但**注释里要写明这个取舍**：

```ts
// Synchronous on purpose: a move must be durable before the response goes
// out, and at 9x9 the write is a few milliseconds. Revisit if boards grow.
```

---

## 8. 完成标准

```text
[ ] FileRoomRepository 实现 RoomRepository
[ ] 一个房间一个 JSON 文件，原子写
[ ] 损坏文件不影响启动
[ ] 启动时 restoreAll() 恢复所有房间
[ ] data/ 加进 .gitignore
[ ] ARENA_DATA_DIR 可配置
[ ] pnpm test 全绿（249 + 新增）
[ ] pnpm typecheck + build 通过
```

### 8.1 手动验收（重要）

```powershell
# 1. 起服务，下一盘棋
pnpm start

# 2. 走几步，然后杀掉服务
# 3. 重启
pnpm start

# 4. 打开网页，棋局应该还在
#    → GET /api/rooms 能看到那个房间，moveCount 正确
```

**这一步必须真做**，不能只靠单元测试。

---

## 9. 提交

```text
feat(persist): keep rooms on disk, so a restart no longer loses the game

MemoryRoomRepository forgot everything on exit, which cost a real game the user
had just finished. FileRoomRepository writes one JSON per room and the manager
recreates them on boot, so a restart resumes where it stopped.

Writes go through a temp file and rename: a half-written snapshot would take the
whole room down on the next load, and a corrupt room must never stop the server
from starting.

The roster is deliberately not persisted. Connections are gone after a restart,
so an agent reconnects with join_game and the roster's same-name rule hands back
its seat.
```

---

## 10. 做完之后

P3 完整 + 持久化完成后，可以进 **P4 聊天室**。

聊天室会复用这套 repository，所以这一步是 P4 的地基之一。
