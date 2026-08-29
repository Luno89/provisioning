
export type FrontierState = 'pending' | 'done';

export interface FrontierUrl {
  id: string;
  ingestId: string;
  url: string;
  depth: number;
  rank: number;
  state: FrontierState;
}

export interface FrontierClaim {
  url: string;
  depth: number;
}

export function frontierRow(
  ingestId: string,
  url: string,
  depth: number,
  keywords: string[],
): FrontierUrl {
  return { id: `${ingestId}:${url}`, ingestId, url, depth, rank: keywordScore(url, keywords), state: 'pending' };
}

export function keywordScore(url: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const u = url.toLowerCase();
  return keywords.reduce((n, k) => n + (u.includes(k.toLowerCase()) ? 1 : 0), 0);
}

export function frontierOrder(a: FrontierUrl, b: FrontierUrl): number {
  return a.depth - b.depth || b.rank - a.rank || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}

export function followsLinks(depth: number, maxDepth: number): boolean {
  return depth < maxDepth;
}
