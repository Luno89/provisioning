import { cleanPath, SEARCH_LIMIT, type FileEntry } from './file-places.js';

export const STORED_SCOPE_KINDS = ['project', 'person', 'conversation', 'run'] as const;
export type StoredScopeKind = typeof STORED_SCOPE_KINDS[number];

export interface StoredScope {
  kind: StoredScopeKind;
  id: string;
}

export type StoredFileKind = 'file' | 'folder';
export type StoredFileState = 'uploading' | 'stored';

export interface StoredFileRecord {
  id: string;
  objectId: string;
  ownerId: string;
  scope: StoredScope;
  path: string;
  kind: StoredFileKind;
  size: number;
  contentType: string;
  version: number;
  madeAt: string;
  changedAt: string;
  state: StoredFileState;
  touchedAt: string;
  expiresAt?: string | undefined;
}

export const STORED_FILES_BUCKET = 'koala';
export const TOUCH_EVERY_MS = 30_000;
export const DEAD_AFTER_MS = 10 * 60_000;
export const FOLDER_TYPE = 'inode/directory';

export const objectKey = (id: string): string => `files/${id}`;

export const idOfObjectKey = (key: string): string | undefined => (key.startsWith('files/') && key.length > 'files/'.length ? key.slice('files/'.length) : undefined);

export const sameScope = (a: StoredScope, b: StoredScope): boolean => a.kind === b.kind && a.id === b.id;

export const scopeText = (scope: StoredScope): string => `${scope.kind} ${scope.id}`;

export const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const isUnder = (path: string, folder: string): boolean => folder === '' || path === folder || path.startsWith(`${folder}/`);

export function scopeProblem(scope: StoredScope): string | undefined {
  if (!STORED_SCOPE_KINDS.includes(scope.kind)) return `${String(scope.kind)} is not a place files are kept`;
  if (!scope.id.trim()) return `a ${scope.kind}'s files need the ${scope.kind}'s id`;
  return undefined;
}

export function uploadIsDead(record: Pick<StoredFileRecord, 'state' | 'touchedAt'>, now: string): boolean {
  return record.state === 'uploading' && Date.parse(now) - Date.parse(record.touchedAt) >= DEAD_AFTER_MS;
}

export function touchDue(lastTouched: number, now: number): boolean {
  return now - lastTouched >= TOUCH_EVERY_MS;
}

export function expired(record: Pick<StoredFileRecord, 'expiresAt'>, now: string): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.parse(now);
}

const entryOf = (record: StoredFileRecord): FileEntry => (record.kind === 'folder'
  ? { name: nameOf(record.path), path: record.path, type: 'dir', modified: record.changedAt }
  : { name: nameOf(record.path), path: record.path, type: 'file', size: record.size, modified: record.changedAt });

const byFoldersThenName = (a: FileEntry, b: FileEntry): number => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);

export function listing(records: readonly StoredFileRecord[], dir: string): FileEntry[] {
  const found = new Map<string, FileEntry>();
  for (const record of records) {
    if (record.state !== 'stored' || record.path === dir || !isUnder(record.path, dir)) continue;
    const rest = dir === '' ? record.path : record.path.slice(dir.length + 1);
    const first = rest.split('/')[0]!;
    const path = dir === '' ? first : `${dir}/${first}`;
    if (first === rest) {
      const entry = entryOf(record);
      if (entry.type === 'file' || !found.has(path)) found.set(path, entry);
    } else if (!found.has(path)) {
      found.set(path, { name: first, path, type: 'dir' });
    }
  }
  return [...found.values()].sort(byFoldersThenName);
}

export function searching(records: readonly StoredFileRecord[], query: string): FileEntry[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];
  return records
    .filter((record) => record.state === 'stored' && record.kind === 'file' && nameOf(record.path).toLowerCase().includes(wanted))
    .map(entryOf)
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, SEARCH_LIMIT);
}

export interface PathMove {
  id: string;
  path: string;
}

export type MovePlan = { ok: true; moves: PathMove[] } | { ok: false; status: 404 | 409 | 400; why: string };

export function movePlan(records: readonly StoredFileRecord[], from: string, to: string): MovePlan {
  const source = cleanPath(from);
  const target = cleanPath(to);
  if (!source.ok) return { ok: false, status: 400, why: source.why };
  if (!target.ok) return { ok: false, status: 400, why: target.why };
  if (source.path === target.path) return { ok: true, moves: [] };
  if (isUnder(target.path, source.path)) return { ok: false, status: 400, why: `${source.path} cannot move inside itself` };
  const stored = records.filter((record) => record.state === 'stored');
  const moving = stored.filter((record) => isUnder(record.path, source.path));
  if (moving.length === 0) return { ok: false, status: 404, why: `${source.path} is not there` };
  const moves = moving.map((record) => ({ id: record.id, path: `${target.path}${record.path.slice(source.path.length)}` }));
  const staying = stored.filter((record) => !isUnder(record.path, source.path));
  const taken = staying.find((record) => isUnder(record.path, target.path));
  if (taken) return { ok: false, status: 409, why: `${target.path} is already there` };
  const fileAbove = staying.find((record) => record.kind === 'file' && isUnder(target.path, record.path));
  if (fileAbove) return { ok: false, status: 409, why: `${fileAbove.path} is a file, not a folder` };
  return { ok: true, moves };
}

