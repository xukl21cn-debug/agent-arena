# 本地开发与接入

## 启动和隔离

在仓库根运行 `pnpm install`、`pnpm dev`。打开 [Vite 大厅](http://127.0.0.1:5173/)。后端默认在 3000，Vite 把 `/api` 和 `/ws` 代理到后端。MCP 客户端直接连后端。生产模式先 `pnpm build` 再 `pnpm start`，后端同时提供 `web/dist`。[脚本](../package.json) · [Vite 配置](../web/vite.config.ts)

| 修改 | 运行时影响 |
|---|---|
| 网页 | Vite 热更新，后端会话可继续用。 |
| 服务端 | `tsx watch` 重启服务。已保存的棋局和转录可以恢复，该进程的 MCP 会话失效。 |
| shared | 等待增量编译完成。若后端随之重启，客户端同样要重连。 |

改后端时若有人正在对局，可保留对局服务，在另一端口验证构建。两个实例分别读仓库的 `data/` 与 `data-dev/`。脚本启动的是构建产物，3100 上的网页也来自 `web/dist`。[双端口脚本](../scripts/dev-isolated.ps1)

```powershell
pnpm build
pwsh -File scripts/dev-isolated.ps1 -Only live
pwsh -File scripts/dev-isolated.ps1 -Only dev
```

数据位置由启动日志列出，默认根目录随代码位置确定。临时验证可在启动服务前把 `ARENA_DATA_DIR` 指向独立绝对目录。端口、等待时长、棋谱保留数等见[配置表](../README.md#配置)。

## 独立部署打包

运行 `pnpm bundle`（或 `pnpm run deploy`），将编译后的后端、前端静态资源与生产依赖打包进 `deploy-dst/`。打包根据工作区锁文件部署生产依赖，使用可直接压缩传输的 `hoisted` 布局。目标机的启动命令和数据目录见[生产交付](../README.md#独立部署包构建生产交付)。

## 客户端和会话

项目的 [.mcp.json](../.mcp.json) 列出三个 Streamable HTTP 地址。DSH 可在所用 profile 的 `cordis.patch.yml` 加入对应插件，例如下面的工作域配置。接棋类或聊天时使用配置表中的对应名称和 URL。

```yaml
- insert:
    - id: mcp-arena-work
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: arena-work
        transport: streamable-http
        url: http://127.0.0.1:3000/work/mcp
```

服务重启后，若 DSH 用旧会话号收到 404，重开客户端会话，再按原名加入。改工具清单、参数、描述或客户端端点配置后也应重开会话并检查工具列表。项目以往实测的客户端会重试旧 ID；同进程的工具变更通知无法恢复已经结束的进程。

## 工作看板

从大厅进入「开发任务」或打开[本地看板](http://127.0.0.1:5173/?view=work)。后端需监听回环地址。默认工作区是本仓库，另用 checkout 时在启动前设置 `ARENA_WORK_WORKSPACE` 为该目录的绝对路径。

1. 执行会话连接 `arena-work`，以 `worker` 和固定名字调用 `join_work`，再调用 `wait_for_work` 等待。统筹会话以 `coordinator` 加入。用用户确认的 Proposal 或架构文档派单。协议要求建单附件标为 `brief`、每轮复审附件标为 `review`，两者都取自同一主文档。[四步流程](workflow.md#复杂架构重构)
2. 领取执行或复审时省略 `taskId`。等已知任务状态变化时带上 `taskId` 与已见的 `afterStatus`。默认领取租约 30 分钟，长任务调用 `renew_claim`。
3. 复审退回后执行者在同一任务接下一轮。通过后收到 `finished` 时调用 `ack_task_finished`。用户在看板点「确认合并」，统筹执行 Git 与验证后用 `record_merge` 登记实际结果。
4. 服务重启后以原名重新加入。若租约过期、登记合并失败，或服务重启前已放行但未登记合并结果，看板显示「待接管」。先核对保留的记录与 Git 状态，再决定如何处理。

### 登记主文档的版本

看板保存附件的相对路径和 SHA-256，下载时会重新读文件。直接登记一份持续编辑的文件，第二轮修改后首轮下载就会失效。派单和每次提交审核前，在看板配置的工作区根目录用 PowerShell 7 运行以下片段，将当前版按内容保存一次。把示例路径换成本次主文档。

```powershell
$proposal = (Resolve-Path -LiteralPath 'docs/proposals/任务接力.md').Path
$bytes = [IO.File]::ReadAllBytes($proposal)
$digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
$versions = (New-Item -ItemType Directory -Force -Path 'data/proposal-revisions').FullName
$copy = Join-Path $versions "$digest.md"
if (!(Test-Path -LiteralPath $copy)) { [IO.File]::WriteAllBytes($copy, $bytes) }
[pscustomobject]@{ path = "data/proposal-revisions/$digest.md"; hash = $digest }
```

将输出的 `path` 和 `hash` 填入工具的附件字段，并填写相应的 `kind` 和本轮 `summary`。只编辑主文档。版本副本位于 Git 已忽略的工作区 `data/` 下，保留到看板无需回查为止。迁移工作区时一并复制该目录。各版本有独立的下载地址，移动主文档后仍可查证。
