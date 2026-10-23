import { createBoard } from '../server/dist/core/rules.js';
import { toAgentStateView } from '../server/dist/core/insights.js';

// Payload-size regression check: the same 46-stone middlegame as
// demo-agent-view.mjs, with the history padded to 100 moves. Numbers are
// comparable across runs only when the board position is unchanged.
const stones = [
  ['white',4,5],['black',4,6],['black',4,7],
  ['black',5,4],['white',5,5],['white',5,6],['white',5,7],['black',5,8],
  ['black',6,3],['white',6,4],['black',6,5],['black',6,6],['black',6,7],['black',6,8],['white',6,9],
  ['white',7,4],['black',7,5],['white',7,6],['black',7,7],['white',7,8],['black',7,9],
  ['black',8,3],['white',8,5],['white',8,6],['black',8,7],['white',8,8],['black',8,9],
  ['black',9,5],['white',9,6],['white',9,7],['white',9,8],['white',9,9],['black',9,10],
  ['black',10,5],['white',10,6],['white',10,7],['black',10,8],['white',10,9],['white',10,10],
  ['white',11,5],['black',11,6],['black',11,8],['white',11,9],
  ['black',12,4],['white',12,9],['black',13,9],
];
const board = createBoard(15);
for (const [color, row, col] of stones) {
  board[row][col] = color;
}

const history = Array.from({ length: 100 }, (_, i) => ({
  row: Math.floor(i / 10),
  col: i % 10,
  color: i % 2 === 0 ? 'black' : 'white',
  index: i + 1,
  at: '',
}));
const state = {
  schemaVersion: 1,
  roomId: 'default',
  gameId: 'g1',
  rules: { boardSize: 15, winLength: 5, overlineWin: true, forbidden: 'none' },
  board,
  turn: 'black',
  seats: { black: { kind: 'human' }, white: { kind: 'agent' } },
  status: 'playing',
  winner: null,
  endReason: null,
  winLine: null,
  lastMove: { ...history[99], index: 100 },
  moveCount: 100,
  version: 100,
  updatedAt: '2026-10-23T00:00:00.000Z',
};

const view = toAgentStateView(state, history, { recentMoves: 8 });
const fullView = toAgentStateView(state, history);
const hotPath = JSON.stringify({ state: view, yourColor: 'white', reason: 'your_turn' });
const fullPath = JSON.stringify({ state: fullView, yourColor: 'white', reason: 'your_turn' });

console.log(`100-move hot-path (recent 8) : ${hotPath.length} chars  (budget: <= 4000)`);
console.log(`100-move get_state (full)    : ${fullPath.length} chars`);
console.log(`moves kept: ${view.moves.length}, movesOmitted: ${view.movesOmitted}`);
console.log(`boardText: ${view.boardText.length} chars, hotPoints: black ${view.hotPoints.black.length} / white ${view.hotPoints.white.length}`);
