import type {
  GameState,
  ParticipantView,
  PresenceState,
  StoneColor,
} from '@gomoku/shared';
import { SeatBadge } from './SeatBadge';

interface StatusBarProps {
  state: GameState | null;
  humanColor: StoneColor | null;
  agentColor: StoneColor | null;
  participants: ParticipantView[];
}

interface StatusCopy {
  title: string;
  detail: string;
  turn: StoneColor | null;
}

/** Presence of the side that is not to move, used to explain a stuck game. */
function opponentNote(
  state: GameState | null,
  humanColor: StoneColor | null,
  agentPresence: PresenceState | null,
): string | null {
  if (!state || state.status !== 'playing' || humanColor === null) {
    return null;
  }
  if (state.turn === humanColor) {
    return null;
  }
  if (agentPresence === 'unknown') {
    return 'AI 还没有接入，检查 MCP 配置';
  }
  if (agentPresence === 'disconnected') {
    return 'AI 已断开，可以继续等待或认输重开';
  }
  return null;
}

function describe(
  state: GameState | null,
  humanColor: StoneColor | null,
  agentPresence: PresenceState | null,
): StatusCopy {
  if (!state || state.status === 'idle') {
    return {
      title: '还没有开局',
      detail: '选一边坐在棋盘前，AI 会通过 MCP 接入',
      turn: null,
    };
  }

  if (state.status === 'playing') {
    const side = state.turn === 'black' ? '黑棋' : '白棋';
    const note = opponentNote(state, humanColor, agentPresence);
    return {
      title: state.turn === humanColor ? '轮到你了' : 'AI 正在思考',
      detail: note ?? `第 ${state.moveCount + 1} 手 · ${side}`,
      turn: state.turn,
    };
  }

  const draw = state.winner === 'draw';
  const humanWon = state.winner === humanColor;
  const reason =
    state.endReason === 'resign'
      ? '认输'
      : state.endReason === 'draw'
        ? '棋盘下满'
        : '五连';
  const turn =
    state.winner === 'black' || state.winner === 'white'
      ? state.winner
      : null;

  return {
    title: draw ? '和棋' : humanWon ? '你赢了' : 'AI 获胜',
    detail: `${reason} · 共 ${state.moveCount} 手`,
    turn,
  };
}

export function StatusBar({
  state,
  humanColor,
  agentColor,
  participants,
}: StatusBarProps) {
  const agentPresence =
    participants.find((item) => item.seat === agentColor)?.presence ?? null;
  const { title, detail, turn } = describe(state, humanColor, agentPresence);

  const human = participants.find((item) => item.seat === humanColor) ?? null;
  const agent = participants.find((item) => item.seat === agentColor) ?? null;

  return (
    <section className="status" aria-live="polite">
      <div className="status-main">
        {turn ? (
          <span className={`turn-stone turn-stone--${turn}`} aria-hidden="true" />
        ) : (
          <span className="turn-stone turn-stone--empty" aria-hidden="true" />
        )}
        <div className="status-copy">
          <h2 className="status-title">{title}</h2>
          <p className="status-detail">{detail}</p>
        </div>
      </div>

      <div className="seats" aria-label="对局双方">
        <SeatBadge participant={human} color={humanColor} side="human" />
        <SeatBadge participant={agent} color={agentColor} side="agent" />
      </div>
    </section>
  );
}
