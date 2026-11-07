import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { cleanPath, type FileEntry } from '../lib/file-places.js';
import {
  FOLDER_TYPE, isUnder, listing, scopeProblem, searching, sameScope, touchDue, uploadPlan,
  type CommitPlan, type StoredFileCommit, type StoredFileRecord, type StoredScope,
} from '../lib/stored-files.js';
import type { FilesStore } from '../store.js';
import type { ObjectStore } from './ObjectStore.js';

export type StoredOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; why: string };

export interface StoredFileCommits {
  commit(ownerId: string, commits: readonly StoredFileCommit[], options: { replace: boolean }): Promise<CommitPlan>;
  remove(ownerId: string, ids: readonly string[]): Promise<void>;
}

export type StoredFileRecords = Pick<FilesStore,
  'beginStoredFile' | 'touchStoredFile' | 'storedFilesIn' | 'storedFileById' | 'makeStoredFolder' | 'moveStoredFiles' | 'moveStoredScope'>;

export interface StoredFilesDeps {
  records: StoredFileRecords;
  objects: ObjectStore;
  commits: StoredFileCommits;
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

  async byId(ownerId: string, id: string): Promise<StoredDownload | undefined> {
    const record = await this.deps.records.storedFileById(id);
    if (!record || record.ownerId !== ownerId || record.state !== 'stored' || record.kind !== 'file') return undefined;
    return { record, body: await this.deps.objects.get(record.id) };
  }

  async recordById(ownerId: string, id: string): Promise<StoredFileRecord | undefined> {
    const record = await this.deps.records.storedFileById(id);
    return record && record.ownerId === ownerId && record.state === 'stored' ? record : undefined;
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
    return { ok: true, value: { record, body: await this.deps.objects.get(record.id) } };
  }

  async upload(path: string, body: Readable, size: number | undefined, contentType: string, options: UploadOptions): Promise<StoredOutcome<StoredFileRecord>> {
    const cleaned = cleanPath(path);
    if (!cleaned.ok) return refused(400, cleaned.why);
    const records = await this.records();
    const plan = uploadPlan(records, cleaned.path);
    if (!plan.ok) return plan;
    if (!options.replace && records.some((record) => record.kind === 'file' && record.path === cleaned.path)) return refused(409, `${cleaned.path} is already there, and it may not be replaced`);
    const at = this.iso();
    const record: StoredFileRecord = {
      id: this.newId(), ownerId: this.ownerId, scope: this.scope, path: cleaned.path, kind: 'file', size: 0, contentType,
      version: 0, madeAt: at, changedAt: at, state: 'uploading', touchedAt: at,
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    };
    await this.deps.records.beginStoredFile(record);
    await this.deps.objects.put(record.id, body.pipe(this.touching(record.id)), size, contentType);
    const stat = await this.deps.objects.stat(record.id);
    if (!stat) throw new Error(`the bytes of ${cleaned.path} were sent to the instance's MinIO and are not there`);
    const committed = await this.deps.commits.commit(this.ownerId, [{ id: record.id, size: stat.size }], { replace: options.replace });
    if (!committed.ok) return committed;
    return { ok: true, value: committed.stored[0]! };
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

  async makeFolder(path: string): Promise<StoredOutcome<{ path: string; made: boolean }>> {
    const cleaned = cleanPath(path);
    if (!cleaned.ok) return refused(400, cleaned.why);
    const at = this.iso();
    const made = await this.deps.records.makeStoredFolder({
      id: this.newId(), ownerId: this.ownerId, scope: this.scope, path: cleaned.path, kind: 'folder', size: 0, contentType: FOLDER_TYPE,
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
    await this.deps.commits.remove(this.ownerId, going.map((record) => record.id));
    return { ok: true, value: { path: cleaned.path, removed: going.length } };
  }

  async removeAll(): Promise<number> {
    const going = await this.records();
    if (going.length > 0) await this.deps.commits.remove(this.ownerId, going.map((record) => record.id));
    return going.length;
  }
}
