export type FileServerKind = 'minio';

export const FILES_BUCKET = 'koala-files';
export const FOLDER_MARK = '.keep';
export const SEARCH_LIMIT = 200;

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
}

export function fileServersOf(deployments: readonly ServerCandidate[], ownerId: string): FileServer[] {
  return deployments
    .filter((entry) => entry.ownerId === ownerId && entry.status === 'running' && entry.appType === 'minio' && Boolean(entry.minioRootPassword))
    .map((entry) => ({ kind: 'minio' as const, deploymentId: entry.id, name: entry.name, clusterId: entry.clusterId }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const PERSONAL_FOLDER = 'personal';

export function folderFor(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (slug === PERSONAL_FOLDER) return `${PERSONAL_FOLDER}-project`;
  return slug || 'files';
}

export function sharedFolder(
  place: Pick<FilePlace, 'deploymentId' | 'folder'>,
  others: readonly { name: string; files?: Pick<FilePlace, 'deploymentId' | 'folder'> | undefined }[],
  personalServer: string | undefined,
): string | undefined {
  if (place.folder === PERSONAL_FOLDER && place.deploymentId === personalServer) return 'the person\'s own files';
  const other = others.find((project) => project.files?.deploymentId === place.deploymentId && project.files.folder === place.folder);
  return other ? `the project ${other.name}` : undefined;
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

export const isFolderMark = (path: string): boolean => path === FOLDER_MARK || path.endsWith(`/${FOLDER_MARK}`);

export function matchesSearch(path: string, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted || isFolderMark(path)) return false;
  return (path.split('/').pop() ?? path).toLowerCase().includes(wanted);
}

export function storyFolder(leafId: string): string {
  return `stories/${leafId}`;
}

export function placeProblem(place: FilePlace | undefined, servers: readonly FileServer[]): string | undefined {
  if (!place) return undefined;
  if (!servers.some((server) => server.deploymentId === place.deploymentId)) return 'its file server is not running any more';
  return undefined;
}
