import { drainThenStop, type DrainDeps } from '../services/drain.js';
import type { SignedInSockets } from '../middleware/socket-sign-in.js';

export interface BackendStop {
  stopping: () => void;
  sockets: SignedInSockets;
  drain: DrainDeps;
  exit: (code: number) => void;
}

export async function stopBackend(stop: BackendStop): Promise<void> {
  stop.stopping();
  stop.sockets.stopTaking();
  let code = 0;
  if (stop.drain.place) {
    await drainThenStop(stop.drain).catch((err: Error) => {
      stop.drain.log(`[drain] ${err.message}`);
      code = 1;
    });
  }
  stop.exit(code);
}
