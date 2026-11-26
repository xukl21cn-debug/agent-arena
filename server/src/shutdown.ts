import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';

/** Close code for "the server is going away": a clean close, not a dropped socket. */
const GOING_AWAY = 1001;

/**
 * Stop listening, close every connection, and resolve once the server is
 * really down.
 *
 * `server.close()` alone never finishes while a browser tab is open: a socket
 * that was upgraded to WebSocket is no longer tracked by the HTTP server, so
 * neither `close()` nor `closeAllConnections()` reaches it, and the close
 * callback waits for it forever. Closing the WebSocket clients is what lets
 * the callback fire; one that does not answer the close handshake is dropped
 * by ws after its own timeout.
 *
 * Rejects when the server was not listening.
 */
export function closeServer(server: Server, wss: WebSocketServer): Promise<void> {
  wss.close();
  for (const client of wss.clients) client.close(GOING_AWAY);
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // Idle keep-alive sockets and anything still mid-request: do not wait for
    // their next request to arrive or time out.
    server.closeAllConnections();
  });
}
