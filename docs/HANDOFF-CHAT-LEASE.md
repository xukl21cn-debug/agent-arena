# 工作单：修轮次租约的懒结算（房间卡死）

> 面向：GLM
> 状态：`main` 干净，351 测试全绿（`8322acc`）
> 分支：从最新 main 新建 `fix/chat-lease`
> 预计：1–2 小时
> 来源：[`OBSERVE-CHAT-PASS.md`](OBSERVE-CHAT-PASS.md) §4
>
> **方案已用原型验证**（15 条检查全过）。关键结论见 §1.4：
> sweep 确实会唤醒挂起的 `wait`，且单个房间抛错不影响其他房间。

---

## 0. 问题是什么

**全员退出后，房间会永久卡在某个 agent 的轮次上，永远不结算。**

实测（[`OBSERVE-CHAT-PASS.md`](OBSERVE-CHAT-PASS.md) §4）：双 agent 房间结束后
`turn=alice`，alice 也退出了。等 45 秒（远超 `turnTimeoutMs`），状态**完全没变**：

```text
phase=open  turn=alice   ← 没有任何「超时，跳过」的系统消息
```

人类发一条消息后立刻结算出 `#6 [system] alice 超时，跳过`。

### 根因

`settleExpiredTurn` 是**懒结算**，只有三个调用点：

```text
chat-room.ts:200   sendMessage
chat-room.ts:332   passTurn
chat-room.ts:442   wait
```

**三者都要求「有人主动操作」。** `snapshot()` 和 `manager.list()` 都不结算
（实测确认：`snapshot()` 只是拼对象，无副作用）。

两个 agent 都退出后 → 没人调用任何工具 → **永不结算**。

### 为什么这是真问题

| 场景 | 后果 |
|---|---|
| agent 主动 pass | ✅ 轮次立刻转走 |
| agent 不 pass 但还在循环 wait | ✅ 下次 wait 触发结算 |
| **agent 不 pass 且已退出** | ❌ **房间永久卡住** |

**第三种是常见情况**——agent 发满预算就退出，不会一直 wait。

而且这不只是「房间不好看」：卡住期间
- 其他 agent 的 `wait` 会看到「轮次在某人身上」，一直等
- `turn` 的租约时间已经过了，但没人知道

---

## 1. 要做什么

### 1.1 给 `ChatManager` 加 `sweep(now)`

```ts
/** Settle expired turn leases across every room. */
sweep(now: number): void {
  for (const room of this.rooms.values()) {
    room.settleExpiredTurn(now);
  }
}
```

⚠️ **`settleExpiredTurn` 已经是 `public`**，`ChatManager` 也持有
`private readonly rooms = new Map<string, ChatRoom>()`。**不需要改 `ChatRoom` 的可见性。**

⚠️ **不要改 `snapshot()` 让它结算。** 那是把「读」变成有副作用，
会让所有调用方（网页轮询、WS 广播、回放）都被牵连。`ChatRoom` 的注释
（`chat-room.ts:489`）明确写了「snapshot() stays a pure read」，这个约定要保住。

### 1.2 在 `index.ts` 加定时器

**照 `presence.sweep()` 的现成模式**（`index.ts:49`）：

```ts
const CHAT_SWEEP_MS = 15_000;
const chatSweepTimer = setInterval(() => chat.sweep(Date.now()), CHAT_SWEEP_MS);
chatSweepTimer.unref();
```

关闭时清理（`index.ts:80` 附近）：

```ts
clearInterval(chatSweepTimer);
```

⚠️ **必须 `unref()`**——否则定时器会阻止进程退出。`presence` 那个也是这么做的。

⚠️ **间隔选 15 秒**，和 `PRESENCE_SWEEP_MS` 一致。理由：
- 太密（1 秒）：无意义地扫全部房间
- 太疏（60 秒）：`turnTimeoutMs` 是 120 秒，60 秒扫一次会让「超时后」最多再等 60 秒才结算

15 秒在 120 秒租约下是可接受的延迟（最坏 135 秒结算）。

### 1.3 结算后要广播

`sweep` 里的 `settleExpiredTurn` 已经调了 `emitChange()` + `wakeAll()`
（看 `chat-room.ts:494` 后面的实现），所以：

- WS 订阅者会收到 `room` 帧 ✅
- 挂起的 `wait` 会被唤醒 ✅

**不需要额外做事**，但要**验证**（见 §4 的 T3/T4）。

### 1.4 原型验证结果（写工作单之前就验过）

用 `tsx` 跑了一个原型，直接驱动真实的 `ChatRoom`：

| 用例 | 结果 |
|---|---|
| 过期租约被结算，未过期的**不动** | ✅ |
| sweep 触发订阅者（WS 能收到帧） | ✅ |
| **sweep 唤醒了挂起的 `wait`** | ✅ `timedOut: false`（是「有变化」，不是超时） |
| `paused` / `closed` 房间不受影响 | ✅ |
| `turn === null` 的房间不抛错 | ✅ |
| 同一成员连续第二次超时 → 暂停（原语义不变） | ✅ |
| **一个房间抛错不影响其他房间** | ✅ |

```text
PASS 15   FAIL 0
SWEEP DESIGN VERIFIED
```

