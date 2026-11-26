# 看板派单与人工复审

**状态：实现完成，待独立评审/用户验收。** 分支：`feat/work-page-dispatch`。基线：`main` @ `63485bc`。

## 背景

工作域原先只能由 MCP 统筹会话 `create_task` / `submit_review`，网页只读。runner 让任务可以自动执行后，用户希望直接在 `/work` 看板派单和复审，不必再经过主 agent。

## 范围

- `/work` 新增「新建任务」对话框：标题、需求、分支、基线、验收标准、brief 路径/摘要；从 `GET /api/work/context` 预填当前分支和 HEAD。
- 网页以固定本地协调者身份（`w_human_0` / `看板用户`）创建任务，任务仍进入同一 `WorkStore`。
- `pending_review` 且协调者是看板用户时，任务详情显示「复审任务」：可「复审通过」或「要求返工」；服务端在 `POST /api/work/tasks/:id/review` 内部领取并提交 review claim。
- runner 继续作为 worker 自动领取；页面不启动/停止 runner 进程。

## 非目标

- 不改变工作域状态机、MCP 工具契约或任务存储格式。
- 不处理主 agent coordinator 创建的任务（页面不显示复审按钮，避免越权）。
- 不做多人协调者、任务草稿或附件上传。

## 验收条件

1. 没有 runner 时创建任务返回明确错误，页面不崩溃。
2. runner 在线时，从页面新建的任务进入 `queued`，随后被领取并进入 `working`。
3. 任务进入 `pending_review` 后，页面能提交「通过」或「返工」；通过后进入 `pending_ack`，返工后进入下一轮。
4. 既有 `/work` 任务列表、状态徽标、合并确认和主 agent 工作流不回归。

## 实现记录

| 项目 | 内容 |
|---|---|
| 提交 | `10f40a4`（页面派单/复审）、`d3384ec`（复审前预检） |
| 测试 | server 37 文件 / 480 测试，runner 8 文件 / 33 测试 |
| 已知缺口 | 看板派单固定使用本地人类 coordinator；主 agent 的 coordinator 任务不能从页面复审 |
| 审核结论 | 待独立评审 |
