import type {
  GameState,
  OpponentStatus,
  ParticipantView,
  StoneColor,
} from '@gomoku/shared';
import { opponentStatus } from '@gomoku/shared';
import { SeatBadge } from './SeatBadge';

interface StatusBarProps {
  state: GameState | null;
  humanColor: StoneColor | null;
  agentColor: StoneColor | null;
  /** Both seats are agents: this tab is watching, not playing. */
  spectator: boolean;
  participants: ParticipantView[];
}

interface StatusCopy {
  title: string;
  detail: string;
  turn: StoneColor | null;
}

/** Extra line explaining a game that is waiting on nobody. */
const OPPONENT_NOTES: Partial<Record<OpponentStatus, string>> = {
  offline: 'AI 还没有接入，检查 MCP 配置',
  disconnected: 'AI 已断开，可以继续等待或认输重开',
};

function describe(
  state: GameState | null,
  humanColor: StoneColor | null,
  opponent: OpponentStatus,
  spectator: boolean,
): StatusCopy {
  if (!state || state.status === 'idle') {
    return spectator
      ? {
          title: '观战中',
          detail: '等待两个 AI 开始对局',
          turn: null,
        }
      : {
          title: '还没有开局',
          detail: '选一边坐在棋盘前，AI 会通过 MCP 接入',
          turn: null,
        };
  }

  if (state.status === 'playing') {
    const side = state.turn === 'black' ? '黑棋' : '白棋';
    if (spectator) {
      return {
        title: `轮到${side}`,
        detail: `第 ${state.moveCount + 1} 手 · 观战中`,
        turn: state.turn,
      };
    }
    if (state.turn === humanColor) {
      return {
        title: '轮到你了',
        detail: `第 ${state.moveCount + 1} 手 · ${side}`,
        turn: state.turn,
      };
    }

    // It is the agent's turn. Say so only when it can actually act; otherwise
    // name the problem, because "AI 正在思考" for an absent agent is a lie.
    const note = OPPONENT_NOTES[opponent];
    return {
      title:
        opponent === 'thinking'
          ? 'AI 正在思考'
          : opponent === 'disconnected'
            ? 'AI 已断开'
            : 'AI 未接入',
      detail: note ?? `第 ${state.moveCount + 1} 手 · ${side}`,
      turn: state.turn,
    };
  }

  const draw = state.winner === 'draw';
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

  if (spectator) {
    return {
      title: draw
        ? '和棋'
        : state.winner === 'black'
          ? '黑方获胜'
          : '白方获胜',
      detail: `${reason} · 共 ${state.moveCount} 手`,
      turn,
    };
  }

  const humanWon = state.winner === humanColor;
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
  spectator,
  participants,
}: StatusBarProps) {
  const agent = participants.find((item) => item.seat === agentColor) ?? null;
  const human = participants.find((item) => item.seat === humanColor) ?? null;
  const black = participants.find((item) => item.seat === 'black') ?? null;
  const white = participants.find((item) => item.seat === 'white') ?? null;

  const opponent = opponentStatus(agent, {
    playing: state?.status === 'playing',
    isOpponentTurn: state?.status === 'playing' && state.turn === agentColor,
  });
  const { title, detail, turn } = describe(
    state,
    humanColor,
    opponent,
    spectator,
  );

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
        {spectator ? (
          // Both seats are agents: show each one's name and presence instead
          // of the human/agent pair, which would render two empty badges.
          <>
            <SeatBadge participant={black} color="black" side="agent" />
            <SeatBadge participant={white} color="white" side="agent" />
          </>
        ) : (
          <>
            <SeatBadge participant={human} color={humanColor} side="human" />
            <SeatBadge participant={agent} color={agentColor} side="agent" />
          </>
        )}
      </div>
    </section>
  );
}
