# AGENTS.md

给在这个仓库里干活的 AI agent 看的。**先读这一份，再读具体的工作单。**

最后更新：2026-10-26

---

## 1. 这是什么项目

`agent-arena`：一个本地竞技场，**给 AI agent 玩的房间**。

- 棋类房间：五子棋（15×15）、围棋（9 路，中国规则面积法）
- 聊天房间：多个 agent 轮流发言
- 通过 **MCP** 暴露给任意标准客户端（DSH / Claude Code / ZCode）
- 人类可以在网页观战、下棋、主持

技术栈：TypeScript · Node · Express · pnpm workspace（`shared` / `server` / `web`）

---

## 2. 分工（重要）

| 角色 | 负责 |
|---|---|
| **GLM** | **写代码** |
| **DSH（评审方）** | 设计、写工作单、评审、写文档、独立验证 |
| **用户** | 决定优先级、验收、观战 |

**评审方不要自己写业务代码。** 需要实现时，写工作单交给 GLM。

**评审方的验证不能只看 GLM 的测试**——必须独立写检查，见 §6。

---

## 3. 工作流程

```text
① 评审方写工作单 docs/HANDOFF-*.md
    - 边界（做什么 / 不做什么）
    - 硬约束（踩了就返工）
    - 易错点
    - 验收标准
    - 测试清单

② GLM 从最新 main 建分支实现
    - 做完就停，不自行扩大范围

③ 评审方评审
    - 独立验证（不看 GLM 的断言，自己写）
    - 写 docs/REVIEW-*.md
    - 通过则合并，不通过则打回

④ 合入 main，删除分支，跑全量测试
```

### 分支命名

```text
feat/<topic>      新功能
fix/<topic>       修 bug
docs/<topic>      纯文档
```

### 提交信息

```text
<type>(<scope>): <一句话>

为什么这样做（不是做了什么——diff 已经说明了）
关键取舍和理由
```

**用英文写提交信息，正文说「为什么」。** 中文只用在面向用户的文案和文档里。

---

## 4. 硬性约束（踩了就返工）

### 4.1 棋类侧

| 约束 | 原因 |
|---|---|
| `GameStatus` 只有 `idle/playing/finished` | MCP 契约 + 292 个测试依赖 |
| 围棋的 `scoring` 放在独立的 `GoStatus` | 不污染公共类型 |
| `PlayerSpec.id` 保持可选 | engine 默认值没有 id |
| 旧 `actor` 路径保留 | 旧客户端还在用 |
| presence 信号键按**座位** | 改 participantId 会牵动 `rebindSeats` |
| `RoomView` / `RoomSummary` 只增字段 | 网页和旧客户端依赖 |

### 4.2 聊天室侧

| 约束 | 原因 |
|---|---|
| 不改 `rooms/` / `core/presence.ts` / `mcp/tools.ts` | 聊天是独立领域对象 |
| 不复用 `PresenceRegistry` | 它按 seat 索引，聊天成员无座位 |
| `ChatErrorCode` 不进 `shared` | 棋类契约不动 |

### 4.3 通用

| 约束 | 原因 |
|---|---|
| 中文文案风格：短句 | 「AI 未接入」「思考中」 |
| 面向 agent 的字段只给**事实**，不给结论 | 判断是模型的活，见 §7 |

---

## 5. 开发环境

### 5.1 日常：`pnpm dev`

```powershell
pnpm dev
```

| 进程 | 端口 | 说明 |
|---|---|---|
| server | **3000** | `tsx watch`，改 `server/` 自动重启 |
| web | **5173** | Vite + proxy → 3000，改 `web/` 热更新 |
| shared | — | `tsc --watch` |

**网页开 5173，不是 3000。**

### 5.2 改代码的影响（实测）

| 改了什么 | 对局 | DSH 会话 |
|---|---|---|
| `web/` | ✅ 不受影响（HMR） | ✅ 不受影响 |
| `server/` | ✅ **持久化恢复** | ❌ 断（需新开会话） |
| `shared/` | ✅ 恢复 | ⚠️ 可能断 |

**P3.5 的持久化让对局在重启后自动恢复**，所以 `pnpm dev` 下改后端只丢 MCP 会话，不丢对局。

### 5.3 什么时候用双端口

只有「改后端 + 同时要用 DSH 对局」时：

```powershell
pwsh -File scripts/dev-isolated.ps1 -Only live   # 3000 不动
pnpm build
pwsh -File scripts/dev-isolated.ps1 -Only dev    # 3100 随便重启
pwsh -File scripts/dev-isolated.ps1 -Stop
```

⚠️ 双端口模式没有 Vite，3100 服务的是 `web/dist/`。改前端还是用 `pnpm dev`。

详见 [`docs/DEV-WORKFLOW.md`](docs/DEV-WORKFLOW.md)。

### 5.4 常用命令

```powershell
pnpm build        # 全量构建（shared + server + web）
pnpm test         # 全量测试（当前 292）
pnpm typecheck    # 类型检查
pnpm start        # 生产模式起服务（读 dist/，改完必须 build）
pnpm duel         # 两个脚本客户端下一盘五子棋（协议层自测）
```

⚠️ **`pnpm start` 读 `dist/`，改完 server 代码必须 `pnpm build` 再重启。**

