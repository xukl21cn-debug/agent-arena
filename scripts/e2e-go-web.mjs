/**
 * P3b-4 end-to-end acceptance: one full 9×9 Go game, web-side identity over
 * REST ("the human in the browser") against a real MCP session ("the agent").
 *
 *   node scripts/e2e-go-web.mjs
 *
 * Requires the dev server on 127.0.0.1:3000 (pnpm --filter server dev).
 *
 * The walk exercises every piece of the M4 checklist the server can prove:
 *   - new_game with game:'go' from the human side
 *   - the agent joins through MCP and answers through wait_for_turn
 *   - a mid-game pass, then play continues (one pass must not end the game)
 *   - two passes enter scoring with no turn change
 *   - mark_dead toggles whole blocks and resets BOTH confirmations
 *   - resume_play returns to playing, turn preserved, marks cleared
 *   - both confirmations produce endReason 'scored' with the full GoScore
 *   - the final score matches an independent area recount of the same board
 */

const BASE = process.env.ARENA_URL ?? 'http://127.0.0.1:3000';

// ---------------------------------------------------------------------------
// REST (the browser's side)
// ---------------------------------------------------------------------------

async function rest(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `REST ${method} ${path} -> ${res.status} ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

// ---------------------------------------------------------------------------
// MCP (the agent's side) — raw JSON-RPC over the Streamable HTTP transport
// ---------------------------------------------------------------------------

class McpAgent {
  constructor(name) {
    this.name = name;
    this.sessionId = null;
    this.nextId = 1;
  }

  async rpc(method, params, { notification = false } = {}) {
    const id = notification ? undefined : this.nextId++;
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        ...(params ? { params } : {}),
        ...(id === undefined ? {} : { id }),
      }),
    });

    if (notification) {
      if (!res.ok) {
        throw new Error(`MCP notification ${method} -> ${res.status}`);
      }
      return null;
    }

    const contentType = res.headers.get('content-type') ?? '';
    let message = null;
    if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) {
          continue;
        }
        try {
          const parsed = JSON.parse(line.slice(5).trim());
          if (parsed.id === id) {
            message = parsed;
          }
        } catch {
          // keep-alive comments and partial frames are not JSON
        }
      }
    } else {
      message = await res.json();
    }

    const newSession = res.headers.get('mcp-session-id');
    if (newSession) {
      this.sessionId = newSession;
    }

    if (!message || message.id !== id) {
      throw new Error(`MCP ${method}: no matching response (got ${JSON.stringify(message)})`);
    }
    if (message.error) {
      throw new Error(`MCP ${method}: ${JSON.stringify(message.error)}`);
    }
    return message.result;
  }

  async connect() {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: this.name, version: '0.0.1' },
    });
    await this.rpc('notifications/initialized', undefined, { notification: true });
  }

  async tool(name, args = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    if (result.isError) {
      throw new Error(`tool ${name} failed: ${JSON.stringify(result.content)}`);
    }
    const text = result.content?.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') {
      throw new Error(`tool ${name} returned no text content`);
    }
    return JSON.parse(text);
  }
}

// ---------------------------------------------------------------------------
// Independent area recount, mirroring the engine's scoreBoard for the final
// cross-check (dead stones off the board, one-colour regions are territory).
// ---------------------------------------------------------------------------

function recount(board, deadStones, komi) {
  const size = board.length;
  const work = board.map((line) => line.slice());
  for (const { row, col } of deadStones) {
    work[row][col] = null;
  }
  let stones = { black: 0, white: 0 };
  for (const line of work) {
    for (const cell of line) {
      if (cell) stones[cell] += 1;
    }
  }
  let territory = { black: 0, white: 0 };
  const seen = Array.from({ length: size }, () => Array(size).fill(false));
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (work[row][col] !== null || seen[row][col]) continue;
      const region = [];
      const borders = new Set();
      const stack = [[row, col]];
      seen[row][col] = true;
      while (stack.length > 0) {
        const [r, c] = stack.pop();
        region.push([r, c]);
        for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
          if (work[nr][nc] === null) {
            if (!seen[nr][nc]) {
              seen[nr][nc] = true;
              stack.push([nr, nc]);
            }
          } else {
            borders.add(work[nr][nc]);
          }
        }
      }
      if (borders.size === 1) {
        territory[borders.has('black') ? 'black' : 'white'] += region.length;
      }
    }
  }
  const blackTotal = stones.black + territory.black;
  const whiteTotal = stones.white + territory.white + komi;
  return {
    blackArea: blackTotal,
    whiteArea: stones.white + territory.white,
    komi,
    blackTotal,
    whiteTotal,
    winner:
      blackTotal > whiteTotal ? 'black' : blackTotal < whiteTotal ? 'white' : 'draw',
    margin: Math.abs(blackTotal - whiteTotal),
  };
}

// ---------------------------------------------------------------------------
// The scripted game
// ---------------------------------------------------------------------------

let failures = 0;
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${condition || !detail ? '' : ` — ${detail}`}`);
}

