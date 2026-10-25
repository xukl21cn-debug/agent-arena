import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  AGENT_RECENT_MOVES,
  DEFAULT_ROOM_ID,
  DEFAULT_WAIT_MS,
  MAX_COMMENTARY_LENGTH,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  ROOM_ID_PATTERN,
  type CommentaryKind,
  type CommentaryMood,
} from '@arena/shared';
import { ArenaApiError, type ArenaApi } from './api.js';
import { toAnyAgentStateView } from '../core/insights.js';

const COMMENTARY_KINDS = [
  'evaluation',
  'position',
  'reaction',
  'result',
  'banter',
] as const satisfies readonly CommentaryKind[];

const COMMENTARY_MOODS = [
  'neutral',
  'confident',
  'happy',
  'nervous',
  'surprised',
  'sad',
] as const satisfies readonly CommentaryMood[];

const roomIdSchema = z
  .string()
  .regex(ROOM_ID_PATTERN)
  .optional()
  .describe(
    `房间号，1-32 位字母/数字/下划线/连字符；默认 "${DEFAULT_ROOM_ID}"。v1 网页固定使用 default。`,
  );

export const SERVER_INSTRUCTIONS = `你是五子棋对弈 Agent，在 15×15 棋盘上与人类对弈。
坐标 0-based：row 从上到下，col 从左到右；黑先；无禁手，五连（含长连）获胜。

读盘方式（重要）：
- state.boardText 是等宽棋盘图：X=黑 O=白 .=空，小写 x/o=最新一手，#/@=五连；
- state.moves 是最近的走子记录；movesOmitted>0 表示更早的手数被省略，完整历史用 get_state 查；
- state.hotPoints 列出双方"落子即成威胁"的关键点：
  win=该点落子成五获胜 | open4=该点落子成两头开四（双杀）| four=该点落子成冲四（fiveAt 即成五点）| open3=活三（参考级）。
  double=该点同时制造两个独立必应威胁（four+open3 或双活三），open3At 给出活三的拆点——
  四三杀不能只当普通 four（挡完 fiveAt 还会被活三开四），双活三不能只拆一端。
禁止自己逐格重建棋盘或数数组——判断一律以 boardText 和 hotPoints 为准。

每次落子前，按以下优先级检查 hotPoints（先算胜，再算防）：
1. 自己的 win 点：直接落子获胜。
2. 对手的 win 点：必须占住；若对手已有两个 win 点，说明开四已成立无法全挡，选最能拖延或制造反击的一手。
3. 自己的 open4 候选点：优先落子，形成对手挡不住的双杀——它通常比防守对手的 open4 候选更快获胜。
4. 对手的 open4 候选点：必须在本手直接占掉该候选点本身（hotPoints[对手] 中 effect=open4 的 row/col）——
   等对方落子后再去挡 fiveAt 就已经晚了。
5. 对手的 double 点：本手优先占掉该点本身（hotPoints[对手] 中 double 非空的 row/col），不要下发展棋。
   - four+open3（double 含 four）：占不了时，可挡 fiveAt，或拆 open3At 的一端；之后还要防另一条线。
   - 双活三（double 只有 open3）：必须占点，或自己有更快的成五/开四；只拆一个端点挡不住两个活三。
6. 对手的 four 点：本手挡在其 fiveAt；不要等它落子。
7. 再往后才是自己的 double / four / open3；自己的 double 是两步杀，但没有上述必防项时才优先。
低阶威胁只作参考，不要为它们放弃上面的必防项。

标准流程：
1. 先调用 join_game 占座（name 用你的名字，seat 选执黑或执白）；之后所有调用都会自动以这个身份进行；
2. 调用 wait_for_turn 等待轮到你；
3. reason=your_turn 时，先调用 say 评价对手刚落的那一步（kind=evaluation），
   再按上述优先级依据 boardText / hotPoints 选择一个空位调用 place_stone；
4. 落子后调用 say 评论局势或表达情绪（kind=position / reaction），
   然后再次 wait_for_turn；
5. reason=game_over 时用 say（kind=result）总结胜负；
   reason=timeout 时再次调用 wait_for_turn；
   reason=idle 时可调用 new_game 或提示人类在网页开局。

房间里可能有两个 agent 对弈（join_game 返回的 participants 会显示）：
- 你只能操作自己座位那个颜色，不要替对手落子；
- 你的身份由服务端绑定，不要在参数里伪造别人的 id；
- 对手在思考时你调用 wait_for_turn 会挂起，这是正常的。

只能操作 yourColor 颜色的棋子，不要替人类落子。每次落子前确认目标格为空。
解说是对玩家说的话，简短、有个性，不要输出完整推理过程。`;

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  if (error instanceof ArenaApiError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            code: error.code,
            message: error.message,
            // Errors carry history when the transport knows it; when it is
            // genuinely unavailable the view says so via movesOmitted.
            state: error.state
              ? toAnyAgentStateView(error.state, error.history, {
                  recentMoves: AGENT_RECENT_MOVES,
                })
              : null,
          }),
        },
      ],
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ code: 'INTERNAL_ERROR', message, state: null }),
      },
    ],
  };
}

