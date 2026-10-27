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

export class DeviceWorkerHost {
  private current: Current | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly start: (settings: EngineSettings) => Promise<RunningWorker>,
    private readonly log: (line: string) => void = (line) => console.log(`[koala-local-agent] ${line}`),
  ) {}

  get fingerprint(): string | undefined {
    return this.current?.fingerprint;
  }

  connected(settingsOf: () => Promise<EngineSettings>): Promise<void> {
    this.queue = this.queue.then(() => this.follow(settingsOf)).catch((err: Error) => this.log(`the engine worker could not start: ${err.message}`));
    return this.queue;
  }

  async stop(): Promise<void> {
    await this.queue;
    await this.retire();
  }

  private async follow(settingsOf: () => Promise<EngineSettings>): Promise<void> {
    const settings = await settingsOf();
    const fingerprint = settingsFingerprint(settings);
    if (this.current?.fingerprint === fingerprint) return;
    if (this.current) this.log('Koala\'s payload key or the way to its Temporal changed, so the engine worker starts again with it');
    await this.retire();
    const worker = await this.start(settings);
    const current: Current = {
      fingerprint,
      worker,
      done: worker.run().catch((err: Error) => this.log(`the engine worker stopped: ${err.message}`)).finally(() => {
        if (this.current === current) this.current = undefined;
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
