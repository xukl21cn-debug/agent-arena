# @arena/runner

本机工作域执行器。它不是 agent，不负责推理和任务决策：它作为 `worker` 连接 `/work/mcp`，领取任务，启动或续接 agent CLI，把结构化结果写回工作域。

P1 只支持 DSH headless，单进程、单任务顺序执行。

## 启动

1. 启动 arena server（`pnpm dev` 或 `pnpm start`）。
2. 在仓库根复制配置模板并修改：

   ```bash
   cp runner/runner.config.example.json runner.config.json
   ```

   `workspace` 必须与服务端 `ARENA_WORK_WORKSPACE` 指向同一个目录。相对路径按配置文件所在目录解析。
3. 启动 runner：

   ```bash
   pnpm runner -- --config runner.config.json
   ```

   `pnpm runner` 会先构建 `shared` 和 `runner`，然后从仓库根启动 `runner/dist/index.js`，所以默认工作区就是仓库根。

启动后打开 `/runners` 查看在线状态、当前任务与最近事件；runner 不在线时页面仍可打开，命令会留在服务端队列里，等它重连后生效。

## 配置

```json
{
  "id": "runner-local",
  "serverUrl": "http://127.0.0.1:3000",
  "name": "runner-dsh",
  "workspace": ".",
  "stateFile": ".arena-runner/state.json",
  "waitTimeoutMs": 20000,
  "heartbeatIntervalMs": 5000,
  "dsh": {
    "command": "dsh",
    "argsPrefix": [],
    "profile": "headless",
    "permissionMode": "workspace-write",
    "approvalPolicy": "never",
    "extraDirs": [],
    "timeoutMs": 1800000
  }
}
```

- `id` 是管理接口里的稳定标识；省略时按 `name` 生成稳定短哈希。同 `id` 重连会覆盖旧心跳，不会新建重复实例；server 重启清空注册表后，运行中的 runner 会在下次心跳时自动重新注册。
- `heartbeatIntervalMs` 是注册表心跳间隔，页面用它在 `/runners` 显示在线/离线。
- `stateFile` 记录任务轮次与 DSH `sessionId`，用于避免重复执行；它属于本地状态，不提交。
- `dsh.command` 在 Windows 默认解析为 `dsh.cmd`，也可以写绝对路径；配置里写 `dsh` 也会在 Windows 归一为 `dsh.cmd`。
- 首轮从 `--json` 的 `session` 事件自动创建并记录会话 ID；同一任务的返工轮会沿用该任务之前的 DSH 会话。
- 模型凭据由 DSH 自己读取：启动环境、会话工作目录的 `.env`，或 `$DSH_HOME/.env`；runner 不保存凭据。
- `permissionMode` 默认 `workspace-write`；无人值守时 `approvalPolicy` 默认 `never`。需要额外可写目录时用 `extraDirs`。
- 如果 Windows 上 DSH 报 `windows-acl workspace grant failed ... grantWrite(...)`，是 DSH 的 workspace-write 授权在工作区根目录上失败。常见原因：工作区所在的盘只给当前用户「修改」权限（非系统盘的默认设置就是这样），而授权时要写完整性标签，需要「完全控制」。修法是给工作区根目录补上当前用户的完全控制——DSH 自带的 `diagnose-windows-sandbox-acl` 脚本一条命令完成诊断、修复，并生成恢复脚本。`"permissionMode": "danger-full-access"` 只是放弃文件沙箱的临时绕行，链路通了就应改回去。

## 结果约定

DSH 的最终回复最后必须包含一个 ```arena-result 代码块：

```json
{
  "summary": "做了什么、测试结果、已知缺口",
  "files": ["相对工作区的文件路径"],
  "commits": ["7-64 位十六进制提交号"],
  "tests": [{ "command": "pnpm test", "outcome": "passed" }],
  "docs": [],
  "unresolved": "仅当受阻时填写"
}
```

`commits` 与 `unresolved` 至少填一项。无法解析时 runner 会把最终回复作为 summary，并填写 `unresolved`，任务仍进入 `pending_review` 供统筹核对。

## 当前范围

- 任务/会话绑定与重复执行保护：本地 `stateFile`（原子写、损坏文件保留为 `.corrupt-*`）。
- 执行中的租约续期：按 claim 剩余有效期的一半调用 `renew_claim`。
- 重启恢复、超时/取消、失败回报的完整流程在 P3；P1 遇到上次未完成的 `running` 记录会拒绝重复启动，等待后续阶段的接管流程。runner 与 server 断线后的自动重连也留到 P3。
- `runner/test/` 的 wire/e2e 测试会引用 `server/src` 作为本地测试夹具；`runner/src` 的生产代码只依赖 `@arena/shared` 和 MCP 客户端。
