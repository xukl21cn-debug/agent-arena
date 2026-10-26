import type {
  AnyGameState,
  AnyMove,
  GameState,
  GoPassMove,
  GoState,
} from '@arena/shared';
import { applyMove, startGame } from './engine.js';
import { applyGoPass, applyGoPlacement, startGoGame } from './go-game.js';

/** One replay step: the state after `move`, or the opening when it is null. */
export interface ReplayFrame {
  index: number;
  state: AnyGameState;
  move: AnyMove | null;
}

/**
 * The history diverged from the rules (corrupt or foreign data). The move
 * number travels in the message — the caller reports it verbatim instead of
 * silently truncating to wherever the replay got stuck.
 */
export class ReplayError extends Error {
  constructor(
    readonly moveIndex: number,
    readonly code: string,
    message: string,
  ) {
    super(`replay diverged at move ${moveIndex}: ${code} — ${message}`);
    this.name = 'ReplayError';
  }
}

function isPass(move: AnyMove): move is GoPassMove {
  return (move as { kind?: unknown }).kind === 'pass';
}

/**
 * The move's own recorded index when there is one; disk data may be corrupt,
 * and the fallback (the frame it would occupy) still names the right spot.
 */
function moveIndexOr(move: AnyMove, fallback: number): number {
  return typeof move.index === 'number' ? move.index : fallback;
}

/**
 * Rebuild every intermediate state of a recorded game by re-running the real
 * engines move by move. No rules are reimplemented here — captures, ko,
 * suicide and five-in-a-row are whatever the engine says they are, which is
 * the whole point: a replay that agrees with the live game by construction.
 *
 * The opening state is rebuilt with the FINAL state's gameId and rules —
 * the starters generate a fresh gameId, and the frames must stay addressable
 * by the one the room archived. `now` is every move's own `at`, so frame
 * timestamps are the times the moves were actually played, not "now".
 *
 * frames[0] is the opening; frames[N] is after move N. A diverging history
 * throws {@link ReplayError} naming the move — never a silent truncation.
 */
export function buildReplay(
  final: AnyGameState,
  history: AnyMove[],
): ReplayFrame[] {
  const openedAt = history[0]?.at;
  const frames: ReplayFrame[] = [];

  let state: AnyGameState;
  if (final.game === 'go') {
    const goFinal = final as GoState;
    state = startGoGame(
      { roomId: final.roomId, version: 0 },
      goFinal.seats,
      { rules: goFinal.rules, gameId: final.gameId, ...(openedAt === undefined ? {} : { now: openedAt }) },
    );
  } else {
    const gomokuFinal = final as GameState;
    state = startGame(
      { roomId: final.roomId, version: 0, rules: gomokuFinal.rules },
      gomokuFinal.seats,
      {
        rules: gomokuFinal.rules,
        gameId: final.gameId,
        ...(openedAt === undefined ? {} : { now: openedAt }),
      },
    );
  }
  frames.push({ index: 0, state, move: null });

  for (const move of history) {
    const index = frames.length;
    let result;
    if (final.game === 'go') {
      // Runtime type checks stay even where types already narrow: history
      // comes off disk, where a "Move" can be missing anything.
      if (isPass(move)) {
        result = applyGoPass(state as GoState, move.color, move.at);
      } else if (
        typeof move.row !== 'number' ||
        typeof move.col !== 'number'
      ) {
        result = {
          ok: false as const,
          code: 'INVALID_REQUEST',
          message: 'go history holds a placement without coordinates.',
        };
      } else {
        result = applyGoPlacement(
          state as GoState,
          move.color,
          move.row,
          move.col,
          move.at,
        );
      }
    } else if (isPass(move) || typeof move.row !== 'number' || typeof move.col !== 'number') {
      // A pass or coordinate-less entry in a gomoku history is corruption,
      // not a rule question — the engine cannot judge it.
      result = {
        ok: false as const,
        code: 'INVALID_REQUEST',
        message: 'gomoku history holds a malformed move.',
      };
    } else {
      result = applyMove(
        state as GameState,
        move.color,
        move.row,
        move.col,
        move.at,
      );
    }
    if (!result.ok) {
      throw new ReplayError(moveIndexOr(move, index), result.code, result.message);
    }
    state = result.state;
    frames.push({ index, state, move });
  }

  return frames;
}
