import { ignore } from '@koala/engine-core/failures';
import { PROCESS_BEAT_MS, liveSince, stillWaitingOn, type Closing, type Fence, type KoalaProcess, type RaisedFence } from '../lib/fence.js';
import { watchingAll, type Watching } from '../lib/change-streams.js';
import type { PlatformStore } from '../store.js';
import { keepTrying } from '../lib/keep-trying.js';

type FenceStore = Pick<PlatformStore, 'fencesRaised' | 'watchFences' | 'ackFence' | 'beatProcess' | 'forgetProcess'>;

export interface FenceWatchDeps {
  store: FenceStore;
  fence: Fence;
  process: KoalaProcess;
  now?: () => number;
}

export class FenceWatch {
  private watching: Watching | undefined;
  private beating: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: FenceWatchDeps) {}

  private at(): string {
    return new Date((this.deps.now ?? Date.now)()).toISOString();
  }

  async start(): Promise<void> {
    await this.beat();
    this.beating = setInterval(() => { void this.beat().catch(ignore('a beat Mongo refuses is followed by the next one; a process stays live while any beat lands')); }, PROCESS_BEAT_MS);
    this.beating.unref();
    this.watching = this.deps.store.watchFences((fence) => { void this.hold(fence); });
    await this.watching.ready;
    await Promise.all((await this.deps.store.fencesRaised()).map((fence) => this.hold(fence)));
  }

  private beat(): Promise<void> {
    return this.deps.store.beatProcess(this.deps.process, this.at());
  }

  private async hold(raised: RaisedFence): Promise<void> {
    this.deps.fence.close(raised.closing);
    if (raised.confirmed) return;
    await this.deps.fence.quiet(raised.closing);
    await keepTrying(`giving this process's word that it holds the fence round ${raised.closing.kind} ${raised.closing.id}`, () => this.deps.store.ackFence(raised.closing, this.deps.process.id, this.at()), (message) => console.warn(`[fence] ${message}`));
  }

  async stop(): Promise<void> {
    if (this.beating) clearInterval(this.beating);
    this.beating = undefined;
    await this.watching?.close();
    this.watching = undefined;
    await this.deps.store.forgetProcess(this.deps.process.id);
  }
}

type HeldStore = Pick<PlatformStore, 'fenceAcks' | 'watchFenceAcks' | 'processesSeenSince' | 'watchProcesses'>;

export async function fenceHeldEverywhere(deps: { store: HeldStore; now?: () => number }, closing: Closing): Promise<string[]> {
  const now = deps.now ?? Date.now;
  let settle!: (by: string[]) => void;
  let fail!: (err: unknown) => void;
  const held = new Promise<string[]>((resolve, reject) => { settle = resolve; fail = reject; });
  let looking = Promise.resolve();
  const look = (): void => {
    looking = looking.then(async () => {
      const acked = await deps.store.fenceAcks(closing);
      const live = await deps.store.processesSeenSince(liveSince(now()));
      if (stillWaitingOn(live, acked).length === 0) settle(acked);
    }).catch(fail);
  };
  const watching = watchingAll([
    deps.store.watchFenceAcks((ack) => { if (ack.closing.kind === closing.kind && ack.closing.id === closing.id) look(); }),
    deps.store.watchProcesses(look),
  ]);
  try {
    await watching.ready;
    look();
    return await held;
  } finally {
    await watching.close();
  }
}
