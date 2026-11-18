import type { Server as SocketServer, Socket } from 'socket.io';
import type { Database, SecretKey } from '../../platform/index.js';
import { matchDeviceToken } from '../lib/local-agent-registry.js';
import { TOKEN_EXPIRED_SAID, type TokenVia } from '../lib/device-tokens.js';
import { rotateDeviceToken } from '../lib/device-rotation.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import type { PlacedKoala } from '../../instances/index.js';

export const ACCOUNT_NAMESPACE = '/machine-account';

export interface AccountSockets {
  removed(deviceId: string): boolean;
  koala(deviceId: string, koala: { url: string; workToken: string } | null): boolean;
  placeKoala(deviceId: string, placed: PlacedKoala): Promise<boolean>;
  online(deviceId: string): boolean;
}

export function wireMachineAccounts(deps: {
  io: Pick<SocketServer, 'of'>;
  db: Pick<Database, 'machines'>;
  dataKey: SecretKey;
  accounts: () => Pick<MachineAccounts, 'rotationFor' | 'tokenTaken' | 'seen' | 'recordMeshIp' | 'koalaFor' | 'deliverKoala' | 'renewalFailed'>;
  now?: (() => Date) | undefined;
}): AccountSockets {
  const namespace = deps.io.of(ACCOUNT_NAMESPACE);
  const connected = new Map<string, Set<Socket>>();
  const admitted = new WeakMap<object, { deviceId: string; via: TokenVia }>();

  namespace.use((socket, next) => {
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
    if (!token) return next(new Error('Missing device token'));
    deps.db.machines.getLocalAgentDevices().then((devices) => {
      const match = matchDeviceToken(devices, token, deps.dataKey, (deps.now ?? (() => new Date()))());
      if (!match) return next(new Error('Unauthorized'));
      if (match.expired) return next(new Error(TOKEN_EXPIRED_SAID));
      admitted.set(socket, { deviceId: match.device.id, via: match.via });
      return next();
    }, (err: Error) => next(new Error(`Koala could not look up this machine just now (${err.message}); it connects again by itself`)));
  });

  namespace.on('connection', (socket) => {
    const machine = admitted.get(socket);
    if (!machine) {
      socket.disconnect(true);
      return;
    }
    const { deviceId, via } = machine;
    const accounts = deps.accounts();
    const sockets = connected.get(deviceId) ?? new Set<Socket>();
    sockets.add(socket);
    connected.set(deviceId, sockets);
    accounts.seen(deviceId).catch((err: Error) => console.warn(`[machines] ${deviceId}: when it was last seen could not be recorded: ${err.message}`));
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
  const placeKoala = (deviceId: string, placed: PlacedKoala): Promise<boolean> => {
    const socket = [...(connected.get(deviceId) ?? [])][0];
    if (!socket) return Promise.resolve(false);
    return new Promise<boolean>((done) => {
      const gone = () => done(false);
      socket.once('disconnect', gone);
      socket.emit('machine:place-koala', placed, (answer: { taken?: unknown } | undefined) => {
        socket.off('disconnect', gone);
        done(answer?.taken === true);
      });
    });
  };
  return {
    removed: (deviceId) => each(deviceId, (socket) => socket.emit('machine:removed')),
    koala: (deviceId, koala) => each(deviceId, (socket) => socket.emit('machine:koala', koala)),
    placeKoala,
    online: (deviceId) => Boolean(connected.get(deviceId)?.size),
  };
}
