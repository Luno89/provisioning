import type { Server as SocketServer } from 'socket.io';
import { signsEveryoneIn } from '../lib/auth.js';
import type { Database } from '../lib/db-interface.js';
import type { SocketSession } from '../lib/session-sockets.js';
import type { SessionSockets } from '../services/SessionSockets.js';
import type { Auth } from './auth.js';

export interface SocketSignInDeps {
  auth: Pick<Auth, 'sessionFromCookie' | 'securedFor'>;
  db: Pick<Database, 'accounts'>;
  env: NodeJS.ProcessEnv;
  sessionSockets: Pick<SessionSockets, 'track' | 'forget'>;
}

export function signSocketsIn(io: SocketServer, deps: SocketSignInDeps): void {
  io.use(async (socket, next) => {
    if (signsEveryoneIn(deps.env)) {
      const users = await deps.db.accounts.getUsers();
      socket.data.user = users[0] || { id: 'test-user-id', email: 'test@example.com' };
      return next();
    }
    try {
      const signedIn = await deps.auth.sessionFromCookie(socket.handshake.headers.cookie, deps.auth.securedFor(socket.handshake));
      if (!signedIn) return next(new Error('Unauthorized'));
      socket.data.user = signedIn.user;
      socket.data.session = { sessionId: signedIn.sessionId, personId: signedIn.user.id, sessionAt: signedIn.sessionAt } satisfies SocketSession;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    const session = socket.data.session as SocketSession | undefined;
    if (!session) return;
    deps.sessionSockets.track(socket, session);
    socket.on('disconnect', () => deps.sessionSockets.forget(socket.id));
  });
}
