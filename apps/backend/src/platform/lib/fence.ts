import { WorkStopped, workFor, type WorkFor } from '@koala/engine-core/work-for';

export interface Closing {
  kind: 'owner' | 'project';
  id: string;
}

export interface RaisedFence {
  closing: Closing;
  at: string;
  confirmed: boolean;
  endedWith?: string[] | undefined;
}

export interface KoalaProcess {
  id: string;
  name: string;
}

export const PROCESS_BEAT_MS = 15_000;
export const LIVE_FOR_BEATS = 3;

export const liveSince = (now: number): string => new Date(now - PROCESS_BEAT_MS * LIVE_FOR_BEATS).toISOString();

const keyOf = (closing: Closing): string => `${closing.kind}:${closing.id}`;

export const fenceIdOf = keyOf;

export function closingOf(fenceId: string): Closing | undefined {
  const at = fenceId.indexOf(':');
  const kind = fenceId.slice(0, at);
  const id = fenceId.slice(at + 1);
  return (kind === 'owner' || kind === 'project') && id ? { kind, id } : undefined;
}

export const droppableFences = (fences: readonly RaisedFence[], live: readonly string[]): Closing[] =>
  fences.filter((fence) => fence.endedWith !== undefined && !fence.endedWith.some((id) => live.includes(id))).map((fence) => fence.closing);

export const stillWaitingOn = (live: readonly KoalaProcess[], acked: readonly string[]): KoalaProcess[] =>
  live.filter((process) => !acked.includes(process.id));

const keysOf = (work: WorkFor | undefined): string[] => [
  ...(work?.owner ? [keyOf({ kind: 'owner', id: work.owner })] : []),
  ...(work?.project ? [keyOf({ kind: 'project', id: work.project })] : []),
];

export class Fence {
  private readonly closed = new Set<string>();
  private readonly inFlight = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();

  close(closing: Closing): void {
    this.closed.add(keyOf(closing));
  }

  open(closing: Closing): void {
    this.closed.delete(keyOf(closing));
  }

  holds(closing: Closing): boolean {
    return this.closed.has(keyOf(closing));
  }

  stopped(work: WorkFor | undefined = workFor()): Closing | undefined {
    if (work?.owner && this.closed.has(keyOf({ kind: 'owner', id: work.owner }))) return { kind: 'owner', id: work.owner };
    if (work?.project && this.closed.has(keyOf({ kind: 'project', id: work.project }))) return { kind: 'project', id: work.project };
    return undefined;
  }

  async guard<T>(write: () => Promise<T>): Promise<T> {
    const work = workFor();
    const stopped = this.stopped(work);
    if (stopped) throw new WorkStopped(stopped);
    const keys = keysOf(work);
    for (const key of keys) this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    try {
      return await write();
    } finally {
      for (const key of keys) this.finished(key);
    }
  }

  quiet(closing: Closing): Promise<void> {
    const key = keyOf(closing);
    if (!this.inFlight.get(key)) return Promise.resolve();
    return new Promise((resolve) => this.waiting.set(key, [...(this.waiting.get(key) ?? []), resolve]));
  }

  private finished(key: string): void {
    const left = (this.inFlight.get(key) ?? 1) - 1;
    if (left > 0) {
      this.inFlight.set(key, left);
      return;
    }
    this.inFlight.delete(key);
    const waiters = this.waiting.get(key) ?? [];
    this.waiting.delete(key);
    for (const resolve of waiters) resolve();
  }
}

const processFence = new Fence();

export const theFence = (): Fence => processFence;
