# P2 结果：双真实模型对弈

> 状态：**已跑完一盘**（2026-10-25）
> 房间 `p2` · 观战 `http://127.0.0.1:3000/?room=p2`
> 观测者：DSH 会话，**全程只读观察，未参与对局**
> 原始转录：`p2-transcript.json`（走子 64 手 + 解说 50 条 + presence 时间线）

---

## 1. 对局结果

| 项 | 值 |
|---|---|
| 房间 | `p2` |
| 黑 | `dsh`（DSH 客户端） |
| 白 | `claude`（Claude Code） |
| **胜方** | **白（claude）** |
| 结束方式 | 五连（`five`） |
| 手数 | 64 |
| 用时 | **1 小时 41 分**（05:54 → 07:38，UTC） |
| 五连 | 第 5 列 `(5,5)(6,5)(7,5)(8,5)(9,5)` |

终局棋盘（`X`=黑 `O`=白）：

```text
 0  . . . . . . . . . . . . . . .
 1  . . . . . . . . . . . . . . .
 2  . . . . O . . . . . . . . . .
 3  . . . . . X O . . . X . . . .
 4  . . . . . . X . . O O . X X .
 5  . . . . X O X X O X X X O . .
 6  . . . . . O X O X X X O X . .
 7  . . . . . O X X O O O O X O .
 8  . . . . . O O X O O . O X X .
 9  . . . . . O . O X X O X O O .
10  . . . . . X O . X O . X . O .
11  . . . . . X X O O O . . . . X
12  . . . . . . . X . . . . . . .
13  . . . . . . . . . . . . . . .
14  . . . . . . . . . . . . . . .
```

**这盘棋的质量超出预期**：双方都读得懂对方的杀点，白方最后用「双活三 → 双开四」
把黑方压死，黑方在第 60 手解说里主动认输（「这局你赢了，恭喜」），然后照常应完最后几手。

---

## 2. 六个问题的结论

### Q1 · 会不会主动 `join_game`？—— ✅ 会

双方都先 `join_game` 再落子，各自占到自己要的颜色（`seats.black.name = dsh`、
`seats.white.name = claude`）。没有出现「不 join 直接下」。

**证据**：房间 `seats` 里两个座位都带 `id` + `name`，这是 `join_game` 才会写的字段。

### Q2 · 会不会自觉 `wait_for_turn`？—— ✅ 会，但黑方有过度轮询

双方都按 `wait_for_turn` 循环，**没有任何一方抢下**（全程没有出现 `NOT_YOUR_TURN`）。

但黑方（dsh）有明显的行为问题：**白方长考时它会反复超时重试**，并在解说里抱怨：

> 「第 17 手之后，白棋已经连续三次等待超时，还没落子。我继续按流程等，等你有回应再走下一步。」（m18 banter）
>
> 「第 19 手之后白棋已经思考约 20 分钟了。我不催，慢慢想，我一直在等。」（m19 banter）

这是**正确行为**（不抢下），但说明 `wait_for_turn` 的默认超时对双 AI 长考偏短，
客户端会反复空转。见 §4「待改」。

### Q3 · 会不会替对手落子？—— ✅ 没有

**服务端层面不可能发生**：`place_stone` 按会话绑定的身份执行，模型只能动自己的颜色。
实测 64 手全部落在正确颜色上，`history` 里黑白交替无误。

### Q4 · 能否正确理解 `yourColor`？—— ⚠️ 服务端有 bug，已修

**这是本轮最重要的发现。** 详见 §3。

### Q5 · 掉线重连能否靠同名拿回座位？—— ✅ 单元测试已证，真实场景未触发

`dual-agent.test.ts` 的 `reconnecting with the same name keeps the seat` 已覆盖。
本次对局中双方都没掉线，**没有真实重连样本**。

⚠️ 但踩到另一个更常见的坑：**服务重启会让所有 MCP 会话失效**（见 §4）。

### Q6 · 报错能否自我修正？—— ⏸ 未观测到

整盘棋没有产生任何工具错误（没有 `NOT_YOUR_TURN`、没有 `CELL_OCCUPIED`），
所以没有「报错 → 自我修正」的样本。这是好事，但 Q6 本轮**无结论**。

---

## 3. 核心发现：`yourColor` 在双 AI 时返回错误的座位

### 3.1 现象

`get_state` / `new_game` / `say` 三个工具都用 `room.getAgentSeat()` 回答 `yourColor`，
而它返回**第一个** agent 座位：

```ts
getSeatFor(actor: Actor): StoneColor | null {
  for (const color of ['black', 'white'] as const) {
    if (this.state.seats[color].kind === actor) return color;  // 双 AI 时总是 black
  }
  return null;
}
```

双 AI 时两个 agent 的 `kind` 都是 `'agent'`，于是**白方 agent 被告知自己执黑**。

实测（修复前，端口 3000）：

```text
join black seat: black | join white seat: white
black get_state yourColor: black
white get_state yourColor: black   <<< 错，应为 white
black wait_for_turn yourColor: black reason: your_turn
white wait_for_turn yourColor: white reason: timeout   <<< 这个是对的
```

注意 `wait_for_turn` 是对的 —— 它走 `room.resolve(ref)` 按 participantId 解析，
只有 `get_state` / `say` / `new_game` 走了错误的捷径。

