import { io, type Socket } from 'socket.io-client';
import { MACHINE_CLIENT_TOKEN } from '@koala/engine-core/machine-join';

export interface KoalaAccess {
  token(resource: string): Promise<string>;
  freshToken(resource: string): Promise<string>;
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
