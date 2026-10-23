#!/usr/bin/env node
// Game 2 replay: 2026-10-23, room "default", 25 moves, black (human) wins —
// white (agent, GLM) resigned after black's (4,7) 四三 double kill matured
// into an unstoppable open four.
//
// Companion to docs/GAME-2026-10-23-2.md and the v0.4 proposal: at the
// move-21 checkpoint, black's (4,7) shows only as a `four` candidate; the
// open three it simultaneously creates on the r+c=11 anti-diagonal is not
// merged into the point's classification. That missing merge is exactly the
// v0.4 "double-threat detection" feature request.
//
// Run from repo root: node scripts/replay-game2.mjs
import { createBoard } from '../server/dist/core/rules.js';
import { toAgentStateView } from '../server/dist/core/insights.js';

const MOVES = [
  [7, 7], [8, 8], [7, 8], [7, 9], [9, 7], [8, 7], [8, 9], [9, 8],
  [7, 6], [7, 5], [6, 7], [9, 10], [5, 6], [4, 5], [5, 8], [8, 5],
  [5, 7], [5, 5], [6, 5], [8, 6], [8, 4], [8, 10], [4, 7], [3, 7], [7, 4],
];

const CHECKPOINTS = new Map([
  [11, '黑11 (6,7) 第一次两头开三连 → (5,6)/(9,10) 双开四候选；白12 实际选 (9,10) 拆点'],
  [17, '黑17 (5,7) 第二次两头开三连 → (5,5)/(5,9) 双开四候选；白18 实际选 (5,5)（拆点+封三+己方冲四）'],
  [21, '黑21 (8,4) 后 = v0.4 关键局面：白22 的实际选择是发展 (8,10)。黑候选里 (4,7) 只标 four、(3,8) 只标 open3 —— (4,7) 落子同时制造的「冲四 + 活三」没有被合并标注，正确下法应是抢占 (4,7) 或 (3,8)'],
  [23, '黑23 (4,7) 四三双杀成立：竖七冲四 (fiveAt 3,7) + 斜活三 (4,7)(5,6)(6,5)；雷达上 (3,7):win 且 (3,8)/(7,4):open4'],
  [25, '黑25 (7,4) 开四落地：(3,8)/(8,3) 双 win 点，白方认输'],
]);

const rules = { boardSize: 15, winLength: 5, overlineWin: true, forbidden: 'none' };
const board = createBoard(15);
const history = [];

const fmt = (list) => list.slice(0, 8).map((p) =>
  `(${p.row},${p.col}):${p.effect}` + (p.fiveAt.length
    ? `[5at ${p.fiveAt.map((f) => `${f.row},${f.col}`).join(' & ')}]`
    : '')
).join(' ');

MOVES.forEach(([row, col], i) => {
  const index = i + 1;
  const color = index % 2 === 1 ? 'black' : 'white';
  if (board[row][col] !== null) throw new Error(`double placement at move ${index} (${row},${col})`);
  board[row][col] = color;
  history.push({ row, col, color, index, at: '' });

  if (!CHECKPOINTS.has(index)) return;
  const finished = index === 25;
  const state = {
    schemaVersion: 1,
    roomId: 'default',
    gameId: 'game-2',
    rules,
    board,
    turn: finished || index % 2 === 0 ? 'black' : 'white',
    seats: { black: { kind: 'human' }, white: { kind: 'agent' } },
    status: finished ? 'finished' : 'playing',
    winner: finished ? 'black' : null,
    endReason: finished ? 'resign' : null,
    winLine: null,
    lastMove: history[history.length - 1],
    moveCount: index,
    version: index,
    updatedAt: '',
  };
  const view = toAgentStateView(state, history);
  console.log(`\n===== 第 ${index} 手后：${CHECKPOINTS.get(index)} =====`);
  console.log(view.boardText);
  console.log(`hotPoints X: ${fmt(view.hotPoints.black) || '(无)'}`);
  console.log(`hotPoints O: ${fmt(view.hotPoints.white) || '(无)'}`);
});

console.log('\n===== 完整棋谱 =====');
console.log(history.map((m) => `${m.index}${m.color === 'black' ? 'X' : 'O'}(${m.row},${m.col})`).join(' '));
