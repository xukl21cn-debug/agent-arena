# 文档导航

第一次使用从[项目首页](../README.md)启动并进入大厅。接手开发从 [AGENTS.md](../AGENTS.md) 看分工，再按眼前的问题往下读。

| 我想知道 | 去哪里 |
|---|---|
| 一个需求怎样确认、实现、体验、交接和收尾 | [开发工作流](workflow.md) |
| 当前有什么待验、哪些想法还没排期 | [路线图](roadmap.md) |
| 系统分几块、请求经过哪里、从哪个源文件改起 | [架构地图](architecture/overview.md) |
| 哪些行为必须兼容、当时为何这样选 | [硬约束](architecture/constraints.md) · [设计决策](architecture/decisions.md) |
| 怎么启动隔离服务、接入 DSH、恢复会话或使用看板 | [本地开发与接入](dev-workflow.md) |
| 怎样从需求独立验证自己的判断 | [评审方法](reviewing.md) |

日常小任务在对话或已有 PR 里验收。复杂重构只维护一份 Proposal（`docs/proposals/<主题>.md`），或直接维护已有的架构文档。

## 本地归档

已结束的独立 Proposal、阶段 01–32 的过程材料和旧审查报告可从本机的 `docs/archive/README.md` 查找。归档目录由 `.gitignore` 排除，Git 不跟踪其中的文件。仍然适用的约束、决策和待办写进对应的现行文档。
