import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Identity of the MCP session a tool call arrived on.
 *
 * The HTTP transport knows the session id, but `GomokuApi` is constructed once
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
