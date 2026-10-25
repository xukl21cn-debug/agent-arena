import { describe, expect, it } from 'vitest';
import { computePresence, type PresenceInput } from '@gomoku/shared';
import { PresenceRegistry, seatLabel } from '../src/core/presence';

const NOW = 1_800_000_000_000;

function input(overrides: Partial<PresenceInput> = {}): PresenceInput {
  return {
    connected: false,
    waiting: false,
    lastSeenAt: null,
    isTurn: false,
    now: NOW,
    ...overrides,
  };
}

describe('computePresence', () => {
  it('reports unknown for a seat that never connected', () => {
    expect(computePresence(input())).toBe('unknown');
  });

  it('treats a parked long-poll as waiting, even when it is also on turn', () => {
    expect(
      computePresence(
        input({ waiting: true, connected: true, isTurn: true, lastSeenAt: NOW }),
      ),
    ).toBe('waiting');
  });

  it('reports thinking while it is the seat turn and the connection is alive', () => {
    expect(
      computePresence(input({ connected: true, isTurn: true, lastSeenAt: NOW })),
    ).toBe('thinking');
  });

  it('keeps a quiet connected seat idle instead of disconnected', () => {
    // A player staring at the board for ten minutes is still connected.
    expect(
      computePresence(
        input({ connected: true, lastSeenAt: NOW - 600_000, isTurn: false }),
      ),
    ).toBe('idle');
  });

  it('reports disconnected once the connection is gone', () => {
    expect(
      computePresence(input({ connected: false, lastSeenAt: NOW - 1_000 })),
    ).toBe('disconnected');
  });

  it('reports disconnected as soon as nothing is attached, however recent the call', () => {
    // Freshness alone is not connection: the caller decides what counts as
    // attached, and a REST call is never proof for a human seat.
    expect(
      computePresence(input({ connected: false, lastSeenAt: NOW - 10 })),
    ).toBe('disconnected');
  });
});

describe('seatLabel', () => {
  it('prefers the declared name', () => {
    expect(seatLabel('black', { kind: 'agent', name: 'dsh' })).toBe('dsh');
  });

  it('falls back to 你 for the human seat and AI for the agent seat', () => {
    expect(seatLabel('black', { kind: 'human' })).toBe('你');
    expect(seatLabel('white', { kind: 'agent' })).toBe('AI');
  });
});

