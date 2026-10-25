import { createHash } from 'node:crypto';

export const INFISICAL_NAME_LIMIT = 64;
const READER_STAMP = 8;

function fitted(prefix: string, projectId: string, room: number): string {
  if (prefix.length + projectId.length <= room) return `${prefix}${projectId}`;
  const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 12);
  return `${prefix}${projectId.slice(0, room - prefix.length - hash.length - 1)}-${hash}`;
}

export function workspaceNameFor(projectId: string): string {
  return fitted('provisioning-', projectId, INFISICAL_NAME_LIMIT);
}

export function readerPrefixFor(projectId: string): string {
  return `${fitted('reader-', projectId, INFISICAL_NAME_LIMIT - READER_STAMP - 1)}-`;
}

export function readerNameFor(projectId: string, at: number): string {
  return `${readerPrefixFor(projectId)}${at.toString(36).padStart(READER_STAMP, '0').slice(-READER_STAMP)}`;
}
