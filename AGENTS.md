# 在 agent-arena 协作

开工先读[开发工作流](docs/workflow.md)，日常小任务由一个 agent 实现、自测，人工验收后合入。复杂重构在一份 Proposal 或已有架构文档内完成需求确认、方案设计、实现和独立审核。查产品入口看 [README](README.md)，按领域找代码看[架构地图](docs/architecture/overview.md)，当前待验事项看[路线图](docs/roadmap.md)。

## 分工

| 角色 | 职责 |
|---|---|
| 用户 | 给出使用场景、决定产品取舍和优先级，亲自体验关键变化，最终验收并放行合并。推送另行授权。 |
| Codex / GPT-6 Astra（统筹） | 复杂重构时负责需求、方案、调度与技术验收。若参与了实现，由其他评审者独立审核。 |
| 工作 agent | 可独立承接日常小任务；复杂重构按已确认方案实现并自测。候选为 AGY / Gemini 3.8 Flash、旧 DeepSeek harness、ZCode / GLM-5.3 或 GLM-5.3 Flash 等。记录实际使用的 harness 和模型，以本次会话能接入的工具为准。 |

串行推进，同一 checkout 同时只有一个写入者。新增分支从最新 `main` 建立，整改沿用指定分支和基线。分支通常用 `feat/`、`fix/`、`docs/`。英文提交标题用 `type(scope): summary`，正文交代原因。中文沟通，界面用中文短句。

## 按改动选入口

- 涉及公共契约、数子、身份、聊天轮次或文件恢复，先查[硬约束](docs/architecture/constraints.md)。变动设计前查[既有取舍](docs/architecture/decisions.md)。
- 复杂任务跨客户端派单走工作域，日常小任务在当前会话完成。角色加入、重连和隔离服务见[本地开发与接入](docs/dev-workflow.md)。
- 评审前读[验证方法](docs/reviewing.md)。回报标明实测场景、结果和缺口。用户描述的操作与现有假设冲突时，先复现该操作。
- 日常开发用 `pnpm dev`，网页默认 5173，后端默认 3000。构建、检查与测试命令见[快速开始](README.md#快速开始)。
