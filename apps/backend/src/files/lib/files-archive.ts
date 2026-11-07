import { cleanPath, FOLDER_MARK } from './file-places.js';

export const ARCHIVE_FOLDER = 'Archive';
export const OLD_BUCKETS = ['koala-files', 'koala-artifacts'] as const;
export const ARCHIVE_MIGRATION = 'stored-files-archived';

export interface OldArtifact {
  ownerId: string;
  runId: string;
  name: string;
  contentType: string;
  bytes: Buffer;
}

export type ArchivedEntry = { kind: 'file' | 'folder'; path: string } | { kind: 'none' };

const archived = (...parts: string[]): string | undefined => {
  const cleaned = cleanPath(parts.join('/'));
  return cleaned.ok ? cleaned.path : undefined;
};

export function archivedObject(appName: string, bucket: string, key: string): ArchivedEntry {
  const name = appName.trim() || 'minio';
  if (key === FOLDER_MARK || key.endsWith(`/${FOLDER_MARK}`)) {
    const folder = key === FOLDER_MARK ? '' : key.slice(0, -(FOLDER_MARK.length + 1));
    const path = archived(ARCHIVE_FOLDER, name, bucket, folder);
    return path ? { kind: 'folder', path } : { kind: 'none' };
  }
  if (key.endsWith('/')) return { kind: 'none' };
  const path = archived(ARCHIVE_FOLDER, name, bucket, key);
  return path ? { kind: 'file', path } : { kind: 'none' };
}

export function archivedArtifact(runId: string, name: string): string | undefined {
  return archived(ARCHIVE_FOLDER, 'artifacts', runId || 'no-run', name || 'artifact');
}
