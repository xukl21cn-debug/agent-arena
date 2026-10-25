import { describe, expect, it } from 'vitest';
import type { GoState, StoneColor } from '@arena/shared';
import { GameRoom } from '../src/rooms/room';
import { toAnyAgentStateView } from '../src/core/insights';

/**
 * Go scoring, end to end at the room level (P3b-3): G6/G10/G14/G15/G16 and
 * S1-S6 from the work order, plus the §6.1 wait semantics. Scoring has no
 * turn order, so every wait test drives both seats, never one.
 */

function goRoom(): GameRoom {
  const room = new GameRoom('go-scoring');
  room.newGame({ game: 'go', agentColor: 'white' });
  return room;
}

function play(room: GameRoom, color: StoneColor, row: number, col: number): void {
  const result = room.moveAs(
    { actor: color === 'black' ? 'human' : 'agent' },
    row,
    col,
  );
  if (!result.ok) {
    throw new Error(`expected ${color} (${row},${col}) to succeed: ${result.code}`);
  }
}

function pass(room: GameRoom, color: StoneColor): void {
  const result = room.passAs({ actor: color === 'black' ? 'human' : 'agent' });
  if (!result.ok) {
    throw new Error(`expected ${color} pass to succeed: ${result.code}`);
  }
}

/**
 * Reach scoring the ordinary way: a few stones for later marking, then two
 * consecutive passes. Black passed first, so scoring's turn stays black.
 */
function toScoring(room: GameRoom): GoState {
  play(room, 'black', 8, 8);
  play(room, 'white', 7, 7);
  pass(room, 'black');
  pass(room, 'white');
  const state = room.getState();
  if (state.game !== 'go' || state.status !== 'scoring') {
    throw new Error('expected to reach the scoring phase');
  }
  return state;
}

/** A two-stone white corner block with a liberty, plus black stones around. */
function cornerBlockRoom(): GameRoom {
  const room = goRoom();
  play(room, 'black', 2, 0);
  play(room, 'white', 0, 0);
  play(room, 'black', 2, 1);
  play(room, 'white', 1, 0);
  play(room, 'black', 4, 4);
  return room;
}

function sortCells(cells: Array<{ row: number; col: number }>): Array<{ row: number; col: number }> {
  return [...cells].sort(
    (a, b) => a.row - b.row || a.col - b.col,
  );
}

function asGo(room: GameRoom): GoState {
  const state = room.getState();
  if (state.game !== 'go') {
    throw new Error('expected a Go state');
  }
  return state;
}

describe('G10: two passes enter scoring, resume leaves it', () => {
  it('enters scoring after two consecutive passes with turn untouched', () => {
    const room = goRoom();
    play(room, 'black', 8, 8);
    play(room, 'white', 7, 7);

    pass(room, 'black');
    let state = asGo(room);
    expect(state.status).toBe('playing');
    expect(state.consecutivePasses).toBe(1);

    pass(room, 'white');
    state = asGo(room);
    expect(state.status).toBe('scoring');
    // White passed last, so "the side that would play next" is black —
    // and scoring must not have moved or nulled it.
    expect(state.turn).toBe('black');
    expect(state.consecutivePasses).toBe(2);
  });

  it('resume_play returns to playing with every counter reset', () => {
    const room = goRoom();
    const scoring = toScoring(room);
    const marked = room.markDeadAs({ actor: 'human' }, 8, 8);
    expect(marked.ok).toBe(true);

    const resumed = room.resumePlayAs({ actor: 'agent' });
    expect(resumed.ok).toBe(true);

    const state = asGo(room);
    expect(state.status).toBe('playing');
    expect(state.deadStones).toEqual([]);
    expect(state.scoreConfirmed).toEqual({ black: false, white: false });
    expect(state.consecutivePasses).toBe(0);
    expect(state.turn).toBe(scoring.turn);
    // The board is untouched: same stones, same points.
    expect(state.board).toEqual(scoring.board);
  });
});

