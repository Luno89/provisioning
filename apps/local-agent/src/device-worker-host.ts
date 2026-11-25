import { reopening } from '@koala/engine-core/reopening';
import { settingsFingerprint, type EngineSettings } from './remote-blobs.js';

export interface RunningWorker {
  run(): Promise<void>;
  shutdown(): void;
  failed(): boolean;
}

export interface TemporalWorkerLike {
  run(): Promise<void>;
  shutdown(): void;
  getState(): string;
}

export function runningWorkerOf(worker: TemporalWorkerLike, stop: () => void): RunningWorker {
  return {
    run: () => worker.run().finally(stop),
    shutdown: () => {
      stop();
      if (worker.getState() === 'RUNNING') worker.shutdown();
    },
    failed: () => worker.getState() === 'FAILED',
  };
}

interface Current {
  fingerprint: string;
  worker: RunningWorker;
  done: Promise<void>;
}

export type After = (ms: number, then: () => void) => () => void;

export const realAfter: After = (ms, then) => {
  const timer = setTimeout(then, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export const RAN_LONG_ENOUGH_MS = 60_000;

export class DeviceWorkerHost {
  private current: Current | undefined;
  private queue: Promise<void> = Promise.resolve();
  private settingsOf: (() => Promise<EngineSettings>) | undefined;
  private readonly wait = reopening();
  private cancelRetry: (() => void) | undefined;
  private stopped = false;
  private paused = false;

  constructor(
    private readonly start: (settings: EngineSettings) => Promise<RunningWorker>,
    private readonly log: (line: string) => void = (line) => console.log(`[koala-local-agent] ${line}`),
    private readonly after: After = realAfter,
    private readonly now: () => number = Date.now,
  ) {}

  get fingerprint(): string | undefined {
    return this.current?.fingerprint;
  }

  connected(settingsOf: () => Promise<EngineSettings>): Promise<void> {
    this.settingsOf = settingsOf;
    if (this.paused) return this.queue;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.queue = this.queue.then(() => this.follow(settingsOf)).catch((err: Error) => {
      this.log(`the engine worker could not start: ${err.message}`);
      if (!this.current) this.retryLater();
    });
    return this.queue;
  }

  async pause(): Promise<void> {
    this.paused = true;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    await this.queue;
    await this.retire();
  }

  resume(): Promise<void> {
    this.paused = false;
    if (this.stopped || !this.settingsOf) return Promise.resolve();
    return this.connected(this.settingsOf);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    await this.queue;
    await this.retire();
  }

  private retryLater(): void {
    if (this.stopped || this.paused || this.cancelRetry || !this.settingsOf) return;
    const delay = this.wait.take();
    this.log(`the engine worker starts again in ${Math.round(delay / 1000)}s`);
    this.cancelRetry = this.after(delay, () => {
      this.cancelRetry = undefined;
      if (!this.stopped && !this.paused && !this.current && this.settingsOf) void this.connected(this.settingsOf);
    });
  }

  private async follow(settingsOf: () => Promise<EngineSettings>): Promise<void> {
    if (this.paused) return;
    const settings = await settingsOf();
    if (this.paused) return;
    const fingerprint = settingsFingerprint(settings);
    if (this.current?.worker.failed()) this.log('the engine worker had failed and could not finish stopping, so a fresh one starts');
    else if (this.current?.fingerprint === fingerprint) return;
    else if (this.current) this.log('Koala\'s payload key or the way to its Temporal changed, so the engine worker starts again with it');
    await this.retire();
    const worker = await this.start(settings);
    const startedAt = this.now();
    const current: Current = {
      fingerprint,
      worker,
      done: worker.run().catch((err: Error) => this.log(`the engine worker stopped: ${err.message}`)).finally(() => {
        if (this.current !== current) return;
        this.current = undefined;
        if (this.now() - startedAt >= RAN_LONG_ENOUGH_MS) this.wait.reset();
        this.retryLater();
      }),
    };
    this.current = current;
  }

  private async retire(): Promise<void> {
    const current = this.current;
    if (!current) return;
    this.current = undefined;
    current.worker.shutdown();
    if (!current.worker.failed()) await current.done;
  }
}
