import type { GameState, StoneColor } from '@gomoku/shared';

interface StatusBarProps {
  state: GameState | null;
  humanColor: StoneColor | null;
  agentColor: StoneColor | null;
}

interface StatusCopy {
  title: string;
  detail: string;
  turn: StoneColor | null;
}

function describe(
  state: GameState | null,
  humanColor: StoneColor | null,
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
    return {
      title: state.turn === humanColor ? '轮到你了' : 'AI 正在思考',
      detail: `第 ${state.moveCount + 1} 手 · ${side}`,
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

function seatLabel(
  side: 'human' | 'agent',
  color: StoneColor | null,
): string {
  const name = side === 'human' ? '你' : 'AI';
  if (color === 'black') {
    return `${name} · 黑`;
  }
  if (color === 'white') {
    return `${name} · 白`;
  }
  return name;
}

export function StatusBar({ state, humanColor, agentColor }: StatusBarProps) {
  const { title, detail, turn } = describe(state, humanColor);
  const playing = state?.status === 'playing';

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
        <span
          className={`seat ${playing && turn === humanColor ? 'is-active' : ''}`}
        >
          <i
            className={`seat-dot seat-dot--${humanColor ?? 'empty'}`}
            aria-hidden="true"
          />
          {seatLabel('human', humanColor)}
        </span>
        <span
          className={`seat ${playing && turn === agentColor ? 'is-active' : ''}`}
        >
          <i
            className={`seat-dot seat-dot--${agentColor ?? 'empty'}`}
            aria-hidden="true"
          />
          {seatLabel('agent', agentColor)}
        </span>
      </div>
    </section>
  );
}
