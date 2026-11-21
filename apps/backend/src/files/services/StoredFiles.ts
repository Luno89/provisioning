import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { alreadyThere, noRoomFor } from '../lib/file-room.js';
import { cleanPath, type FileEntry } from '../lib/file-places.js';
import {
  FOLDER_TYPE, isUnder, listing, scopeProblem, searching, sameScope, touchDue, uploadPlan,
  type CommitPlan, type FilesRefusal, type StoredFileCommit, type StoredFileRecord, type StoredScope,
} from '../lib/stored-files.js';
import type { FilesStore } from '../store.js';
import type { ObjectStore } from './ObjectStore.js';

export type StoredOutcome<T> = { ok: true; value: T } | FilesRefusal;

export interface StoredFileCommits {
  commit(ownerId: string, commits: readonly StoredFileCommit[], options: { replace: boolean; scope?: StoredScope | undefined }): Promise<CommitPlan>;
  remove(ownerId: string, files: readonly Pick<StoredFileRecord, 'id' | 'objectId'>[], scope?: StoredScope | undefined): Promise<void>;
}

export type StoredFileRecords = Pick<FilesStore,
  'beginStoredFile' | 'touchStoredFile' | 'storedFilesIn' | 'storedFileById' | 'makeStoredFolder' | 'moveStoredFiles' | 'moveStoredScope' | 'storedFilesOwnedBy'>;

export interface StoredFilesDeps {
  records: StoredFileRecords;
  objects: ObjectStore;
  commits: StoredFileCommits;
  room: () => Promise<number>;
  now?: () => number;
  newId?: () => string;
}

export interface StoredDownload {
  record: StoredFileRecord;
  body: Readable;
}

export interface UploadOptions {
  replace: boolean;
  expiresAt?: string | undefined;
}

const refused = <T>(status: 400 | 404 | 409, why: string): StoredOutcome<T> => ({ ok: false, status, why });

const asIfKept = (record: StoredFileRecord): StoredFileRecord => ({ ...record, state: 'stored' });

export class StoredFiles {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: StoredFilesDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  at(ownerId: string, scope: StoredScope): Folder {
    const problem = scopeProblem(scope);
    if (problem) throw new Error(problem);
    return new Folder(this.deps, ownerId, { ...scope }, this.now, this.newId);
  }

  room(): Promise<number> {
    return this.deps.room();
  }

  async byId(ownerId: string, id: string): Promise<StoredDownload | undefined> {
    const record = await this.deps.records.storedFileById(id);
    if (!record || record.ownerId !== ownerId || record.state !== 'stored' || record.kind !== 'file') return undefined;
    return { record, body: await this.deps.objects.get(record.objectId) };
  }

  async recordById(ownerId: string, id: string): Promise<StoredFileRecord | undefined> {
    const record = await this.deps.records.storedFileById(id);
    return record && record.ownerId === ownerId && record.state === 'stored' ? record : undefined;
  }

  async removeOwned(ownerId: string): Promise<number> {
    const going = await this.deps.records.storedFilesOwnedBy(ownerId);
    if (going.length > 0) await this.deps.commits.remove(ownerId, going);
    return going.length;
  }

  async moveScope(ownerId: string, from: StoredScope, to: StoredScope, under: string): Promise<number> {
    const problem = scopeProblem(from) ?? scopeProblem(to);
    if (problem) throw new Error(problem);
    if (sameScope(from, to)) throw new Error('files cannot be moved into the place they are in');
    return this.deps.records.moveStoredScope(ownerId, from, to, under, new Date(this.now()).toISOString());
  }
}

