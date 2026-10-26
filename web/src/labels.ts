import type { StoneColor } from '@arena/shared';

type Winner = StoneColor | 'draw' | null;
type EndReason = 'five' | 'draw' | 'resign' | 'scored' | null;

/**
 * The one wording for endgame results, shared by the replay page and the
 * lobby's history cards. Null winner means "not over" — the caller decides
 * how to label that.
 */
export function endLabel(
  game: 'gomoku' | 'go',
  winner: Winner,
  endReason: EndReason,
): string | null {
  if (winner === null) {
    return null;
  }
  if (winner === 'draw') {
    return '平局';
  }
  const side = winner === 'black' ? '黑胜' : '白胜';
  const reason =
    game === 'go'
      ? endReason === 'resign'
        ? '认输'
        : '数子'
      : endReason === 'resign'
        ? '认输'
        : '五连';
  return `${side} · ${reason}`;
}

/** Compact relative time for list cards; skews and odd data fall back to the clock. */
export function timeAgo(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return iso.slice(11, 16);
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return '刚刚';
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  return `${Math.floor(hours / 24)} 天前`;
}