describe('PresenceRegistry', () => {
  const seats = {
    black: { kind: 'human' as const },
    white: { kind: 'agent' as const },
  };

  function registry(clock: { now: number } = { now: NOW }): PresenceRegistry {
    return new PresenceRegistry({
      now: () => clock.now,
      staleAfterMs: 10_000,
      sessionIdleMs: 90_000,
    });
  }

  function snapshot(
    reg: PresenceRegistry,
    turn: 'black' | 'white' | null = null,
  ) {
    return reg.snapshot({
      roomId: 'r1',
      seats,
      turn,
      playing: turn !== null,
    });
  }

  it('reports both seats as unknown before anything connects', () => {
    expect(snapshot(registry()).map((view) => view.presence)).toEqual([
      'unknown',
      'unknown',
    ]);
  });

  it('marks the human seat idle while a browser viewer is attached', () => {
    const reg = registry();
    const detach = reg.attachViewer('r1');
    expect(snapshot(reg)[0]?.presence).toBe('idle');

    // Closing the tab means nobody is watching, so the seat is gone at once —
    // no stale window, because a human seat has no "recently seen" state.
    detach();
    expect(snapshot(reg)[0]?.presence).toBe('unknown');
  });

  it('follows the human seat when a new game moves it to the other color', () => {
    // The regression this test exists for: the tab used to bind to whichever
    // seat was human at connect time, so starting a game as white left the
    // viewer on black — the AI showed "thinking" and the human "disconnected".
    const reg = registry();
    reg.attachViewer('r1');
    reg.attachSession('r1', 'black', 'session-1', 'dsh');

    const asBlackHuman = snapshot(reg);
    expect(asBlackHuman[0]?.presence).toBe('idle');

    // Now the human plays white and the agent plays black.
    const swapped = reg.snapshot({
      roomId: 'r1',
      seats: {
        black: { kind: 'agent' },
        white: { kind: 'human' },
      },
      turn: 'black',
      playing: true,
    });

    expect(swapped[0]?.presence).toBe('thinking'); // agent to move
    expect(swapped[1]?.presence).toBe('idle'); // human watching
  });

  it('clears carried-over activity when a seat changes hands', () => {
    // The bug this test exists for: signals are keyed by seat, but seats swap
    // occupants between games. The human's moves in a game where they played
    // black left a fresh call stamp on black, so the next game's *agent* seat
    // (also black) read "online" for the whole stale window even though no
    // agent had ever connected.
    const reg = registry();
    reg.attachViewer('r1');
    reg.touch('r1', 'black'); // human played black in the previous game

    // New game: agent takes black, nothing has connected to it.
    reg.rebindSeats('r1', 'black');

    const views = reg.snapshot({
      roomId: 'r1',
      seats: {
        black: { kind: 'agent' },
        white: { kind: 'human' },
      },
      turn: 'black',
      playing: true,
    });

    expect(views[0]?.presence).toBe('unknown');
    expect(views[1]?.presence).toBe('idle');
  });

  it('keeps live evidence when a seat changes hands', () => {
    // A new game must not wipe an agent that is connected right now: an
    // attached session is proof somebody is there, whichever color they took.
    const reg = registry();
    reg.attachViewer('r1');
    reg.attachSession('r1', 'black', 'session-1', 'dsh');
    reg.touch('r1', 'black');

    reg.rebindSeats('r1', 'black');

    const views = reg.snapshot({
      roomId: 'r1',
      seats: {
        black: { kind: 'agent' },
        white: { kind: 'human' },
      },
      turn: 'black',
      playing: true,
    });

    expect(views[0]?.presence).toBe('thinking');
  });

  it('drops the human seat immediately, not after the stale window', () => {
    // The bug this test exists for: closing the tab used to leave the human
    // seat reading `idle` until the stale window expired, so a refresh looked
    // like "still online" for two minutes.
    const clock = { now: NOW };
    const reg = registry(clock);
    const detach = reg.attachViewer('r1');
    detach();

    expect(snapshot(reg)[0]?.presence).toBe('unknown');
    clock.now += 11_000;
    expect(snapshot(reg)[0]?.presence).toBe('unknown');
  });

  it('counts viewers per room and keeps them independent', () => {
    const reg = registry();
    reg.attachViewer('r1');
    reg.attachViewer('r1');
    const detachOne = reg.attachViewer('r1');

    expect(snapshot(reg)[0]?.presence).toBe('idle');
    detachOne();
    // Two tabs remain: the human is still watching.
    expect(snapshot(reg)[0]?.presence).toBe('idle');
  });

  it('marks the agent seat idle while an MCP session is attached', () => {
    const reg = registry();
    reg.attachSession('r1', 'white', 'session-1', 'dsh');
    const agent = snapshot(reg)[1];
    expect(agent?.presence).toBe('idle');
    expect(agent?.client).toBe('dsh');
  });

  it('reports waiting while a long-poll is parked, and idle after it returns', () => {
    const reg = registry();
    reg.attachSession('r1', 'white', 'session-1', 'dsh');
    const release = reg.beginWait('r1', 'white');

    const waiting = snapshot(reg)[1];
    expect(waiting?.presence).toBe('waiting');
    expect(waiting?.waiting).toBe(true);

    release();
    expect(snapshot(reg)[1]?.presence).toBe('idle');
  });

  it('reports thinking for the seat whose turn it is', () => {
    const reg = registry();
    reg.attachSession('r1', 'white', 'session-1', 'dsh');
    reg.attachViewer('r1');

    const views = snapshot(reg, 'white');
    expect(views[0]?.presence).toBe('idle');
    expect(views[1]?.presence).toBe('thinking');
    expect(views[1]?.isTurn).toBe(true);
  });

  it('keeps a session-backed seat alive while the session keeps calling', () => {
    const clock = { now: NOW };
    const reg = registry(clock);

    // Each call refreshes the session, the way a waiting agent keeps polling.
    for (let i = 0; i < 10; i++) {
      reg.attachSession('r1', 'white', 'session-1', 'dsh');
      clock.now += 60_000;
      expect(snapshot(reg)[1]?.presence).toBe('idle');
    }
  });

  it('expires a session that stopped calling, because close() never says so', () => {
    // The MCP SDK's client.close() aborts locally without a DELETE, so silence
    // is the only signal a vanished client gives the server.
    const clock = { now: NOW };
    const reg = registry(clock);
    reg.attachSession('r1', 'white', 'session-1', 'dsh');

    clock.now += 60_000;
    expect(snapshot(reg)[1]?.presence).toBe('idle');

    clock.now += 31_000;
    expect(snapshot(reg)[1]?.presence).toBe('disconnected');
  });

  it('drops the seat to disconnected once its session closes', () => {
    const clock = { now: NOW };
    const reg = registry(clock);
    reg.attachSession('r1', 'white', 'session-1', 'dsh');
    reg.detachSession('session-1');

    clock.now += 11_000;
    expect(snapshot(reg)[1]?.presence).toBe('disconnected');
  });

  it('treats a closed session as disconnected even while the call stamp is fresh', () => {
    // A session that closes is a confirmed disconnect. The recent-call fallback
    // exists for the stdio bridge, which never has a session — it must not keep
    // a departed agent looking alive for the whole stale window.
    const reg = registry();
    reg.attachSession('r1', 'white', 'session-1', 'dsh');
    reg.detachSession('session-1');

    expect(snapshot(reg)[1]?.presence).toBe('disconnected');
  });

  it('falls back to a recent call for clients without a session', () => {
    // The stdio bridge has no MCP session in this process; its REST calls are
    // the only evidence that the agent is alive.
    const reg = registry();
    reg.touch('r1', 'white');
    expect(snapshot(reg)[1]?.presence).toBe('idle');
  });

  it('never treats a REST call as proof that the human seat is watching', () => {
    // A human seat has exactly one client: the browser tab. Without a viewer,
    // a recent move (or any other REST call) must not read as connected, or
    // the UI would claim somebody is there when nobody is looking.
    const reg = registry();
    reg.touch('r1', 'black');
    expect(snapshot(reg)[0]?.presence).toBe('unknown');
  });

  it('sweeps a room whose seats went quiet past the stale window', () => {
    const clock = { now: NOW };
    const reg = registry(clock);
    const seen: string[] = [];
    reg.onChange((roomId) => seen.push(roomId));

    reg.touch('r1', 'white');
    seen.length = 0;

    clock.now += 9_000;
    reg.sweep();
    expect(seen).toEqual([]);

    clock.now += 2_000;
    reg.sweep();
    expect(seen).toEqual(['r1']);
  });

  it('does not sweep rooms that still have a viewer or a parked wait', () => {
    const clock = { now: NOW };
    const reg = registry(clock);
    const seen: string[] = [];
    reg.onChange((roomId) => seen.push(roomId));

    reg.attachViewer('r1');
    clock.now += 60_000;
    seen.length = 0;
    reg.sweep();
    expect(seen).toEqual([]);

    reg.beginWait('r1', 'white');
    seen.length = 0;
    reg.sweep();
    expect(seen).toEqual([]);
  });

  it('stops notifying once a listener unsubscribes', () => {
    const reg = registry();
    const seen: string[] = [];
    const off = reg.onChange((roomId) => seen.push(roomId));
    reg.touch('r1', 'black');
    expect(seen).toEqual(['r1']);

    off();
    reg.touch('r1', 'black');
    expect(seen).toEqual(['r1']);
  });

  it('keeps two rooms isolated', () => {
    const reg = registry();
    reg.attachSession('r1', 'white', 'session-1', 'dsh');

    const other = reg.snapshot({
      roomId: 'r2',
      seats,
      turn: null,
      playing: false,
    });
    expect(other.map((view) => view.presence)).toEqual(['unknown', 'unknown']);
    expect(snapshot(reg)[1]?.presence).toBe('idle');
  });

  it('forgets a room on clearRoom', () => {
    const reg = registry();
    reg.attachSession('r1', 'white', 'session-1', 'dsh');
    reg.clearRoom('r1');
    expect(snapshot(reg)[1]?.presence).toBe('unknown');
  });

  it('names the seated participant in the view', () => {
    // Two agents cannot be told apart by label or kind alone; the id is the
    // link from a rendered seat back to the roster entry.
    const reg = registry();
    const views = reg.snapshot({
      roomId: 'duo',
      seats: {
        black: { kind: 'agent', id: 'p_black', name: 'dsh' },
        white: { kind: 'agent', id: 'p_white', name: 'codex' },
      },
      turn: null,
      playing: false,
    });
    expect(views.map((view) => view.participantId)).toEqual([
      'p_black',
      'p_white',
    ]);
  });

  it('omits participantId when the seat has nobody behind it', () => {
    const views = snapshot(registry());
    expect(views.map((view) => view.participantId)).toEqual([
      undefined,
      undefined,
    ]);
  });
});
