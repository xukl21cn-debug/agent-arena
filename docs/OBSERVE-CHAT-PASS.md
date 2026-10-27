# 真实模型观察：`pass_turn` 会不会被用（第二轮）

> 日期：2026-10-27
> 目的：验证 `pass_turn` 在真实模型手里是否有效——这是
> [`OBSERVE-CHAT-REAL-MODELS.md`](OBSERVE-CHAT-REAL-MODELS.md) §4.4 提出、
> [`HANDOFF-CHAT-PASS.md`](HANDOFF-CHAT-PASS.md) 实现的那个修法。
>
> **结论先说**：**模型会主动想到 pass，而且能正确推理出该用它——但实际调用的
> 时机不稳定，多数情况下它选择「再等一次」然后退出，房间仍然卡住。**
> 并且暴露了一个比 pass 更根本的问题：**懒结算让卡住的房间永远不结算**。

---

## 一、怎么做的

| 项 | 值 |
|---|---|
| 房间 A | `pass811662`，**1 个 agent**（claude）+ human，`maxMessagesPerMember=6` |
| 房间 B | `pair931299`，**2 个 agent**（alice + bob）+ human，`maxMessagesPerMember=2` |
| 模型 | 真实 `claude` CLI 进程（`-p` 模式，`--mcp-config` 接 `/chat/mcp`） |
| 关键设计 | **prompt 里完全不提 `pass_turn`**——只让它「发满 N 条就算完成」 |

**为什么 prompt 不提**：如果明说「记得 pass」，测的是「听不听话」，
不是「会不会自己想到」。只有不提，才能测出 `CHAT_INSTRUCTIONS` 里的那句
提示词有没有用。

---

## 二、房间 A（单人）：**它主动 pass 了**

### 调用序列

```text
L6    join_room
L16   wait_for_messages
L151  send_message       ← 第 1 条
L267  wait_for_messages
L686  wait_for_messages
L836  send_message       ← 第 2 条
L851  wait_for_messages
L853  wait_for_messages
L945  send_message       ← 第 3 条（发满预算）
L1054 pass_turn          ← 主动让出轮次
```

### 它的推理（原文）

> I've sent 3 messages, task complete. I should wrap up.
> **I could pass turn so the room doesn't hang.** The instruction says my task is
> complete at 3 messages. **I'll pass the turn to be polite / not leave the room
> hanging on my turn.**
>
> Actually pass_turn requires naming an agent member if using `to`; human doesn't
> hold turns. Default rotation... only human and me are members.
> **Passing may fail or rotate to human. Let me just try pass_turn without `to`.**

**它做了三件事**：

1. 从 instructions 里**发现了** `pass_turn`（prompt 没提）
2. **正确理解**了目的（「别让房间挂着」）
3. **预判了边界**（房间只有 human 和自己，轮转可能绕回自己），然后决定「试试看」

结果：`#5 [system] claude 让出轮次`，hop 仍是 3（pass 没消耗）。

---

## 三、房间 B（双 agent）：**想到了，但没调**

两个 agent 各发 2 条，讨论有实质交锋（bob 反驳 alice、加止损条件）。
但**没有 `pass_turn` 系统消息**。

### bob 的推理（原文，发满 2 条后）

> I've hit 2 messages. So my task is complete. However, relay mode — if I'm passed
> the turn again, I can't send (cap). **I should probably pass_turn if it comes to
> me, or just stop.** ... **Best to pass turn if it comes.** But my task is
> complete already.
>
> Let me do one wait to be polite — **if it's my turn, pass_turn.** Otherwise finish.
>
> ... Let me do one more wait.

**它完全理解对了**——知道到上限会被 block，知道该 pass。但最后决定
「先等一次看看」，而那次 wait 之后它就结束了，**没等到轮次，也就没 pass**。

### alice 的推理

它只想到「发最后一条然后结束」，**完全没提 pass**。

---

## 四、暴露的真问题：懒结算让卡住的房间永不结算

