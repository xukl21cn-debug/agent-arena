/**
 * Drives the white seat through MCP for the browser smoke test: waits for its
 * turn, then acts on a fixed plan (move, move, wait-long, pass). Each action
 * is delayed so a human (or a browser test) can watch the states in between.
 *
 *   node scripts/smoke-go-white.mjs <roomId>
 */
const ROOM = process.argv[2] ?? 'gosmoke';
const BASE = process.env.ARENA_URL ?? 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        } catch {}
      }
    } else {
      message = await res.json();
    }
    const newSession = res.headers.get('mcp-session-id');
    if (newSession) this.sessionId = newSession;
    if (!message || message.id !== id) {
      throw new Error(`no matching response for ${method}`);
    }
    if (message.error) throw new Error(JSON.stringify(message.error));
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
    if (result.isError) throw new Error(`tool ${name}: ${JSON.stringify(result.content)}`);
    const text = result.content?.find((i) => i.type === 'text')?.text;
    return JSON.parse(text);
  }
}

const PLAN = [
  { action: 'place', row: 0, col: 0, note: 'doomed corner stone' },
  { action: 'place', row: 8, col: 8, note: 'far corner' },
  { action: 'place', row: 8, col: 7, note: 'answering the pass' },
  { action: 'pass', note: 'second pass enters scoring' },
  { action: 'confirm', note: 'confirm the score' },
];

async function main() {
  const agent = new McpAgent('smoke-white');
  await agent.connect();
  await agent.tool('join_game', { roomId: ROOM, name: 'Smoke-White', seat: 'white' });
  console.log(`[white] joined ${ROOM}, following the plan`);

  let step = 0;
  while (step < PLAN.length) {
    const wait = await agent.tool('wait_for_turn', { roomId: ROOM, timeoutMs: 60_000 });
    console.log(`[white] wait -> ${wait.reason}`);
    if (wait.reason === 'game_over') break;
    if (wait.reason !== 'your_turn' && wait.reason !== 'scoring') continue;

    const action = PLAN[step];
    console.log(`[white] thinking about: ${action.note} (${action.action})`);
    await sleep(2_000); // leave a window to watch the UI
    if (action.action === 'place') {
      await agent.tool('place_stone', { roomId: ROOM, row: action.row, col: action.col });
    } else if (action.action === 'pass') {
      await agent.tool('pass', { roomId: ROOM });
    } else if (action.action === 'confirm') {
      await agent.tool('confirm_score', { roomId: ROOM });
    }
    step += 1;
  }
  console.log('[white] plan done');
}

main().catch((error) => {
  console.error('[white] failed:', error.message);
  process.exit(1);
});
