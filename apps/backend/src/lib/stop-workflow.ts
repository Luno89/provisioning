export const STOP_WAIT_MS = 60_000;

export interface StoppableWorkflow {
  describe(): Promise<{ status: { name: string } }>;
  cancel(): Promise<unknown>;
  result(): Promise<unknown>;
  terminate(reason: string): Promise<unknown>;
}

export type Stopped = 'not-running' | 'cancelled' | 'terminated';

const notFound = (err: unknown): boolean => /not\s*found/i.test(String((err as Error)?.message ?? err));

export async function stopIfRunning(handle: StoppableWorkflow, reason: string, waitMs = STOP_WAIT_MS): Promise<Stopped> {
  const running = await handle.describe().then((found) => found.status.name === 'RUNNING', (err: unknown) => {
    if (notFound(err)) return false;
    throw err;
  });
  if (!running) return 'not-running';

  await handle.cancel().catch((err: unknown) => {
    if (!notFound(err)) throw err;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    handle.result().then(() => true, () => true),
    new Promise<boolean>((settle) => { timer = setTimeout(() => settle(false), waitMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (closed) return 'cancelled';

  await handle.terminate(`${reason} — it did not stop within ${Math.round(waitMs / 1000)}s of being cancelled`).catch((err: unknown) => {
    if (!notFound(err)) throw err;
  });
  return 'terminated';
}
