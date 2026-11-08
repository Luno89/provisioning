import { applyPatch, diffRecord, type HubChange, type HubDirty, type HubLink, type HubSyncStore, type RecordChange, type SyncedDoc, type SyncedKind } from '../lib/hub-sync.js';
import { CHANGES_PAGE } from './HubService.js';
import type { Processes } from '../../platform/index.js';
import { mainHeads, syncMain, type GitEnd } from './HubRepoSync.js';
import type { HubMemberName } from '../lib/hub-sync.js';
import type { HubRequest, HubStatus } from '../lib/hub-board.js';
import type { HubInstanceWork, InstanceAnswer, InstanceCall } from './HubInstanceWork.js';
import { elapsedSeconds, koalaMetrics } from '@koala/engine-core/telemetry';
import { ignore } from '@koala/engine-core/failures';
import type { Watching } from '../../platform/index.js';

export interface HubSyncTransport {
  push(link: HubLink, changes: RecordChange[]): Promise<{ through: number }>;
  pull(link: HubLink, after: number): Promise<{ changes: HubChange[]; through: number; members?: HubMemberName[] | undefined }>;
  requests(link: HubLink): Promise<HubRequest[]>;
  settle(link: HubLink, requestId: string, outcome: { state: 'done' | 'refused'; why?: string | undefined }): Promise<void>;
  status(link: HubLink, status: HubStatus): Promise<void>;
  connect(line: HubLineHandlers): () => void;
  answer(link: HubLink, callId: string, answer: InstanceAnswer): Promise<void>;
}

export interface HubLineHandlers {
  connected(): void;
  call(call: InstanceCall): void;
  changed(hubProjectId: string): void;
}

export interface HubRepoSides {
  ends(link: HubLink): Promise<{ owner: GitEnd; hub: GitEnd } | undefined>;
  conflicted(link: HubLink, conflict: { files: string[]; kept: string }): Promise<void>;
}

export interface HubSyncDeps {
  store: HubSyncStore;
  transport: HubSyncTransport;
  origin: string;
  repos?: HubRepoSides | undefined;
  git?: Processes | undefined;
  work?: (() => HubInstanceWork | undefined) | undefined;
  log?: ((line: string) => void) | undefined;
}

