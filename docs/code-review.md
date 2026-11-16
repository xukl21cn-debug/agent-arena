# agent-arena 全局代码审查报告 (Code Review)

> 审查时间：2026-11-16  
> 审查范围：`shared/`, `server/`, `web/`, 以及与 `docs/architecture/constraints.md` / `AGENTS.md` 的契约一致性  
> 评审组织：Swarm 评审联合工作组（后端专家 @server-rev、前端专家 @web-rev、验证与文档负责人 @verifier）

---

## 1. 审查概览与基准验证

在开展深度源码审查前，评审组首先对仓库进行了全量静态类型检查与单元/集成测试套件验证：

| 检查项 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| 全局类型检查 | `pnpm typecheck` | ✅ **0 Error** (shared / server / web) | ~3s |
| 全量测试套件 | `pnpm test` | ✅ **365 Passed** (26 files, 含进程级 e2e) | ~17s |

**重要结论**：现存 365 个自动化测试全部通过，但这**并不代表代码没有重大缺陷**（严格符合 `docs/reviewing.md` §1「不要只看测试，通过不等于正确」）。测试套件中缺少针对部分组合场景（如围棋房间成员退出、双 Agent 经 stdio 桥接查询身份、Web 端未开局房间的错误捕获与重连行为等）的用例覆盖。

本次审查共发现并独立验证了 **23 项具体问题**，按严重程度分级如下：
- **P0 严重 (Critical)**：0 项（无进程崩溃或远程未授权利用漏洞）
- **P1 高危 (High)**：7 项（逻辑崩溃、状态机脱节、状态竞争污染、协议假在线/假思考、死循环重连）
- **P2 中危 (Medium)**：7 项（领域边界击穿、长轮询死循环忙等、IME 输入法中断、时区错位、内存泄漏）
- **P3 低危 / 改进建议 (Low & Suggestions)**：9 项（边缘边界值、文案规范、移动端触摸事件、选择器避坑指导）

---

## 2. 缺陷汇总清单

