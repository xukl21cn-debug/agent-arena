/**
 * 全站错误文案的唯一入口。
 *
 * 服务端的错误契约仍然是 `{ code, message }`：界面只显示中文，优先使用
 * code 对应的本地文案；`message` 原文仅留给开发控制台，避免英文、裸 code
 * 或内部细节直接出现在用户面前。未知错误一律用中文兜底。
 */

/** 已知错误 code 的中文文案（游戏域 + 聊天域）。 */
const CODE_TEXT: Readonly<Record<string, string>> = {
  // 房间 / 参与者
  ROOM_NOT_FOUND: '房间不存在或已删除。',
  ROOM_EXISTS: '房间已存在，换一个房间号试试。',
  ROOM_BUSY: '房间还在进行中，暂时不能删除。',
  INVALID_ROOM_ID: '房间号格式不正确。',
  NO_AGENT_SEAT: '房间里没有 AI 座位。',
  IDENTITY_REQUIRED: '无法确认你的身份，请刷新页面后重试。',
  PARTICIPANT_NOT_FOUND: '找不到这位参与者。',
  NOT_SEATED: '你在这间房没有座位。',
  AMBIGUOUS_ACTOR: '房间里有多个同名参与者，无法确定操作者。',
  SEAT_TAKEN: '这个座位已经有人了。',

  // 对局
  GAME_NOT_PLAYING: '当前没有进行中的对局。',
  NOT_YOUR_TURN: '还没轮到你。',
  OUT_OF_BOUNDS: '落子位置超出棋盘范围。',
  CELL_OCCUPIED: '这个位置已经有棋子了。',
  INVALID_COMMENTARY: '解说内容不符合要求。',
  SUICIDE: '不能自杀落子：这一步下完棋子没有气。',
  KO: '打劫：不能立即回提。',
  WRONG_GAME: '当前房间不是这种玩法。',
  NOT_SCORING: '当前不在数子阶段。',
  INVALID_DEAD_STONE: '这个位置没有可以标记的棋子。',
  UNSUPPORTED_RULE: '暂不支持这组规则。',

  // 回放
  ARCHIVE_NOT_FOUND: '没有找到这份棋谱，可能已经被删除。',
  NO_MOVES: '这间房还没有下过棋，暂无回放。',
  REPLAY_TOO_LONG: '这局棋的步数太多，暂时无法回放。',
  REPLAY_FAILED: '棋谱解析失败，无法回放。',

  // 聊天
  ROOM_CLOSED: '房间已经关闭。',
  ROOM_PAUSED: '房间已暂停，等主持人恢复后才能继续。',
  MEMBER_NOT_FOUND: '找不到这位成员，可能已经离开房间。',
  MEMBER_LIMIT_REACHED: '你的发言已达上限，轮次已交给下一位。',
  DUPLICATE_MESSAGE: '上一条消息内容相同，换句话再说吧。',
  MESSAGE_TOO_LONG: '消息太长，请精简后再发。',

  // 通用
  INVALID_REQUEST: '请求参数不正确。',
  BACKEND_UNAVAILABLE: '后端服务暂时不可用。',
  INTERNAL_ERROR: '服务出了点问题，请稍后重试。',
  NETWORK_ERROR: '网络连接失败，请检查网络后重试。',
};

interface MessageRule {
  pattern: RegExp;
  /** `m` is the regex match; capture groups carry the server's numbers/names. */
  format: (m: RegExpExecArray) => string;
}

/**
 * 服务端英文 `message` 的兜底翻译。code 覆盖不到的旧接口或合成错误（例如
 * HTTP 状态兜底）也能落到中文；带数字的错误保留具体数字。
 */
