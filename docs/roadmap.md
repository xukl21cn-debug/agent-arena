# 当前状态与候选方向

## 正在验什么

2026-11-19 的本地基线为 `main@570408a`。当前分支 `codex/project-refactor@70a38ab` 已把开发交接集中到工作域，聊天室保留群聊。看板、多轮返工、收工确认和用户放行已有实现与试跑记录，**阶段 32 仍待独立评审和用户放行**。原生 Codex 与 DSH 走通了返工、确认和看板放行，在隔离仓库执行 Git 写入时受阻。成功的合并证据来自另一轮 SDK 与浏览器试跑。[需求与验收场景](archive/phases/32-work-relay/brief.md) · [实现方核验](archive/phases/32-work-relay/review.md) · [历史试跑](archive/phases/32-work-relay/run.md)

## 下一次产品反馈

先从大厅进入开发任务看板，用一次确实需要跨客户端交接的重构验证三件事：用户能否看懂为什么退回，执行者能否直接收到意见，放行后能否查到合并提交和验证结果。先记录体验与阻塞，再由用户决定下一项。

## 尚未排期

- **历史遗留问题。** 原审查表中 S-08～S-10、W-08～W-11、W-13 共八项标为待处理。W-04 的浏览器合成事件已验，真实系统输入法仍待体验。选中某项时先在当前版本复现。[缺陷编号与原始描述](archive/code-review.md) · [复审范围](archive/phases/24-final-fix-review/review.md)
- **聊天提示词。** 若仍观察到成员想让出轮次却没有调用 `pass_turn`，用真实客户端比较提示调整前后的实际调用。[现场观察](archive/phases/17-chat-pass-turn/observation.md)
- **runner 与更多聊天模式。** 若停车收件无法满足真实使用，再评估 runner 或会话续接。若轮流发言确实限制讨论，再评估 `mentions` 或 `free` 模式。[协作原提案](archive/proposals/agent-collaboration.md) · [聊天模型](../server/src/chat/model.ts)

过去的 P/M/G 编号、依赖顺序和完成记录保存在[历次规划](archive/roadmap-to-phase-32.md)。
