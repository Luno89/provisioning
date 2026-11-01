import { runIdsFrom, type RunLife } from '../lib/run-watch.js';

export interface RunLiveness {
  life(runId: string, ownerId: string): Promise<RunLife>;
  closed(runId: string, ownerId: string): Promise<RunLife>;
}

export type TellRunEnded = (runId: string) => void;

interface Following {
  ownerId: string;
  tell: TellRunEnded;
  runs: Set<string>;
}

export class MachineRunWatch {
  private readonly following = new Map<string, Following>();

  constructor(
    private readonly runs: RunLiveness,
    private readonly log: (line: string) => void = (line) => console.warn(`[machines] ${line}`),
  ) {}

  follow(deviceId: string, ownerId: string, raw: unknown, tell: TellRunEnded): void {
    const runIds = runIdsFrom(raw);
    let following = this.following.get(deviceId);
    if (!following || following.tell !== tell) {
      following = { ownerId, tell, runs: new Set() };
      this.following.set(deviceId, following);
    }
    for (const runId of following.runs) if (!runIds.includes(runId)) following.runs.delete(runId);
    for (const runId of runIds) {
      if (following.runs.has(runId)) continue;
      following.runs.add(runId);
      void this.watch(deviceId, following, runId);
    }
  }

  forget(deviceId: string, tell: TellRunEnded): void {
    if (this.following.get(deviceId)?.tell === tell) this.following.delete(deviceId);
  }

  watching(deviceId: string): string[] {
    return [...(this.following.get(deviceId)?.runs ?? [])].sort();
  }

  private async watch(deviceId: string, following: Following, runId: string): Promise<void> {
    const now = await this.runs.life(runId, following.ownerId).catch((err: Error): RunLife => {
      this.log(`${deviceId} named ${runId}, whose state could not be read, so Koala waits for it to close: ${err.message}`);
      return 'running';
    });
    const life = now === 'running' ? await this.runs.closed(runId, following.ownerId) : now;
    if (this.following.get(deviceId) !== following || !following.runs.has(runId)) return;
    following.runs.delete(runId);
    if (life === 'ended') following.tell(runId);
    else this.log(`${deviceId} named ${runId}, which is not its owner's run, so nothing about it is told`);
  }
}