const sameStatus = (a: HubStatus | undefined, b: HubStatus): boolean => {
  if (!a) return false;
  const { at: _a, ...left } = a;
  const { at: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
};

const DIRTY_PAGE = 200;
const PULL_PAGES = 20;

type Pending = { entry: HubDirty; link: HubLink; change: RecordChange; after: SyncedDoc | undefined };

export class HubSyncService {
  private running: Promise<void> | undefined;
  private next: Promise<void> | undefined;
  private readonly sentStatus = new Map<string, HubStatus>();
  private statusOfAll = false;
  private moved = new Set<string>();
  private parents = new Map<string, SyncedDoc | undefined>();
  private watching: Watching | undefined;
  private disconnect: (() => void) | undefined;

  constructor(private readonly deps: HubSyncDeps) {}

  private async projectOf(kind: SyncedKind, doc: SyncedDoc, linked: ReadonlySet<string>, depth = 0): Promise<string | undefined> {
    if (depth > 6) return undefined;
    const up = async (upKind: SyncedKind, id: unknown) => {
      if (typeof id !== 'string' || !id) return undefined;
      const key = `${upKind}/${id}`;
      if (!this.parents.has(key)) this.parents.set(key, await this.deps.store.syncedRecord(upKind, id));
      const parent = this.parents.get(key);
      return parent ? this.projectOf(upKind, parent, linked, depth + 1) : undefined;
    };
    switch (kind) {
      case 'trees': return ((doc.projectIds as string[] | undefined) ?? []).find((id) => linked.has(id));
      case 'branches': return up('trees', doc.treeId);
      case 'leaves': return up('branches', doc.branchId);
      case 'tasks': return doc.leafId ? up('leaves', doc.leafId) : linked.has(String(doc.projectId)) ? String(doc.projectId) : undefined;
      case 'conversations':
        if (doc.kind !== 'channel' && doc.kind !== 'item') return undefined;
        if (typeof doc.projectId === 'string' && linked.has(doc.projectId)) return doc.projectId;
        return up('trees', doc.treeId);
      case 'planProposals': return up('conversations', doc.conversationId);
    }
  }

  async pushOnce(): Promise<number> {
    const dirty = await this.deps.store.hubDirty(DIRTY_PAGE);
    if (dirty.length === 0) return 0;
    this.parents = new Map();
    const links = new Map((await this.deps.store.getHubLinks()).map((link) => [link.projectId, link]));
    const linked = new Set(links.keys());
    const pending: Pending[] = [];
    const settled: HubDirty[] = [];
    for (const entry of dirty) {
      const doc = entry.deleted ? undefined : await this.deps.store.syncedRecord(entry.kind, entry.id);
      const snapshot = await this.deps.store.hubSnapshot(entry.kind, entry.id);
      const projectId = doc ? await this.projectOf(entry.kind, doc, linked) : undefined;
      const link = projectId ? links.get(projectId) : undefined;
      const before = snapshot && snapshot.projectId === projectId ? snapshot.doc : undefined;
      if (snapshot && snapshot.projectId !== projectId && links.has(snapshot.projectId)) {
        pending.push({ entry, link: links.get(snapshot.projectId)!, change: { kind: entry.kind, id: entry.id, deleted: true }, after: undefined });
      }
      const patch = doc && link ? diffRecord(before, doc) : undefined;
      if (doc && link && patch) pending.push({ entry, link, change: { kind: entry.kind, id: entry.id, patch }, after: doc });
      if (!pending.some((item) => item.entry === entry)) {
        if (snapshot && !links.has(snapshot.projectId)) await this.deps.store.deleteHubSnapshot(entry.kind, entry.id);
        settled.push(entry);
      }
    }
    let sent = 0;
    for (const link of new Set(pending.map((item) => item.link))) {
      const mine = pending.filter((item) => item.link === link);
      try {
        await this.deps.transport.push(link, mine.map((item) => item.change));
      } catch (err) {
        if (await this.goneFromHub(link, err)) settled.push(...mine.map((item) => item.entry));
        else this.deps.log?.(`hub sync: ${link.projectId} not sent yet: ${(err as Error).message}`);
        continue;
      }
      for (const item of mine) {
        if (item.after) await this.deps.store.saveHubSnapshot(link.projectId, item.change.kind, item.after);
        else await this.deps.store.deleteHubSnapshot(item.change.kind, item.change.id);
        settled.push(item.entry);
      }
      this.moved.add(link.projectId);
      sent += mine.length;
    }
    await this.deps.store.clearHubDirty(settled);
    return sent;
  }

  private async goneFromHub(link: HubLink, err: unknown): Promise<boolean> {
    if ((err as { status?: number }).status !== 404) return false;
    await this.deps.store.deleteHubLink(link.projectId);
    await this.deps.store.deleteHubSnapshots(link.projectId);
    this.deps.log?.(`hub sync: ${link.projectId} is no longer on the hub, so it is no longer shared`);
    return true;
  }

  async pullOnce(): Promise<number> {
    let applied = 0;
    for (const link of await this.deps.store.getHubLinks()) {
      let after = link.pulledThrough;
      let members = link.members;
      for (let page = 0; page < PULL_PAGES; page += 1) {
        let answer: Awaited<ReturnType<HubSyncTransport['pull']>>;
        try {
          answer = await this.deps.transport.pull(link, after);
        } catch (err) {
          if (!await this.goneFromHub(link, err)) this.deps.log?.(`hub sync: ${link.projectId} not read yet: ${(err as Error).message}`);
          break;
        }
        for (const { origin, change } of answer.changes) {
          if (origin === this.deps.origin) continue;
          if ('deleted' in change) {
            await this.deps.store.deleteSyncedRecord(change.kind, change.id);
            await this.deps.store.deleteHubSnapshot(change.kind, change.id);
          } else {
            const snapshot = await this.deps.store.hubSnapshot(change.kind, change.id);
            await this.deps.store.patchSyncedRecord(change.kind, change.id, change.patch);
            await this.deps.store.saveHubSnapshot(link.projectId, change.kind, applyPatch(snapshot?.doc, change.id, change.patch));
          }
          applied += 1;
        }
        const named = answer.members && JSON.stringify(answer.members) !== JSON.stringify(members);
        if (named) members = answer.members;
        if (answer.through !== after || named) await this.deps.store.saveHubLink({ ...link, ...(members ? { members } : {}), pulledThrough: answer.through });
        after = answer.through;
        if (answer.changes.length < CHANGES_PAGE) break;
      }
    }
    return applied;
  }

  async syncRepos(): Promise<number> {
    let moved = 0;
    if (!this.deps.repos) return moved;
    for (const link of await this.deps.store.getHubLinks()) {
      if (!link.repo) continue;
      try {
        const ends = await this.deps.repos.ends(link);
        if (!ends) continue;
        const heads = await mainHeads(ends.owner, ends.hub, this.deps.git);
        const unchanged = (known: { owner?: string | undefined; hub?: string | undefined } | undefined) => known?.owner === heads.owner && known?.hub === heads.hub;
        if (unchanged(link.repoHeads) || unchanged(link.repoConflict)) continue;
        const synced = await syncMain(ends.owner, ends.hub, () => `hub/main-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`, this.deps.git);
        const fresh = (await this.deps.store.getHubLinks()).find((entry) => entry.projectId === link.projectId);
        if (!fresh) continue;
        if (synced.outcome === 'conflict') {
          await this.deps.store.saveHubLink({ ...fresh, repoConflict: { ...heads, kept: synced.kept } });
          await this.deps.repos.conflicted(fresh, { files: synced.files, kept: synced.kept });
        } else {
          const { repoConflict: _cleared, ...rest } = fresh;
          await this.deps.store.saveHubLink({ ...rest, repoHeads: { owner: synced.head, hub: synced.head } });
          if (synced.outcome !== 'same') moved += 1;
        }
      } catch (err) {
        this.deps.log?.(`hub sync: ${link.projectId}'s main not synced yet: ${(err as Error).message}`);
      }
    }
    return moved;
  }

  async carryOutRequests(): Promise<number> {
    const work = this.deps.work?.();
    if (!work) return 0;
    let settled = 0;
    for (const link of await this.deps.store.getHubLinks()) {
      let waiting: HubRequest[];
      try {
        waiting = await this.deps.transport.requests(link);
      } catch (err) {
        this.deps.log?.(`hub sync: ${link.projectId}'s requests not read yet: ${(err as Error).message}`);
        continue;
      }
      for (const request of waiting.filter((entry) => entry.after <= link.pulledThrough)) {
        const done = await work.carryOut(link, request).catch((err: Error) => ({ ok: false as const, why: err.message }));
        try {
          await this.deps.transport.settle(link, request.id, done.ok ? { state: 'done' } : { state: 'refused', why: done.why });
          settled += 1;
        } catch (err) {
          this.deps.log?.(`hub sync: ${link.projectId}'s request ${request.id} was carried out but not settled yet: ${(err as Error).message}`);
        }
      }
    }
    return settled;
  }

  async sendStatus(): Promise<number> {
    const work = this.deps.work?.();
    if (!work) return 0;
    let sent = 0;
    const moved = this.moved;
    const all = this.statusOfAll;
    this.moved = new Set();
    this.statusOfAll = false;
    for (const link of await this.deps.store.getHubLinks()) {
      if (!all && !moved.has(link.projectId)) continue;
      try {
        const status = await work.statusOf(link);
        if (!status || sameStatus(this.sentStatus.get(link.projectId), status)) continue;
        await this.deps.transport.status(link, status);
        this.sentStatus.set(link.projectId, status);
        sent += 1;
      } catch (err) {
        this.deps.log?.(`hub sync: ${link.projectId}'s status not sent yet: ${(err as Error).message}`);
      }
    }
    return sent;
  }

  private async answerFor(call: InstanceCall): Promise<void> {
    const work = this.deps.work?.();
    const link = (await this.deps.store.getHubLinks()).find((entry) => entry.hubProjectId === call.projectId);
    if (!work || !link) {
      await this.deps.transport.answer({ hubProjectId: call.projectId } as HubLink, call.id, { kind: 'json', status: 503, body: { error: 'The owner\'s instance is not sharing this project any more.' } })
        .catch((err: Error) => this.deps.log?.(`hub sync: an answer to the hub was lost: ${err.message}`));
      return;
    }
    await this.answerCall(work, link, call);
  }

  private async answerCall(work: HubInstanceWork, link: HubLink, call: InstanceCall): Promise<void> {
    const answer = await work.handle(link, call).catch((err: Error): InstanceAnswer => ({ kind: 'json', status: 502, body: { error: `The owner's instance could not answer: ${err.message}` } }));
    await this.deps.transport.answer(link, call.id, answer).catch((err: Error) => this.deps.log?.(`hub sync: an answer to the hub was lost: ${err.message}`));
  }

  private async timed<T>(step: string, run: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await run();
    } finally {
      koalaMetrics().hubSyncSeconds.record(elapsedSeconds(startedAt), { step });
    }
  }

  once(): Promise<void> {
    if (!this.running) {
      this.running = this.pass().finally(() => { this.running = undefined; });
      return this.running;
    }
    this.next ??= this.running.catch(ignore('whoever started the running pass hears how it failed; the next pass only waits for it to end')).then(() => {
      this.next = undefined;
      return this.once();
    });
    return this.next;
  }

  private async pass(): Promise<void> {
    koalaMetrics().hubChangesSent.add(await this.timed('push', () => this.pushOnce()));
    await this.timed('pull', () => this.pullOnce());
    await this.timed('repos', () => this.syncRepos());
    await this.timed('requests', () => this.carryOutRequests());
    await this.timed('status', () => this.sendStatus());
  }

  private kick(): void {
    this.once().catch((err: Error) => this.deps.log?.(`hub sync: ${err.message}`));
  }

  repoMoved(): void {
    this.kick();
  }

  statusMoved(): void {
    this.statusOfAll = true;
    this.kick();
  }

  async start(): Promise<void> {
    if (this.watching) return;
    this.watching = this.deps.store.watchHubDirty(() => this.kick());
    await this.watching.ready;
    this.disconnect = this.deps.transport.connect({
      connected: () => this.statusMoved(),
      changed: () => this.kick(),
      call: (call) => { void this.answerFor(call); },
    });
    this.kick();
  }

  async stop(): Promise<void> {
    this.disconnect?.();
    this.disconnect = undefined;
    await this.watching?.close();
    this.watching = undefined;
  }
}
