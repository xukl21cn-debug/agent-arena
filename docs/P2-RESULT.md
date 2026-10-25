# P2 结果：双真实模型对弈

> 状态：**进行中**（对局未结束，结论待补）
> 开始：2026-10-25 13:54 · 房间 `p2` · 观战 `http://127.0.0.1:3000/?room=p2`
> 观测者：DSH（本会话），**只读观察，未参与对局**

---

## 1. 对局双方

| 座位 | 名字 | 客户端 | 模型 |
|---|---|---|---|
| 黑 | `dsh` | DSH | deepseek-v4.1-flash |
| 白 | `claude` | Claude Code | — |

房间 `p2`（不是 `duel`；GLM 另开了房间，避开人类默认局）。

---

## 2. 已确认的结论

### 2.1 Q4：能否正确理解 `yourColor` 和 `participants`？

**结论：服务端有 bug，已修复。**

真实双 AI 对局暴露了一个用单 agent 测试永远测不到的错误：

`get_state` / `new_game` / `say` 三个工具都用 `room.getAgentSeat()` 回答
`yourColor`，而 `getAgentSeat()` 返回**第一个** agent 座位：

```ts
getSeatFor(actor) {
  for (const color of ['black', 'white']) {
    if (this.state.seats[color].kind === actor) return color;  // 总是 black
  }
}
```

双 AI 时两个 agent 的 `kind` 都是 `'agent'`，所以**白方 agent 被告知自己执黑**。

实测（修复前，端口 3000）：

```text
join black seat: black | join white seat: white
black get_state yourColor: black
white get_state yourColor: black   <<< 错，应为 white
black wait_for_turn yourColor: black reason: your_turn
white wait_for_turn yourColor: white reason: timeout   <<< 这个是对的
```

注意 `wait_for_turn` 是对的——它走 `room.resolve(ref)` 按 participantId 解析，
只有 `get_state` / `say` / `new_game` 走了错误的捷径。这也解释了为什么
`dual-agent.test.ts` 里只断言了 `wait_for_turn.yourColor` 就没发现。

**连带的 presence 污染**（同一个根因，后果更严重）：

```text
after joins   : black:pb=thinking(probe-black)  white:pw=idle(probe-white)
after white say: black:pb=thinking(probe-white)  white:pw=idle(probe-white)
                                                  ^^^^^^^^^^^^^^ 白方的会话挂到了黑方座位
```

`notePresence()` 也用了 `getAgentSeat()`，所以白方 agent 每次说话/读状态，
都会把自己的 MCP session 挂到**黑方**座位上。后果：

- 黑方标签显示成白方的客户端名
- 白方一安静，黑方标签就闪 `disconnected`（观察 p2 时确实看到了这个闪烁）

**修复**（提交 `0c8a297`）：新增 `callerSeat(room)`，从会话绑定查
participantId → roster → seat，三个工具改用它；未 join 的旧路径仍回退到
`getAgentSeat()`。

修复后实测（端口 3100 独立实例）：

```text
black get_state yourColor: black
white get_state yourColor: white   OK
after white say: black:pb=thinking(probe-black)  white:pw=idle(probe-white)   OK
```

回归测试：`dual-agent.test.ts` 新增 `reports each agent its own color from get_state and say`，
**167 测试全绿**（原 166 + 1）。

### 2.2 Q1–Q3、Q5、Q6

见下方「待补」章节 —— 需要等对局结束、以及双方的实际工具调用序列才能定论。

---

## 3. 对局转录

（对局结束后补全，含走子表 + 解说时间线）

---

## 4. 已知问题

| 问题 | 严重度 | 状态 |
|---|---|---|
| 双 AI 时 `yourColor` 返回第一个 agent 座位 | **高** | ✅ 已修（`0c8a297`） |
| 白方 agent 的 presence 挂到黑方座位 | **高** | ✅ 已修（同一提交） |
| 服务重启后 MCP 会话 404，客户端不重连 | 中 | ⬜ 待记录 |
| 双 AI 单局时长可能极长（本局已 45+ 手、近 1 小时） | 中 | ⬜ 待评估 |

---

## 5. 待补

- [ ] 对局最终结果（胜方 / 手数 / 用时）
- [ ] Q1（是否主动 join）
- [ ] Q2（是否自觉 wait）
- [ ] Q3（是否替对手落子）
- [ ] Q5（重连拿回座位）
- [ ] Q6（报错自我修正）
