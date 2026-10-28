import { settingsFingerprint, type EngineSettings } from './remote-blobs.js';

export interface RunningWorker {
  run(): Promise<void>;
  shutdown(): void;
}

interface Current {
  fingerprint: string;
  worker: RunningWorker;
  done: Promise<void>;
}

export type After = (ms: number, then: () => void) => () => void;

const realAfter: After = (ms, then) => {
  const timer = setTimeout(then, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export const RETRY_FIRST_MS = 5_000;
export const RETRY_MOST_MS = 60_000;
export const RAN_LONG_ENOUGH_MS = 60_000;

export function retryDelay(failures: number): number {
  return Math.min(RETRY_MOST_MS, RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1));
}

export class DeviceWorkerHost {
  private current: Current | undefined;
  private queue: Promise<void> = Promise.resolve();
  private settingsOf: (() => Promise<EngineSettings>) | undefined;
  private failures = 0;
  private cancelRetry: (() => void) | undefined;
  private stopped = false;

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
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.queue = this.queue.then(() => this.follow(settingsOf)).catch((err: Error) => {
      this.log(`the engine worker could not start: ${err.message}`);
      if (!this.current) this.retryLater();
    });
    return this.queue;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    await this.queue;
    await this.retire();
  }

  private retryLater(): void {
    if (this.stopped || this.cancelRetry || !this.settingsOf) return;
    this.failures += 1;
    const delay = retryDelay(this.failures);
    this.log(`the engine worker starts again in ${Math.round(delay / 1000)}s`);
    this.cancelRetry = this.after(delay, () => {
      this.cancelRetry = undefined;
      if (!this.stopped && !this.current && this.settingsOf) void this.connected(this.settingsOf);
    });
  }

  private async follow(settingsOf: () => Promise<EngineSettings>): Promise<void> {
    const settings = await settingsOf();
    const fingerprint = settingsFingerprint(settings);
    if (this.current?.fingerprint === fingerprint) return;
    if (this.current) this.log('Koala\'s payload key or the way to its Temporal changed, so the engine worker starts again with it');
    await this.retire();
    const worker = await this.start(settings);
    const startedAt = this.now();
    const current: Current = {
      fingerprint,
      worker,
      done: worker.run().catch((err: Error) => this.log(`the engine worker stopped: ${err.message}`)).finally(() => {
        if (this.current !== current) return;
        this.current = undefined;
        if (this.now() - startedAt >= RAN_LONG_ENOUGH_MS) this.failures = 0;
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
    await current.done;
  }
}
