import { io, type Socket } from 'socket.io-client';
import { MACHINE_CLIENT_TOKEN } from '@koala/engine-core/machine-join';
import { realAfter, type After } from './device-worker-host.js';

export interface KoalaAccess {
  token(resource: string): Promise<string>;
  freshToken(resource: string): Promise<string>;
  renewsAt(resource: string): number | undefined;
}

export interface TokenFreshness {
  access: KoalaAccess;
  resource: string;
  apply: (token: string) => Promise<void>;
  say: (line: string) => void;
  now?: (() => number) | undefined;
  after?: After | undefined;
}

export function keepTokenFresh(options: TokenFreshness): () => void {
  const { access, resource, say } = options;
  const now = options.now ?? Date.now;
  const after = options.after ?? realAfter;
  let cancel: () => void = () => undefined;
  let stopped = false;
  const next = (): void => {
    const at = access.renewsAt(resource);
    if (at === undefined) return say('this machine holds no token for its Koala to keep fresh; it takes one as it starts its work again');
    cancel = after(Math.max(0, at - now()), () => {
      access.token(resource).then((token) => options.apply(token)).then(
        () => { if (!stopped) next(); },
        (err: Error) => say(`this machine could not take a fresh token for its Koala from root (${err.message}); its Koala's Temporal stops taking its calls once the one it holds ends, and it takes a fresh one as it starts its work again`),
      );
    });
    return undefined;
  };
  next();
  return () => {
    stopped = true;
    cancel();
  };
}

export interface KoalaSocketOptions {
  url: string;
  resource: string;
  access: KoalaAccess;
  auth: Record<string, unknown>;
  say: (line: string) => void;
}

export function koalaSocket(options: KoalaSocketOptions): Socket {
  const { access, resource, say } = options;
  let held: string | undefined;
  const auth = (answer: (data: Record<string, unknown>) => void): void => {
    access.freshToken(resource).then((token) => {
      held = token;
      answer({ ...options.auth, token });
    }, (err: Error) => {
      say(`this machine could not take a token for its Koala from root (${err.message}); it asks again as it connects again`);
      answer({ ...options.auth });
    });
  };
  const socket = io(`${options.url}/agent`, { auth, reconnection: true });
  const emit = socket.emit.bind(socket);
  let sending = Promise.resolve();
  socket.emit = ((event: string, ...args: unknown[]) => {
    sending = sending.then(() => access.token(resource)).then((token) => {
      if (token !== held && socket.connected) {
        held = token;
        emit(MACHINE_CLIENT_TOKEN, { token });
      }
      emit(event, ...args);
    }, (err: Error) => {
      say(`its Koala was not sent ${event}: this machine could not take a token for it from root (${err.message}); it connects again, asking root again`);
      socket.disconnect().connect();
    });
    return socket;
  }) as typeof socket.emit;
  return socket;
}
