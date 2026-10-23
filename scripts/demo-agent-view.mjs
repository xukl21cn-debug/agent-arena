import { createBoard } from '../server/dist/core/rules.js';
import {
  findHotPoints,
  renderBoardText,
  toAgentStateView,
} from '../server/dist/core/insights.js';

// Exact position of game 1 right before black's winning move 47 (9,4):
// the final board minus (9,4) black and (7,2) white (played afterwards).
const stones = [
  // row 4
  ['white', 4, 5], ['black', 4, 6], ['black', 4, 7],
  // row 5
  ['black', 5, 4], ['white', 5, 5], ['white', 5, 6],
  ['white', 5, 7], ['black', 5, 8],
  // row 6
  ['black', 6, 3], ['white', 6, 4], ['black', 6, 5], ['black', 6, 6],
  ['black', 6, 7], ['black', 6, 8], ['white', 6, 9],
  // row 7
  ['white', 7, 4], ['black', 7, 5], ['white', 7, 6], ['black', 7, 7],
  ['white', 7, 8], ['black', 7, 9],
  // row 8
  ['black', 8, 3], ['white', 8, 5], ['white', 8, 6], ['black', 8, 7],
  ['white', 8, 8], ['black', 8, 9],
  // row 9
  ['black', 9, 5], ['white', 9, 6], ['white', 9, 7], ['white', 9, 8],
  ['white', 9, 9], ['black', 9, 10],
  // row 10
  ['black', 10, 5], ['white', 10, 6], ['white', 10, 7], ['black', 10, 8],
  ['white', 10, 9], ['white', 10, 10],
  // row 11
  ['white', 11, 5], ['black', 11, 6], ['black', 11, 8], ['white', 11, 9],
  // row 12-13
  ['black', 12, 4], ['white', 12, 9], ['black', 13, 9],
];

const board = createBoard(15);
for (const [color, row, col] of stones) {
  if (board[row][col] !== null) {
    throw new Error(`double placement at (${row},${col})`);
  }
  board[row][col] = color;
}

const rules = {
  boardSize: 15,
  winLength: 5,
  overlineWin: true,
  forbidden: 'none',
};
const state = {
  schemaVersion: 1,
  roomId: 'default',
  gameId: 'game-1',
  rules,
  board,
  turn: 'black',
  seats: { black: { kind: 'human' }, white: { kind: 'agent' } },
  status: 'playing',
  winner: null,
  endReason: null,
  winLine: null,
  lastMove: { row: 10, col: 10, color: 'white', index: 46, at: '' },
  moveCount: 46,
  version: 46,
  updatedAt: '',
};

// History is reconstructed positionally, so the exact move order is unknown
// here; passing null reports that honestly via movesOmitted.
const view = toAgentStateView(state, null);
console.log('=== boardText ===');
console.log(view.boardText);
console.log(`\nmovesOmitted: ${view.movesOmitted} (历史不可得时如实标注，完整对局服务端会给出 moves)`);
console.log('\n=== hotPoints.black (top 8) ===');
for (const point of view.hotPoints.black.slice(0, 8)) {
  const five = point.fiveAt.length
    ? ` fiveAt=${JSON.stringify(point.fiveAt)}`
    : '';
  console.log(`(${point.row},${point.col}) -> ${point.effect}${five}`);
}
console.log('\n=== hotPoints.white (top 5) ===');
for (const point of view.hotPoints.white.slice(0, 5)) {
  const five = point.fiveAt.length
    ? ` fiveAt=${JSON.stringify(point.fiveAt)}`
    : '';
  console.log(`(${point.row},${point.col}) -> ${point.effect}${five}`);
}
console.log(`\nblack total: ${view.hotPoints.black.length}, white total: ${view.hotPoints.white.length}`);
console.log(`boardText size: ${view.boardText.length} chars`);
