import type { ProvisioningView, ProvisionReason, ProvisionTarget } from '@koala/engine-core/koala-install';
import { reopening } from '@koala/engine-core/reopening';
import { runStamp, type Watching } from '../../platform/index.js';
import {
  openedRecord, provisionedFor, provisioningView, provisionRunId, runEnded, startDecision,
  type Provisioned, type Provisioner, type ProvisioningRecord, type ProvisionRunInput,
} from '../lib/provisioning.js';
import type { InfrastructureStore, ProvisioningPatch } from '../store.js';

export interface ProvisionRuns {
  start(input: ProvisionRunInput): Promise<string>;
  started(runId: string): Promise<string | undefined>;
  ended(workflowId: string): Promise<string>;
}

export interface ProvisioningDeps {
  store: Pick<InfrastructureStore, 'getProvisioning' | 'getProvisioningRun' | 'openProvisioning' | 'patchProvisioning' | 'watchProvisioning'>;
  runs: ProvisionRuns;
  koala: { ownerId: string; clusterId: string; revision: number };
  changed(ownerId: string, view: ProvisioningView): void;
  log(line: string): void;
  now?: () => Date;
}

export const NEVER_STARTED = 'Koala stopped before this setup\'s run started';

const endedPatch = (record: ProvisioningRecord): ProvisioningPatch => ({
  state: record.state,
  pieces: record.pieces,
  ...(record.why !== undefined ? { why: record.why } : {}),
  ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
});

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class Provisioning implements Provisioner {
  private watching: Watching | undefined;
  private readonly following = new Set<string>();
  private readonly followAgain = reopening();
  private closed = false;

  constructor(private readonly deps: ProvisioningDeps) {}

  private get koalaTarget(): ProvisionTarget {
    return { kind: 'koala', clusterId: this.deps.koala.clusterId };
  }

  private at(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async start(): Promise<void> {
    if (!this.watching) {
      this.watching = this.deps.store.watchProvisioning((record) => this.heard(record));
      await this.watching.ready;
    }
    for (const record of await this.deps.store.getProvisioning()) {
      if (record.state === 'running') await this.resume(record);
    }
    await this.startRun(this.koalaTarget, 'revision');
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.watching?.close();
    this.watching = undefined;
  }

  ensure(target: ProvisionTarget, reason: Exclude<ProvisionReason, 'revision'>): Promise<ProvisioningRecord> {
    return this.startRun(target, reason);
  }

  async again(clusterId: string): Promise<ProvisioningRecord | undefined> {
    const record = (await this.deps.store.getProvisioning(clusterId)).at(-1);
    return record ? this.ensure(record.target, 'asked') : undefined;
  }

  async latest(): Promise<ProvisioningRecord[]> {
    const byCluster = new Map<string, ProvisioningRecord>();
    for (const record of await this.deps.store.getProvisioning()) byCluster.set(record.target.clusterId, record);
    return [...byCluster.values()].sort((a, b) => Number(b.target.kind === 'koala') - Number(a.target.kind === 'koala') || a.startedAt.localeCompare(b.startedAt));
  }

  async settled(recordId: string): Promise<Provisioned> {
    let finish!: (record: ProvisioningRecord) => void;
    const ended = new Promise<ProvisioningRecord>((resolve) => { finish = resolve; });
    const watching = this.deps.store.watchProvisioning((record) => {
      if (record.id === recordId && record.state !== 'running') finish(record);
    });
    try {
      await watching.ready;
      const now = await this.deps.store.getProvisioningRun(recordId);
      if (!now) throw new Error(`there is no setup run ${recordId}`);
      if (now.state !== 'running') finish(now);
      const record = await ended;
      return provisionedFor([record], record.target.clusterId, record.revision);
    } finally {
      await watching.close();
    }
  }

  private heard(record: ProvisioningRecord): void {
    this.deps.changed(record.ownerId, provisioningView(record));
    if (record.state === 'running' && record.workflowId) this.follow(record.id, record.workflowId);
  }

  private async startRun(target: ProvisionTarget, reason: ProvisionReason): Promise<ProvisioningRecord> {
    const { ownerId, revision } = this.deps.koala;
    const decision = startDecision(await this.deps.store.getProvisioning(target.clusterId), target, revision, reason);
    if (!decision.start) return 'running' in decision ? decision.running : decision.already;
    const at = this.at();
    const opened = openedRecord({ ownerId, target, revision, reason, runId: provisionRunId(target.clusterId, runStamp(at.getTime())), at: at.toISOString() });
    const open = await this.deps.store.openProvisioning(opened);
    if (!open.opened) return open.running;
    let workflowId: string;
    try {
      workflowId = await this.deps.runs.start({ ownerId, recordId: opened.id, target, revision, reason });
    } catch (err) {
      return this.settle(opened, `the setup could not start: ${messageOf(err)}`);
    }
    const named = await this.deps.store.patchProvisioning(opened.id, { workflowId });
    this.follow(opened.id, workflowId);
    return named ?? { ...opened, workflowId };
  }

  private async resume(record: ProvisioningRecord): Promise<void> {
    if (record.workflowId) {
      this.follow(record.id, record.workflowId);
      return;
    }
    const workflowId = await this.deps.runs.started(record.runId);
    if (!workflowId) {
      await this.settle(record, NEVER_STARTED);
      return;
    }
    await this.deps.store.patchProvisioning(record.id, { workflowId }, true);
    this.follow(record.id, workflowId);
  }

  private async settle(record: ProvisioningRecord, why: string): Promise<ProvisioningRecord> {
    const ended = runEnded(record, why, this.at().toISOString());
    return (await this.deps.store.patchProvisioning(record.id, endedPatch(ended), true)) ?? (await this.deps.store.getProvisioningRun(record.id)) ?? ended;
  }

  private follow(recordId: string, workflowId: string): void {
    if (this.following.has(recordId) || this.closed) return;
    this.following.add(recordId);
    const watch = async (): Promise<void> => {
      try {
        const why = await this.deps.runs.ended(workflowId);
        const record = await this.deps.store.getProvisioningRun(recordId);
        if (record?.state === 'running') await this.settle(record, why);
        this.followAgain.reset();
        this.following.delete(recordId);
      } catch (err) {
        if (this.closed) return;
        this.deps.log(`[provisioning] following the setup ${recordId} stopped (${messageOf(err)}); following it again in ${this.followAgain.seconds} s`);
        this.followAgain.later(() => { void watch(); });
      }
    };
    void watch();
  }
}