export function scopeMovePlan(records: readonly StoredFileRecord[], under: string): PathMove[] {
  const prefix = cleanPath(under, { allowRoot: true });
  if (!prefix.ok) throw new Error(prefix.why);
  return records.map((record) => ({ id: record.id, path: prefix.path ? `${prefix.path}/${record.path}` : record.path }));
}

export type FolderPlan = { ok: true; exists: boolean } | { ok: false; status: 400 | 409; why: string };

export function folderPlan(records: readonly StoredFileRecord[], path: string): FolderPlan {
  const cleaned = cleanPath(path);
  if (!cleaned.ok) return { ok: false, status: 400, why: cleaned.why };
  const stored = records.filter((record) => record.state === 'stored');
  const file = stored.find((record) => record.kind === 'file' && (record.path === cleaned.path || isUnder(cleaned.path, record.path)));
  if (file) return { ok: false, status: 409, why: `${file.path} is a file` };
  return { ok: true, exists: stored.some((record) => isUnder(record.path, cleaned.path)) };
}

export type UploadPlan = { ok: true } | { ok: false; status: 400 | 409; why: string };

export function uploadPlan(records: readonly StoredFileRecord[], path: string): UploadPlan {
  const cleaned = cleanPath(path);
  if (!cleaned.ok) return { ok: false, status: 400, why: cleaned.why };
  const stored = records.filter((record) => record.state === 'stored');
  if (stored.some((record) => record.path !== cleaned.path && isUnder(record.path, cleaned.path))) return { ok: false, status: 409, why: `${cleaned.path} is a folder` };
  const above = stored.find((record) => record.kind === 'file' && isUnder(cleaned.path, record.path) && record.path !== cleaned.path);
  if (above) return { ok: false, status: 409, why: `${above.path} is a file, not a folder` };
  if (stored.some((record) => record.kind === 'folder' && record.path === cleaned.path)) return { ok: false, status: 409, why: `${cleaned.path} is a folder` };
  return { ok: true };
}

export interface StoredFileCommit {
  id: string;
  size: number;
}

export type CommitPlan =
  | { ok: true; stored: StoredFileRecord[]; replaced: string[]; absorbed: string[] }
  | { ok: false; status: 404 | 409 | 400; why: string };

export const committedAs = (record: StoredFileRecord | undefined, commit: StoredFileCommit): boolean =>
  record !== undefined && (record.id === commit.id || record.objectId === commit.id);

export function commitPlan(
  uploading: readonly (StoredFileRecord | undefined)[],
  commits: readonly StoredFileCommit[],
  inScope: (record: StoredFileRecord) => readonly StoredFileRecord[],
  options: { replace: boolean },
  at: string,
): CommitPlan {
  const stored: StoredFileRecord[] = [];
  const replaced: string[] = [];
  const absorbed: string[] = [];
  const claimed = new Set<string>();
  for (const [index, commit] of commits.entries()) {
    const record = uploading[index];
    if (!record || !committedAs(record, commit)) return { ok: false, status: 404, why: `the upload ${commit.id} is not waiting to be kept` };
    if (record.state === 'stored') {
      stored.push(record);
      continue;
    }
    const where = `${scopeText(record.scope)}:${record.path}`;
    if (claimed.has(where)) return { ok: false, status: 409, why: `${record.path} is uploaded twice at once` };
    claimed.add(where);
    const others = inScope(record);
    const batch = stored.filter((planned) => planned.ownerId === record.ownerId && sameScope(planned.scope, record.scope));
    const plan = uploadPlan([...others.filter((other) => other.id !== record.id && !batch.some((planned) => planned.id === other.id)), ...batch], record.path);
    if (!plan.ok) return plan;
    const old = others.find((other) => other.state === 'stored' && other.kind === 'file' && other.path === record.path);
    if (old && !options.replace) return { ok: false, status: 409, why: `${record.path} is already there, and it may not be replaced` };
    if (old) {
      replaced.push(old.objectId);
      absorbed.push(record.id);
      const { expiresAt: _was, ...kept } = old;
      stored.push({ ...kept, objectId: record.objectId, size: commit.size, contentType: record.contentType, version: old.version + 1, changedAt: at, touchedAt: at, ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}) });
    } else {
      stored.push({ ...record, state: 'stored', size: commit.size, changedAt: at, touchedAt: at, version: 1 });
    }
  }
  return { ok: true, stored, replaced, absorbed };
}