describe('S1/S2: scoring rejects placements and passes', () => {
  it('answers NOT_SCORING for place_stone and pass during scoring', () => {
    const room = goRoom();
    toScoring(room);

    const placed = room.moveAs({ actor: 'human' }, 0, 0);
    expect(placed.ok).toBe(false);
    if (!placed.ok) {
      expect(placed.code).toBe('NOT_SCORING');
    }

    const passed = room.passAs({ actor: 'human' });
    expect(passed.ok).toBe(false);
    if (!passed.ok) {
      expect(passed.code).toBe('NOT_SCORING');
    }
  });
});

describe('S3: mark_dead outside scoring is NOT_SCORING', () => {
  it('rejects mark_dead while playing', () => {
    const room = goRoom();
    play(room, 'black', 8, 8);

    const result = room.markDeadAs({ actor: 'human' }, 8, 8);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_SCORING');
    }
  });
});

describe('S4: marking a point with no stone fails loudly', () => {
  it('answers INVALID_DEAD_STONE for empty and off-board points', () => {
    const room = goRoom();
    toScoring(room);

    for (const [row, col] of [
      [0, 0],
      [4, 4],
      [9, 0],
      [-1, 2],
    ] as const) {
      const result = room.markDeadAs({ actor: 'human' }, row, col);
      expect(result.ok, `expected (${row},${col}) to fail`).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_DEAD_STONE');
      }
    }
  });
});

describe('mark_dead toggles whole blocks', () => {
  it('marks and unmarks a two-stone block as one unit', () => {
    const room = cornerBlockRoom();
    pass(room, 'white');
    pass(room, 'black');
    expect(asGo(room).status).toBe('scoring');

    // One call on one stone marks the whole block.
    const marked = room.markDeadAs({ actor: 'human' }, 0, 0);
    expect(marked.ok).toBe(true);
    // Order inside a block is an engine DFS by-product; compare as a set.
    expect(sortCells(asGo(room).deadStones)).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 0 },
    ]);

    // Toggling the other stone of the same block removes the whole block.
    const unmarked = room.markDeadAs({ actor: 'agent' }, 1, 0);
    expect(unmarked.ok).toBe(true);
    expect(asGo(room).deadStones).toEqual([]);

    // And marking again re-adds the block.
    const remarried = room.markDeadAs({ actor: 'human' }, 1, 0);
    expect(remarried.ok).toBe(true);
    expect(sortCells(asGo(room).deadStones)).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 0 },
    ]);
  });

  it('keeps both confirmations reset after every mark change', () => {
    const room = goRoom();
    toScoring(room);

    const first = room.markDeadAs({ actor: 'human' }, 8, 8);
    expect(first.ok).toBe(true);
    expect(asGo(room).scoreConfirmed).toEqual({ black: false, white: false });

    room.confirmScoreAs({ actor: 'human' });
    expect(asGo(room).scoreConfirmed.black).toBe(true);

    // The toggle that removes the mark is a change like any other.
    const second = room.markDeadAs({ actor: 'agent' }, 8, 8);
    expect(second.ok).toBe(true);
    const state = asGo(room);
    expect(state.scoreConfirmed).toEqual({ black: false, white: false });
    expect(state.deadStones).toEqual([]);
  });
});

describe('G14: a mark change invalidates the confirmations', () => {
  it('re-wakes the confirmed side as scoring when the other side marks', async () => {
    const room = goRoom();
    toScoring(room);

    room.confirmScoreAs({ actor: 'human' });
    const blackWait = room.waitForSeat('black', 5_000);
    room.markDeadAs({ actor: 'agent' }, 7, 7);

    const result = await blackWait;
    expect(result.reason).toBe('scoring');
    expect(asGo(room).scoreConfirmed.black).toBe(false);
  });
});

describe('S5: confirm_score is idempotent', () => {
  it('answers ok without changing the state on a repeat confirm', () => {
    const room = goRoom();
    toScoring(room);

    const first = room.confirmScoreAs({ actor: 'human' });
    expect(first.ok).toBe(true);
    const once = asGo(room);
    expect(once.scoreConfirmed.black).toBe(true);
    expect(once.status).toBe('scoring');

    const second = room.confirmScoreAs({ actor: 'human' });
    expect(second.ok).toBe(true);
    expect(room.getState()).toBe(once);
  });
});

