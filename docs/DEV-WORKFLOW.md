# 开发流程：双端口隔离

> 解决的问题：改代码时不想打断正在进行的对局
> 脚本：`scripts/dev-isolated.ps1`

---

## 1. 为什么需要这个

MCP 客户端（DSH / Claude Code）在**连接那一刻**抓取工具清单，之后不会自己更新。

实测证据（`probe-client.mjs` + `probe-server.mjs`）：

```text
1. 客户端连上，拿到 tools=[tool_one]
2. 杀掉服务端
   → transport.onerror: SSE stream disconnected
   → transport.onclose 从未触发
3. 用 tools=[tool_one,tool_two,tool_three] 重启服务端
   → 客户端仍在用旧 sessionId 重试
   → 拿到 404，无限重试
   → FINAL tools=[tool_one]     ← 永远看不到新工具
```

**结论：服务端重启后，客户端必须重开会话才能拿到新工具。**

这不是我们实现的问题，是 MCP SDK 客户端的行为：
它只在传输层 `onclose` 时重连，而服务端返回 404 不触发 `onclose`。

---

## 2. 所以：双端口

```text
:3000   对局服务   ← 你下棋的地方，改代码期间不碰
:3100   开发服务   ← 随便重启，用来验证
```

两个服务：

- **独立进程**
- **独立数据目录**（`data/` vs `data-dev/`）
- **独立日志**（`live.log` / `dev.log`）

所以 3100 上怎么折腾，3000 的对局都不受影响。

---

## 3. 用法

```powershell
cd E:\code\fun\agent-arena

# 两个都起
pwsh -File scripts/dev-isolated.ps1

# 只起开发服务（对局服务已经在跑）
pwsh -File scripts/dev-isolated.ps1 -Only dev

# 只起对局服务
pwsh -File scripts/dev-isolated.ps1 -Only live

# 都停掉
pwsh -File scripts/dev-isolated.ps1 -Stop

# 换端口
pwsh -File scripts/dev-isolated.ps1 -LivePort 3000 -DevPort 3200
```

---

## 4. 推荐的工作流

```text
① 开局对弈
   pwsh -File scripts/dev-isolated.ps1 -Only live
   → 打开 http://127.0.0.1:3000 下棋

② 改代码（对局还在跑）
   编辑 server/src/...
   pnpm build

③ 在开发服务验证
   pwsh -File scripts/dev-isolated.ps1 -Only dev
   → 打开 http://127.0.0.1:3100 测试
   → :3000 的对局毫发无伤

④ 验证通过，通知 / 自己判断
   - 对局还没下完？等它下完
   - 或者这局不要了？直接切

⑤ 切换对局服务
   pwsh -File scripts/dev-isolated.ps1 -Stop    # 停掉两个
   pwsh -File scripts/dev-isolated.ps1           # 用新构建起两个
```

---

## 5. 什么时候必须重开 DSH 会话

这是关键判断表：

| 你改了什么 | 需要重开 DSH？ | 原因 |
|---|---|---|
| **工具清单**（加/删工具、改工具参数） | ✅ **必须** | 客户端缓存了旧清单 |
| **工具描述/instructions** | ✅ 必须 | 同上 |
| 业务逻辑（不改工具签名） | ❌ 不用 | 工具定义没变，只是后端行为变了 |
| 前端（web/） | ❌ 不用 | 浏览器刷新即可 |
| 数据模型、持久化 | ❌ 不用 | 不影响 MCP 契约 |

**判断方法**：看 `server/src/mcp/tools.ts` 有没有变。

---

## 6. 已知限制（改不了）

| 限制 | 原因 |
|---|---|
| 服务端重启 = 所有 MCP 会话失效 | 会话表在内存里 |
| 客户端不会自动重新握手 | SDK 客户端只重试旧 sessionId |
| 会话无法持久化 | SDK 明说：`State is maintained in-memory` |
| `tools/list_changed` 通知 | ✅ 有效，但只在**同一进程内**加工具时有用；重启就没意义了 |

---

## 7. 为什么不建议用 `pnpm dev`

`pnpm dev` 会跑 `tsx watch`，它**检测到文件变化就重启进程**。

实测：

```text
[probe] counter=12 pid=26884     ← 改文件前
[tsx] change in ./watch-probe.ts Restarting...
[probe] started pid=7324          ← 新进程，内存归零
[probe] counter=1 pid=7324
```

所以 `pnpm dev` 的问题不是「不热更新」，而是**热更新 = 重启进程 = 对局和会话全丢**。

如果你在 `pnpm dev` 下下棋，改一行代码对局就没了。

**用 `dev-isolated.ps1` 代替。**

---

## 8. 数据目录

| 服务 | 数据目录 | 说明 |
|---|---|---|
| live (:3000) | `data/`（或 `server/data/`，取决于启动位置） | 真实对局 |
| dev (:3100) | `data-dev/` | 测试数据，可以随便删 |

⚠️ **注意**：如果用 `pnpm start`（从仓库根）起，`process.cwd()` 是仓库根，数据落在 `data/`；
如果从 `server/` 起 `node dist/index.js`，落在 `server/data/`。

脚本统一用 `ARENA_DATA_DIR` 显式指定，避免歧义：

```text
live → <repo>/data
dev  → <repo>/data-dev
```

两个都在 `.gitignore` 里（`data/` 规则匹配任意层级，但 `data-dev/` 需要单独确认）。

---

## 9. 相关文件

| 文件 | 内容 |
|---|---|
| `scripts/dev-isolated.ps1` | 双端口启停脚本 |
| `docs/REVIEW-P4-C1.md` | 聊天室评审（含工具指纹的来龙去脉） |
| `docs/HANDOFF-TOOL-FP.md` | 工具指纹工作单（**已决定不做**，见下） |

---

## 10. 工具指纹：决定不做

原计划做「工具清单指纹 + 启动提示」，后来确认：

- `sendToolListChanged()` **确实有效**（实测通过，`autoRefresh: false` 也能触发 `onChanged`）
- 但只在**同一进程内**加工具时有用
- 我们的流程是「改代码 → 重启进程」，重启后旧会话已经死了，通知无处可发

**所以指纹的价值只剩「提示你该重开会话了」**，而这一点用第 5 节的判断表就够了：
**看 `tools.ts` 有没有变**。

如果以后真的需要（比如做进程内工具热替换），再捡起 `HANDOFF-TOOL-FP.md`。
