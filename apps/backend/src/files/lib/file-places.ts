import type { StoredScope } from './stored-files.js';

export const FOLDER_MARK = '.keep';
export const SEARCH_LIMIT = 200;

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number | undefined;
  modified?: string | undefined;
}

export type FileScope<P extends { id: string } = { id: string }> =
  | { kind: 'project'; project: P }
  | { kind: 'person' }
  | { kind: 'conversation'; conversationId: string; projectId?: string | undefined };

export interface StoredPlace {
  scope: StoredScope;
  under: string;
}

export const chatFolder = (conversationId: string): string => `chats/${conversationId}`;

export function storedPlaceOf(ownerId: string, scope: FileScope): StoredPlace {
  if (scope.kind === 'project') return { scope: { kind: 'project', id: scope.project.id }, under: '' };
  if (scope.kind === 'person') return { scope: { kind: 'person', id: ownerId }, under: '' };
  if (scope.projectId) return { scope: { kind: 'project', id: scope.projectId }, under: chatFolder(scope.conversationId) };
  return { scope: { kind: 'conversation', id: scope.conversationId }, under: '' };
}

export const inside = (under: string, path: string): string => [under, path].filter(Boolean).join('/');

export function outside(under: string, path: string): string | undefined {
  if (!under) return path;
  if (path === under) return '';
  return path.startsWith(`${under}/`) ? path.slice(under.length + 1) : undefined;
}

export type CleanPath = { ok: true; path: string } | { ok: false; why: string };

export function cleanPath(input: string, options: { allowRoot?: boolean } = {}): CleanPath {
  const parts = input.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) return { ok: false, why: `${input} would leave the project's files` };
  if (parts.some((part) => /[\u0000-\u001f\\]/.test(part))) return { ok: false, why: `${input} has a character a file name cannot have` };
  if (parts.length === 0 && !options.allowRoot) return { ok: false, why: 'a file needs a name' };
  return { ok: true, path: parts.join('/') };
}

export function storyFolder(leafId: string): string {
  return `stories/${leafId}`;
}