async function runTool(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return textResult(await action());
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * The single source of truth for the MCP tools. Both the in-process HTTP
 * transport and the stdio bridge register exactly these definitions, so every
 * client sees identical behaviour and descriptions.
 */
export function registerTools(server: McpServer, api: ArenaApi): void {
  server.registerTool(
    'join_game',
    {
      title: '加入房间',
      description: `加入一个房间并占座，之后所有工具调用都会自动以这个身份进行——你不需要再传任何 id。

- name：房间内显示名（如 "dsh"）。同名再次加入视为重连，会拿回原来的 id 和座位。
- seat：想执的颜色。省略则只进房间不占座（观战/等待）。占座会把原占座者挤成无座。
- 两个 agent 可以同房间对弈：各自 join_game 占不同颜色，然后各自 wait_for_turn。

返回 { participantId, name, seat, phase, state, participants }，participants 列出房间里其他人和他们的座位与 ready 状态。
连接后建议先调用本工具，再调用 wait_for_turn。`,
      inputSchema: z.object({
        roomId: roomIdSchema,
        name: z
          .string()
          .min(1)
          .max(24)
          .optional()
          .describe('房间内显示名，如 "dsh"；同名视为重连。'),
        seat: z
          .enum(['black', 'white'])
          .optional()
          .describe('想执的颜色；省略则只进房间不占座。'),
        kind: z
          .enum(['agent', 'human'])
          .optional()
          .describe('参与者类型，默认 agent。'),
        ready: z
          .boolean()
          .optional()
          .describe('加入即声明准备就绪（true）。双方都 ready 且座位齐全时会自动开局。'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ roomId, name, seat, kind, ready }) =>
      runTool(() =>
        api.joinGame(roomId ?? DEFAULT_ROOM_ID, {
          ...(name === undefined ? {} : { name }),
          ...(seat === undefined ? {} : { seat }),
          ...(kind === undefined ? {} : { kind }),
          ...(ready === undefined ? {} : { ready }),
        }),
      ),
  );

  server.registerTool(
    'leave_room',
    {
      title: '离开房间',
      description: `离开房间并释放座位。对局不会因此结束，只是这个座位变空。重连后需要重新 join_game。`,
      inputSchema: z.object({ roomId: roomIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ roomId }) => runTool(() => api.leaveGame(roomId ?? DEFAULT_ROOM_ID)),
  );

  server.registerTool(
    'new_game',
    {
      title: '开新局',
      description: `开始一局新的 15×15 五子棋（黑先，无禁手，五连或长连获胜）。
用 agentColor 选择 AI 执黑还是执白（默认 white），另一种颜色由人类执子。网页棋盘会立即重置。
roomId 指向不存在的房间时会自动创建；重复调用会直接覆盖当前对局，旧局作废。
若网页已经开局，通常不需要调用此工具。`,
      inputSchema: z.object({
        roomId: roomIdSchema,
        agentColor: z
          .enum(['black', 'white'])
          .optional()
          .describe('AI 执子颜色，默认 white。'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ roomId, agentColor }) =>
      runTool(() => api.newGame(roomId ?? DEFAULT_ROOM_ID, agentColor)),
  );

  server.registerTool(
    'get_state',
    {
      title: '读取棋局',
      description: `读取指定房间的完整棋局状态，不改变任何东西。返回 { state, yourColor }，state 不含二维数组，改为对 LLM 友好的三件套：
- state.boardText：等宽棋盘图（X=黑 O=白 .=空，小写 x/o=最新一手，#/@=五连），行列号 0-based；
- state.moves：完整走子记录（本工具不截断；其他工具只给最近几手，movesOmitted>0 时用本工具查全史）；
- state.hotPoints：双方"落子即成威胁"的点，effect 分级 win（落子成五）> open4（落子成开四双杀）> four（落子成冲四，fiveAt=成五点）> open3（活三，参考级）；
  double 表示同时制造两个独立必应威胁（four+open3 或双活三），open3At 给出活三拆点；
- 另有 state.turn / status / winner / endReason / winLine / lastMove / seats / version 等元信息。
用于断线重连后恢复上下文，或任何需要完整盘面的时刻。`,
      inputSchema: z.object({ roomId: roomIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ roomId }) => runTool(() => api.getState(roomId ?? DEFAULT_ROOM_ID)),
  );

  server.registerTool(
    'wait_for_turn',
    {
      title: '等轮到我',
      description: `挂起等待，直到轮到你落子、对局结束、开了新局或超时。timeoutMs 默认 ${DEFAULT_WAIT_MS}，范围 ${MIN_WAIT_MS}-${MAX_WAIT_MS}。
返回 { state, yourColor, reason }，state 含 boardText（等宽棋盘图）、moves（最近走子，movesOmitted>0 表示更早的已省略）、hotPoints（双方威胁点）：
- your_turn：轮到你了。落子前按优先级检查 hotPoints（先算胜，再算防）：
  ① 自己的 win 点直接下；② 对手的 win 点必占（若有两个，开四已成立，选最能拖延/反击的一手）；
  ③ 自己的 open4 候选优先下（通常比防守更快获胜）；④ 对手的 open4 候选必须本手直接占掉该点本身，
  等对方落子后再挡 fiveAt 就晚了；⑤ 对手的 double 点本手优先占点：four+open3 可退而挡 fiveAt/拆 open3At 一端，
  双活三必须占点或自己更快取胜，只拆一端挡不住；⑥ 对手的 four 本手挡在其 fiveAt，不要等；
  ⑦ 再往后才是自己的 double/four/open3。低阶只作参考。
- game_over：对局已结束，用 say(kind="result") 收尾；
- idle：还没有开局，请人类在网页点「新对局」，或自己调用 new_game；
- new_game：等待期间开了新局，按新状态继续；
- timeout：不是错误，立即再次调用 wait_for_turn 继续等待。

推荐循环：wait_for_turn → 先 say 评价人类刚落的那一步 → place_stone → say 评论局势 → 再次 wait_for_turn。
不要替人类落子；不要因为 timeout 就结束回合。`,
      inputSchema: z.object({
        roomId: roomIdSchema,
        timeoutMs: z
          .number()
          .int()
          .min(MIN_WAIT_MS)
          .max(MAX_WAIT_MS)
          .optional()
          .describe(`等待超时（毫秒），默认 ${DEFAULT_WAIT_MS}。`),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ roomId, timeoutMs }) =>
      runTool(() =>
        api.waitForTurn(roomId ?? DEFAULT_ROOM_ID, timeoutMs ?? DEFAULT_WAIT_MS),
      ),
  );

  server.registerTool(
    'place_stone',
    {
      title: '落子',
      description: `在 (row, col) 落下你的一颗棋子。坐标 0-based：row 从上到下 0-14，col 从左到右 0-14。
落子前按 wait_for_turn 里写的优先级检查 state.hotPoints：自己的 win 点直接取胜；对手的 win 点必占；
自己的 open4 候选优先下；对手的 open4 候选必须本手直接占掉该点本身（不要等它落子后再挡 fiveAt）；
对手的 double 点本手优先占点（four+open3 可退而挡 fiveAt/拆 open3At 一端；双活三必须占点或自己更快取胜）；
对手的 four 本手挡在其 fiveAt。
只能在自己的回合、用自己的颜色落子，且目标格必须为空（看 state.boardText 里该位置是否为 '.'）。
成功返回 { ok: true, state }（state 含更新后的 boardText / 最近走子 / hotPoints）；失败返回 isError 和 { code, message, state }：
- NOT_YOUR_TURN：还没轮到你，先调用 wait_for_turn；
- CELL_OCCUPIED / OUT_OF_BOUNDS：坐标不合法，换一个空位；
- GAME_NOT_PLAYING：当前没有进行中的对局，先 new_game。
落子后建议调用 say 评论局势，然后再次 wait_for_turn。`,
      inputSchema: z.object({
        roomId: roomIdSchema,
        row: z.number().int().min(0).describe('行号 0-14，从上到下。'),
        col: z.number().int().min(0).describe('列号 0-14，从左到右。'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ roomId, row, col }) =>
      runTool(async () => ({
        ok: true,
        state: await api.placeStone(roomId ?? DEFAULT_ROOM_ID, row, col),
      })),
  );

  server.registerTool(
    'resign',
    {
      title: '认输',
      description: `你认输，这一局由人类获胜。仅在进行中的对局可用；认输后不会再接受落子。
对局结束后用 say(kind="result") 向玩家告别，或调用 new_game 再来一局。
除非确定必败，不要轻易认输。返回 { state }。`,
      inputSchema: z.object({ roomId: roomIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ roomId }) =>
      runTool(async () => ({
        state: await api.resign(roomId ?? DEFAULT_ROOM_ID),
      })),
  );

  server.registerTool(
    'say',
    {
      title: '对玩家说话',
      description: `对玩家说一句解说，实时显示在网页「AI 互动」面板。这是给玩家看的话，不是内部推理：1-3 句、简短、有个性，最多 ${MAX_COMMENTARY_LENGTH} 字符（超出截断），空文本会被拒绝。
kind：evaluation=评价人类刚落的一步；position=自己落子后判断局势；reaction=被偷袭/失误/局势突变；result=对局结束；banter=闲聊挑衅。默认 reaction。
mood：neutral / confident / happy / nervous / surprised / sad，用于气泡配色，不影响规则。默认 neutral。
建议节奏：wait_for_turn 返回 your_turn 后先 say(kind="evaluation")，place_stone 后再 say(kind="position")；每回合 1-2 条即可。
返回 { ok: true, commentary }。`,
      inputSchema: z.object({
        roomId: roomIdSchema,
        text: z
          .string()
          .min(1)
          .describe(`要对玩家说的话，1-${MAX_COMMENTARY_LENGTH} 字符。`),
        kind: z
          .enum(COMMENTARY_KINDS)
          .optional()
          .describe('解说类型，默认 reaction。'),
        mood: z
          .enum(COMMENTARY_MOODS)
          .optional()
          .describe('情绪，用于前端配色，默认 neutral。'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ roomId, text, kind, mood }) =>
      runTool(async () => ({
        ok: true,
        commentary: await api.say(
          roomId ?? DEFAULT_ROOM_ID,
          text,
          kind,
          mood,
        ),
      })),
  );
}