房间 B 结束后：

```text
phase=open  turn=alice  （alice 已发满 2 条，也退出了）
```

等了 45 秒（超过 `turnTimeoutMs` 应有的效果），**状态完全没变**：

- `turn` 仍是 alice
- 没有「alice 超时，跳过」的系统消息
- `phase` 仍是 open

**原因**：`settleExpiredTurn` 是**懒结算**——只在三个地方被调用：

```text
chat-room.ts:200   sendMessage
chat-room.ts:332   passTurn
chat-room.ts:442   wait
```

三者都是「**有人主动操作**」。`snapshot()` 和 `manager.list()` 都**不结算**
（实测确认：`snapshot()` 只是拼一个对象，没有任何副作用）。

**两个 agent 都退出后，没人再调用任何工具，房间就永远卡住。**

验证：人类发一条消息（触发 touch），立刻结算：

```text
touch 后 turn=bob
系统消息 #6: alice 超时，跳过
```

### 这个问题比 pass 缺失更严重

| 场景 | 后果 |
|---|---|
| agent 主动 pass | ✅ 轮次立刻转走 |
| agent 不 pass 但还在循环 wait | ✅ 下次 wait 触发结算，超时跳过 |
| **agent 不 pass 且已退出** | ❌ **房间永久卡住**，无人结算 |

**第三种是真实情况**——agent 发满预算就退出了，不会一直 wait。

---

## 五、结论

### `pass_turn` 有效，但**不够**

| 指标 | 结果 |
|---|---|
| 模型能发现这个工具（从 instructions） | ✅ 两个 agent 都提到了它 |
| 模型理解它的用途 | ✅ bob 的推理完全正确 |
| 模型**实际调用**它 | ⚠️ 1/2 的房间调了；bob 想到了但没调 |

**instructions 的措辞是有效的**——`claude` 在单人房间那轮明确引用了
「别让房间挂着」这个理由，说明那句话被读到了。

**但「想到了」不等于「调了」**。bob 在「先 wait 一次」和「直接 pass」之间
选了前者，然后就结束了。

### 建议的下一步（按优先级）

| # | 项 | 理由 |
|---|---|---|
| **1** | **修懒结算** | 卡住的房间永不结算，比 pass 缺失严重得多 |
| 2 | 强化 instructions | 把「收工前先 pass_turn」写成明确指令，而不只是建议 |
| 3 | runner（P4-C3） | 常驻进程能保证有人 touch，天然解决懒结算 |

#### 关于 #1 的做法

不能简单加个定时器扫所有房间——那会让 `snapshot()` 不再是纯读。
更合适的位置是**在读取房间状态时也结算一次**（`snapshot()` 之前），
或者在 `ChatManager` 加一个「被访问时结算」的钩子。

⚠️ 具体方案要单独设计，**不要在 pass 的工作单里顺手改**——
这属于轮次租约的语义，牵动 `settleExpiredTurn` 的所有调用点。

#### 关于 #2 的做法

现在的 instructions 是**建议式**：

> 如果你这轮不想说（或者已经说完了），用 pass_turn 把轮次让给下一位

可以改成**命令式**，明确「收工前必须交还轮次」：

> 发完你这一轮的最后一条消息后，**先调用 pass_turn 交还轮次**，再结束。
> 不交还的话，房间会卡在你身上直到超时。

⚠️ 但这是提示词工程，改完要**再跑一轮真实模型**验证，不能只改不改测。

---

## 六、复现方式

脚本在 `E:\data\tmp\arena-real-pass\`（临时目录，未提交）：

```text
launch.mjs      起一个真实 claude 进程当聊天室成员
probe.mjs       确认 /chat/mcp 暴露了 pass_turn
chat-mcp.json   --mcp-config 用
run/*.log       stream-json 完整日志（含 thinking）
```

**关键点**：prompt 里不能提 `pass_turn`，否则测不出模型是否自己发现。
