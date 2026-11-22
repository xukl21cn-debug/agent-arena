import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Identity of the MCP session a tool call arrived on.
 *
 * The HTTP transport knows the session id, but `ArenaApi` is constructed once
 * and shared by every session, so the id cannot travel as a constructor
 * argument. An async-local carrier keeps the interface unchanged: the request
 * handler runs each transport call inside `run`, and the API reads whatever
 * session that call belongs to.
 */
export interface SessionContext {
  /** Session id; filled in when the transport finishes initialization. */
  sessionId?: string;
  /** `clientInfo.name` the client reported during initialize. */
  client?: string;
}

export const sessionContext = new AsyncLocalStorage<SessionContext>();

/** The session the current call arrived on, when it arrived over HTTP MCP. */
export function currentSession(): SessionContext | undefined {
  return sessionContext.getStore();
}

/**
 * Which participant each session has claimed, per room.
 *
 * This is what makes identity invisible to the model: `join_game` binds the
 * session to a participant once, and every later tool call is routed by that
 * binding. A model never types a participant id, so it cannot mistype one or
 * impersonate another agent — the binding is the server's own record of who
 * connected, not something the caller asserts per call.
 *
 * The mapping lives outside the room so a session can hold seats in several
 * rooms, and outside `GameRoom` so a game reset does not forget who is here.
 */
export class SessionBindings {
  /** sessionId → (roomId → participantId) */
  private readonly bySession = new Map<string, Map<string, string>>();

  /** Remember that this session acts as `participantId` in `roomId`. */
  bind(sessionId: string, roomId: string, participantId: string): void {
    let rooms = this.bySession.get(sessionId);
    if (!rooms) {
      rooms = new Map();
      this.bySession.set(sessionId, rooms);
    }
    rooms.set(roomId, participantId);
  }

  /** The participant this session claims in a room, if it has joined. */
  participantOf(sessionId: string, roomId: string): string | undefined {
    return this.bySession.get(sessionId)?.get(roomId);
  }

  /** Drop every binding for a session (transport closed). */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Forget one room's binding, e.g. after leaving it. */
  unbind(sessionId: string, roomId: string): void {
    this.bySession.get(sessionId)?.delete(roomId);
  }
}