const MESSAGE_RULES: ReadonlyArray<MessageRule> = [
  {
    pattern: /^Room "[^"]*" not found\.$/,
    format: () => '房间不存在或已删除。',
  },
  {
    pattern: /^Archive "[^"]*" not found\.$/,
    format: () => '没有找到这份棋谱，可能已经被删除。',
  },
  {
    pattern: /^Room "[^"]*" has not played a game yet\.$/,
    format: () => '这间房还没有下过棋，暂无回放。',
  },
  {
    pattern: /^Message is (\d+) characters; the limit is (\d+)\.$/,
    format: (m) => `消息太长：当前 ${m[1]} 字，上限 ${m[2]} 字。`,
  },
  {
    pattern: /^Message text must not be empty\.$/,
    format: () => '消息不能为空。',
  },
  {
    pattern: /^Chat room "[^"]*" is closed\.$/,
    format: () => '房间已关闭，不能再发消息。',
  },
  {
    pattern: /^(?:The room|Chat room "[^"]*") is paused; wait for the host to resume it\.$/,
    format: () => '房间已暂停，等主持人恢复后才能继续。',
  },
  {
    pattern:
      /^No member "[^"]*" in this room; check the member list in the snapshot\.$/,
    format: () => '房间里没有这位成员，请检查成员列表。',
  },
  {
    pattern: /^"to" must name an agent member; "[^"]*" does not hold turns\.$/,
    format: () => '只能点名 agent 成员，这位成员不持有轮次。',
  },
  {
    pattern:
      /^You have sent \d+ messages, the per-member limit is \d+\. The turn moved on\.$/,
    format: () => '你的发言已达上限，轮次已交给下一位。',
  },
  {
    pattern: /^Your last message is identical; rephrase instead of repeating\.$/,
    format: () => '上一条消息内容相同，换句话再说吧。',
  },
  {
    pattern: /^Chat room "[^"]*" holds \d+ messages and is \w+; close it before deleting\.$/,
    format: () => '房间还有未关闭的记录，请先关闭房间再删除。',
  },
  {
    pattern: /^Room "[^"]*" is playing; finish or abandon the game before deleting it\.$/,
    format: () => '房间对局进行中，请先结束对局再删除。',
  },
  {
    pattern: /^Request body is not valid JSON\.$/,
    format: () => '请求内容不是有效的 JSON。',
  },
  {
    pattern: /^Request body is too large\.$/,
    format: () => '请求内容过大。',
  },
  {
    pattern: /^Request body must be a JSON object\.$/,
    format: () => '请求内容格式不正确。',
  },
  {
    pattern: /^Internal server error\.$/,
    format: () => '服务出了点问题，请稍后重试。',
  },
  {
    pattern: /^Route not found\.$/,
    format: () => '页面不存在。',
  },
  {
    pattern: /^Game is not in progress\.$/,
    format: () => '当前没有进行中的对局。',
  },
  {
    pattern: /^It is (black|white)'s turn\.$/,
    format: (m) => `还没轮到你（现在轮到${m[1] === 'black' ? '黑方' : '白方'}）。`,
  },
  {
    pattern: /^(?:Cell|Point) \((\d+),(\d+)\) is (?:already )?occupied\.$/,
    format: () => '这个位置已经有棋子了。',
  },
  {
    pattern:
      /^The game is in the scoring phase; use mark_dead \/ confirm_score \/ resume_play\.$/,
    format: () => '当前处于数子阶段，请使用数子面板操作。',
  },
  {
    pattern: /^Participant "[^"]*" is not in room "[^"]*"\.$/,
    format: () => '找不到这位参与者。',
  },
];

const HAN = /\p{Script=Han}/u;

/** `message` 是否已经是中文（服务端有些错误本来就是中文，保留更具体的信息）。 */
function hasChinese(text: string): boolean {
  return HAN.test(text);
}

/**
 * 把一个错误 code / message 转成中文界面文案。
 *
 * 顺序：英文 message 的已知模式（保留数字等细节）→ 已是中文的 message →
 * code 映射 → 中文兜底。原始文本只在开发模式打一条 console.warn，便于排查。
 */
export function errorText(
  code?: string | null,
  message?: string | null,
): string {
  const raw = typeof message === 'string' ? message.trim() : '';
  if (import.meta.env.DEV) {
    console.warn('[error]', code ?? '(no code)', raw || '(no message)');
  }
  if (raw !== '' && !hasChinese(raw)) {
    for (const rule of MESSAGE_RULES) {
      const match = rule.pattern.exec(raw);
      if (match) {
        return rule.format(match);
      }
    }
  }
  if (raw !== '' && hasChinese(raw)) {
    return raw;
  }
  if (typeof code === 'string' && code !== '') {
    const text = CODE_TEXT[code];
    if (text !== undefined) {
      return text;
    }
  }
  return '操作失败，请稍后重试。';
}

/** `errorMessage` 的集中实现：ApiError / Error / 未知值统一走中文文案。 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const coded = error as { code?: unknown; message?: unknown };
    const code = typeof coded.code === 'string' ? coded.code : null;
    const message =
      typeof coded.message === 'string' ? coded.message : null;
    if (code !== null || message !== null) {
      return errorText(code, message);
    }
  }
  return '发生未知错误，请稍后重试。';
}
