/**
 * P4-C14: two real MCP clients converse through /chat/mcp.
 *
 *   node scripts/chat-duel.mjs           # needs the server on :3000
 *   ARENA_URL=http://127.0.0.1:3100 node scripts/chat-duel.mjs
 *
 * The script creates the room over REST (as the human host would), opens
 * with a question aimed at agent A, then both agents park on
 * wait_for_messages and take relay turns until each has said its piece.
 * Asserts: long-poll really parks and wakes, turns rotate, hop counts,
 * out-of-turn refusal, and the transcript holds the whole exchange.
 */

const BASE = process.env.ARENA_URL ?? 'http://127.0.0.1:3000';
const ROOM = `duel${Date.now() % 100000}`;

let failures = 0;
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${condition || !detail ? '' : ` — ${detail}`}`);
}

class ChatAgent {
  constructor(name) {
    this.name = name;
    this.sessionId = null;
    this.nextId = 1;
    this.participantId = null;
  }

  async rpc(method, params, { notification = false } = {}) {
    const id = notification ? undefined : this.nextId++;
    const res = await fetch(`${BASE}/chat/mcp`, {
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
      if (!res.ok) throw new Error(`notify ${method} -> ${res.status}`);
      return null;
    }
    const contentType = res.headers.get('content-type') ?? '';
    let message = null;
    if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const parsed = JSON.parse(line.slice(5).trim());
          if (parsed.id === id) message = parsed;
        } catch {
          // keep-alive frames are not JSON
        }
      }
    } else {
      message = await res.json();
    }
    const newSession = res.headers.get('mcp-session-id');
    if (newSession) this.sessionId = newSession;
    if (!message || message.id !== id) {
      throw new Error(`no matching response for ${method}`);
    }
    if (message.error) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
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
    const text = result.content?.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error(`tool ${name}: no text content`);
    const payload = JSON.parse(text);
    if (result.isError) {
      throw new Error(`tool ${name}: ${text}`);
    }
    return payload;
  }

  async join(roomId) {
    const joined = await this.tool('join_room', { roomId, name: this.name });
    this.participantId = joined.participantId;
    return joined;
  }

  /** Park until the turn is ours, relaying every message we see. */
  async waitMyTurn({ maxMs = 60_000 } = {}) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const seen = await this.tool('wait_for_messages', { roomId: ROOM, timeoutMs: 10_000 });
      for (const message of seen.messages) {
        console.log(`    [${ROOM}] ${message.from}: ${message.text}`);
      }
      if (seen.yourTurn) return seen;
      if (seen.room.phase !== 'open') throw new Error(`room ${seen.room.phase} while waiting`);
    }
    throw new Error('timed out waiting for the turn');
  }
}

async function main() {
  console.log(`chat-duel: room ${ROOM} on ${BASE}`);

  // The human host creates the room; agents join before the host names one.
  const created = await fetch(`${BASE}/api/chat/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: ROOM, title: 'agent-茶话会' }),
  });
  check('REST 建房 201', created.status === 201);

  const dsh = new ChatAgent('dsh');
  const codex = new ChatAgent('codex');
  await dsh.connect();
  await codex.connect();
  const dshJoin = await dsh.join(ROOM);
  const codexJoin = await codex.join(ROOM);
  check('两 agent 加入且身份不同',
    typeof dshJoin.participantId === 'string' && dshJoin.participantId !== codexJoin.participantId);

  const open = await fetch(`${BASE}/api/chat/rooms/${ROOM}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: '问你们一个技术问题：MCP 长轮询和 WebSocket 该怎么选？dsh 先说。',
      to: 'dsh',
    }),
  });
  check('human 开场并点名 dsh', open.status === 201);

  // Naming an absent member must be an honest 400, not a silent appointment.
  const ghost = await fetch(`${BASE}/api/chat/rooms/${ROOM}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '点名不存在的人', to: 'nobody' }),
  });
  check('点名未加入成员被拒 400',
    ghost.status === 400 && (await ghost.json()).error.code === 'MEMBER_NOT_FOUND');

  // dsh parks AFTER the opening message: the wait must return at once
  // because the turn is already ours.
  const t0 = Date.now();
  const dshTurn = await dsh.tool('wait_for_messages', { roomId: ROOM });
  check('轮到自己时 wait 立即返回', dshTurn.yourTurn === true && Date.now() - t0 < 3000);

  // codex parks while dsh thinks; dsh's send must wake it.
  const codexParked = codex.tool('wait_for_messages', { roomId: ROOM, timeoutMs: 30_000 });
  let parked = true;
  codexParked.then(() => { parked = false; });
  await new Promise((r) => setTimeout(r, 500));
  check('codex 的 wait 真的挂起', parked);

  await dsh.tool('send_message', {
    roomId: ROOM,
    text: '选长轮询：无状态、过代理友好，我们的工具调用本来就是一问一答。',
    to: 'codex',
  });
  const codexWoken = await codexParked;
  check('dsh 发言唤醒了挂起的 codex', codexWoken.timedOut === false);
  check('唤醒带回 dsh 的新消息',
    (codexWoken.messages ?? []).some((m) => m.from === 'dsh'));
  check('转交后轮到 codex', codexWoken.yourTurn === true);

  // dsh parks again; codex's message (aimed at dsh) must wake it.
  const dshParked = dsh.tool('wait_for_messages', { roomId: ROOM, timeoutMs: 30_000 });
  await new Promise((r) => setTimeout(r, 300));
  await codex.tool('send_message', {
    roomId: ROOM,
    text: '补充：双向推送需求出现了再上 WS，别为聊天室养一条常驻连接。',
    to: 'dsh',
  });
  const dshSecond = await dshParked;
  check('codex 发言唤醒 dsh',
    dshSecond.timedOut === false &&
    (dshSecond.messages ?? []).some((m) => m.from === 'codex'));

  // Out-of-turn refusal: codex just spoke, so it may not speak again.
  let refused = '';
  try {
    await codex.tool('send_message', { roomId: ROOM, text: '我再补一句' });
  } catch (error) {
    refused = error.message;
  }
  check('抢话被拒 NOT_YOUR_TURN', refused.includes('NOT_YOUR_TURN'), refused);

  // The host wraps up: close the room, agents must see it.
  await fetch(`${BASE}/api/chat/rooms/${ROOM}/close`, { method: 'POST' });
  const afterClose = await dsh.tool('wait_for_messages', { roomId: ROOM });
  check('关闭后 wait 带回 closed 房间', afterClose.room.phase === 'closed');
  check('hint 说房间已关闭', afterClose.hint.includes('已关闭'));

  const transcript = await dsh.tool('get_transcript', { roomId: ROOM, limit: 20 });
  const texts = (transcript.messages ?? []).map((m) => m.text).join('\n');
  check('转录含开场、双方发言',
    texts.includes('MCP 长轮询和 WebSocket') &&
    texts.includes('无状态、过代理友好') &&
    texts.includes('双向推送'));
  check('hop 计数 = 2 次 agent 发言', transcript.room.hop === 2,
    `got ${transcript.room?.hop}`);

  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((error) => {
  console.error('\nchat-duel failed:', error.message);
  process.exit(1);
});
