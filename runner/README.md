# @arena/runner

本机工作域执行器。它不是 agent，不负责推理和任务决策：它作为 `worker` 连接 `/work/mcp`，领取任务，启动或续接 agent CLI，把结构化结果写回工作域。

目前只支持 DSH headless，单进程、单任务顺序执行；多客户端与并发留给后续阶段。

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

启动后打开 `/runners` 查看在线状态、当前任务与最近事件；runner 不在线时页面仍可打开，命令会留在服务端队列里（每个 runner 最多 100 条），等它重连后生效。

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

## 可靠性

- **任务与会话的绑定**：本地 `stateFile` 原子写，损坏的文件保留为 `.corrupt-*`；每条运行记录带 runner 进程的实例标识。已结束的记录只留最近 100 条。
- **租约续期**：执行期间按 claim 剩余有效期的一半调用 `renew_claim`。
- **重启恢复**：启动时和每轮轮询前，先补交没交出去的结果，再逐条核对上一个进程留下的 `running` 记录。上一个进程启动的 DSH 如果还在运行，先结束它——进程号记在状态文件里，只有命令行带着启动参数、且启动它的进程已经不在时才会动手。然后认领仍有效就用原来的 DSH 会话续跑，并在提示词里告诉模型上次被中断；已过期则记为中断，向 `/runners` 发一条事件，等人在工作页「继续本轮」或取消。续跑不回滚工作区。
- **结果不丢**：回报先写进状态文件再提交。连不上时当场快速重试 3 次，仍不行就留到下一轮；服务端回答「认领已失效」才放弃，其它回答连续被拒 5 次才停。同一认领的重复提交在服务端是幂等的。身份丢失或角色被别人占着不算被拒。
- **断线重连**：server 重启后 MCP 会话失效，runner 自动换新会话并按原名重新加入，同一时刻只重连一次。会话还在但没加入时也会重新加入再重试，重新加入被拒不会让它停在那里。
- **空闲时被杀不留后患**：runner 轮询等待时连接断开，服务端会立刻结束那次等待，下一个任务不会发给已经不存在的会话。
- **取消**：工作页的「取消任务」把任务置为已取消，并让正在执行它的 runner 终止进程。runner 在开始和结束一轮时会立刻心跳，所以刚领到任务就取消也来得及。runner 只执行任务号对得上的 cancel 命令，`/runners` 页的取消同样如此。被取消的那一轮不会再向服务端提交结果。
- **事件**：领取、续跑、完成、超时、被取消、失败、放弃提交都报到 `/runners` 的最近事件；有待接管任务挡住接单时只报一次。
- **命令**：游标带服务端注册表的代次，server 重启后从头读取，不会吞掉新命令。

## 限制

- 单 runner、单任务：一个 `needs_attention` 任务会挡住后面的任务，直到被继续、接管或取消。
- 进程的启动与停止仍由用户负责；DSH 会话能否续接取决于被杀时它是否已经落盘。
- `runner/test/` 的 wire/e2e 测试会引用 `server/src` 作为本地测试夹具；`runner/src` 的生产代码只依赖 `@arena/shared` 和 MCP 客户端。