---

## 6. 评审方怎么验证

**不要只看 GLM 的测试。** 那些测试是它自己写的，通过不等于正确。

### 6.1 独立验证的套路

```text
1. 从规则/需求出发，自己写检查（不看 GLM 的断言）
2. 用真实服务，不用 mock
3. 覆盖边界：空值、越界、类型错、拼写错
4. 验证**行为**，不只是返回值
5. 检查「拒绝后不留残留」
```

### 6.2 踩过的坑（评审方自己犯的，别再犯）

| 坑 | 教训 |
|---|---|
| **复用房间名** | 上次运行的参与者还在，`AMBIGUOUS_ACTOR` 让后续全部失败。**每次用带时间戳的新房间名** |
| **`timeoutMs` 传太小** | schema 下限是 1000，传 800 直接报错。**调工具前确认参数范围** |
| **测试双人系统时只放一个人** | 没有对手方，轮次永远不推进。**必须两个会话都在场** |
| **断言字段名猜错** | `komi` 在 `state.rules.komi` 不在顶层；`get_transcript` 返回 `messages` 不是 `transcript`。**先 dump 一次真实响应** |

**这四条已经犯了不止一次。写审计脚本前先对照一遍。**

### 6.3 实测脚本怎么写

- 用真实 MCP 客户端（`@modelcontextprotocol/sdk`）
- 浏览器用 CDP 直接驱动 Chromium（`--remote-debugging-port`），不需要 playwright 包
- 脚本放临时目录，不要提交进仓库

---

## 7. 设计原则（从实战学到的）

### 7.1 工具给事实，模型做判断

`hotPoints` 给「哪里落子成威胁」，`groups` 给「哪块棋几口气」，**不给「该逃该弃」的结论**。

P2 复盘时确认过：黑棋拿到了全部信息，也把正确的点念出来了，**照样下错**。
那是模型能力问题，不是工具缺信息。**加工具补推理等于把竞技场变成演示。**

### 7.2 错误信息要可操作

| 不好 | 好 |
|---|---|
| `GAME_NOT_PLAYING` | `NOT_SCORING`（明确告诉它「现在是数子阶段」） |
| `Session not found` | 带 `hint`：「轮到你了」「等 X 发言」 |

### 7.3 失败要可诊断

- 损坏的房间文件：**跳过、记日志、文件留在磁盘**，不要覆盖（会销毁证据）
- 校验失败：**报错**，不要静默回退默认值（policy bug 就是这么来的）

### 7.4 兼容优先

- 新功能 opt-in，旧路径行为不变
- 类型只增字段，不改不改名

---

## 8. MCP 的两个硬事实（改不了）

| 事实 | 影响 |
|---|---|
| **会话是内存对象，无法持久化** | 服务重启 → 所有会话失效（404） |
| **客户端不会自动重新握手** | 拿到 404 只会重试旧 id，永远看不到新工具 |

**所以：改了工具清单（`mcp/tools.ts`）就必须重开客户端会话。**

| 你改了什么 | 重开 DSH？ |
|---|---|
| 工具清单 / 工具描述 | ✅ **必须** |
| 业务逻辑（工具签名不变） | ❌ 不用 |
| 前端 / 数据模型 | ❌ 不用 |

`sendToolListChanged()` 实测有效，但只在**同一进程内**加工具时有用；重启进程就没意义了。

---

## 9. 当前状态（2026-10-26）

| 项 | 值 |
|---|---|
| 分支 | `main`，干净 |
| 测试 | **292 全绿** |
| 已完成 | P1 · P2 · P3 · P3.5 · P4-C1/C2 · chat policy 修复 · 真实模型聊天观察 · **聊天室两缺陷修复** |
| 进行中 | P4（聊天室）：服务端已完成且已验证，**C4 网页未开始** |

**下一步见 [`docs/SESSION-HANDOFF.md`](docs/SESSION-HANDOFF.md) §3.3**——写 `HANDOFF-P4-C4.md`，做网页聊天页。

---

## 10. 文档地图

| 文件 | 内容 |
|---|---|
| **`AGENTS.md`** | 本文件：通用约定，**先读这个** |
| `docs/ROADMAP.md` | 路线图、编号对照（P/M/G）、各阶段状态 |
| `docs/SESSION-HANDOFF.md` | **最新交接**（读它知道从哪继续） |
| `docs/DEV-WORKFLOW.md` | 双端口开发流程 |
| `docs/DESIGN.md` | 原始设计文档 |
| `docs/HANDOFF-*.md` | 各阶段工作单 |
| `docs/REVIEW-*.md` | 各阶段评审记录 |
| `docs/OBSERVE-*.md` | 实测观察记录（真实模型行为、缺陷证据） |
| `docs/PROPOSAL-*.md` | 提案（围棋、聊天室、参与者模型） |

### 文档惯例

- 工作单：`HANDOFF-<阶段>.md`，**边界写死**，做完即停
- 评审：`REVIEW-<阶段>.md`，**记录独立验证的过程和结论**
- 交接：`SESSION-HANDOFF.md`，**只写「从哪继续」和「别再踩什么」**
- 作废的工作单：**顶部加醒目警告**，保留实验结论（别删，别人会重踩）
