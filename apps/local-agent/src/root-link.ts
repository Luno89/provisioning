import { io, type Socket } from 'socket.io-client';
import { saveDeviceToken, tokenAnswer, workTokenExpiry } from './machine-token.js';

export interface Koala {
  url: string;
  workToken: string;
}

export interface RootLinkOptions {
  rootUrl: string;
  token: string;
  configFile: string;
  meshIp: () => Promise<string | undefined>;
  onKoala: (koala: Koala) => void;
  onRemoved: () => void;
  onPlaceKoala?: ((raw: unknown) => boolean) | undefined;
  say: (line: string) => void;
  renewBeforeSeconds?: number | undefined;
  connect?: ((url: string, options: Parameters<typeof io>[1]) => Socket) | undefined;
}

export interface RootLink {
  socket: Socket;
  askKoala(): void;
  close(): void;
}

export const koalaFrom = (raw: unknown): Koala | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const { url, workToken } = raw as { url?: unknown; workToken?: unknown };
  return typeof url === 'string' && url && typeof workToken === 'string' && workToken ? { url, workToken } : undefined;
};

export function linkToRoot(options: RootLinkOptions): RootLink {
  const { say } = options;
  const renewBefore = options.renewBeforeSeconds ?? 7 * 24 * 3600;
  const socket = (options.connect ?? io)(`${options.rootUrl}/machine-account`, { auth: { token: options.token }, reconnection: true });
  let renewal: NodeJS.Timeout | undefined;
  let renewing: number | undefined;
  const askKoala = () => { if (socket.connected) socket.emit('machine:koala?'); };
  const renewFor = (token: string) => {
    const exp = workTokenExpiry(token);
    if (exp === undefined || (renewing !== undefined && exp <= renewing)) return;
    if (renewal) clearTimeout(renewal);
    renewal = setTimeout(() => {
      renewing = exp;
      askKoala();
    }, Math.max(0, (exp - renewBefore) * 1000 - Date.now()));
    renewal.unref();
  };

  socket.on('machine:token', ({ token: next }: { token?: unknown } = {}, ack: (answer: { taken: boolean }) => void) => {
    if (typeof next !== 'string' || !next) return ack(tokenAnswer(false));
    saveDeviceToken(options.configFile, next)
      .then(() => {
        socket.auth = { ...(socket.auth as Record<string, unknown>), token: next };
        say('this machine took a new token from root');
        ack(tokenAnswer(true));
      })
      .catch((err: Error) => {
        say(`a new token could not be kept: ${err.message}`);
        ack(tokenAnswer(false));
      });
  });
  socket.on('connect', () => {
    say(`connected to root at ${options.rootUrl}`);
    void options.meshIp().then((ip) => { if (ip) socket.emit('machine:mesh', { ip }); });
  });
  socket.on('machine:removed', () => {
    socket.io.opts.reconnection = false;
    options.onRemoved();
  });
  socket.on('machine:place-koala', (raw: unknown, ack?: (answer: { taken: boolean }) => void) => {
    const taken = options.onPlaceKoala?.(raw) ?? false;
    if (typeof ack === 'function') ack({ taken });
  });
  socket.on('machine:koala', (raw: unknown) => {
    const koala = koalaFrom(raw);
    if (!koala) {
      say('root names no Koala for this machine yet; it waits until there is one');
      return;
    }
    renewFor(koala.workToken);
    options.onKoala(koala);
  });
  socket.on('disconnect', (reason) => say(`root disconnected: ${reason}`));
  socket.on('connect_error', (err: Error) => say(`root refused or could not be reached: ${err.message}`));
  return {
    socket,
    askKoala,
    close: () => {
      if (renewal) clearTimeout(renewal);
      socket.close();
    },
  };
}
