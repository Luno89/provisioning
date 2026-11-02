import type { Server as SocketServer } from 'socket.io';
import { HUB_LINES_NAMESPACE } from '../lib/hub.js';
import type { InstanceCredentials } from '../routes/hub-instance.js';
import type { HubService, SyncOrigin } from '../services/HubService.js';
import { describedCall } from '../lib/hub-lines.js';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function wireHubLines(
  io: Pick<SocketServer, 'of'>,
  hub: Pick<HubService, 'connectInstance'>,
  check: (given: InstanceCredentials) => Promise<SyncOrigin | undefined>,
): void {
  const namespace = io.of(HUB_LINES_NAMESPACE);
  const admitted = new WeakMap<object, SyncOrigin>();
  namespace.use((socket, next) => {
    const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
    check({ instanceId: text(auth.instanceId), personId: text(auth.personId), email: text(auth.email), token: text(auth.token) }).then((origin) => {
      if (!origin) return next(new Error('Unauthorized'));
      admitted.set(socket, origin);
      next();
    }, (err: Error) => {
      console.warn(`[hub-lines] an instance's connection could not be checked: ${err.message}`);
      next(new Error('the hub could not check this instance just now; it connects again by itself'));
    });
  });
  namespace.on('connection', (socket) => {
    const origin = admitted.get(socket);
    const connected = origin ? hub.connectInstance(origin, {
      call: (call) => { socket.emit('call', describedCall(call)); },
      changed: (projectId) => { socket.emit('changed', projectId); },
    }) : undefined;
    if (!connected?.ok) {
      socket.disconnect(true);
      return;
    }
    socket.on('disconnect', connected.value);
  });
}