const ROOM = `e2ego${Date.now() % 1000000}`;

/** Human (REST, black) and agent (MCP, white) placements, in order. */
const BLACK_MOVES = [
  [4, 4], [4, 5], [3, 4], [1, 1], [5, 5], [2, 1], [1, 2], [6, 6],
];
const WHITE_MOVES = [
  [7, 7], [7, 6], [0, 0], [2, 2], [3, 2], [8, 8], [8, 7],
];

async function humanMove(state, row, col, label) {
  const next = await rest('POST', `/rooms/${ROOM}/moves`, {
    row,
    col,
    actor: 'human',
  });
  check(label, next.state.game === 'go' && next.state.status === 'playing');
  return next.state;
}

async function agentPlace(agent, row, col, label) {
  const wait = await agent.tool('wait_for_turn', {
    roomId: ROOM,
    timeoutMs: 60_000,
  });
  check(`${label} · wait_for_turn -> your_turn`, wait.reason === 'your_turn', `got ${wait.reason}`);
  const next = await agent.tool('place_stone', { roomId: ROOM, row, col });
  check(label, next.state.status === 'playing');
  return next.state;
}

async function agentPass(agent, label) {
  const wait = await agent.tool('wait_for_turn', {
    roomId: ROOM,
    timeoutMs: 60_000,
  });
  check(`${label} · wait_for_turn -> your_turn`, wait.reason === 'your_turn', `got ${wait.reason}`);
  const next = await agent.tool('pass', { roomId: ROOM });
  return next.state;
}

