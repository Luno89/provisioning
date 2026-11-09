import { ROLLOUT_KINDS, rolloutAcross, stuckHook, type ExecuteOptions, type Reach } from '../infrastructure/index.js';
import type { ClusterSteps } from './cluster-steps.js';

export type Pause = (ms: number) => Promise<void>;

export const WATCH_EVERY_MS = 5_000;

const pause: Pause = (ms) => new Promise((done) => { setTimeout(done, ms); });

export class CannotRollOut extends Error {
  constructor(readonly what: string, readonly why: string) {
    super(`${what} cannot finish: ${why}`);
    this.name = 'CannotRollOut';
  }
}

export interface Watched {
  what: string;
  reach: Reach;
  namespaces: readonly string[];
  log?: ((line: string) => void) | undefined;
}

type Read = { lists: unknown[] } | { unread: string };

async function readAll(steps: Pick<ClusterSteps, 'access'>, watched: Watched): Promise<Read> {
  try {
    const lists = await Promise.all(watched.namespaces.map(async (namespace) => JSON.parse(await steps.access.kubectl(watched.reach, ['get', ROLLOUT_KINDS, '-n', namespace, '-o', 'json'])) as unknown));
    return { lists };
  } catch (err) {
    return { unread: (err as Error).message };
  }
}

export async function applyWatched(
  steps: Pick<ClusterSteps, 'access' | 'infra'>,
  stack: string,
  options: Omit<ExecuteOptions, 'signal'>,
  watched: Watched & { signal?: AbortSignal | undefined },
  wait: Pause = pause,
): Promise<void> {
  const since = Date.now();
  const stop = new AbortController();
  const stopWith = () => stop.abort(watched.signal?.reason);
  if (watched.signal?.aborted) stopWith();
  watched.signal?.addEventListener('abort', stopWith, { once: true });
  const ended: { done?: true; failed?: { error: unknown } } = {};
  const applying = steps.infra.deploy(stack, { ...options, signal: stop.signal })
    .then(() => { ended.done = true; }, (error: unknown) => { ended.failed = { error }; });
  let unread = '';
  try {
    for (;;) {
      await Promise.race([applying, wait(WATCH_EVERY_MS)]);
      if (ended.done) return;
      if (ended.failed) throw ended.failed.error;
      const read = await readAll(steps, watched);
      if ('unread' in read) {
        if (read.unread !== unread) watched.log?.(`what ${watched.what} made could not be read while it applies: ${read.unread}`);
        unread = read.unread;
        continue;
      }
      unread = '';
      const rollout = rolloutAcross(read.lists);
      const hopeless = read.lists.map((listed) => stuckHook(listed, since)).find((reason) => reason !== undefined)
        ?? (rollout.state === 'hopeless' ? rollout.reason : undefined);
      if (hopeless) {
        stop.abort(new Error(hopeless));
        await applying;
        throw new CannotRollOut(watched.what, hopeless);
      }
    }
  } finally {
    watched.signal?.removeEventListener('abort', stopWith);
  }
}

export async function untilRolledOut(steps: Pick<ClusterSteps, 'access'>, watched: Watched, wait: Pause = pause): Promise<void> {
  let said = '';
  for (;;) {
    const read = await readAll(steps, watched);
    const now = 'unread' in read ? `what ${watched.what} made could not be read: ${read.unread}` : undefined;
    const rollout = 'lists' in read ? rolloutAcross(read.lists, { none: 'done' }) : undefined;
    if (rollout?.state === 'done') return;
    if (rollout?.state === 'hopeless') throw new CannotRollOut(watched.what, rollout.reason);
    const waiting = now ?? (rollout?.state === 'rolling' ? `${watched.what} waits: ${rollout.waiting}` : '');
    if (waiting !== said) watched.log?.(waiting);
    said = waiting;
    await wait(WATCH_EVERY_MS);
  }
}
