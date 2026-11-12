# 工作单：pass / yield（agent 主动让出轮次）

> 面向：GLM
> 状态：`main` 干净，336 测试全绿（`b713041`）
> 分支：从最新 main 新建 `feat/chat-pass`
> 预计：1–2 小时
> 来源：[`observation.md`](../13-p4-c25-chat-fix/observation.md) §4.4
>
> **设计方案已用原型验证**（19 条检查全过，含「pass 清超时计数」的对照实验）。
> 验证结论见 §1.3。

---

## 0. 问题是什么

**agent 收工后，轮次会卡在它身上，只能等 `turnTimeoutMs`（默认 120 秒）超时才跳过。**

真实模型观察里，claude 发满 6 条就收工退出，房间就卡了 120 秒。
连续两次超时还会把整个房间暂停——一个已经走了的 agent，能把房间拖死。

claude 自己在对话里提出了修法（[P4-C2.5 观察报告](../13-p4-c25-chat-fix/observation.md) §4.4）：

> 给 `send_message` 加一个 pass/yield，或者让 runner 在 agent 本轮结束时
> 主动交还轮次，超时值从 120s 降到 10s 只是兜底。

**本工作单只做前半句：显式的 `pass` 工具。** 超时值不动（见 §2）。

---

## 1. 要做什么

### 1.1 新增 MCP 工具 `pass_turn`

```ts
pass_turn(roomId: string, to?: string) → {
  passed: true,
  turn: string | null,      // 下一位发言者名字
  hop: string,              // "3/16"（不变，pass 不消耗）
  hint: string,
}
```

语义：**不发言，把轮次交给下一位（或指定的 `to`）**。

- `to` 省略 → 按 join 顺序轮转到下一位 agent
- `to` 指定 → 交给那个 agent（校验同 `send_message` 的 `to`）
- **不产生 `chat` 消息，不消耗 hop**
- **记一条 `system` 消息**（留痕，可追溯）

### 1.2 ⚠️ 五个必须做对的点

#### ① 只有轮到自己的才能 pass

和 `send_message` 一样：`this.turn !== null && this.turn.participantId !== member.id`
→ `NOT_YOUR_TURN`。

**但有一个例外要考虑**：`turn === null` 时能不能 pass？
- `sendMessage` 里 `turn === null` 是允许的（谁先说话谁拿轮次）
- **`pass` 在 `turn === null` 时应该拒绝**——没有轮次可让，让什么？

建议：`turn === null` → `INVALID_REQUEST`，message 说「当前没有进行中的轮次」。

#### ② 必须清 `consecutiveTimeouts`

`sendMessage` 里有这一行（`chat-room.ts:276`）：

```ts
this.consecutiveTimeouts.delete(member.id);
```

**pass 也必须清**。理由：主动让出轮次证明这个 agent 是**活的**，
不该继续累计「连续超时」。不清的话，一个偶尔 pass 的 agent 会莫名其妙触发暂停。

### 1.3 ⚠️ 时序陷阱（原型验证时踩到的）

**`consecutiveTimeouts` 是每人独立的**，而且每次结算会从**结算时刻**重新发放
`turnTimeoutMs` 的租约。实测轨迹：

```text
send(1000)      → bob,    expires 2000
settle(2500)    → bob 超时（streak 1）→ alice, expires 3500
settle(5000)    → alice 超时（streak 1）→ bob,  expires 6000
settle(7000)    → bob 超时（streak 2）→ 暂停
```

**写测试时注意**：

- 要验「pass 清了某人的计数」，必须让**那个人自己 pass**，
  不是让别人 pass（别人的计数与他的无关）
- 两次超时必须**紧邻**，中间不能插别人的超时，否则 streak 不会累到 2
- 租约从**结算时刻**起算，不是从发言时刻

原型里我先写错了这两处，得到「该暂停的没暂停、不该暂停的暂停了」——
**正好反过来的结果**就是时序写错的典型症状。

#### ③ 必须 `emitChange()` + `wakeAll()`

轮次变了，等待中的 agent 要能立刻醒来。

#### ④ 系统消息的文案

建议：`${member.name} 让出轮次`，指定了 `to` 时：`${member.name} 把轮次交给 ${toName}`。

⚠️ **系统消息会占 `seq`**，`wait_for_messages` 的游标会前进——这是对的，
agent 应该看到「有人让出了轮次」。

#### ⑤ 房间暂停 / 关闭时的行为

- `phase === 'closed'` → `ROOM_CLOSED`
- `phase === 'paused'` → `ROOM_PAUSED`（和 `sendMessage` 一致）

---

## 2. 明确不做

| 不做 | 原因 |
|---|---|
| ❌ 改 `turnTimeoutMs` | 120s 保持不动。10s 对真实模型思考太短，会误判 |
| ❌ 改 `send_message` 的签名 | 加 `yield` 参数会让一个工具干两件事 |
| ❌ runner（P4-C3） | 独立工作单 |
| ❌ 自动 pass | 那是 runner 的职责，不是领域对象的 |
| ❌ 改 `mentions` 模式 | 独立工作单 |