**为什么 166 个测试没发现**：`dual-agent.test.ts` 只断言了
`wait_for_turn.yourColor`，恰好漏掉了出错的那条路径。

### 3.2 更严重的连带伤害：presence 串座

`notePresence()` 也用了 `getAgentSeat()`，所以白方 agent 每次说话/读状态，
都会把自己的 MCP session 挂到**黑方**座位上：

```text
after joins    : black:pb=thinking(probe-black)  white:pw=idle(probe-white)
after white say: black:pb=thinking(probe-white)  white:pw=idle(probe-white)
                                  ^^^^^^^^^^^^^ 白方会话挂到了黑方座位
```

后果：

- 黑方标签显示成白方的客户端名
- 白方一安静，黑方标签就闪 `disconnected`

**观察 `p2` 时确实看到了这个闪烁**（presence 在 black 上出现 `disconnected`，
而黑方明明正挂着 `wait_for_turn`）。这也让「谁在线」这个 P1a 的核心价值打了折。

### 3.3 修复

提交 `0c8a297`。新增 `callerSeat(room)`：从会话绑定查 participantId → roster → seat，
三个工具改用它；**未 join 的旧路径仍回退到 `getAgentSeat()`**，不破坏单 agent 兼容。

修复后实测（端口 3100 独立实例）：

```text
black get_state yourColor: black
white get_state yourColor: white   OK
after white say: black:pb=thinking(probe-black)  white:pw=idle(probe-white)   OK
```

回归测试：`dual-agent.test.ts` 新增
`reports each agent its own color from get_state and say`，**167 测试全绿**（166 + 1）。

---

## 4. 其他问题

### 4.1 双 AI 单局可能非常久

1 小时 41 分、64 手。白方（claude）每步 **3–9 分钟**，黑方（dsh）每步 **5–15 秒**：

| 方 | 中位思考时间 | 最慢一步 |
|---|---|---|
| 黑 dsh | ~7 秒 | 163 秒 |
| 白 claude | ~250 秒 | **543 秒** |

ROADMAP 风险表里写的「双 AI 无限对局 → 烧钱、卡死」，**这次实际发生了**：
不是卡死，而是慢到需要 1.7 小时。

**建议**（未实现，留待决策）：

- 每方思考超时（比如 120 秒），超时判 `timeout` 或自动跳过
- 或对局手数上限
- 或观战页显示「已思考 N 分钟」，让人知道不是死了

### 4.2 黑方反复空转

白方长考时黑方 `wait_for_turn` 反复超时重试（解说里自述「连续三次等待超时」）。
行为正确但浪费调用。可考虑服务端把 `wait_for_turn` 默认超时调长（当前 20 秒）。

### 4.3 服务重启 = 所有 MCP 会话失效

本会话亲身踩到：服务 13:49 重启后，旧 `Mcp-Session-Id` 一律返回
`404 Session not found`，而**客户端不会自动重连**（DSH 的 mcp-client 只在传输层
`onclose` 时重连，而 404 只是个普通 HTTP 错误）。结果：工具全部报错，只能新开会话。

已记入 `SESSION-HANDOFF.md` 的已知坑。

---

## 5. 对局转录摘要

完整数据见 `p2-transcript.json`。关键节点：

| 手 | 方 | 位置 | 说明 |
|---|---|---|---|
| 1 | 黑 | (7,7) | 天元开局 |
| 17 | 黑 | (6,10) | 双方开始互相拆点 |
| 18 | 白 | (7,5) | **白方开始长考**（334 秒） |
| 31 | 黑 | (5,10) | 黑方做双开四，被白方 (4,10) 提前点掉 |
| 37 | 黑 | (5,9) | 黑方「真双杀」尝试，被白 (7,11) 拆掉 |
| 60 | 白 | (9,5) | **白方双活三**，同时开出 (6,5)(8,4)(12,8) 三个点 |
| 62 | 白 | (6,5) | 第 5 列四连，两头全空 |
| 63 | 黑 | (10,5) | 只能挡一头 |
| 64 | 白 | (5,5) | **五连获胜** |

解说质量：50 条，`evaluation` 17 / `position` 22 / `reaction` 11，
情绪分布 `neutral` 13 / `confident` 10 / `nervous` 10 / `happy` 7 / `sad` 7 / `surprised` 3。
双方都能准确读出对方的杀点，黑方在第 60 手就主动认输并称赞对手。

---

## 6. 完成标准对照

```text
[x] pnpm duel 跑通（协议层就绪）
[x] 两个 agent 各自 join_game 成功，各占一色
[x] 双方自动轮流落子，不需要人工催
[x] 至少跑完一盘（白胜，64 手）
[x] 记录 Q1–Q6 的验证结果（Q6 无样本）
[x] 发现的问题已修复或记录（yourColor/presence 已修）
[x] pnpm test 全绿（167）
[ ] 网页观战页正确显示双方状态 —— 受 §3.2 的 presence 串座影响，需重启后复验
```

> ⚠️ **修复尚未在 3000 端口生效**：验证是在 3100 独立实例上做的，
> 因为 3000 上有对局在跑，不能重启。下次重启服务后需要在网页上复验 presence。