async function main() {
  console.log(`e2e-go-web: room ${ROOM} on ${BASE}`);

  // 0. A fresh room and a Go game opened from the human side.
  await rest('POST', '/rooms', { roomId: ROOM });
  let state = (await rest('POST', `/rooms/${ROOM}/games`, {
    agentColor: 'white',
    game: 'go',
  })).state;
  check('new_game game:go → 9×9 GoState, playing, komi 7.5',
    state.game === 'go' && state.status === 'playing' &&
    state.rules.boardSize === 9 && state.rules.komi === 7.5);

  // 1. The agent joins through MCP and is seated white.
  const agent = new McpAgent('e2e-go-agent');
  await agent.connect();
  const joined = await agent.tool('join_game', {
    roomId: ROOM,
    name: 'E2E-Agent',
    seat: 'white',
  });
  check('agent join_game → white seat',
    joined.yourColor === 'white' || joined.state?.seats?.white?.kind === 'agent',
    JSON.stringify(joined).slice(0, 200));

  // 2. Openings. Black (web/REST) and white (MCP) alternate.
  console.log('\n— opening: alternating placements —');
  state = await humanMove(state, ...BLACK_MOVES[0], 'black 1 (4,4)');
  state = await agentPlace(agent, ...WHITE_MOVES[0], 'white 2 (7,7)');
  state = await humanMove(state, ...BLACK_MOVES[1], 'black 3 (4,5)');
  state = await agentPlace(agent, ...WHITE_MOVES[1], 'white 4 (7,6)');
  state = await humanMove(state, ...BLACK_MOVES[2], 'black 5 (3,4)');
  state = await agentPlace(agent, ...WHITE_MOVES[2], 'white 6 (0,0) — doomed corner stone');
  state = await humanMove(state, ...BLACK_MOVES[3], 'black 7 (1,1)');

  // 3. A mid-game pass: one pass must NOT end the game.
  console.log('\n— mid-game pass, then play continues —');
  state = await agentPass(agent, 'white 8 passes');
  check('one pass → still playing, consecutivePasses 1',
    state.status === 'playing' && state.consecutivePasses === 1);
  state = await humanMove(state, ...BLACK_MOVES[4], 'black 9 (5,5) answers the pass');
  check('a placement resets consecutivePasses to 0', state.consecutivePasses === 0);
  state = await agentPlace(agent, ...WHITE_MOVES[3], 'white 10 (2,2)');
  state = await humanMove(state, ...BLACK_MOVES[5], 'black 11 (2,1)');
  state = await agentPlace(agent, ...WHITE_MOVES[4], 'white 12 (3,2)');
  state = await humanMove(state, ...BLACK_MOVES[6], 'black 13 (1,2)');
  state = await agentPlace(agent, ...WHITE_MOVES[5], 'white 14 (8,8)');

  // 4. Two passes enter scoring; turn stays where the last pass left it.
  console.log('\n— two passes → scoring —');
  const turnBeforeScoring = state.turn; // black: white 14 just played
  state = (await rest('POST', `/rooms/${ROOM}/pass`, { actor: 'human' })).state;
  check('human pass → still playing, consecutivePasses 1',
    state.status === 'playing' && state.consecutivePasses === 1);
  state = await agentPass(agent, 'white passes');
  check('second pass → scoring, turn preserved (the side that would have played next)',
    state.status === 'scoring' && state.turn === turnBeforeScoring,
    `status ${state.status} turn ${state.turn} (expected ${turnBeforeScoring})`);
  check('fresh scoring has no marks or confirmations',
    state.deadStones.length === 0 && !state.scoreConfirmed.black && !state.scoreConfirmed.white);

  // 5. Scoring: toggles, confirmations, resets, resume.
  console.log('\n— scoring: mark, confirm, reset, resume —');
  state = (await rest('POST', `/rooms/${ROOM}/dead-stones`, {
    row: 0, col: 0, actor: 'human',
  })).state;
  check('human marks the corner stone dead (whole block)',
    state.deadStones.length === 1 && state.deadStones[0].row === 0 && state.deadStones[0].col === 0);

  await agent.tool('wait_for_turn', { roomId: ROOM, timeoutMs: 60_000 })
    .then((wait) => check('agent wait during scoring → reason scoring', wait.reason === 'scoring', `got ${wait.reason}`));
  state = (await agent.tool('confirm_score', { roomId: ROOM })).state;
  check('agent confirms', state.scoreConfirmed.white === true && state.scoreConfirmed.black === false);

  state = (await rest('POST', `/rooms/${ROOM}/dead-stones`, {
    row: 0, col: 0, actor: 'human',
  })).state;
  check('human toggles the same block off — marks empty AND the agent confirmation reset',
    state.deadStones.length === 0 && state.scoreConfirmed.white === false,
    JSON.stringify({ dead: state.deadStones, confirmed: state.scoreConfirmed }));

  state = (await rest('POST', `/rooms/${ROOM}/dead-stones`, {
    row: 0, col: 0, actor: 'human',
  })).state;
  check('human re-marks the block dead', state.deadStones.length === 1);

  state = (await agent.tool('confirm_score', { roomId: ROOM })).state;
  check('agent confirms again', state.scoreConfirmed.white === true);

  state = (await rest('POST', `/rooms/${ROOM}/score/resume`, { actor: 'human' })).state;
  check('resume_play → playing, marks cleared, pass count reset',
    state.status === 'playing' && state.deadStones.length === 0 && state.consecutivePasses === 0,
    `status ${state.status}`);

  // 6. A little more play, then the real end: two passes, mark, both confirm.
  console.log('\n— final round: two passes, mark dead, both confirm —');
  // resume_play preserved the turn (black here), so black leads this round.
  state = await humanMove(state, ...BLACK_MOVES[7], 'black (6,6)');
  state = await agentPlace(agent, ...WHITE_MOVES[6], 'white (8,7)');

  state = (await rest('POST', `/rooms/${ROOM}/pass`, { actor: 'human' })).state;
  check('human pass → still playing', state.status === 'playing');
  state = await agentPass(agent, 'white passes');
  check('scoring again', state.status === 'scoring');

  state = (await rest('POST', `/rooms/${ROOM}/dead-stones`, {
    row: 0, col: 0, actor: 'human',
  })).state;
  check('human marks the corner stone dead', state.deadStones.length === 1);

  await agent.tool('wait_for_turn', { roomId: ROOM, timeoutMs: 60_000 })
    .then((wait) => check('agent woken for scoring', wait.reason === 'scoring', `got ${wait.reason}`));
  state = (await agent.tool('confirm_score', { roomId: ROOM })).state;
  check('agent confirms', state.scoreConfirmed.white === true && state.status === 'scoring');

  state = (await rest('POST', `/rooms/${ROOM}/score/confirm`, { actor: 'human' })).state;
  check('both confirmed → finished with endReason scored',
    state.status === 'finished' && state.endReason === 'scored');

  // 7. The score: fields, arithmetic, and an independent recount.
  const score = state.score;
  check('score present with komi 7.5', score !== null && score.komi === 7.5);
  check('whiteTotal = whiteArea + komi', score.whiteTotal === score.whiteArea + 7.5);
  check('blackTotal = blackArea', score.blackTotal === score.blackArea);
  check('margin = |black − white|', score.margin === Math.abs(score.blackTotal - score.whiteTotal));
  const expected = recount(state.board, state.deadStones, 7.5);
  check('independent recount of the final board matches the server score',
    JSON.stringify(expected) === JSON.stringify(score),
    `recount ${JSON.stringify(expected)} vs server ${JSON.stringify(score)}`);

  const over = await agent.tool('wait_for_turn', { roomId: ROOM, timeoutMs: 5_000 });
  check('agent sees game_over', over.reason === 'game_over', `got ${over.reason}`);

  console.log(`\nresult: ${state.winner === 'draw' ? 'draw' : `${state.winner} wins`} by ${score.margin} — ` +
    `black ${score.blackTotal} / white ${score.whiteTotal} (komi ${score.komi})`);

  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((error) => {
  console.error('\ne2e failed:', error.message);
  process.exit(1);
});
