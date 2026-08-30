export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

export const TAG_SORTS = ['newest', 'oldest', 'version', 'name'] as const;
export type TagSort = typeof TAG_SORTS[number];

export interface TagPage {
  tags: string[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: TagSort;
}

export interface TagPageRequest {
  page?: number | undefined;
  pageSize?: number | undefined;
  sort?: TagSort | undefined;
}

const CHANNEL_TAGS = new Set([
  'latest', 'stable', 'main', 'master', 'release', 'edge', 'nightly',
  'develop', 'production', 'preview', 'beta', 'dev',
]);

export function isNoiseTag(tag: string): boolean {
  return tag.includes('sha256')
    || tag.startsWith('buildcache-')
    || tag.startsWith('git-')
    || tag.includes('metadata')
    || tag.includes('.sig');
}

export function isChannelTag(tag: string): boolean {
  return CHANNEL_TAGS.has(tag);
}

export function isTagSort(value: unknown): value is TagSort {
  return typeof value === 'string' && (TAG_SORTS as readonly string[]).includes(value);
}

export function parseTagSort(value: unknown): TagSort {
  return isTagSort(value) ? value : 'newest';
}

export function clampPageSize(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

export function clampPage(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function normalizeTags(
  tags: readonly string[],
  order: 'newest-first' | 'oldest-first',
): string[] {
  const clean = tags.filter((tag) => typeof tag === 'string' && tag.length > 0 && !isNoiseTag(tag));
  const newestFirst = order === 'oldest-first' ? [...clean].reverse() : clean;
  return [...new Set(newestFirst)];
}

function versionKey(tag: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(tag);
  if (!match?.[1]) return null;
  return match[1].split('.').map(Number);
}

function compareVersionKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] ?? -1) - (a[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function sortTags(newestFirst: readonly string[], sort: TagSort): string[] {
  if (sort === 'oldest') return [...newestFirst].reverse();
  if (sort === 'name') return [...newestFirst].sort((a, b) => a.localeCompare(b));

  const channels = newestFirst.filter(isChannelTag);
  const rest = newestFirst.filter((tag) => !isChannelTag(tag));

  if (sort === 'version') {
    const keyed = rest.map((tag, index) => ({ tag, index, key: versionKey(tag) }));
    keyed.sort((a, b) => {
      if (a.key && b.key) return compareVersionKeys(a.key, b.key) || a.index - b.index;
      if (a.key) return -1;
      if (b.key) return 1;
      return a.index - b.index;
    });
    return [...channels, ...keyed.map((k) => k.tag)];
  }

  return [...channels, ...rest];
}

export function pageOf(newestFirst: readonly string[], request: TagPageRequest = {}): TagPage {
  const sort = parseTagSort(request.sort);
  const pageSize = clampPageSize(request.pageSize);
  const sorted = sortTags(newestFirst, sort);
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(clampPage(request.page), totalPages);
  const start = (page - 1) * pageSize;
  return { tags: sorted.slice(start, start + pageSize), page, pageSize, total, totalPages, sort };
}

export function nextPageUrl(linkHeader: string | undefined, registryOrigin: string): string | undefined {
  if (!linkHeader) return undefined;
  const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(linkHeader);
  const target = match?.[1];
  if (!target) return undefined;
  return target.startsWith('http') ? target : `${registryOrigin}${target.startsWith('/') ? '' : '/'}${target}`;
}

export function isValidImageTag(tag: unknown): tag is string {
  return typeof tag === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag);
}
