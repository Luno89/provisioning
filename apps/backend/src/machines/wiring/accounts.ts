import type { Server as SocketServer, Socket } from 'socket.io';
import type { Database } from '../../platform/index.js';
import { matchDeviceToken } from '../lib/local-agent-registry.js';
import { deviceTokenHash, TOKEN_EXPIRED_SAID, type TokenVia } from '../lib/device-tokens.js';
import { rotateDeviceToken } from '../lib/device-rotation.js';
import { PLACE_KOALA, STOP_KOALA, type KoalaStop, type PlacedKoala } from '@koala/engine-core/koala-install';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import type { KoalaInstalls } from '../services/KoalaInstalls.js';

export const ACCOUNT_NAMESPACE = '/machine-account';

export interface AccountSockets {
  removed(deviceId: string): boolean;
  koala(deviceId: string, koala: { url: string; workToken: string } | null): boolean;
  placeKoala(deviceId: string, placed: PlacedKoala): Promise<boolean>;
  stopKoala(deviceId: string, stop: KoalaStop): boolean;
  online(deviceId: string): boolean;
}

export function wireMachineAccounts(deps: {
  io: Pick<SocketServer, 'of'>;
  db: Pick<Database, 'machines'>;
  accounts: () => Pick<MachineAccounts, 'rotationFor' | 'tokenTaken' | 'seen' | 'joinFinished' | 'recordMeshIp' | 'koalaFor' | 'deliverKoala' | 'renewalFailed'>;
  installs: () => Pick<KoalaInstalls, 'connected'>;
  now?: (() => Date) | undefined;
}): AccountSockets {
  const namespace = deps.io.of(ACCOUNT_NAMESPACE);
  const connected = new Map<string, Set<Socket>>();
  const admitted = new WeakMap<object, { deviceId: string; via: TokenVia; tokenHash: string }>();

  namespace.use((socket, next) => {
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
    if (!token) return next(new Error('Missing device token'));
    deps.db.machines.getLocalAgentDevices().then((devices) => {
      const match = matchDeviceToken(devices, token, (deps.now ?? (() => new Date()))());
      if (!match) return next(new Error('Unauthorized'));
      if (match.expired) return next(new Error(TOKEN_EXPIRED_SAID));
      admitted.set(socket, { deviceId: match.device.id, via: match.via, tokenHash: deviceTokenHash(token) });
      return next();
    }, (err: Error) => next(new Error(`Koala could not look up this machine just now (${err.message}); it connects again by itself`)));
  });

  namespace.on('connection', (socket) => {
    const machine = admitted.get(socket);
    if (!machine) {
      socket.disconnect(true);
      return;
    }
    const { deviceId, via, tokenHash } = machine;
    const accounts = deps.accounts();
    const sockets = connected.get(deviceId) ?? new Set<Socket>();
    sockets.add(socket);
    connected.set(deviceId, sockets);
    accounts.seen(deviceId).catch((err: Error) => console.warn(`[machines] ${deviceId}: when it was last seen could not be recorded: ${err.message}`));
    accounts.joinFinished(deviceId, tokenHash).catch((err: Error) => console.warn(`[machines] ${deviceId}: its join could not be marked finished: ${err.message}`));
    deps.installs().connected(deviceId).catch((err: Error) => console.warn(`[machines] ${deviceId}: the install of Koala it was asked for could not be asked again: ${err.message}`));
    void rotateDeviceToken(socket, deviceId, via, accounts)
      .then((renewal) => (renewal === 'refused' ? accounts.renewalFailed(deviceId, 'the machine did not keep its new token') : undefined), (err: Error) => accounts.renewalFailed(deviceId, err.message))
      .catch((err: Error) => console.warn(`[machines] ${deviceId}: its token renewal could not be recorded: ${err.message}`));
    const tellKoala = () => accounts.koalaFor(deviceId).then(
      (koala) => { if (socket.connected) socket.emit('machine:koala', koala ?? null); },
      (err: Error) => console.warn(`[machines] ${deviceId}: where its Koala is could not be told: ${err.message}`),
    );
    void tellKoala();
    socket.on('machine:koala?', () => { void tellKoala(); });
    socket.on('machine:mesh', (report: { ip?: unknown } | undefined) => {
      accounts.recordMeshIp(deviceId, report?.ip)
        .then(() => accounts.deliverKoala(deviceId))
        .then((placed) => { if (!placed.ok) console.warn(`[machines] ${deviceId}: Koala could not be put on it: ${placed.error}`); })
        .catch((err: Error) => console.warn(`[machines] ${deviceId}: its mesh address could not be recorded: ${err.message}`));
    });
    socket.on('disconnect', () => {
      sockets.delete(socket);
      if (!sockets.size) connected.delete(deviceId);
    });
  });

  const each = (deviceId: string, send: (socket: Socket) => void): boolean => {
    const sockets = connected.get(deviceId);
    if (!sockets?.size) return false;
    for (const socket of sockets) send(socket);
    return true;
  };
  const placeKoala = async (deviceId: string, placed: PlacedKoala): Promise<boolean> =>
    (await Promise.all([...(connected.get(deviceId) ?? [])].map((socket) => placeKoalaOn(socket, placed)))).some(Boolean);
  const placeKoalaOn = (socket: Socket, placed: PlacedKoala): Promise<boolean> => {
    if (!socket.connected) return Promise.resolve(false);
    return new Promise<boolean>((done) => {
      const gone = () => done(false);
      socket.once('disconnect', gone);
      socket.emit(PLACE_KOALA, placed, (answer: { taken?: unknown } | undefined) => {
        socket.off('disconnect', gone);
        done(answer?.taken === true);
      });
    });
  };
  return {
    removed: (deviceId) => each(deviceId, (socket) => { socket.emit('machine:removed'); socket.disconnect(true); }),
    koala: (deviceId, koala) => each(deviceId, (socket) => socket.emit('machine:koala', koala)),
    placeKoala,
    stopKoala: (deviceId, stop) => each(deviceId, (socket) => socket.emit(STOP_KOALA, stop)),
    online: (deviceId) => Boolean(connected.get(deviceId)?.size),
  };
}