export class Folder {
  constructor(
    private readonly deps: StoredFilesDeps,
    readonly ownerId: string,
    readonly scope: StoredScope,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {}

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private records(): Promise<StoredFileRecord[]> {
    return this.deps.records.storedFilesIn(this.ownerId, this.scope);
  }

  async list(dir: string): Promise<StoredOutcome<FileEntry[]>> {
    const cleaned = cleanPath(dir, { allowRoot: true });
    if (!cleaned.ok) return refused(400, cleaned.why);
    const records = await this.records();
    if (cleaned.path && !records.some((record) => isUnder(record.path, cleaned.path) && !(record.path === cleaned.path && record.kind === 'file'))) return refused(404, `${cleaned.path} is not a folder here`);
    return { ok: true, value: listing(records, cleaned.path) };
  }

  async files(): Promise<StoredFileRecord[]> {
    return (await this.records()).filter((record) => record.kind === 'file');
  }

  async search(query: string): Promise<FileEntry[]> {
    return searching(await this.records(), query);
  }

  async find(path: string): Promise<StoredFileRecord | undefined> {
    const cleaned = cleanPath(path);
    if (!cleaned.ok) return undefined;
    return (await this.records()).find((record) => record.path === cleaned.path && record.kind === 'file');
  }

  async download(path: string): Promise<StoredOutcome<StoredDownload>> {
    const cleaned = cleanPath(path);
    if (!cleaned.ok) return refused(400, cleaned.why);
    const record = await this.find(cleaned.path);
    if (!record) return refused(404, `${cleaned.path} is not here`);
    return { ok: true, value: { record, body: await this.deps.objects.get(record.objectId) } };
  }

  async startBatch(options: UploadOptions): Promise<UploadBatch> {
    return new UploadBatch(this.deps, this.ownerId, this.scope, await this.records(), options, this.now, this.newId);
  }

  async upload(path: string, body: Readable, size: number | undefined, contentType: string, options: UploadOptions): Promise<StoredOutcome<StoredFileRecord>> {
    const batch = await this.startBatch(options);
    const added = await batch.add(path, body, size, contentType);
    if (!added.ok) return added;
    const kept = await batch.keep();
    return kept.ok ? { ok: true, value: kept.value[0]! } : kept;
  }

  async makeFolder(path: string): Promise<StoredOutcome<{ path: string; made: boolean }>> {
    const cleaned = cleanPath(path);
    if (!cleaned.ok) return refused(400, cleaned.why);
    const at = this.iso();
    const id = this.newId();
    const made = await this.deps.records.makeStoredFolder({
      id, objectId: id, ownerId: this.ownerId, scope: this.scope, path: cleaned.path, kind: 'folder', size: 0, contentType: FOLDER_TYPE,
      version: 1, madeAt: at, changedAt: at, state: 'stored', touchedAt: at,
    });
    if (!made.ok) return made;
    return { ok: true, value: { path: cleaned.path, made: made.made } };
  }

  async move(from: string, to: string): Promise<StoredOutcome<{ path: string; moved: number }>> {
    const moved = await this.deps.records.moveStoredFiles(this.ownerId, this.scope, from, to, this.iso());
    if (!moved.ok) return moved;
    const target = cleanPath(to);
    return { ok: true, value: { path: target.ok ? target.path : to, moved: moved.moved } };
  }

  async remove(path: string): Promise<StoredOutcome<{ path: string; removed: number }>> {
    const cleaned = cleanPath(path);
    if (!cleaned.ok) return refused(400, cleaned.why);
    const going = (await this.records()).filter((record) => isUnder(record.path, cleaned.path));
    if (going.length === 0) return refused(404, `${cleaned.path} is not here`);
    await this.deps.commits.remove(this.ownerId, going, this.scope);
    return { ok: true, value: { path: cleaned.path, removed: going.length } };
  }

  async removeAll(): Promise<number> {
    const going = await this.records();
    if (going.length > 0) await this.deps.commits.remove(this.ownerId, going, this.scope);
    return going.length;
  }
}

export class UploadBatch {
  private readonly begun: StoredFileRecord[] = [];
  private readonly commits: StoredFileCommit[] = [];

  constructor(
    private readonly deps: StoredFilesDeps,
    readonly ownerId: string,
    readonly scope: StoredScope,
    private readonly there: readonly StoredFileRecord[],
    readonly options: UploadOptions,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {}

  get replace(): boolean {
    return this.options.replace;
  }

  check(path: string): StoredOutcome<{ path: string; taken: boolean }> {
    const cleaned = cleanPath(path);
    if (!cleaned.ok) return refused(400, cleaned.why);
    if (this.begun.some((record) => record.path === cleaned.path)) return refused(409, `${cleaned.path} is uploaded twice at once`);
    const plan = uploadPlan([...this.there, ...this.begun.map(asIfKept)], cleaned.path);
    if (!plan.ok) return plan;
    const taken = this.there.some((record) => record.state === 'stored' && record.kind === 'file' && record.path === cleaned.path);
    return { ok: true, value: { path: cleaned.path, taken } };
  }

  async add(path: string, body: Readable, size: number | undefined, contentType: string): Promise<StoredOutcome<StoredFileRecord>> {
    const checked = this.check(path);
    if (!checked.ok) return checked;
    const at = checked.value.path;
    if (checked.value.taken && !this.options.replace) return { ok: false, status: 409, why: alreadyThere([at]), exists: [at] };
    const noRoom = noRoomFor(size, await this.deps.room());
    if (noRoom) return { ok: false, status: 507, ...noRoom };
    const madeAt = new Date(this.now()).toISOString();
    const id = this.newId();
    const record: StoredFileRecord = {
      id, objectId: id, ownerId: this.ownerId, scope: this.scope, path: at, kind: 'file', size: 0, contentType,
      version: 0, madeAt, changedAt: madeAt, state: 'uploading', touchedAt: madeAt,
      ...(this.options.expiresAt ? { expiresAt: this.options.expiresAt } : {}),
    };
    await this.deps.records.beginStoredFile(record);
    this.begun.push(record);
    await this.deps.objects.put(record.objectId, body.pipe(this.touching(record.id)), size, contentType);
    const stat = await this.deps.objects.stat(record.objectId);
    if (!stat) throw new Error(`the bytes of ${at} were sent to the instance's MinIO and are not there`);
    this.commits.push({ id: record.id, size: stat.size });
    return { ok: true, value: record };
  }

  async keep(): Promise<StoredOutcome<StoredFileRecord[]>> {
    if (this.commits.length === 0) return refused(400, 'nothing was uploaded');
    if (this.commits.length < this.begun.length) throw new Error('a file of this upload is still arriving, so the upload cannot be kept yet');
    const committed: CommitPlan = await this.deps.commits.commit(this.ownerId, this.commits, { replace: this.options.replace, scope: this.scope });
    if (!committed.ok) {
      await this.abandon();
      return committed;
    }
    return { ok: true, value: committed.stored };
  }

  async abandon(): Promise<void> {
    if (this.begun.length > 0) await this.deps.commits.remove(this.ownerId, this.begun, this.scope);
  }

  private touching(id: string): Transform {
    let last = this.now();
    const { records } = this.deps;
    const now = this.now;
    return new Transform({
      transform(chunk: Buffer, _encoding, done) {
        const at = now();
        if (!touchDue(last, at)) {
          done(null, chunk);
          return;
        }
        last = at;
        records.touchStoredFile(id, new Date(at).toISOString()).then(() => done(null, chunk), (err: unknown) => done(err as Error));
      },
    });
  }
}
