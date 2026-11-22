import type { ProvisioningView, ProvisionPieceKey, ProvisionReason, ProvisionReport, ProvisionRootRefusal, ProvisionTarget } from '@koala/engine-core/koala-install';
import type { MachineProgress } from '@koala/engine-core/machine-progress';
import { reopening, type Reopening } from '@koala/engine-core/reopening';
import { runStamp, type Watching } from '../../platform/index.js';
import {
  againPieces, heardPatch, openedRecord, piecesUp, progressSince, provisionedFor, provisioningView, provisionRunId, rootRefusal, rootReportOf, runEnded, startDecision,
  type Provisioned, type Provisioner, type ProvisioningRecord, type ProvisionRunInput,
} from '../lib/provisioning.js';
import type { InfrastructureStore } from '../store.js';

export interface ProvisionRuns {
  start(input: ProvisionRunInput): Promise<string>;
  ended(workflowId: string): Promise<string>;
}

export type RootAnswer = { ok: true } | { ok: false; status: number; error: string };

export interface ProvisionRoot {
  setup(report: ProvisionReport): Promise<RootAnswer>;
  setupAsked(): Promise<boolean>;
}

export interface ProvisioningDeps {
  store: Pick<InfrastructureStore, 'getProvisioning' | 'getProvisioningRun' | 'openProvisioning' | 'patchProvisioning' | 'watchProvisioning'>;
  runs: ProvisionRuns;
  root: ProvisionRoot;
  koala: { ownerId: string; clusterId: string; revision: number };
  changed(ownerId: string, view: ProvisioningView): void;
  log(line: string): void;
  up?: (piece: ProvisionPieceKey) => void;
  now?: () => Date;
  tellAgain?: Reopening;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface ProvisionAsksDeps {
  store: Pick<InfrastructureStore, 'getProvisioning' | 'getProvisioningRun' | 'openProvisioning' | 'watchProvisioning'>;
  koala: { ownerId: string; revision: number };
  now?: () => Date;
}

type Opening = { opened: ProvisioningRecord } | { joined: ProvisioningRecord };

async function openRun(deps: ProvisionAsksDeps, target: ProvisionTarget, reason: ProvisionReason, at: Date, runId: string, again = false): Promise<Opening> {
  const { ownerId, revision } = deps.koala;
  const records = await deps.store.getProvisioning(target.clusterId);
  const decision = startDecision(records, target, revision, reason);
  if (!decision.start) return { joined: 'running' in decision ? decision.running : decision.already };
  const pieces = again ? againPieces(records.at(-1), target, revision) : undefined;
  const opened = openedRecord({ ownerId, target, revision, reason, runId, at: at.toISOString(), pieces });
  const open = await deps.store.openProvisioning(opened);
  return open.opened ? { opened } : { joined: open.running };
}

async function settledRun(store: ProvisionAsksDeps['store'], recordId: string): Promise<Provisioned> {
  let finish!: (record: ProvisioningRecord) => void;
  const ended = new Promise<ProvisioningRecord>((resolve) => { finish = resolve; });
  const watching = store.watchProvisioning((record) => {
    if (record.id === recordId && record.state !== 'running') finish(record);
  });
  try {
    await watching.ready;
    const now = await store.getProvisioningRun(recordId);
    if (!now) throw new Error(`there is no setup run ${recordId}`);
    if (now.state !== 'running') finish(now);
    const record = await ended;
    return provisionedFor([record], record.target.clusterId, record.revision);
  } finally {
    await watching.close();
  }
}

export class ProvisionAsks implements Provisioner {
  constructor(private readonly deps: ProvisionAsksDeps) {}

  async ensure(target: ProvisionTarget, reason: Exclude<ProvisionReason, 'revision'>): Promise<ProvisioningRecord> {
    const at = this.deps.now ? this.deps.now() : new Date();
    const run = await openRun(this.deps, target, reason, at, provisionRunId(target.clusterId, runStamp(at.getTime())));
    return 'opened' in run ? run.opened : run.joined;
  }