describe('G16: the area score with komi decides the winner', () => {
  it('scores black 40 vs white 35 + komi 7.5 as a white win', () => {
    const room = goRoom();
    // 40 black stones on rows 0-3 plus (4,0)-(4,3); 35 white stones on rows
    // 5-8 minus (5,8); the 6 remaining points touch both colours and stay
    // neutral. The board is set directly: area counting reads positions, not
    // the move history.
    const state = asGo(room);
    for (let row = 0; row <= 3; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        state.board[row]![col] = 'black';
      }
    }
    for (let col = 0; col <= 3; col += 1) {
      state.board[4]![col] = 'black';
    }
    for (let row = 5; row <= 8; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        state.board[row]![col] = 'white';
      }
    }
    state.board[5]![8] = null;

    pass(room, 'black');
    pass(room, 'white');
    expect(room.getState().status).toBe('scoring');

    room.confirmScoreAs({ actor: 'human' });
    const final = room.confirmScoreAs({ actor: 'agent' });
    expect(final.ok).toBe(true);

    const finished = asGo(room);
    expect(finished.status).toBe('finished');
    expect(finished.endReason).toBe('scored');
    expect(finished.score).not.toBeNull();
    expect(finished.score!.blackTotal).toBe(40);
    expect(finished.score!.whiteTotal).toBe(42.5);
    expect(finished.winner).toBe('white');
    expect(finished.score!.winner).toBe('white');
  });
});

describe('G6: dead stones leave the area count, captures never enter it', () => {
  it('gives the dead block and its region to the surrounding colour', () => {
    const room = cornerBlockRoom();
    // Dead stones were removed first, so the empty corner region touches
    // only black; with white wiped out entirely the rest is black area too.
    // Captures are 0 all game: they appear nowhere in the numbers.
    pass(room, 'white');
    pass(room, 'black');

    const marked = room.markDeadAs({ actor: 'human' }, 0, 0);
    expect(marked.ok).toBe(true);
    // Order inside a block is an engine DFS by-product; compare as a set.
    expect(sortCells(asGo(room).deadStones)).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 0 },
    ]);

    room.confirmScoreAs({ actor: 'human' });
    room.confirmScoreAs({ actor: 'agent' });

    const finished = asGo(room);
    expect(finished.status).toBe('finished');
    expect(finished.captures).toEqual({ black: 0, white: 0 });
    // White's stones are gone: black's 3 stones plus the whole empty board.
    expect(finished.score!.blackArea).toBe(81);
    expect(finished.score!.whiteArea).toBe(0);
    expect(finished.winner).toBe('black');
    expect(finished.score!.margin).toBeCloseTo(81 - 7.5, 5);
  });

  it('scores a live-looking board differently than a marked one', () => {
    const room = cornerBlockRoom();
    pass(room, 'white');
    pass(room, 'black');

    // Preview without marks: the white corner stones sit on the board and
    // the empty points between the colours stay neutral.
    const preview = room.markDeadAs({ actor: 'human' }, 4, 4);
    expect(preview.ok).toBe(true);
    let state = asGo(room);
    expect(state.deadStones).toEqual([{ row: 4, col: 4 }]);

    // Marking black (4,4) instead gives that point to nobody: a lone stone
    // removed still leaves its point surrounded by both colours' regions.
    room.confirmScoreAs({ actor: 'human' });
    room.confirmScoreAs({ actor: 'agent' });
    state = asGo(room);
    expect(state.status).toBe('finished');
    expect(state.score!.blackArea).toBe(2);
    expect(state.score!.whiteArea).toBe(2);
  });
});

