import { asStored } from '../../platform/testing/as-stored.js';
import { copied, collectionIn, type Collections } from '../../platform/testing/memory-records.js';
import { fieldUpdate, messageUpdates, type HubDirty, type HubLink, type MessageMatch, type RecordPatch, type SyncedDoc, type SyncedKind } from '../lib/hub-sync.js';
import type { HubStore } from '../store.js';

type Row = Record<string, unknown>;
type StoredLink = Omit<HubLink, 'projectId'>;
type Snapshot = { projectId: string; kind: SyncedKind; doc: SyncedDoc };

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

function matches(message: unknown, wanted: MessageMatch): boolean {
  if (!isRow(message) || message.role !== wanted.role || message.at !== wanted.at) return false;
  if ('$exists' in wanted.author) return !('author' in message);
  return JSON.stringify(message.author) === JSON.stringify(wanted.author);
}

function setPath(row: Row, path: string, value: unknown): void {
  const steps = path.split('.');
  let at = row;
  for (const step of steps.slice(0, -1)) {
    const next = at[step];
    if (!isRow(next)) at[step] = {};
    at = at[step] as Row;
  }
  at[steps[steps.length - 1]!] = value;
}

function unsetPath(row: Row, path: string): void {
  const steps = path.split('.');
  let at: unknown = row;
  for (const step of steps.slice(0, -1)) at = isRow(at) ? at[step] : undefined;
  if (isRow(at)) delete at[steps[steps.length - 1]!];
}

const byAt = (a: unknown, b: unknown): number => {
  const left = isRow(a) && typeof a.at === 'string' ? a.at : '';
  const right = isRow(b) && typeof b.at === 'string' ? b.at : '';
  return left < right ? -1 : left > right ? 1 : 0;
};

export class MemoryHubStore implements HubStore {
  private readonly links: Map<string, StoredLink>;
  private readonly dirty = new Map<string, HubDirty>();
  private readonly snapshots: Map<string, Snapshot>;

  constructor(private readonly collections: Collections = new Map()) {
    this.links = collectionIn<StoredLink>(collections, 'hubLinks');
    this.snapshots = collectionIn<Snapshot>(collections, 'hubSnapshots');
  }

  private rows(kind: SyncedKind): Map<string, Row> {
    return collectionIn<Row>(this.collections, kind);
  }

  async ensureIndexes(): Promise<void> {}

  async getHubLinks(): Promise<HubLink[]> {
    return [...this.links.entries()].map(([projectId, rest]) => ({ ...copied(rest), projectId }));
  }

  async saveHubLink(link: HubLink): Promise<void> {
    const { projectId, ...rest } = asStored(link);
    this.links.set(projectId, rest);
  }

  async deleteHubLink(projectId: string): Promise<void> {
    this.links.delete(projectId);
  }

  async markForHub(kind: SyncedKind, id: string, deleted: boolean): Promise<void> {
    if (this.links.size === 0) return;
    const at = `${String(Date.now()).padStart(15, '0')}-${Math.random().toString(36).slice(2, 10)}`;
    this.dirty.set(`${kind}/${id}`, { kind, id, deleted, at });
  }

  async hubDirty(limit: number): Promise<HubDirty[]> {
    const ordered = [...this.dirty.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const wanted = Math.abs(limit);
    return copied(wanted === 0 ? ordered : ordered.slice(0, wanted));
  }

  async clearHubDirty(entries: readonly HubDirty[]): Promise<void> {
    for (const entry of entries) {
      const key = `${entry.kind}/${entry.id}`;
      if (this.dirty.get(key)?.at === entry.at) this.dirty.delete(key);
    }
  }

  async syncedRecord(kind: SyncedKind, id: string): Promise<SyncedDoc | undefined> {
    const row = this.rows(kind).get(id);
    return row ? { ...copied(row), id } : undefined;
  }

  async patchSyncedRecord(kind: SyncedKind, id: string, patch: RecordPatch): Promise<void> {
    const rows = this.rows(kind);
    const fields = fieldUpdate(patch);
    const messages = messageUpdates(patch);
    if (fields) {
      const row = rows.get(id) ?? { id };
      for (const [field, value] of Object.entries(asStored(fields.$set ?? {}))) setPath(row, field, value);
      for (const field of Object.keys(fields.$unset ?? {})) unsetPath(row, field);
      rows.set(id, row);
    }
    if (messages.pull) {
      const row = rows.get(id);
      if (row && Array.isArray(row.messages)) {
        const wanted = messages.pull;
        row.messages = row.messages.filter((message) => !wanted.some((match) => matches(message, match)));
      }
    }
    if (messages.push) {
      const row = rows.get(id) ?? { id };
      const existing: unknown[] = Array.isArray(row.messages) ? row.messages : [];
      row.messages = [...existing, ...asStored(messages.push)].sort(byAt);
      rows.set(id, row);
    }
  }

  async deleteSyncedRecord(kind: SyncedKind, id: string): Promise<void> {
    this.rows(kind).delete(id);
  }

  async hubSnapshot(kind: SyncedKind, id: string): Promise<{ projectId: string; doc: SyncedDoc } | undefined> {
    const found = this.snapshots.get(`${kind}/${id}`);
    return found ? copied({ projectId: found.projectId, doc: found.doc }) : undefined;
  }

  async saveHubSnapshot(projectId: string, kind: SyncedKind, doc: SyncedDoc): Promise<void> {
    this.snapshots.set(`${kind}/${doc.id}`, asStored({ projectId, kind, doc }));
  }

  async deleteHubSnapshot(kind: SyncedKind, id: string): Promise<void> {
    this.snapshots.delete(`${kind}/${id}`);
  }

  async deleteHubSnapshots(projectId: string): Promise<void> {
    for (const [key, snapshot] of this.snapshots) if (snapshot.projectId === projectId) this.snapshots.delete(key);
  }
}
