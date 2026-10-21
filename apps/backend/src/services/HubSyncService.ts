import { applyPatch, diffRecord, type HubChange, type HubDirty, type HubLink, type HubSyncStore, type RecordChange, type SyncedDoc, type SyncedKind } from '../lib/hub-sync.js';
import type { HubService } from './HubService.js';
import { mainHeads, syncMain, type GitEnd } from './HubRepoSync.js';

export interface HubSyncTransport {
  push(link: HubLink, changes: RecordChange[]): Promise<{ through: number }>;
  pull(link: HubLink, after: number): Promise<{ changes: HubChange[]; through: number }>;
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
  log?: ((line: string) => void) | undefined;
}

const DIRTY_PAGE = 200;

type Pending = { entry: HubDirty; link: HubLink; change: RecordChange; after: SyncedDoc | undefined };

export class HubSyncService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(private readonly deps: HubSyncDeps) {}

  private async projectOf(kind: SyncedKind, doc: SyncedDoc, linked: ReadonlySet<string>, depth = 0): Promise<string | undefined> {
    if (depth > 6) return undefined;
    const up = async (upKind: SyncedKind, id: unknown) => {
      if (typeof id !== 'string' || !id) return undefined;
      const parent = await this.deps.store.syncedRecord(upKind, id);
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
      let answer: { changes: HubChange[]; through: number };
      try {
        answer = await this.deps.transport.pull(link, link.pulledThrough);
      } catch (err) {
        if (!await this.goneFromHub(link, err)) this.deps.log?.(`hub sync: ${link.projectId} not read yet: ${(err as Error).message}`);
        continue;
      }
      for (const { origin, change } of answer.changes) {
        if (origin === this.deps.origin) continue;
        if ('deleted' in change) {
          await this.deps.store.deleteSyncedRecord(change.kind, change.id);
          await this.deps.store.deleteHubSnapshot(change.kind, change.id);
        } else {
          const local = await this.deps.store.syncedRecord(change.kind, change.id);
          const snapshot = await this.deps.store.hubSnapshot(change.kind, change.id);
          await this.deps.store.writeSyncedRecord(change.kind, applyPatch(local, change.id, change.patch));
          await this.deps.store.saveHubSnapshot(link.projectId, change.kind, applyPatch(snapshot?.doc, change.id, change.patch));
        }
        applied += 1;
      }
      if (answer.through !== link.pulledThrough) await this.deps.store.saveHubLink({ ...link, pulledThrough: answer.through });
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
        const heads = await mainHeads(ends.owner, ends.hub);
        const unchanged = (known: { owner?: string | undefined; hub?: string | undefined } | undefined) => known?.owner === heads.owner && known?.hub === heads.hub;
        if (unchanged(link.repoHeads) || unchanged(link.repoConflict)) continue;
        const synced = await syncMain(ends.owner, ends.hub, () => `hub/main-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`);
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

  async once(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.pushOnce();
      await this.pullOnce();
      await this.syncRepos();
    } finally {
      this.busy = false;
    }
  }

  start(everyMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.once().catch((err: Error) => this.deps.log?.(`hub sync: ${err.message}`)); }, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function localHubSync(hub: { receive: HubService['receive']; changesSince: HubService['changesSince'] }, instanceId: string): HubSyncTransport {
  const origin = (link: HubLink) => ({ kind: 'instance' as const, personId: link.ownerId, instanceId });
  return {
    async push(link, changes) {
      const outcome = await hub.receive(origin(link), link.hubProjectId, changes);
      if (!outcome.ok) throw Object.assign(new Error(outcome.why), { status: outcome.status });
      return outcome.value;
    },
    async pull(link, after) {
      const outcome = await hub.changesSince(origin(link), link.hubProjectId, after);
      if (!outcome.ok) throw Object.assign(new Error(outcome.why), { status: outcome.status });
      return outcome.value;
    },
  };
}
