import type { Server as SocketServer, Socket } from 'socket.io';
import { signsEveryoneIn } from '../lib/auth.js';
import type { Database } from '../lib/db-interface.js';
import type { UserMetadata } from '../lib/types.js';
import type { SocketSession } from '../lib/session-sockets.js';
import type { SessionSockets } from '../services/SessionSockets.js';
import type { Auth } from './auth.js';

export interface SocketSignInDeps {
  auth: Pick<Auth, 'sessionFromCookie' | 'securedFor'>;
  db: Pick<Database, 'accounts'>;
  env: NodeJS.ProcessEnv;
  sessionSockets: Pick<SessionSockets, 'track' | 'forget'>;
}

interface SignedInData {
  user?: UserMetadata | { id: string; email: string };
  session?: SocketSession;
}

export const SIGN_IN_UNCHECKED = { tryAgain: true } as const;

const signedInData = (socket: Socket): SignedInData => socket.data as SignedInData;

export function signSocketsIn(io: SocketServer, deps: SocketSignInDeps): void {
  io.use((socket, next) => {
    const signIn = async (): Promise<Error | undefined> => {
      if (signsEveryoneIn(deps.env)) {
        const users = await deps.db.accounts.getUsers();
        signedInData(socket).user = users[0] || { id: 'test-user-id', email: 'test@example.com' };
        return undefined;
      }
      const signedIn = await deps.auth.sessionFromCookie(socket.handshake.headers.cookie, deps.auth.securedFor(socket.handshake));
      if (!signedIn) return new Error('Unauthorized');
      const data = signedInData(socket);
      data.user = signedIn.user;
      data.session = { sessionId: signedIn.sessionId, personId: signedIn.user.id, sessionAt: signedIn.sessionAt };
      return undefined;
    };
    signIn().then((refused) => next(refused), (err: unknown) => {
      console.error(`[sockets] a connection's session could not be checked, so it is asked to try again: ${err instanceof Error ? err.message : String(err)}`);
      next(Object.assign(new Error('the session could not be checked; try again'), { data: SIGN_IN_UNCHECKED }));
    });
  });
  io.on('connection', (socket) => {
    const { session } = signedInData(socket);
    if (!session) return;
    deps.sessionSockets.track(socket, session);
    socket.on('disconnect', () => deps.sessionSockets.forget(socket.id));
  });
}
