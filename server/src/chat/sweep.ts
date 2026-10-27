import type { ChatManager } from './manager.js';

/**
 * How often expired chat turn leases are settled without anyone touching
 * the room. 15s, same cadence as the presence sweep: dense enough that a
 * 120s lease settles within ~135s of going dead, sparse enough not to
 * churn every room for nothing.
 */
export const CHAT_SWEEP_MS = 15_000;

/**
 * The background lease pass: every CHAT_SWEEP_MS, settle expired turns in
 * every room. Settlement is deliberately lazy inside ChatRoom — a domain
 * object owns no clock — so when the last participant walks away, nothing
 * fires on its own; this timer is the only thing that closes that hole.
 *
 * Lives in its own module (not inline in index.ts) only so the wiring is
 * importable by tests: index.ts has side effects on import, and "the timer
 * is unref'd" / "clearInterval really stops it" are exactly the two things
 * a forgotten line would silently break. The timer is unref'd like the
 * presence sweep — a housekeeping timer must never hold the process open.
 */
export function startChatSweep(chat: ChatManager): NodeJS.Timeout {
  const timer = setInterval(() => chat.sweep(Date.now()), CHAT_SWEEP_MS);
  timer.unref();
  return timer;
}
