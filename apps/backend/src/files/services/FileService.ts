import { randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { allowed, asPerson } from '../../platform/index.js';
import { inside, outside, storedPlaceOf, type FileEntry, type FileScope, type StoredPlace } from '../lib/file-places.js';
import { shareExpires, shareLive, SHARE_TOKEN, type FileShare, type ShareDays } from '../lib/file-shares.js';
import { alreadyThere, noRoomFor } from '../lib/file-room.js';
import { nameOf, sameScope, type FilesRefusal } from '../lib/stored-files.js';
import type { FilesStore } from '../store.js';
import { receiveStoredDrop } from './stored-drop.js';
import type { Folder, StoredFiles } from './StoredFiles.js';

export type { FileScope };

export interface FileServiceDeps {
  files: Pick<StoredFiles, 'at' | 'byId' | 'recordById' | 'room'>;
  shares: Pick<FilesStore, 'getFileShares' | 'getFileShare' | 'getFileShareByToken' | 'saveFileShare' | 'deleteFileShare'>;
  now?: (() => string) | undefined;
}

export interface Download {
  stream: Readable;
  size?: number | undefined;
  contentType: string;
}

export interface AttachableFile {
  id: string;
  path: string;
  size: number;
  contentType: string;
  projectId?: string | undefined;
}

export type FilesOutcome<T> = { ok: true; value: T } | FilesRefusal;

export interface KeptFile {
  path: string;
  id: string;
}

const refused = <T>(status: 400 | 404 | 409, why: string): FilesOutcome<T> => ({ ok: false, status, why });

const gone = refused<never>(404, 'This link does not exist, or it has expired.');

export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private open(ownerId: string, scope: FileScope): { folder: Folder; place: StoredPlace } {
    const place = storedPlaceOf(ownerId, scope);
    return { folder: this.deps.files.at(ownerId, place.scope), place };
  }

  private shown(under: string, entries: readonly FileEntry[]): FileEntry[] {
    return entries.flatMap((entry) => {
      const path = outside(under, entry.path);
      return path ? [{ ...entry, path }] : [];
    });
  }

  async list(ownerId: string, scope: FileScope, dir: string): Promise<FilesOutcome<FileEntry[]>> {
    const { folder, place } = this.open(ownerId, scope);
    const listed = await folder.list(inside(place.under, dir));
    if (!listed.ok) return place.under && !dir && listed.status === 404 ? { ok: true, value: [] } : listed;
    return { ok: true, value: this.shown(place.under, listed.value) };
  }

  async search(ownerId: string, scope: FileScope, query: string): Promise<FilesOutcome<FileEntry[]>> {
    if (!query.trim()) return { ok: true, value: [] };
    const { folder, place } = this.open(ownerId, scope);
    return { ok: true, value: this.shown(place.under, await folder.search(query)) };
  }

  async download(ownerId: string, scope: FileScope, path: string): Promise<FilesOutcome<Download>> {
    const { folder, place } = this.open(ownerId, scope);
    const found = await folder.download(inside(place.under, path));
    if (!found.ok) return found.status === 404 ? refused(404, `There is no file ${path}.`) : found;
    return { ok: true, value: { stream: found.value.body, size: found.value.record.size, contentType: found.value.record.contentType } };
  }

  async downloadById(ownerId: string, fileId: string): Promise<FilesOutcome<Download & { name: string }>> {
    const found = await this.deps.files.byId(ownerId, fileId);
    if (!found) return refused(404, 'You keep no file with that id.');
    return { ok: true, value: { stream: found.body, size: found.record.size, contentType: found.record.contentType, name: nameOf(found.record.path) } };
  }

  async downloadIn(ownerId: string, scope: FileScope, fileId: string): Promise<FilesOutcome<Download & { path: string }>> {
    const place = storedPlaceOf(ownerId, scope);
    const record = await this.deps.files.recordById(ownerId, fileId);
    const path = record && record.kind === 'file' && sameScope(record.scope, place.scope) ? outside(place.under, record.path) : undefined;
    if (!path) return refused(404, `There is no file ${fileId} here.`);
    const found = await this.deps.files.byId(ownerId, fileId);
    if (!found) return refused(404, `There is no file ${fileId} here.`);
    return { ok: true, value: { stream: found.body, size: found.record.size, contentType: found.record.contentType, path } };
  }

  async attachable(ownerId: string, fileId: string): Promise<AttachableFile | undefined> {
    const record = await this.deps.files.recordById(ownerId, fileId);
    if (!record || record.kind !== 'file') return undefined;
    return {
      id: record.id, path: record.path, size: record.size, contentType: record.contentType,
      ...(record.scope.kind === 'project' ? { projectId: record.scope.id } : {}),
    };
  }

  async room(): Promise<{ free: number }> {
    return { free: await this.deps.files.room() };
  }

  async upload(ownerId: string, scope: FileScope, path: string, body: Readable, size: number | undefined, contentType: string, options: { replace: boolean }): Promise<FilesOutcome<KeptFile>> {
    const { folder, place } = this.open(ownerId, scope);
    const stored = await folder.upload(inside(place.under, path), body, size, contentType, { replace: options.replace });
    if (!stored.ok) return stored.exists ? { ...stored, why: alreadyThere([path]), exists: true } : stored;
    return { ok: true, value: { path: outside(place.under, stored.value.path) ?? path, id: stored.value.id } };
  }

  async drop(ownerId: string, scope: FileScope, body: AsyncIterable<Buffer | string>, declared: number | undefined): Promise<FilesOutcome<{ files: KeptFile[] }>> {
    const noRoom = noRoomFor(declared, await this.deps.files.room());
    if (noRoom) return { ok: false, status: 507, ...noRoom };
    const { folder, place } = this.open(ownerId, scope);
    const kept = await receiveStoredDrop(body, (replace) => folder.startBatch({ replace }), (path) => inside(place.under, path));
    if (!kept.ok) {
      if (!Array.isArray(kept.exists)) return kept;
      const exists = kept.exists.map((path) => outside(place.under, path) ?? path);
      return { ...kept, why: alreadyThere(exists), exists };
    }
    return { ok: true, value: { files: kept.value.map((record) => ({ path: outside(place.under, record.path) ?? record.path, id: record.id })) } };
  }

  async remove(ownerId: string, scope: FileScope, path: string): Promise<FilesOutcome<{ path: string }>> {
    const { folder, place } = this.open(ownerId, scope);
    const removed = await folder.remove(inside(place.under, path));
    return removed.ok ? { ok: true, value: { path } } : removed;
  }

  async move(ownerId: string, scope: FileScope, from: string, to: string): Promise<FilesOutcome<{ path: string }>> {
    const { folder, place } = this.open(ownerId, scope);
    const moved = await folder.move(inside(place.under, from), inside(place.under, to));
    return moved.ok ? { ok: true, value: { path: to } } : moved;
  }

  async makeFolder(ownerId: string, scope: FileScope, path: string): Promise<FilesOutcome<{ path: string }>> {
    const { folder, place } = this.open(ownerId, scope);
    const made = await folder.makeFolder(inside(place.under, path));
    return made.ok ? { ok: true, value: { path } } : made;
  }

  async share(ownerId: string, scope: FileScope, path: string, days: ShareDays): Promise<FilesOutcome<FileShare>> {
    const { folder, place } = this.open(ownerId, scope);
    const record = await folder.find(inside(place.under, path));
    if (!record) return refused(404, `There is no file ${path}.`);
    const now = this.now();
    const share: FileShare = {
      id: randomUUID(),
      token: randomBytes(24).toString('base64url'),
      ownerId,
      ...(place.scope.kind === 'project' ? { projectId: place.scope.id } : {}),
      fileId: record.id,
      path,
      name: nameOf(record.path),
      createdAt: now,
      expiresAt: shareExpires(now, days),
    };
    await this.deps.shares.saveFileShare(share);
    return { ok: true, value: share };
  }

  async shares(ownerId: string): Promise<FileShare[]> {
    const now = this.now();
    return (await this.deps.shares.getFileShares(ownerId)).filter((share) => shareLive(share, now));
  }

  async unshare(ownerId: string, id: string): Promise<FilesOutcome<{ id: string }>> {
    const share = await this.deps.shares.getFileShare(id);
    if (!share || !allowed(asPerson(ownerId), 'change', { kind: 'record', noun: 'share link', ownerId: share.ownerId })) return refused(404, 'There is no such link.');
    await this.deps.shares.deleteFileShare(id);
    return { ok: true, value: { id } };
  }

  async shared(token: string): Promise<FilesOutcome<Download & { name: string }>> {
    if (!SHARE_TOKEN.test(token)) return gone;
    const share = await this.deps.shares.getFileShareByToken(token);
    if (!share) return gone;
    if (!shareLive(share, this.now())) {
      await this.deps.shares.deleteFileShare(share.id);
      return gone;
    }
    if (!share.fileId) return refused(404, 'This link was made for a file Koala no longer keeps, so it opens nothing.');
    const found = await this.deps.files.byId(share.ownerId, share.fileId);
    if (!found) return refused(404, 'The file this link was made for has been removed, so the link opens nothing.');
    return { ok: true, value: { stream: found.body, size: found.record.size, contentType: found.record.contentType, name: share.name } };
  }

  async removeProjectFiles(ownerId: string, projectId: string): Promise<number> {
    return this.deps.files.at(ownerId, { kind: 'project', id: projectId }).removeAll();
  }
}
