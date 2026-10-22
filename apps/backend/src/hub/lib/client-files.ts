const clean = (path: string): string => path.replace(/^\/+|\/+$/g, '');

const within = (path: string, folder: string): boolean => {
  const inner = clean(path);
  const outer = clean(folder);
  return outer === '' || inner === outer || inner.startsWith(`${outer}/`);
};

export const seenByClients = (path: string, shared: readonly string[]): boolean => shared.some((entry) => within(path, entry));

export const leadsToShared = (folder: string, shared: readonly string[]): boolean => shared.some((entry) => within(entry, folder));

export type ClientMark = 'itself' | 'folder';

const markOf = (path: string, shared: readonly string[]): ClientMark | undefined =>
  shared.some((entry) => clean(entry) === clean(path)) ? 'itself' : seenByClients(path, shared) ? 'folder' : undefined;

export const marked = <T extends { path: string }>(entries: readonly T[], shared: readonly string[]): (T & { forClients?: ClientMark })[] =>
  entries.map((entry) => {
    const mark = markOf(entry.path, shared);
    return mark ? { ...entry, forClients: mark } : entry;
  });

export function forClients<T extends { path: string; type?: string | undefined }>(entries: readonly T[], shared: readonly string[]): (T & { forClients?: ClientMark })[] {
  return marked(entries, shared).filter((entry) => entry.forClients !== undefined || (entry.type === 'dir' && leadsToShared(entry.path, shared)));
}

export function sharing(shared: readonly string[], path: string, on: boolean): string[] {
  const target = clean(path);
  if (on) return seenByClients(target, shared) ? [...shared] : [...shared.filter((entry) => !within(entry, target)), target].sort();
  return shared.filter((entry) => !within(entry, target));
}

export const afterMove = (shared: readonly string[], from: string, to: string): string[] =>
  shared.map((entry) => (within(entry, from) ? `${clean(to)}${clean(entry).slice(clean(from).length)}` : entry)).sort();

export const afterRemove = (shared: readonly string[], path: string): string[] => shared.filter((entry) => !within(entry, path));