| 编号 | 严重度 | 模块 | 缺陷标题 | 影响面 |
|---|---|---|---|---|
| **S-01** | **P1** | `server/rooms` | `GameRoom.leave()` 在围棋房间中调用触发 `WRONG_GAME` 崩溃 | 围棋房间退出逻辑崩溃、席位状态脱节 |
| **S-02** | **P1** | `server/rooms` | `GameRoom.join()` 换座/重连时未清理旧席位，导致 participantId 幽灵占双座 | 棋盘席位状态与 Roster 不一致 |
| **S-03** | **P1** | `server/mcp` | stdio 桥接模式下双 Agent 对局 `newGame`/`getState` 恒返回 `yourColor: 'black'` | 执白 Agent 误判自身颜色，违反架构约束 |
| **S-04** | **P1** | `server/rooms` | `GameRoom.getPhase()` 与 `summarize()` 遗漏围棋 `scoring` 状态，回退为 `lobby`/`waiting` | 数子阶段前端误展示准备中与准备按钮，大厅列表状态错误 |
| **W-01** | **P1** | `web/App` | `GamePage` 向 `opponentStatus` 传递错误的 `isOpponentTurn`，人类回合误显「AI 正在思考」 | 界面核心状态自相矛盾（标题「轮到你了」vs 状态栏「AI 正在思考」） |
| **W-02** | **P1** | `web/store` | 聊天室 WebSocket 错误帧缺失 `kind: 'chat'` 被直接抛弃，导致无限重连黑屏 | 访问不存在/非法聊天室时前端死锁在重连中 |
| **W-03** | **P1** | `web/store` | 游戏室 WebSocket 遇到 1008 拒绝无感知无限重连；乱序状态合并清空当前局解说 | 访问新房间死循环重连；解说记录被异常抹除 |
| **S-05** | **P2** | `server/chat` | `ChatManager` 引入 `room-manager` 的 `assertRoomId`，跨领域抛出 `RoomError` | 领域边界破坏，聊天室报 500 而非 400 |
| **S-06** | **P2** | `server/chat` | `chatHint` 在暂停房间提示「继续 wait_for_messages」，但 `hasWakeup` 立即返回 | 导致 Agent 陷入 0ms 极速轮询死循环 |
| **S-07** | **P2** | `server/mcp` | `SessionBindings` 在会话关闭/销毁时未执行 `clear` | MCP 长连接生命周期产生内存泄漏 |
| **W-04** | **P2** | `web/chat` | `ChatComposer` 缺少中文输入法 `isComposing` 判断 | 中文拼音回车时误发送半截消息或误选点名候选人 |
| **W-05** | **P2** | `web/chat` | 聊天时间戳与复盘页使用 UTC `slice(11, 16)`，与解说面板本地时间存在 8 小时时差 | 中国时区下界面出现反直觉时间跳变 |
| **W-06** | **P2** | `web/lobby` | `LobbyPage` 轮询缺少组件卸载清理，且使用 `Promise.all` 导致故障强耦合 | 离开页面后控制台报错；聊天接口异常拖垮游戏大厅 |
| **W-07** | **P2** | `web/chat` | 聊天室暂停时 Web 界面过度禁用输入框，主持人无法发话 | 违反领域规则「暂停时人类可随时发言插话」 |
| **S-08** | **P3** | `server/chat` | `ChatRoom.transcript` 在 `limit: 0` 时因 JS `-0` 机制返回全部历史 | 参数边界异常行为 |
| **S-09** | **P3** | `server/rules` | `resolveRules` 校验失败抛出原生 `Error` 而非 `RoomError` | 规则不支持时报 500 而非 400 `UNSUPPORTED_RULE` |
| **S-10** | **P3** | `server/routes` | REST 路由使用 `x-arena-participant` 请求头时绕过 `presence.touch` | 仅以 participantId 发起操作时活跃状态不被刷新 |
| **W-08** | **P3** | `web/chat` | `ChatComposer` 点名候选列表在移动触屏设备上因 `blur` 提前触发而无法点击 | 触屏端无法完成点名选择 |
| **W-09** | **P3** | `web/chat` | 聊天室暂停或关闭时轮次展示为「等待轮转」 | 状态指示不精准 |
| **W-10** | **P3** | `web/store` | `seatColors` 仅认定双 Agent 房间为观战，误将远程玩家/第三方观众设为非观战 | 观众进入围棋数子时出现可点击的确认按钮 |
| **W-11** | **P3** | `web/api` | API 错误处理直接吐出后端英文错误文案，未做本地化转换 | 违反 AGENTS.md 短句中文文案约束 |
| **W-12** | **P3** | `web/replay` | `ReplayPage.tsx` 中局部常量 `endLabel` 遮蔽从 `labels` 导入的同名函数 | 变量命名遮蔽，降低代码可维护性 |
| **W-13** | **P3** | `web/ui` | 子页面（对弈、复盘、聊天）缺失「返回大厅」的直接导航链接 | 用户体验断层 |

---

## 3. P1 高危问题深度剖析与修复建议

