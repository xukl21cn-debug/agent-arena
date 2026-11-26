import http, { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { closeServer } from '../src/shutdown';

let server: Server | undefined;
let wss: WebSocketServer | undefined;
let agent: http.Agent | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.length = 0;
  agent?.destroy();
  wss?.close();
  const open = server;
  if (open?.listening) {
    open.closeAllConnections();
    await new Promise<void>((resolve) => open.close(() => resolve()));
  }
  server = undefined;
  wss = undefined;
  agent = undefined;
});

/** A server with the WebSocket server attached the way `attachWebSocket` does. */
function start(): Promise<string> {
  server = createServer((_req, res) => {
    res.end('ok');
  });
  wss = new WebSocketServer({ server, path: '/ws' });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
    });
  });
}

it('closes while a WebSocket client and an idle keep-alive socket are connected', async () => {
  const base = await start();
  // What an open browser tab looks like from the server: one upgraded socket
  // and one idle keep-alive connection.
  const tab = new WebSocket(`${base.replace('http:', 'ws:')}/ws`);
  sockets.push(tab);
  await new Promise<void>((resolve, reject) => {
    tab.once('open', resolve);
    tab.once('error', reject);
  });
  agent = new http.Agent({ keepAlive: true });
  let idle: Socket | undefined;
  await new Promise<void>((resolve, reject) => {
    http
      .get(`${base}/api/rooms`, { agent }, (res) => {
        res.resume();
        res.once('end', resolve);
      })
      .on('error', reject)
      .on('socket', (socket) => {
        idle = socket;
      });
  });
  const tabClosed = new Promise<number | undefined>((resolve) => {
    tab.once('close', (code) => resolve(code));
  });

  // `server.close()` on its own never calls back here: the upgraded socket is
  // not the HTTP server's to close. This timing out is the regression.
  const running = server!;
  await closeServer(running, wss!);

  expect(running.listening).toBe(false);
  // 1001 "going away": a clean close, not the 1006 of a dropped socket.
  expect(await tabClosed).toBe(1001);
  await Promise.race([once(idle!, 'close'), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  expect(idle!.destroyed).toBe(true);
});

it('rejects when the server was not listening', async () => {
  const idle = createServer();
  await expect(closeServer(idle, new WebSocketServer({ noServer: true }))).rejects.toThrow();
});
