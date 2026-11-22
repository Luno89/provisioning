import type { Server as SocketServer, Socket } from 'socket.io';
import type { Database, DependencyStates, Watching } from '../../platform/index.js';
import { matchDeviceToken } from '../lib/local-agent-registry.js';
import { deviceTokenHash, TOKEN_EXPIRED_SAID, tokenUntil, type TokenVia } from '../lib/device-tokens.js';
import { rotateDeviceToken } from '../lib/device-rotation.js';
import { PLACE_KOALA, STOP_KOALA, type KoalaStop, type PlacedKoala } from '@koala/engine-core/koala-install';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import type { KoalaInstalls } from '../services/KoalaInstalls.js';

export const ACCOUNT_NAMESPACE = '/machine-account';

export interface AccountSockets {
  watched: Watching;
  removed(deviceId: string): boolean;
  koala(deviceId: string, koala: { url: string; workToken: string } | null): boolean;
  placeKoala(deviceId: string, placed: PlacedKoala): Promise<boolean>;
  stopKoala(deviceId: string, stop: KoalaStop): boolean;
  online(deviceId: string): boolean;
}

export function wireMachineAccounts(deps: {
  io: Pick<SocketServer, 'of'>;
  db: Pick<Database, 'machines'>;
  accounts: () => Pick<MachineAccounts, 'rotationFor' | 'tokenTaken' | 'seen' | 'joinFinished' | 'recordMeshIp' | 'koalaFor' | 'deliverKoala' | 'renewalFailed' | 'uninstalled' | 'wentOff'>;
  installs: () => Pick<KoalaInstalls, 'connected'>;
  dependencies: Pick<DependencyStates, 'whenAnswering'>;
  now?: (() => Date) | undefined;
}): AccountSockets {
  const namespace = deps.io.of(ACCOUNT_NAMESPACE);
  const connected = new Map<string, Set<Socket>>();
  const admitted = new WeakMap<object, { deviceId: string; via: TokenVia; tokenHash: string; until: number }>();
  const now = deps.now ?? (() => new Date());

  namespace.use((socket, next) => {
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
    if (!token) return next(new Error('Missing device token'));
    deps.db.machines.getLocalAgentDevices().then((devices) => {
      const match = matchDeviceToken(devices, token, now());
      if (!match) return next(new Error('Unauthorized'));
      if (match.expired) return next(new Error(TOKEN_EXPIRED_SAID));
      admitted.set(socket, { deviceId: match.device.id, via: match.via, tokenHash: deviceTokenHash(token), until: tokenUntil(match.via === 'current' ? match.device.expiresAt : match.device.nextExpiresAt) });
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
    let { until } = machine;
    socket.use((_packet, next) => {
      if (now().getTime() < until) return next();
      socket.disconnect(true);
    });
    const accounts = deps.accounts();
    const sockets = connected.get(deviceId) ?? new Set<Socket>();
    sockets.add(socket);
    connected.set(deviceId, sockets);
    accounts.seen(deviceId).catch((err: Error) => console.warn(`[machines] ${deviceId}: when it was last seen could not be recorded: ${err.message}`));
    accounts.joinFinished(deviceId, tokenHash).catch((err: Error) => console.warn(`[machines] ${deviceId}: its join could not be marked finished: ${err.message}`));
    deps.installs().connected(deviceId).catch((err: Error) => console.warn(`[machines] ${deviceId}: the install of Koala it was asked for could not be asked again: ${err.message}`));
    const renewed = async (): Promise<void> => {
      const held = (await deps.db.machines.getLocalAgentDevices()).find((device) => device.id === deviceId);
      until = tokenUntil(held?.expiresAt);
    };
    void rotateDeviceToken(socket, deviceId, via, accounts)
      .then((renewal) => (renewal === 'refused' ? accounts.renewalFailed(deviceId, 'the machine did not keep its new token') : renewal === 'renewed' ? renewed() : undefined), (err: Error) => accounts.renewalFailed(deviceId, err.message))
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
      if (sockets.size) return;
      connected.delete(deviceId);
      accounts.wentOff(deviceId).catch((err: Error) => console.warn(`[machines] ${deviceId}: when it went off could not be recorded: ${err.message}`));
    });
    void deps.db.machines.getLocalAgentDevices().then(
      (devices) => { if (devices.some((device) => device.id === deviceId && device.removal)) askUninstall(socket, deviceId); },
      (err: Error) => console.warn(`[machines] ${deviceId}: whether its account is being removed could not be read: ${err.message}`),
    );
  });

  const askingToUninstall = new WeakSet<Socket>();
  const unforgotten = new Map<string, { socket: Socket; problem: string | undefined }>();
  const forget = (socket: Socket, deviceId: string, problem: string | undefined): void => {
    unforgotten.delete(deviceId);
    deps.accounts().uninstalled(deviceId, problem)
      .then(() => { socket.disconnect(true); })
      .catch((err: Error) => {
        unforgotten.set(deviceId, { socket, problem });
        console.warn(`[machines] ${deviceId}: it uninstalled, but root could not forget it: ${err.message}; root tries again once what failed answers`);
      });
  };
  for (const dependency of ['mongo', 'temporal'] as const) {
    deps.dependencies.whenAnswering(dependency, () => {
      for (const [deviceId, { socket, problem }] of [...unforgotten]) forget(socket, deviceId, problem);
    });
  }
  const askUninstall = (socket: Socket, deviceId: string): void => {
    if (askingToUninstall.has(socket) || !socket.connected) return;
    askingToUninstall.add(socket);
    socket.emit('machine:removed', (answer: { uninstalled?: unknown; problem?: unknown } | undefined) => {
      const problem = answer?.uninstalled === true ? undefined : typeof answer?.problem === 'string' && answer.problem ? answer.problem.slice(0, 500) : 'the machine did not say whether its uninstall finished';
      forget(socket, deviceId, problem);
    });
  };
  const watched = deps.db.machines.watchDeviceRemovals((device) => {
    for (const socket of connected.get(device.id) ?? []) askUninstall(socket, device.id);
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
    watched,
    removed: (deviceId) => each(deviceId, (socket) => { socket.emit('machine:removed'); socket.disconnect(true); }),
    koala: (deviceId, koala) => each(deviceId, (socket) => socket.emit('machine:koala', koala)),
    placeKoala,
    stopKoala: (deviceId, stop) => each(deviceId, (socket) => socket.emit(STOP_KOALA, stop)),
    online: (deviceId) => Boolean(connected.get(deviceId)?.size),
  };
}
