# 开发流程

> 结论先放这里：**日常用 `pnpm dev`**。双端口脚本只在「改后端同时要保住 DSH 会话」时才用。
>
> 最后更新：2026-10-26（实测后修正，此前文档夸大了双端口的必要性）

---

## 1. 日常开发：`pnpm dev`

```powershell
cd E:\code\fun\agent-arena
pnpm dev
```

它起三个进程：

| 进程 | 端口 | 作用 |
|---|---|---|
| `shared` | — | `tsc --watch`，改 `shared/` 自动重编译 |
| `server` | **3000** | `tsx watch`，改 `server/` 自动重启 |
| `web` | **5173** | Vite dev server，proxy 到 3000 |

**网页打开 http://127.0.0.1:5173**（不是 3000）。

### 1.1 改不同类型代码的影响（实测）

| 你改了什么 | 会发生什么 | 对局 | DSH 会话 |
|---|---|---|---|
| **`web/`** | Vite HMR，浏览器自动更新 | ✅ 不受影响 | ✅ 不受影响 |
| **`shared/`** | 重编译，server 可能重启 | ✅ 持久化恢复 | ⚠️ 可能断 |
| **`server/`** | `tsx` 重启进程 | ✅ **持久化恢复** | ❌ **断** |

**关键：P3.5 的持久化让对局在 server 重启后自动恢复。** 实测：

```text
1. 开围棋局，落一子（moves=1，黑子在 (4,4)）
2. 改 server/src/config.ts 一行
3. tsx watch 重启进程
4. 查询对局 → moves=1，黑子还在 (4,4)   ✅ 没丢
```

**所以 `pnpm dev` 下改后端，丢的只是 MCP 会话，不是对局。**

---

## 2. 什么时候需要双端口

只有一种情况：**改后端，同时要保住 DSH 的 MCP 会话**。

因为 MCP 客户端在**连接那一刻**抓取工具清单，之后不会自己更新（见 §4）。
`tsx watch` 一重启，会话就没了，DSH 必须新开会话。

如果此时你正在用 DSH 下棋/聊天，重开会话会打断它。

**双端口就是为这个场景准备的：**

```powershell
# 对局服务（3000）不动
pwsh -File scripts/dev-isolated.ps1 -Only live

# 开发服务（3100）随便重启
pnpm build
pwsh -File scripts/dev-isolated.ps1 -Only dev
```

| 端口 | 用途 | 数据目录 |
|---|---|---|
| 3000 | 对局（**改代码期间不碰**） | `data/` |
| 3100 | 开发（随便重启） | `data-dev/` |

其他用法：

```powershell
pwsh -File scripts/dev-isolated.ps1            # 两个都起
pwsh -File scripts/dev-isolated.ps1 -Stop      # 都停
pwsh -File scripts/dev-isolated.ps1 -DevPort 3200
```

⚠️ **双端口模式下没有 Vite**——3100 服务的是 `web/dist/` 的构建产物。
改前端还是用 `pnpm dev`。

---

## 3. 怎么选

```text
改前端？                    → pnpm dev（HMR 无可替代）
改后端 + 不用 DSH 对局？     → pnpm dev（对局会恢复）
改后端 + 正在用 DSH 对局？   → 双端口
改工具清单？                → 都要重开会话，见 §4
```

---

## 4. MCP 会话为什么必须重开

这是 MCP SDK 的硬事实，不是我们的实现问题。

### 4.1 实测证据

```text
1. 客户端连上，拿到 tools=[tool_one]
2. 杀掉服务端
   → transport.onerror: SSE stream disconnected
   → transport.onclose 从未触发        ← 关键
3. 用 tools=[tool_one,tool_two,tool_three] 重启服务端
   → 客户端仍在用旧 sessionId 重试
   → 拿到 404，无限重试
   → FINAL tools=[tool_one]            ← 永远看不到新工具
```

### 4.2 三个查证过的死路

| 方案 | 为什么不行 |
|---|---|
| 会话存盘 | SDK 明说 `State is maintained in-memory (connections, message history)` |
| 服务端接受旧 sessionId | 客户端拿旧 id 发的是 `tools/call`，不是 `initialize`，没会话处理不了 |
| `tools/list_changed` 通知 | ✅ **确实有效**（实测通过），但只在**同一进程内**加工具时有用；重启进程就没意义 |

### 4.3 所以

| 你改了什么 | 重开 DSH？ |
|---|---|
| **工具清单**（加/删工具、改参数、改描述） | ✅ **必须** |
| 业务逻辑（工具签名不变） | ❌ 不用 |
| 前端 / 数据模型 / 持久化 | ❌ 不用 |

**判断方法：看 `server/src/mcp/tools.ts` 有没有变。**

---

## 5. 常见问题

### 5.1 `pnpm dev` 起来了但网页打不开

网页在 **5173**，不是 3000。3000 是 API/MCP。

### 5.2 改了 server 代码但行为没变

`tsx watch` 只监听 `server/src/`。如果改的是 `shared/`，要等 `tsc --watch` 编译完
（日志会有 `Found 0 errors`）。

### 5.3 `pnpm start` 和 `pnpm dev` 的区别

| | `pnpm start` | `pnpm dev` |
|---|---|---|
| 读什么 | `dist/`（构建产物） | `src/`（直接跑 TS） |
| 改代码后 | **必须 `pnpm build` 再重启** | 自动 |
| 前端 | 3000 服务 `web/dist/` | 5173 Vite |
| 适合 | 长期跑、给 DSH 用 | 开发 |

### 5.4 端口被占

```powershell
pwsh -File scripts/dev-isolated.ps1 -Stop    # 停 3000/3100
# 或手动
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### 5.5 数据在哪

| 启动方式 | 数据目录 |
|---|---|
| `pnpm dev` / `pnpm start`（仓库根） | `<repo>/data/` |
| `dev-isolated.ps1` live | `<repo>/data/` |
| `dev-isolated.ps1` dev | `<repo>/data-dev/` |
| 从 `server/` 目录直接 `node dist/index.js` | `server/data/` |

都在 `.gitignore` 里。

---

## 6. 相关文件

| 文件 | 内容 |
|---|---|
| `scripts/dev-isolated.ps1` | 双端口启停（备选方案） |
| `AGENTS.md` §5 | 开发环境速查 |
| `AGENTS.md` §8 | MCP 的硬事实 |
