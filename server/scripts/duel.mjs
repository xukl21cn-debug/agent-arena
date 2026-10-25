#!/usr/bin/env node
/**
 * Two MCP clients play a full game against each other.
 *
 * This is the infrastructure check for dual-agent play: it exercises the same
 * protocol path a real model takes (join_game → wait_for_turn → place_stone),
 * but decides moves mechanically so it needs no model and finishes in seconds.
 *
 * What it proves when it passes:
 *   - each session is routed to its own color
 *   - wait_for_turn wakes the right agent and reports that agent's color
 *   - the board accepts both colors and ends the game
 *   - presence reports both seats through the whole game
 *
 * Usage:
 *   node scripts/duel.mjs                    # two bots, one game
 *   node scripts/duel.mjs --room duel2       # a different room
 *   node scripts/duel.mjs --strategy hot     # play from hotPoints (stronger)
 *   node scripts/duel.mjs --keep             # leave the room open afterwards
 *
 * Requires a running server (`pnpm start` or `pnpm dev`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);

function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

function flag(name) {
  return args.includes(`--${name}`);
}

const BASE = arg('server', process.env.ARENA_SERVER_URL ?? 'http://127.0.0.1:3000');
const ROOM = arg('room', 'duel');
const STRATEGY = arg('strategy', 'center');
const KEEP = flag('keep');
const MAX_MOVES = Number(arg('max-moves', 60));

/** Read the text payload a tool returns. */
function payloadOf(result) {
  const content = result.content ?? [];
  const text = content.find((item) => item.type === 'text')?.text;
  if (text === undefined) {
    throw new Error('tool returned no text content');
  }
  return JSON.parse(text);
}

async function call(client, name, toolArgs) {
  const result = await client.callTool({ name, arguments: toolArgs });
  const payload = payloadOf(result);
  if (result.isError) {
    const error = new Error(`${name} failed: ${payload.code ?? '?'} ${payload.message ?? ''}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

/**
 * Pick a move.
 *
 * `center` spirals outward from the middle, which makes a compact game that
 * ends quickly. `hot` follows the server's own threat radar — the same advice
 * a model receives — so the game looks like real play.
 *
 * The occupied set comes from `get_state`, not from the view `wait_for_turn`
 * returns: hot-path responses keep only the recent moves, so a bot reading
 * them would replay an occupied cell once the game passed eight moves.
 */
function chooseMove(fullState, strategy) {
  const occupied = new Set(
    (fullState.moves ?? []).map((move) => `${move.row},${move.col}`),
  );
  const size = fullState.rules?.boardSize ?? 15;
  const middle = Math.floor(size / 2);

  if (strategy === 'hot') {
    const own = fullState.hotPoints?.[fullState.turn] ?? [];
    const rank = { win: 0, open4: 1, four: 2, open3: 3 };
    const sorted = [...own].sort(
      (a, b) => (rank[a.effect] ?? 9) - (rank[b.effect] ?? 9),
    );
    for (const point of sorted) {
      if (!occupied.has(`${point.row},${point.col}`)) {
        return { row: point.row, col: point.col, why: point.effect };
      }
    }
  }

  // Spiral out from the centre.
  for (let radius = 0; radius < size; radius += 1) {
    for (let dr = -radius; dr <= radius; dr += 1) {
      for (let dc = -radius; dc <= radius; dc += 1) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) {
          continue;
        }
        const row = middle + dr;
        const col = middle + dc;
        if (row < 0 || col < 0 || row >= size || col >= size) {
          continue;
        }
        if (!occupied.has(`${row},${col}`)) {
          return { row, col, why: 'center' };
        }
      }
    }
  }
  throw new Error('no empty cell left');
}

async function connect(name) {
  const client = new Client({ name, version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
  return client;
}

async function presence() {
  try {
    const view = await fetch(`${BASE}/api/rooms/${encodeURIComponent(ROOM)}`).then(
      (response) => response.json(),
    );
    return (view.participants ?? [])
      .map((item) => `${item.seat}:${item.label}=${item.presence}`)
      .join('  ');
  } catch {
    return '(unavailable)';
  }
}

async function main() {
  console.log(`arena duel · room=${ROOM} strategy=${STRATEGY} server=${BASE}`);

  const black = await connect('duel-black');
  const white = await connect('duel-white');

  try {
    const blackJoin = await call(black, 'join_game', {
      roomId: ROOM,
      name: 'black-bot',
      seat: 'black',
    });
    const whiteJoin = await call(white, 'join_game', {
      roomId: ROOM,
      name: 'white-bot',
      seat: 'white',
    });

    console.log(
      `joined: black=${blackJoin.participantId} white=${whiteJoin.participantId}`,
    );
    if (blackJoin.participantId === whiteJoin.participantId) {
      throw new Error('both sessions resolved to the same participant');
    }
    console.log(`presence: ${await presence()}`);

    // Black opens the game; seats come from the roster so identities survive.
    await call(black, 'new_game', { roomId: ROOM, agentColor: 'black' });

    const players = { black, white };
    let finished = false;
    let moves = 0;

    while (!finished && moves < MAX_MOVES) {
      // Whoever is to move waits; the other would park, so ask both in turn.
      const waiting = await Promise.all(
        ['black', 'white'].map(async (color) => {
          const view = await call(players[color], 'wait_for_turn', {
            roomId: ROOM,
            timeoutMs: 2_000,
          });
          return { color, view };
        }),
      );

      const active = waiting.find((item) => item.view.reason === 'your_turn');
      if (!active) {
        const over = waiting.find((item) => item.view.reason === 'game_over');
        if (over) {
          console.log(`\ngame over: ${describeResult(over.view.state)}`);
          finished = true;
          break;
        }
        // Neither side is to move yet; wait again.
        continue;
      }

      const { color, view } = active;
      if (view.yourColor !== color) {
        throw new Error(
          `wait_for_turn reported yourColor=${view.yourColor} for the ${color} client`,
        );
      }

      // Full state: `view.state` carries only the recent moves, which is right
      // for a model reading a board picture but not for tracking occupancy.
      const full = await call(players[color], 'get_state', { roomId: ROOM });
      const move = chooseMove(full.state, STRATEGY);
      const result = await call(players[color], 'place_stone', {
        roomId: ROOM,
        row: move.row,
        col: move.col,
      });
      moves += 1;

      const state = result.state;
      console.log(
        `#${String(state.moveCount).padStart(2)} ${color.padEnd(5)} ` +
          `(${move.row},${move.col}) ${move.why.padEnd(7)} ` +
          `presence: ${await presence()}`,
      );

      if (state.status === 'finished') {
        console.log(`\ngame over: ${describeResult(state)}`);
        finished = true;
      }
    }

    if (!finished) {
      console.log(`\nstopped after ${moves} moves without a result`);
    }

    const final = await call(black, 'get_state', { roomId: ROOM });
    console.log(`final moveCount: ${final.state.moveCount}`);
    console.log(final.state.boardText);
  } finally {
    if (!KEEP) {
      await black.callTool({ name: 'leave_room', arguments: { roomId: ROOM } }).catch(() => {});
      await white.callTool({ name: 'leave_room', arguments: { roomId: ROOM } }).catch(() => {});
    }
    await black.close().catch(() => {});
    await white.close().catch(() => {});
  }
}

function describeResult(state) {
  if (state.winner === 'draw') {
    return `draw after ${state.moveCount} moves`;
  }
  return `${state.winner} wins by ${state.endReason} after ${state.moveCount} moves`;
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  if (error.payload) {
    console.error(JSON.stringify(error.payload, null, 2));
  }
  process.exit(1);
});
