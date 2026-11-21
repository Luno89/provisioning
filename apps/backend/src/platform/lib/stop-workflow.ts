import { ignore } from '@koala/engine-core/failures';

export interface CancellableWorkflow {
  describe(): Promise<{ status: { name: string } }>;
  cancel(): Promise<unknown>;
  result(): Promise<unknown>;
}

export type Cancelled = 'not-running' | 'cancelled';

const notFound = (err: unknown): boolean => /not\s*found/i.test(String((err as Error)?.message ?? err));

export async function cancelIfRunning(handle: CancellableWorkflow): Promise<Cancelled> {
  const running = await handle.describe().then((found) => found.status.name === 'RUNNING', (err: unknown) => {
    if (notFound(err)) return false;
    throw err;
  });
  if (!running) return 'not-running';

  const sent = await handle.cancel().then(() => true, (err: unknown) => {
    if (notFound(err)) return false;
    throw err;
  });
  if (!sent) return 'not-running';
  await handle.result().catch(ignore('a workflow that ends cancelled or failed rejects its result, which is it closing all the same'));
  return 'cancelled';
}
