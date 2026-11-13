import { drainThenStop, type DrainDeps } from '../services/drain.js';
import type { FenceWatch } from '../services/FenceWatch.js';
import { letGoOfFences } from './fences.js';

export interface BackendStop {
  stopping: () => void;
  drain: DrainDeps;
  fences: Pick<FenceWatch, 'stop'>;
  exit: (code: number) => void;
}

export async function stopBackend(stop: BackendStop): Promise<void> {
  stop.stopping();
  let code = 0;
  if (stop.drain.place) {
    await drainThenStop(stop.drain).catch((err: Error) => {
      stop.drain.log(`[drain] ${err.message}`);
      code = 1;
    });
  }
  await letGoOfFences(stop.fences);
  stop.exit(code);
}