### [S-01] `GameRoom.leave()` 在围棋房间中调用触发 `WRONG_GAME` 崩溃
- **文件与行号**：[`server/src/rooms/room.ts:397-405`](file:///E:/code/fun/agent-arena/server/src/rooms/room.ts#L397-L405)
- **根本原因**：
  在 `leave(participantId: string)` 中，当退出的参与者持有座位时，代码无条件调用了：
  ```ts
  const current = this.gomoku();
  this.state = {
    ...current,
    seats: {
      ...current.seats,
      [seat]: { kind: current.seats[seat].kind },
    },
  };
  ```
  而在围棋房间（`this.state.game === 'go'`）中，`this.gomoku()`（第 906 行）会显式抛出：
  ```ts
  throw new RoomError('WRONG_GAME', 'This room is not running gomoku.');
  ```
- **影响与复现**：
  创建一局围棋对局后，任何已占座的参与者调用 `DELETE /api/rooms/:id/participants/:pid` 或调用 MCP `leave_room`，服务端直接抛出 400 `WRONG_GAME` 异常，退出失败，Roster 与席位数据不一致。
- **推荐修复**：
  与第 1034 行 `syncSeat` 的多态处理保持一致，或者在更新 `seats` 时解构当前统一接口：
  ```ts
  const seats = {
    ...this.state.seats,
    [seat]: { kind: this.state.seats[seat].kind },
  };
  if (this.state.game === 'go') {
    this.state = { ...this.go(), seats };
  } else {
    this.state = { ...this.gomoku(), seats };
  }
  ```

---

### [S-02] `GameRoom.join()` 换座/重连时未清理旧席位，导致 participantId 幽灵占双座
- **文件与行号**：[`server/src/rooms/room.ts:336-340`](file:///E:/code/fun/agent-arena/server/src/rooms/room.ts#L336-L340), [`server/src/rooms/participant-roster.ts:144-152`](file:///E:/code/fun/agent-arena/server/src/rooms/participant-roster.ts#L144-L152)
- **根本原因**：
  在 `ParticipantRoster.join` 中，如果同名用户以不同席位（例如原先是 `black`，现在请求 `white`）重新加入，`assignSeat` 正确地将 `existing.seat` 更新为 `white`。
  但在 `GameRoom.join` 中：
  ```ts
  const participant = this.roster.join(request);
  if (participant.seat !== null) {
    this.syncSeat(participant.seat, participant);
  }
  ```
  `syncSeat('white', participant)` 仅仅将 `this.state.seats.white` 更新为该参与者，但**完全没有清除 `this.state.seats.black` 里的旧记录**！
- **影响与复现**：
  参与者换座后，`state.seats.black.id` 和 `state.seats.white.id` 都会是同一个 `participantId`。更严重的是，若参与者换为观战（`seat: null`），`this.state.seats` 根本不触发更新，旧座位永远保留其身份。
- **推荐修复**：
  在 `syncSeat` 或 `join` 中，遍历清空非目标席位上存在的同一 `participant.id`：
  ```ts
  private syncSeat(seat: StoneColor, participant: Participant): void {
    const otherSeat: StoneColor = seat === 'black' ? 'white' : 'black';
    const seats = {
      ...this.state.seats,
      [otherSeat]: this.state.seats[otherSeat].id === participant.id
        ? { kind: this.state.seats[otherSeat].kind }
        : this.state.seats[otherSeat],
      [seat]: {
        id: participant.id,
        kind: participant.kind,
        name: participant.name,
      },
    };
    ...
  }
  ```

---

### [S-03] stdio 桥接模式下双 Agent 对局 `newGame`/`getState` 恒返回 `yourColor: 'black'`
- **文件与行号**：[`server/src/mcp/stdio.ts:115, 126`](file:///E:/code/fun/agent-arena/server/src/mcp/stdio.ts#L115), [`server/src/mcp/api.ts:105-113`](file:///E:/code/fun/agent-arena/server/src/mcp/api.ts#L105-L113)
- **根本原因**：
  在 `server/src/mcp/api.ts` 中定义的辅助函数：
  ```ts
  export function agentColorOf(state: AnyGameState): StoneColor | null {
    if (state.seats.black.kind === 'agent') return 'black';
    if (state.seats.white.kind === 'agent') return 'white';
    return null;
  }
  ```
  在双 Agent 场景下，黑白双方的 `kind` 均为 `'agent'`。因此 `agentColorOf` 永远返回 `'black'`。
  在 `server/src/mcp/stdio.ts` 中：
  ```ts
  async newGame(roomId, options) { ... return { state: ..., yourColor: agentColorOf(state) }; }
  async getState(roomId) { ... return { state: ..., yourColor: agentColorOf(view.state) }; }
  ```
  直接使用了该推断，未考虑当前 stdio 实例绑定的 `this.participantId`。
- **影响与复现**：
  违反了 `docs/architecture/constraints.md` §2 中的硬性约束：`yourColor` 必须按会话绑定的 `participantId` 解析。执白的 Agent 读到 `yourColor: 'black'`，导致后续逻辑全乱（认为自己执黑，从而拒不下子或尝试抢下黑子报错 `NOT_YOUR_TURN`）。
- **推荐修复**：
  在 `HttpApi` 中根据 `this.participantId` 匹配 `state.seats`：
  ```ts
  private resolveYourColor(state: AnyGameState): StoneColor | null {
    if (this.participantId) {
      if (state.seats.black.id === this.participantId) return 'black';
      if (state.seats.white.id === this.participantId) return 'white';
    }
    return agentColorOf(state);
  }
  ```

---

### [S-04] `GameRoom.getPhase()` 与 `summarize()` 遗漏围棋 `scoring` 状态，回退为 `lobby`/`waiting`
- **文件与行号**：[`server/src/rooms/room.ts:228-239`](file:///E:/code/fun/agent-arena/server/src/rooms/room.ts#L228-L239), [`server/src/rooms/repository.ts:127-133`](file:///E:/code/fun/agent-arena/server/src/rooms/repository.ts#L127-L133)
- **根本原因**：
  在 `GameRoom.getPhase()` 中：
  ```ts
  getPhase(): RoomPhase {
    if (this.state.status === 'playing') {
      return 'playing';
    }
    if (this.state.status === 'finished') {
      return 'finished';
    }
    return this.roster.list().some((participant) => participant.ready)
      ? 'waiting'
      : 'lobby';
  }
  ```
  围棋状态 `GoStatus` 包含 `'idle' | 'playing' | 'scoring' | 'finished'`。当连续两手 pass 进入数子阶段后，`this.state.status` 变成 `'scoring'`。
  由于既非 `'playing'` 也非 `'finished'`，它直接穿透到了最后的判断，返回了 `'waiting'` 或 `'lobby'`！
  在 `FileRoomRepository.summarize` 中存在完全相同的遗漏。
- **级联影响**：
  1. **前端控制栏错乱**：`Controls.tsx:87` 判定 `const gathering = phase === 'lobby' || phase === 'waiting'` 为真，在数子阶段强行弹出「准备」/「取消准备」按钮以及「双方都准备好后自动开局五子棋」提示！
  2. **状态栏错乱**：`StatusBar.tsx:198` 判定 `showReady={phase === 'lobby' || phase === 'waiting'}` 为真，在数子阶段将席位徽标切为准备标记。
  3. **大厅列表错乱**：正在数子的棋局在 `LobbyPage` 中被标记为「准备中」或「等待加入」，而非「对局中」。
- **推荐修复**：
  围棋数子是对局尚未结束的进行阶段，属于对局生命周期：
  ```ts
  getPhase(): RoomPhase {
    if (this.state.status === 'playing' || (this.state.game === 'go' && this.state.status === 'scoring')) {
      return 'playing';
    }
    if (this.state.status === 'finished') {
      return 'finished';
    }
    return this.roster.list().some((participant) => participant.ready)
      ? 'waiting'
      : 'lobby';
  }
  ```
  同步修正 `repository.ts:summarize` 中的对应映射。

---

### [W-01] `GamePage` 向 `opponentStatus` 传递错误的 `isOpponentTurn`，人类回合误显「AI 正在思考」
- **文件与行号**：[`web/src/App.tsx:133-136`](file:///E:/code/fun/agent-arena/web/src/App.tsx#L133-L136)
- **根本原因**：
  在 `App.tsx` 的 `GamePage` 组件中：
  ```ts
  const opponentState = opponentStatus(opponent, {
    playing: state?.status === 'playing',
    isOpponentTurn: trackedSeat !== null && state?.status === 'playing',
  });
  ```
  在人机对弈中，`trackedSeat` 为 `agentColor`。只要对局进行中（`playing`），`trackedSeat !== null` 恒为真，`isOpponentTurn` 就永远被传入 `true`，**完全没有判断当前轮到哪一方（`state.turn === trackedSeat`）**！
- **影响与复现**：
  只要已连接 Agent 的房间开局，即使是人类执黑先手（`state.turn === 'black'`，人类该落子了），`opponentStatus` 也会因为 `isOpponentTurn === true` 而直接返回 `'thinking'`。
  导致右侧 `CommentaryPanel` 徽章常驻「思考中」，并展示「AI 正在思考 ···」动画。而顶栏 `StatusBar` 却正确展示「轮到你了」，界面产生极其滑稽的自相矛盾。
- **推荐修复**：
  补齐对手轮次判断：
  ```ts
  isOpponentTurn:
    trackedSeat !== null &&
    state?.status === 'playing' &&
    state.turn === trackedSeat,
  ```

---

### [W-02] 聊天室 WebSocket 错误帧缺失 `kind: 'chat'` 被直接抛弃，导致无限重连黑屏
- **文件与行号**：[`web/src/store/chat.ts:207-209, 212-229`](file:///E:/code/fun/agent-arena/web/src/store/chat.ts#L207-L209), [`server/src/http/ws.ts:122-127`](file:///E:/code/fun/agent-arena/server/src/http/ws.ts#L122-L127)
- **根本原因**：
  当用户通过 URL 进入一个不存在的聊天室时，前端请求 `/ws?roomId=bad&kind=chat`。
  服务端在 `server/src/http/ws.ts:122` 查不到房间，发送错误帧：
  ```ts
  sendJson(socket, {
    type: 'error',
    code: 'ROOM_NOT_FOUND',
    message: `Chat room "${roomId}" not found.`,
  });
  socket.close(1008, 'ROOM_NOT_FOUND');
  ```
  注意该错误帧**没有携带 `kind: 'chat'`**！
  而前端 `web/src/store/chat.ts:207`：
  ```ts
  if ((frame as { kind?: unknown }).kind !== 'chat') {
    return;
  }
  ```
  因为不是 `kind: 'chat'`，该帧直接被忽略并 return。随后 socket 触发 `onclose`，进入指数退避定时重连，周而复始。
- **影响与复现**：
  用户访问不存在的聊天房间时，界面没有任何错误提示，页面无限展示「连接中/重连中」死锁。
- **推荐修复**：
  1. 服务端下发的聊天错误消息应附带 `kind: 'chat'`，或通用错误统一处理；
  2. 前端 `subscribeToChatRoom` 中在过滤 `kind !== 'chat'` 之前优先处理 `type === 'error'`，并在 1008 等终态关闭码时不执行重连，同时在 store 中记录 `error`。

---

### [W-03] 游戏室 WebSocket 遇到 1008 拒绝无感知无限重连；`applyState` 抹除解说记录
- **文件与行号**：[`web/src/store/room.ts:169-178, 437-444, 450-460`](file:///E:/code/fun/agent-arena/web/src/store/room.ts#L169-L178)
- **根本原因**：
  - **问题 A**：大厅提示语引导用户「打开 `?room=<房间名>` 即可开一间」。但打开未创建的房间名时，WS 握手被服务端返回 1008 `ROOM_NOT_FOUND`。前端 `store/room.ts` 收到 `error` 帧仅执行了 `console.warn`，未把错误存入 store；在 `onclose` 中无条件执行 `scheduleReconnect()`，导致控制台每隔几秒刷新一次重连失败，界面一直卡在「重连中」。
  - **问题 B**：在 `applyState(state)` 中：
    ```ts
    const previousGame = get().state?.gameId;
    set((current) => ({
      state: mergeState(current.state, state),
      ...(state.gameId === previousGame
        ? {}
        : { commentary: [], resultDismissed: false }),
    }));
    ```
    如果网络偶发延迟导致一条较旧的局状态推达（如迟到的 REST 响应），`mergeState` 依据版本号正确保留了较新的当前局状态；然而紧接着解构时，比较的是 `state.gameId === previousGame`（旧包的 gameId 与当前局不同），直接导致 `{ commentary: [] }` 被覆盖写入，当前对局的解说记录瞬间蒸发！
- **推荐修复**：
  - 问题 A：关闭码为 1008 或收到 `ROOM_NOT_FOUND` 错误帧时，停止重连并将错误置入 `store.error`，提示用户创建或返回大厅；
  - 问题 B：确定是否需要清空解说，应以 `mergeState` 之后决定的最终 `nextState.gameId !== previousGame` 为准。

---

## 4. P2 中危问题深度剖析与修复建议

### [S-05] `ChatManager` 引入 `room-manager` 的 `assertRoomId`，跨领域抛出 `RoomError`
- **文件与行号**：[`server/src/chat/manager.ts:11, 52, 76`](file:///E:/code/fun/agent-arena/server/src/chat/manager.ts#L11), [`server/src/chat/mcp.ts:101-114`](file:///E:/code/fun/agent-arena/server/src/chat/mcp.ts#L101-L114)
- **根本原因**：
  `ChatManager` 引用了 `../rooms/room-manager.js` 的 `assertRoomId`。该断言在校验失败时抛出棋类领域的 `RoomError('INVALID_ROOM_ID')`。
  但在 `/chat/mcp` 端点（`server/src/chat/mcp.ts`）的 `chatErrorResult` 异常处理器中，仅识别 `ChatError`：
  ```ts
  if (error instanceof ChatError) { ... }
  // 非 ChatError 均落入：
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'INTERNAL_ERROR', message }) }] };
  ```
- **影响**：
  聊天客户端传入不合法的 roomId 时，API 返回 500 `INTERNAL_ERROR` 而非 400 `INVALID_ROOM_ID`。严重破坏了 AGENTS.md §4.2 规定的「聊天室为独立领域对象，不依赖 rooms/」的设计约束。
- **推荐修复**：
  在 `server/src/chat/model.ts` 或 `manager.ts` 内使用 `@arena/shared` 的 `ROOM_ID_PATTERN` 自行校验，抛出 `ChatError('INVALID_ROOM_ID', ...)`。

---

### [S-06] `chatHint` 在暂停房间提示「继续 wait_for_messages」，但 `hasWakeup` 立即返回
- **文件与行号**：[`server/src/chat/model.ts:180`](file:///E:/code/fun/agent-arena/server/src/chat/model.ts#L180), [`server/src/chat/chat-room.ts:473`](file:///E:/code/fun/agent-arena/server/src/chat/chat-room.ts#L473)
- **根本原因**：
  在 `chat-room.ts` 的 `hasWakeup` 中：
  ```ts
  if (this.phase !== 'open') {
    return true;
  }
  ```
  房间处于暂停状态时，长轮询请求不会挂起，而是以 `hasWakeup: true` 立即返回当前快照。
  然而在 `model.ts:180` 中，`chatHint` 给出的文案却是：
  ```ts
  if (snapshot.phase === 'paused') {
    return '房间已暂停，等主持人恢复；继续 wait_for_messages';
  }
  ```
- **影响**：
  Agent 遵从 hint 指导再次调用 `wait_for_messages`，由于非 open 状态不挂起，请求立即以 0ms 耗时返回，并再次得到「继续 wait_for_messages」的 hint。Agent 将以此极高频率无限空转轰炸服务端，直至耗尽 Token 额度或遭遇限流。
- **推荐修复**：
  调整文案，与 MCP 工具声明（`mcp.ts:404`「『已暂停/已关闭』就停止」）对齐：
  ```ts
  if (snapshot.phase === 'paused') {
    return '房间已暂停，等主持人恢复；停止调用 wait_for_messages';
  }
  ```

---

### [S-07] `SessionBindings` 在会话关闭/销毁时未执行 `clear`
- **文件与行号**：[`server/src/mcp/http.ts:472-479, 520-524`](file:///E:/code/fun/agent-arena/server/src/mcp/http.ts#L472-L479), [`server/src/chat/mcp.ts:189-195, 230-234`](file:///E:/code/fun/agent-arena/server/src/chat/mcp.ts#L189-L195)
- **根本原因**：
  `server/src/core/session-context.ts` 中专门实现了 `SessionBindings.clear(sessionId)` 方法用于释放会话关联的席位映射。
  但在 `server/src/mcp/http.ts` 与 `server/src/chat/mcp.ts` 的 `transport.onclose` 以及 `DELETE /mcp` / `DELETE /chat/mcp` 回调中，仅删除了 local `sessions` Map，从未调用 `bindings.clear(sessionId)`。
- **影响**：
  长时间运行的服务端（特别是有 Agent 频繁断线重连、开启新 session 时），`SessionBindings` 中的 Map 条目无限累积，造成常驻内存泄漏。
- **推荐修复**：
  在会话关闭分支中补充清理逻辑：
  ```ts
  bindings.clear(closedId);
  ```

---

### [W-04] `ChatComposer` 缺少中文输入法 `isComposing` 判断
- **文件与行号**：[`web/src/components/chat/ChatComposer.tsx:96-129`](file:///E:/code/fun/agent-arena/web/src/components/chat/ChatComposer.tsx#L96-L129)
- **根本原因**：
  中文拼音输入法输入英文字母并敲回车确认上屏汉字时，浏览器会派发 `keydown (Enter)` 事件。
  `ChatComposer` 的 `handleKeyDown` 中直接捕获了 `Enter`：
  - 在点名状态下：第 114 行直接执行 `choose(mention.active)`，导致拼音还没选好字，选单第一项的 agent 已经被强行选入输入框；
  - 在正常输入状态下：第 127 行直接执行 `trySend()`，导致尚未敲汉字的英文字母串（如 `nihao`）被直接当作最终消息发送到了聊天室。
- **推荐修复**：
  在 `handleKeyDown` 开头加入标准中文输入法合成态守卫：
  ```ts
  if (event.nativeEvent.isComposing || event.keyCode === 229) {
    return;
  }
  ```

---

### [W-05] 聊天时间戳与复盘页使用 UTC `slice(11, 16)`，与解说面板本地时间存在 8 小时时差
- **文件与行号**：[`web/src/components/chat/ChatTimeline.tsx:16`](file:///E:/code/fun/agent-arena/web/src/components/chat/ChatTimeline.tsx#L16), [`web/src/components/replay/ReplayPage.tsx:9`](file:///E:/code/fun/agent-arena/web/src/components/replay/ReplayPage.tsx#L9), [`web/src/labels.ts:38`](file:///E:/code/fun/agent-arena/web/src/labels.ts#L38)
- **根本原因**：
  `ChatTimeline` 和 `ReplayPage` 的时间截取函数为：
  ```ts
  function clockOf(at: string): string {
    return at.slice(11, 16);
  }
  ```
  直接截取 ISO 字符串 `2026-11-16T07:15:00.000Z` 的 UTC 小时分。
  而棋局界面的 `CommentaryPanel.tsx:54` 使用 `date.getHours()` 本地时间。
- **影响**：
  在北京时间 15:15 发送的消息，聊天气泡旁显示 `07:15`；而解说面板显示 `15:15`。相差整整 8 个小时，极易引起人类用户困惑。
- **推荐修复**：
  抽取公共的 `formatClock(iso)` 工具函数，通过 `new Date(iso).getHours()` 渲染本地时区时间。

---

### [W-06] `LobbyPage` 轮询缺少组件卸载清理，且使用 `Promise.all` 导致故障强耦合
- **文件与行号**：[`web/src/components/lobby/LobbyPage.tsx:156-177`](file:///E:/code/fun/agent-arena/web/src/components/lobby/LobbyPage.tsx#L156-L177)
- **根本原因**：
  1. `LobbyPage` 8 秒一次的 `load()` 异步方法内部未持有 `isMounted` 或 `AbortController` 守卫，离开大厅页面后若网络请求刚好返回，React 会抛出在已卸载组件上触发 state 更新的警告；
  2. `Promise.all([api.listRooms(), api.listChatRooms()])` 将棋类房间和聊天房间强行绑定。只要聊天服务路由或特定持久化文件出现异常返回 500，整个大厅直接崩溃展示错误横幅，导致健康的五子棋和围棋对局也全部无法加载。
- **推荐修复**：
  1. 在 `useEffect` 闭包内设置 `let cancelled = false;` 守卫；
  2. 采用 `Promise.allSettled` 或独立请求解耦两者故障域。

---

### [W-07] 聊天室暂停时 Web 界面过度禁用输入框，主持人无法发话
- **文件与行号**：[`web/src/components/chat/ChatRoomPage.tsx:200-209`](file:///E:/code/fun/agent-arena/web/src/components/chat/ChatRoomPage.tsx#L200-L209)
- **根本原因**：
  在后端领域设计（`server/src/chat/model.ts:13` 及 `chat-room.ts:193`）中明确规定：
  `/** Host paused the room: agents may not speak, humans still may. */`
  暂停模式的设计初衷是限制 Agent 刷屏，以便人类主持人插话或控场。
  然而前端代码在第 201 行将输入框硬编码禁用：
  ```ts
  const composerDisabled =
    busy || room === null || phase === 'paused' || phase === 'closed';
  ```
- **影响**：
  人类主持人点击「暂停」后，自己也被禁止在网页输入框中打字发言，失去了暂停进行说明主持的核心能力。
- **推荐修复**：
  从 `composerDisabled` 中移除 `phase === 'paused'`（仅保留 `phase === 'closed'`），并在 hint 中提示「房间已暂停，仅主持人可发言」。

---

## 5. P3 低危问题与设计改进建议

### [S-08] JS `-0` 机制导致 `ChatRoom.transcript` 在 `limit: 0` 时返回全量消息
- **文件**：`server/src/chat/chat-room.ts:655`
- **说明**：`pool.slice(-limit)` 当 `limit: 0` 时，`-0` 在 JS 中等于 `0`，`slice(0)` 反而截取了数组全部元素。应加入 `if (limit <= 0) return { messages: [], omitted: pool.length }` 防御。

### [S-09] `resolveRules` 校验失败抛出原生 `Error` 而非 `RoomError`
- **文件**：`server/src/core/rules.ts:18-35`
- **说明**：传入非法 `boardSize` 或 `forbidden` 规则时抛出原生 `Error`，导致 HTTP 接口返回 500 内部错误。应改抛 `RoomError('UNSUPPORTED_RULE', ...)`。

### [S-10] REST 路由使用 `x-arena-participant` 请求头时跳过 `presence.touch`
- **文件**：`server/src/http/routes.ts:622, 649, 672, 705, 733, 754`
- **说明**：落子、让子等动作处理程序中只检查了 `if ('actor' in ref) touchActor(...)`，如果客户端通过 `x-arena-participant: <id>` 认证，其席位活跃时间不会被 touch，可能导致席位被错误标记为超时。

### [W-08] `ChatComposer` 点名候选列表在移动触屏设备上无法选择
- **文件**：`web/src/components/chat/ChatComposer.tsx:175, 186-190`
- **说明**：候选条目仅阻止了 `onMouseDown` 默认事件。触屏设备点击会先使 `<textarea>` 失去焦点触发 `onBlur`，导致选单提前销毁。应添加 `onTouchStart={(e) => { e.preventDefault(); choose(index); }}`。

### [W-09] 聊天室暂停或关闭时轮次展示为「等待轮转」
- **文件**：`web/src/components/chat/ChatRoomPage.tsx:255`
- **说明**：暂停和关闭时后端清空了 `turn`，前端三元表达式直接回退为「等待轮转」，语义不够精准。应依据 phase 分别显示「已暂停」或「已关闭」。

### [W-10] `seatColors` 仅认定双 Agent 房间为观战模式
- **文件**：`web/src/store/room.ts:99-120`
- **说明**：若席位包含 `remote` 参与者或纯第三方围观者，`spectator` 判定为 `false`，导致围棋数子面板呈现不属于该用户的「确认数子」按钮，点击报错。应改为 `spectator: human === null`。

### [W-11] 接口错误信息未做中文本地化
- **文件**：`web/src/api.ts:87-97, 296-304`
- **说明**：后端报出的诸如 `Point (2,3) is occupied.` 等英文错误直接呈现在前端红条上。应在 `labels.ts` 中维护错误码到中文短句的映射字典。

### [W-12] `ReplayPage.tsx` 中局部常量 `endLabel` 遮蔽导入函数
- **文件**：`web/src/components/replay/ReplayPage.tsx:4, 155`
- **说明**：第 4 行导入了 `endLabel` 函数，第 155 行又定义了 `const endLabel = endLabelOf(replay.final)`，存在同名变量遮蔽。建议重命名为 `finalEndLabel`。

### [W-13] 子页面缺失「返回大厅」的直接导航链接
- **文件**：`web/src/App.tsx`, `web/src/components/replay/ReplayPage.tsx`, `web/src/components/chat/ChatRoomPage.tsx`
- **说明**：目前只能通过修改浏览器地址栏回到 `/` 大厅，缺少明显的顶栏「返回大厅」面包屑或按钮。

---

## 6. 协议一致性与测试选择器避坑指南

### 6.1 `shared/` 契约一致性复核
- **类型只增不减**：`shared/src/game.ts` 中 `GameState` 与 `GoState` 的联合区隔规范，`GameStatus` 保持 `idle/playing/finished` 365 项测试契约，围棋专用状态 `GoStatus` 独立分离，完全符合 `docs/architecture/constraints.md`。
- **缺失共享方法**：`server/src/core/go.ts` 与 `web/src/scoring.ts` 存在两份完全镜像实现的 `scoreBoard` 面积计算逻辑。目前虽逻辑一致，但未来算法演进时存在漂移风险。建议后续重构阶段将纯算法函数沉淀至 `@arena/shared`。

### 6.2 自动化测试与独立审查选择器陷阱（摘自实战踩坑）
在编写针对 Web 端落子与盘面的独立测试脚本时，必须注意以下两处 DOM 选择器陷阱：
1. **数棋子切勿选 `circle`**：
   `Board.tsx` 与 `GoBoard.tsx` 中的星位（Hoshi）是通过 SVG 层的 `<circle>` 绘制的（9 路围棋 5 个，15 路五子棋 5 个）。若用 `circle` 统计棋子数，开局 0 子也会报出 5 颗子。
2. **数真实棋子切勿盲目选 `span.stone`**：
   在轮到人类回合时，棋盘上所有合法的空交叉点均渲染了 `<Stone preview />` 预览子（带有 `stone--preview` 类，设置了 `opacity: 0` 供 hover 交互）。若只统计 `span.stone`，空位也会被当成棋子计入。
   👉 **正确写法**：必须使用 `span.stone:not(.stone--preview)`。