describe('S6: the full scoring flow, start to finish', () => {
  it('plays, passes twice, marks, both confirm, and the score lands', () => {
    const room = goRoom();
    play(room, 'black', 2, 2);
    play(room, 'white', 6, 6);
    play(room, 'black', 2, 6);
    play(room, 'white', 6, 2);

    pass(room, 'black');
    const viewDuringPlay = toAnyAgentStateView(
      room.getState(),
      room.getHistory(),
    );
    if (viewDuringPlay.game !== 'go') {
      throw new Error('expected a Go view');
    }
    expect(viewDuringPlay.scorePreview).toBeNull();

    pass(room, 'white');
    let state = asGo(room);
    expect(state.status).toBe('scoring');
    expect(state.turn).toBe('black');

    // The view now carries a preview even before anything is marked.
    const scoringView = toAnyAgentStateView(
      room.getState(),
      room.getHistory(),
    );
    if (scoringView.game !== 'go') {
      throw new Error('expected a Go view');
    }
    expect(scoringView.scorePreview).not.toBeNull();
    expect(scoringView.scorePreview!.komi).toBe(7.5);

    // Mark white (6,6) dead; the block is a single stone.
    const marked = room.markDeadAs({ actor: 'human' }, 6, 6);
    expect(marked.ok).toBe(true);
    expect(asGo(room).deadStones).toEqual([{ row: 6, col: 6 }]);

    // Confirmations are per seat and independent.
    room.confirmScoreAs({ actor: 'human' });
    state = asGo(room);
    expect(state.status).toBe('scoring');
    expect(state.scoreConfirmed).toEqual({ black: true, white: false });

    const finalResult = room.confirmScoreAs({ actor: 'agent' });
    expect(finalResult.ok).toBe(true);
    state = asGo(room);
    expect(state.status).toBe('finished');
    expect(state.endReason).toBe('scored');
    expect(state.score).not.toBeNull();
    expect(state.winner).not.toBeNull();

    // The finished view shows the score, not a preview.
    const finishedView = toAnyAgentStateView(
      room.getState(),
      room.getHistory(),
    );
    if (finishedView.game !== 'go') {
      throw new Error('expected a Go view');
    }
    expect(finishedView.scorePreview).toBeNull();
    expect(finishedView.score).not.toBeNull();
    expect(finishedView.deadStones).toEqual([{ row: 6, col: 6 }]);
  });
});

describe('§6.1: scoring wait semantics, both seats in parallel', () => {
  it('answers both seats immediately with scoring before anyone confirms', async () => {
    const room = goRoom();
    toScoring(room);

    const [black, white] = await Promise.all([
      room.waitForSeat('black', 1_000),
      room.waitForSeat('white', 1_000),
    ]);
    expect(black.reason).toBe('scoring');
    expect(white.reason).toBe('scoring');
  });

  it('parks the confirmed seat while the other is still asked to act', async () => {
    const room = goRoom();
    toScoring(room);

    room.confirmScoreAs({ actor: 'human' });

    const white = await room.waitForSeat('white', 1_000);
    expect(white.reason).toBe('scoring');

    // Black already confirmed, so black keeps waiting until the timeout.
    const black = await room.waitForSeat('black', 100);
    expect(black.reason).toBe('timeout');
  });

  it('wakes the parked seat as game_over once both sides confirmed', async () => {
    const room = goRoom();
    toScoring(room);

    room.confirmScoreAs({ actor: 'human' });
    const blackWait = room.waitForSeat('black', 5_000);
    room.confirmScoreAs({ actor: 'agent' });

    const result = await blackWait;
    expect(result.reason).toBe('game_over');
    expect(asGo(room).status).toBe('finished');
  });

  it('re-wakes a parked confirmed seat when a mark resets its confirmation', async () => {
    const room = goRoom();
    toScoring(room);

    room.confirmScoreAs({ actor: 'human' });
    const blackWait = room.waitForSeat('black', 5_000);
    room.markDeadAs({ actor: 'agent' }, 8, 8);

    const result = await blackWait;
    expect(result.reason).toBe('scoring');
  });
});

describe('resign stays available during scoring', () => {
  it('lets either side resign a scoring game', () => {
    const room = goRoom();
    toScoring(room);

    const result = room.resignAs({ actor: 'agent' });
    expect(result.ok).toBe(true);
    const state = asGo(room);
    expect(state.status).toBe('finished');
    expect(state.endReason).toBe('resign');
    expect(state.winner).toBe('black');
  });
});

describe('gomoku rooms still reject the scoring tools', () => {
  it('answers WRONG_GAME for all three', () => {
    const room = new GameRoom('gomoku-scoring');
    room.newGame();

    for (const probe of [
      () => room.markDeadAs({ actor: 'human' }, 0, 0),
      () => room.confirmScoreAs({ actor: 'human' }),
      () => room.resumePlayAs({ actor: 'human' }),
    ]) {
      const result = probe();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('WRONG_GAME');
      }
    }
  });
});