  settled(recordId: string): Promise<Provisioned> {
    return settledRun(this.deps.store, recordId);
  }
}

export class Provisioning implements Provisioner {
  private watching: Watching | undefined;
  private readonly following = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly followAgain = reopening();
  private readonly toldRoot = new Map<string, ProvisioningRecord>();
  private readonly untold = new Map<string, MachineProgress[]>();
  private readonly unread = new Set<string>();
  private readonly upHeard = new Set<string>();
  private readonly tellAgain: Reopening;
  private telling: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: ProvisioningDeps) {
    this.tellAgain = deps.tellAgain ?? reopening();
  }

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
    const current = await this.startRun(this.koalaTarget, 'revision');
    this.noticeUp(current);
    this.tellRoot(current);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.watching?.close();
    this.watching = undefined;
    await this.telling;
  }

  ensure(target: ProvisionTarget, reason: Exclude<ProvisionReason, 'revision'>): Promise<ProvisioningRecord> {
    return this.startRun(target, reason);
  }

  async again(clusterId: string): Promise<ProvisioningRecord | undefined> {
    const record = (await this.deps.store.getProvisioning(clusterId)).at(-1);
    return record ? this.startRun(record.target, 'asked', true) : undefined;
  }

  async rootAsked(): Promise<ProvisioningRecord | undefined> {
    if (!(await this.deps.root.setupAsked())) return undefined;
    return this.again(this.deps.koala.clusterId);
  }

  async latest(): Promise<ProvisioningRecord[]> {
    const byCluster = new Map<string, ProvisioningRecord>();
    for (const record of await this.deps.store.getProvisioning()) byCluster.set(record.target.clusterId, record);
    return [...byCluster.values()].sort((a, b) => Number(b.target.kind === 'koala') - Number(a.target.kind === 'koala') || a.startedAt.localeCompare(b.startedAt));
  }

  settled(recordId: string): Promise<Provisioned> {
    return settledRun(this.deps.store, recordId);
  }

  private heard(record: ProvisioningRecord): void {
    this.deps.changed(record.ownerId, provisioningView(record));
    this.noticeUp(record);
    if (record.target.kind === 'koala') this.tellRoot(record);
    if (record.state === 'running' && record.workflowId) this.follow(record.id, record.workflowId);
    if (record.state === 'running' && !record.workflowId && !this.closed) void this.startAsked(record.id);
  }

  private noticeUp(record: ProvisioningRecord): void {
    if (record.target.kind !== 'koala' || record.target.clusterId !== this.deps.koala.clusterId) return;
    for (const piece of piecesUp(record)) {
      const key = `${record.id}/${piece}`;
      if (this.upHeard.has(key)) continue;
      this.upHeard.add(key);
      this.deps.up?.(piece);
    }
  }

  private async startAsked(recordId: string): Promise<void> {
    if (this.starting.has(recordId)) return;
    this.starting.add(recordId);
    try {
      const record = await this.deps.store.getProvisioningRun(recordId);
      if (record?.state === 'running' && !record.workflowId) await this.begin(record);
    } catch (err) {
      this.deps.log(`[provisioning] the setup ${recordId} another process asked for could not be started: ${messageOf(err)}`);
    } finally {
      this.starting.delete(recordId);
    }
  }

  private tellRoot(known: ProvisioningRecord): void {
    const recordId = known.id;
    this.telling = this.telling.then(async () => {
      if (this.closed) return;
      const record = await this.deps.store.getProvisioningRun(recordId);
      if (this.unread.delete(recordId)) {
        this.tellAgain.reset();
        if (record) this.deps.changed(record.ownerId, provisioningView(record));
      }
      if (!record) return;
      const fresh = progressSince(this.toldRoot.get(recordId), record);
      this.toldRoot.set(recordId, record);
      if (fresh.length === 0 || !rootReportOf(record, fresh[0]!)) return;
      const lines = [...(this.untold.get(recordId) ?? []), ...fresh];
      this.untold.delete(recordId);
      let refused: ProvisionRootRefusal | undefined;
      for (const [at, progress] of lines.entries()) {
        let answer: RootAnswer;
        try {
          answer = await this.deps.root.setup(rootReportOf(record, progress)!);
        } catch (err) {
          this.untold.set(recordId, lines.slice(at));
          refused = rootRefusal(progress, { thrown: messageOf(err) }, this.at().toISOString());
          break;
        }
        refused = answer.ok ? undefined : rootRefusal(progress, answer, this.at().toISOString());
      }
      if (refused?.why !== record.root?.why) await this.deps.store.patchProvisioning(recordId, { root: refused });
    }).catch((err: unknown) => {
      const why = `Koala could not read or write this setup to tell root how it goes: ${messageOf(err)}`;
      this.deps.log(`[provisioning] ${recordId}: ${why}; trying again in ${this.tellAgain.seconds} s`);
      this.unread.add(recordId);
      this.deps.changed(known.ownerId, { ...provisioningView(known), root: { why, at: this.at().toISOString() } });
      if (!this.closed) this.tellAgain.later(() => { if (!this.closed) this.tellRoot(known); });
    });
  }

  private async startRun(target: ProvisionTarget, reason: ProvisionReason, again = false): Promise<ProvisioningRecord> {
    const at = this.at();
    const runId = provisionRunId(target.clusterId, runStamp(at.getTime()));
    this.starting.add(runId);
    try {
      const run = await openRun(this.deps, target, reason, at, runId, again);
      return 'opened' in run ? await this.begin(run.opened) : run.joined;
    } finally {
      this.starting.delete(runId);
    }
  }

  private async resume(record: ProvisioningRecord): Promise<void> {
    this.tellRoot(record);
    if (record.workflowId) {
      this.follow(record.id, record.workflowId);
      return;
    }
    if (this.starting.has(record.id)) return;
    this.starting.add(record.id);
    try {
      await this.begin(record);
    } finally {
      this.starting.delete(record.id);
    }
  }

  private async begin(record: ProvisioningRecord): Promise<ProvisioningRecord> {
    let workflowId: string;
    try {
      workflowId = await this.deps.runs.start({ ownerId: record.ownerId, recordId: record.id, target: record.target, revision: record.revision, reason: record.reason });
    } catch (err) {
      return this.settle(record, `the setup could not start: ${messageOf(err)}`);
    }
    const named = await this.deps.store.patchProvisioning(record.id, { workflowId }, true);
    return named ?? { ...record, workflowId };
  }

  private async settle(record: ProvisioningRecord, why: string): Promise<ProvisioningRecord> {
    const ended = runEnded(record, why, this.at().toISOString());
    return (await this.deps.store.patchProvisioning(record.id, heardPatch(ended), true)) ?? (await this.deps.store.getProvisioningRun(record.id)) ?? ended;
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