---

## 3. 硬约束

| 约束 | 原因 |
|---|---|
| **`ChatErrorCode` 不新增** | 现有码够用（`NOT_YOUR_TURN` / `INVALID_REQUEST` / `ROOM_PAUSED` / `ROOM_CLOSED`） |
| **不改 `shared/`** | 聊天是独立领域对象 |
| **不改 `rooms/` / `core/presence.ts` / `mcp/tools.ts`** | 硬约束 |
| **`send_message` 行为不变** | 旧客户端依赖 |
| **pass 不消耗 hop** | 不产生对话内容 |
| **pass 不产生 `chat` 消息** | 它不是发言 |

---

## 4. 改动点清单

| 文件 | 改什么 |
|---|---|
| `server/src/chat/chat-room.ts` | 新增 `passTurn(member, to?, now): ChatTurn \| null` |
| `server/src/chat/mcp.ts` | 注册 `pass_turn` 工具 |
| `server/test/chat-pass.test.ts` | 新测试文件 |

⚠️ **`CHAT_INSTRUCTIONS`（`mcp.ts` 顶部）要加一句**，告诉 agent 有这个工具：

```text
- 如果你这轮不想说（或者已经说完了），用 pass_turn 把轮次让给下一位，
  别让房间等 120 秒超时。
```

**这句话很重要**——不写进 instructions，模型不会知道有这个工具。

---

## 5. 易错点

| 坑 | 说明 |
|---|---|
| **忘了清 `consecutiveTimeouts`** | 偶尔 pass 的 agent 会莫名触发暂停 |
| **`turn === null` 时允许 pass** | 没有轮次可让，应该拒绝 |
| **pass 消耗 hop** | 会让预算提前耗尽 |
| **pass 产生 `chat` 消息** | 时间线会多出空消息 |
| **忘了 `wakeAll()`** | 下一位 agent 要等到自己超时才发现轮到它 |
| **忘了写进 `CHAT_INSTRUCTIONS`** | 模型不知道有这个工具，等于白做 |
| **`to` 指向 human** | 同 `send_message`，human 不持有轮次，要拒绝 |
| **`to` 指向自己** | 应该拒绝或忽略——自己让给自己没有意义 |

---

## 6. 测试清单

**领域层**（`chat-pass.test.ts`）：

| # | 测试 | 断言 |
|---|---|---|
| P1 | 轮次在自己时 pass | 轮次转给下一位 |
| P2 | pass 不消耗 hop | `hop` 不变 |
| P3 | pass 不产生 `chat` 消息 | 消息列表里只有 `system` |
| P4 | pass 记了系统消息 | 有一条 `kind: 'system'` 提到让出轮次 |
| P5 | **pass 清了 `consecutiveTimeouts`** | 该成员先超时一次，**他自己** pass，再超时一次——仍是 streak 1，不该暂停（时序见 §1.3） |
| P6 | 不是自己轮次时 pass | `NOT_YOUR_TURN` |
| P7 | `turn === null` 时 pass | `INVALID_REQUEST` |
| P8 | `to` 指定下一位 | 轮次给指定的人 |
| P9 | `to` 指向 human | 拒绝 |
| P10 | `to` 指向自己 | 拒绝 |
| P11 | 暂停时 pass | `ROOM_PAUSED` |
| P12 | 关闭时 pass | `ROOM_CLOSED` |

**MCP 层**（真实会话）：

| # | 测试 | 断言 |
|---|---|---|
| P13 | 两个 agent，A pass | B 的 `wait_for_messages` **立刻返回**（不是等超时） |
| P14 | pass 后 `wait` 的 `messages` 里有系统消息 | agent 能看到「谁让出了轮次」 |
| P15 | pass 不消耗 hop（MCP 视角） | `room.hop` 不变 |
| P16 | `pass_turn` 出现在工具列表里 | `tools/list` 能查到 |

**回归**：

| # | 测试 | 断言 |
|---|---|---|
| P17 | `send_message` 行为完全不变 | 现有 336 测试全绿 |
| P18 | `chat-duel.mjs` | 15/15 |

---

## 7. 验收标准

- [ ] `pnpm typecheck` 干净
- [ ] `pnpm test` 全绿（当前 336，新增后 >350）
- [ ] **P5 / P13 是核心**：pass 清超时计数、pass 立刻唤醒下一位
- [ ] **P16**：`pass_turn` 真的出现在工具列表里
- [ ] `node scripts/chat-duel.mjs` 仍全绿
- [ ] 提交信息用英文，正文说**为什么**

---

## 8. 做完就停

不要做 runner、不要改超时、不要改 `mentions`、不要动回放和大厅。

⚠️ **改了工具清单，DSH 会话要重开才看得到 `pass_turn`**（`AGENTS.md` §8）。
