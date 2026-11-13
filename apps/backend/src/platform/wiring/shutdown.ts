import type { FenceWatch } from '../services/FenceWatch.js';
import { letGoOfFences } from './fences.js';

export interface BackendStop {
  stopping: () => void;
  drain?: (() => Promise<void>) | undefined;
  fences: Pick<FenceWatch, 'stop'>;
  exit: (code: number) => void;
  log?: ((line: string) => void) | undefined;
}

export async function stopBackend(stop: BackendStop): Promise<void> {
  stop.stopping();
  let code = 0;
  if (stop.drain) {
    await stop.drain().catch((err: Error) => {
      (stop.log ?? console.error)(`[drain] ${err.message}`);
      code = 1;
    });
  }
  await letGoOfFences(stop.fences);
  stop.exit(code);
}
