import { useState } from 'react';

/**
 * The room id, with a copy button.
 *
 * The id is the only address a room has: an MCP client joins by
 * `roomId`, and the display name is a label that is neither unique nor
 * resolvable. Handing that string to somebody is the whole point of the chip,
 * so it is one click away instead of a drag-select.
 */
export function RoomChip({ roomId }: { roomId: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(roomId);
      setState('copied');
    } catch {
      // The clipboard API needs a secure context; on a plain-http origin the
      // chip is still selectable, so say what happened instead of failing mute.
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2_000);
  };

  return (
    <span className="room-chip" title="房间号：通知 agent 时用这个">
      room / {roomId}
      <button type="button" className="room-chip-copy" onClick={() => void copy()}>
        {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制'}
      </button>
    </span>
  );
}