**最重要的一条是 T4**：`settleExpiredTurn` 内部「已经调了 `wakeAll()`」
是读代码得出的**假设**，原型把它变成了**观察事实**——
挂起的 `wait` 确实立刻返回，且返回原因是「有变化」而非超时。

---

## 2. 明确不做

| 不做 | 原因 |
|---|---|
| ❌ 改 `snapshot()` 让它结算 | 破坏纯读约定，牵连所有调用方 |
| ❌ 改 `turnTimeoutMs` | 与本次无关 |
| ❌ 改 instructions | 那是提示词工程，要单独验证 |
| ❌ runner（P4-C3） | 独立工作单 |
| ❌ 加 `ChatRoom` 自己的定时器 | 领域对象不该有生命周期 |

---

## 3. 硬约束

| 约束 | 原因 |
|---|---|
| **`snapshot()` 保持纯读** | `chat-room.ts:489` 的约定 |
| **不改 `settleExpiredTurn` 的语义** | 它本身是对的，只是没人调 |
| **不改 `shared/`** | 聊天是独立领域对象 |
| **不改 `rooms/` / `core/presence.ts` / `mcp/tools.ts`** | 硬约束 |
| **定时器必须 `unref()`** | 否则进程退不出 |
| **关闭时必须 `clearInterval`** | 和 presence 一致 |

---

## 4. 测试清单

**领域层**（`chat-lease.test.ts` 或加在现有文件里）：

| # | 测试 | 断言 |
|---|---|---|
| T1 | `manager.sweep(now)` 结算过期租约 | 超时后 `turn` 转给下一位 |
| T2 | `sweep` 不结算未过期的租约 | `turn` 不变，无系统消息 |
| T3 | `sweep` 触发了 `emitChange` | 订阅者收到通知（用 `subscribe` 计数） |
| T4 | **`sweep` 唤醒了挂起的 `wait`** | 一个 agent 挂起 `wait`，`sweep` 后它立刻返回 |
| T5 | `sweep` 对 `paused` / `closed` 房间无副作用 | phase 不变 |
| T6 | `sweep` 对 `turn === null` 的房间无副作用 | 不抛错 |
| T7 | 连续超时仍会暂停 | 两次 sweep 后 `phase === 'paused'`（原有语义不变） |

**集成**（真实服务）：

| # | 测试 | 断言 |
|---|---|---|
| T8 | **端到端：全员退出后房间自动恢复** | 建房间 → agent 发言 → 让租约过期 → 等一个 sweep 周期 → `turn` 已转走 |
| T9 | 定时器不阻止进程退出 | 启动后 `process.exit` 能正常结束（`unref` 生效） |
| T10 | 关闭时清理定时器 | 调 `server.close()` 后无残留 interval |

**回归**：

| # | 测试 | 断言 |
|---|---|---|
| T11 | 现有 351 测试全绿 | `sendMessage` / `passTurn` / `wait` 的结算行为不变 |
| T12 | `chat-duel.mjs` 15/15 | 旧客户端兼容 |

---

## 5. 易错点

| 坑 | 说明 |
|---|---|
| **让 `snapshot()` 结算** | 破坏纯读，牵连网页轮询 / WS / 回放。**不要** |
| **忘了 `unref()`** | 进程退不出，`pnpm test` 可能挂住 |
| **忘了 `clearInterval`** | 测试之间泄漏定时器，后续测试莫名其妙 |
| **sweep 间隔设成 1 秒** | 无意义地扫全部房间 |
| **sweep 间隔设成 60 秒** | 120 秒租约下最坏要 180 秒才结算 |
| **以为 sweep 不需要广播** | `settleExpiredTurn` 内部已经 `emitChange` + `wakeAll`，但要**验证**（T3/T4） |
| **在 `ChatRoom` 里加定时器** | 领域对象不该有生命周期 |
| **sweep 抛错让整个定时器挂掉** | 单个房间出错不该影响其他房间——见下 |

### ⚠️ sweep 要容错

如果某个房间的 `settleExpiredTurn` 抛错（理论上不该，但要防），
**不能让整个 sweep 中断**——后面的房间就不结算了。

```ts
sweep(now: number): void {
  for (const room of this.rooms.values()) {
    try {
      room.settleExpiredTurn(now);
    } catch (error) {
      console.error(`[chat] sweep failed for room "${room.id}":`, error);
    }
  }
}
```

理由：定时器是**旁路**，单个房间失败不该拖垮全局（和归档 prune 的处理一致）。

---

## 6. 验收标准

- [ ] `pnpm typecheck` 干净
- [ ] `pnpm test` 全绿（当前 351，新增后 >360）
- [ ] **T4 / T8 是核心**：sweep 能唤醒挂起的 wait、端到端能自动恢复
- [ ] `node scripts/chat-duel.mjs` 仍全绿
- [ ] 提交信息用英文，正文说**为什么**

---

## 7. 做完就停

不要改 instructions、不要做 runner、不要动回放和大厅。

> **改完可以再跑一轮真实模型观察**：上一轮 [`OBSERVE-CHAT-PASS.md`](OBSERVE-CHAT-PASS.md)
> 暴露的问题是「全员退出后卡死」，这次修完应该能自动恢复。
> 验证方法和上次一样：两个 claude 进程，发满预算后不管，等一个 sweep 周期。
