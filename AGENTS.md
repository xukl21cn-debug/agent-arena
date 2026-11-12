# AGENTS.md

给在这个仓库里干活的 AI agent 看的。**先读这一份，再读具体的工作单。**

> 当前进度与可选项：[`docs/roadmap.md`](docs/roadmap.md) §11 · 找任何文档：[`docs/README.md`](docs/README.md)

最后更新：2026-11-12

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

**评审方的验证不能只看 GLM 的测试**——独立检查的套路、踩坑表、脚本写法都在 [`docs/reviewing.md`](docs/reviewing.md)，**评审前必读**。

### 2.1 协作偏好（用户观察所得）

- **串行推进**，不同时开太多分支
- **文档可追溯**：每阶段工作单 + 评审，结论要能追溯到证据
- **要求实测**，不接受「测试过了就行」；结论带数据（「实测通过」「独立验证 N 条」）
- 中文交流，界面文案用中文短句
- 用户会自己动手验证，问题描述得很细——**描述里的现象优先于我们的假设**

---

## 3. 工作流程

```text
① 评审方建 docs/phases/<NN>-<主题>/，写 handoff.md
    - 边界（做什么 / 不做什么）
    - 硬约束（踩了就返工）
    - 易错点
    - 验收标准
    - 测试清单

② GLM 从最新 main 建分支实现
    - 做完就停，不自行扩大范围

③ 评审方评审
    - 独立验证（不看 GLM 的断言，自己写）
    - 写同目录的 review.md
    - 通过则合并，不通过则打回

④ 合入 main（按 docs/README.md §4 更新索引），删除分支，跑全量测试
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

> 这里是**速查表**。每条约束的「为什么 + 谁在哪一轮踩的」见 [`docs/architecture/constraints.md`](docs/architecture/constraints.md)。

### 4.1 棋类侧

| 约束 | 原因 |
|---|---|
| `GameStatus` 只有 `idle/playing/finished` | MCP 契约 + 365 个测试依赖 |
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

落盘位置固定为 `<repo>/data/{rooms,chat,archive}`——锚在代码文件位置，**与启动目录无关**；启动日志会打印实际路径。要换位置只设 `ARENA_DATA_DIR`，别靠切 cwd。

### 5.3 双端口：改后端 + 同时要用 DSH 对局时

⚠️ 双端口模式没有 Vite，3100 服务的是 `web/dist/`（改前端还是用 `pnpm dev`）。命令和取舍见 [`docs/dev-workflow.md`](docs/dev-workflow.md) §2–3。

### 5.4 常用命令

```powershell
pnpm build        # 全量构建（shared + server + web）
pnpm test         # 全量测试（当前 365，含一个 spawn 真实进程的 e2e，约 17s）
pnpm typecheck    # 类型检查
pnpm start        # 生产模式起服务（读 dist/，改完必须 build）
pnpm duel         # 两个脚本客户端下一盘五子棋（协议层自测）
```

⚠️ **`pnpm start` 读 `dist/`，改完 server 代码必须 `pnpm build` 再重启。**

---

## 6. 评审方怎么验证

已挪到 [`docs/reviewing.md`](docs/reviewing.md)（§1 套路 · §2 坑表 · §3 脚本写法），**评审前必读**。

---

## 7. 设计原则（从实战学到的）

> 每条的「当时放弃了什么、为什么」见 [`docs/architecture/decisions.md`](docs/architecture/decisions.md)。

### 7.1 工具给事实，模型做判断

`hotPoints` 给威胁点，`groups` 给气数，**不给「该逃该弃」的结论**。P2 复盘：信息给全了照样下错——那是模型能力问题，不是工具缺信息。**加工具补推理等于把竞技场变成演示。**

### 7.2 错误信息要可操作

报 `NOT_SCORING`（明确「现在是数子阶段」），不报 `GAME_NOT_PLAYING`；Session 404 带 hint（「轮到你了」「等 X 发言」）。

### 7.3 失败要可诊断

损坏的房间文件：跳过、记日志、**留在磁盘**（覆盖会销毁证据）。校验失败：**报错**，不要静默回退默认值（policy bug 就是这么来的）。

### 7.4 兼容优先

新功能 opt-in，旧路径行为不变；类型只增字段，不改名。

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
