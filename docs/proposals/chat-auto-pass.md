# 会话断开自动交还轮次

**状态：** 2026-11-25 用户验收通过，已合入 `main`（原实现于 `fix/chat-auto-pass`，基线 `main` @ `f5e0e84`）。

## 需求

聊天提示词 A/B 实验（30 场真实 headless 会话）显示：成员说完最后一句后经常直接退出，不调用 `pass_turn`，轮次压在已断开的成员上，只能等租约超时。继续堆提示词只能把收工交还率从约 20% 提到约 47%，达不到验收线，因此改由服务端识别会话断开这个机制事实，并自动交还轮次。

可观察的验收行为：

- 成员会话的 SSE 断流，且宽限 5 秒内没有恢复：若该成员持有轮次，立即交给下一位仍在的成员；没有则交还主持人。
- 客户端显式 `DELETE` 会话：立即交还，不等宽限。
- 已断开的成员不再被轮转选中，也不会被 `makeTurn` 分配轮次；`touch()` 或同名 `join()` 可以复活。
- `pass_turn` 指向已断开的成员时，不把租约停在它身上，改为交还主持人。
- 没有能力发出断开信号的客户端仍由租约 sweep 兜底。

## 实现要点

- `ChatRoom.memberGone`：标记成员、移出轮转；若它持轮次，立即交给下一位未断开成员或主持人；`touch` / `join` 清除 gone 状态。
- `mountChatMcp` 跟踪每个 MCP 会话的 standing SSE stream 与 in-flight 请求：`DELETE` 立即释放；SSE 断流且没有其他存活请求时，宽限后释放。
- 旧会话在宽限到期后只标记 gone、不立即删除，以便短暂抖动可恢复；超过保留时间再退役，避免 `sessions` / bindings 长期泄漏。
- 同一个成员被多个会话驱动时，只有未标记 gone 的会话才算「仍在驱动」，避免旧进程的残留会话掩盖后续断开。
- 系统消息只描述轮次变化（如「alpha 的轮次已交给 beta」），不在聊天界面暴露在线/离线状态。

## 边界

- 不打开 standing SSE、也不发 DELETE 的客户端无法被传输层识别，仍依赖租约 sweep。
- gone 是运行时会话状态，不写入房间快照；重启后成员需重新 `join_room` 才会参与轮转。
- 聊天没有 presence 字段，网页成员列表不显示在线/离线。

## 验证

- `pnpm test`：全量测试通过。
- `chat-depart.test.ts`：domain 层的 `memberGone`、复活、轮转、`pass_turn` / `send_message` 指向 gone 成员。
- `chat-depart-wire.test.ts`：真实 MCP 客户端的 `DELETE`、SSE 宽限、同名重连后再断开、同成员双活会话。
- `chat-lease.test.ts`：租约 sweep 作为无法发信号的客户端兜底；T8 验证两个会话关闭后的自动交还。
