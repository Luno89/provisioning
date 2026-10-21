export type FileServerKind = 'minio' | 'nextcloud';

export const FILES_BUCKET = 'koala-files';
export const NEXTCLOUD_ROOT = 'Koala';
export const NEXTCLOUD_USER = 'admin';
export const NEXTCLOUD_HOST = 'nextcloud';

export interface FileSettings {
  ownerId: string;
  deploymentId?: string | undefined;
}

export interface FileServer {
  kind: FileServerKind;
  deploymentId: string;
  name: string;
  clusterId: string;
}

export interface FilePlace {
  kind: FileServerKind;
  deploymentId: string;
  folder: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number | undefined;
  modified?: string | undefined;
}

export interface ServerCandidate {
  id: string;
  name: string;
  appType?: string | undefined;
  status: string;
  clusterId: string;
  ownerId?: string | undefined;
  minioRootPassword?: string | undefined;
  nextcloudAdminPassword?: string | undefined;
}

const KINDS: readonly FileServerKind[] = ['minio', 'nextcloud'];

export function fileServersOf(deployments: readonly ServerCandidate[], ownerId: string): FileServer[] {
  return deployments
    .filter((entry) => entry.ownerId === ownerId && entry.status === 'running' && KINDS.includes(entry.appType as FileServerKind))
    .filter((entry) => (entry.appType === 'minio' ? Boolean(entry.minioRootPassword) : Boolean(entry.nextcloudAdminPassword)))
    .map((entry) => ({ kind: entry.appType as FileServerKind, deploymentId: entry.id, name: entry.name, clusterId: entry.clusterId }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function folderFor(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'files';
}

export type CleanPath = { ok: true; path: string } | { ok: false; why: string };

export function cleanPath(input: string, options: { allowRoot?: boolean } = {}): CleanPath {
  const parts = input.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) return { ok: false, why: `${input} would leave the project's files` };
  if (parts.some((part) => /[\u0000-\u001f\\]/.test(part))) return { ok: false, why: `${input} has a character a file name cannot have` };
  if (parts.length === 0 && !options.allowRoot) return { ok: false, why: 'a file needs a name' };
  return { ok: true, path: parts.join('/') };
}

export const within = (folder: string, path: string): string => [folder, path].filter(Boolean).join('/');

export function storyFolder(leafId: string): string {
  return `stories/${leafId}`;
}

export function chatFolder(conversationId: string): string {
  return `chats/${conversationId}`;
}

export function placeProblem(place: FilePlace | undefined, servers: readonly FileServer[]): string | undefined {
  if (!place) return undefined;
  if (!servers.some((server) => server.deploymentId === place.deploymentId)) return 'its file server is not running any more';
  return undefined;
}
