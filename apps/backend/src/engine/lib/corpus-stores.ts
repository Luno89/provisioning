import type { CorpusEndpoints } from './web-tools-resolver.js';

export type CorpusStore = 'index' | 'vectors' | 'embeddings';

const LABELS: { readonly [S in CorpusStore]: string } = {
  index: 'Quickwit',
  vectors: 'Qdrant',
  embeddings: 'TEI',
};

export const SEARCHABLE = ['index', 'vectors', 'embeddings'] as const satisfies readonly CorpusStore[];

export const HELD = ['index', 'vectors'] as const satisfies readonly CorpusStore[];

export class CorpusStoresMissing extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'CorpusStoresMissing';
  }
}

export class CorpusStoreDown extends Error {
  readonly status = 503;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'CorpusStoreDown';
  }
}

const listed = (names: readonly string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export function storesMissing(ends: CorpusEndpoints, needed: readonly CorpusStore[], doing: string): string | undefined {
  const missing = needed.filter((store) => !ends[store]);
  if (!missing.length) return undefined;
  return `${doing} needs your own ${listed(needed.map((store) => LABELS[store]))} running, and you have no running ${listed(missing.map((store) => LABELS[store]))}: deploy it as an app first`;
}

export function withStores<S extends CorpusStore>(ends: CorpusEndpoints, needed: readonly S[], doing: string): CorpusEndpoints & Required<Pick<CorpusEndpoints, S>> {
  const missing = storesMissing(ends, needed, doing);
  if (missing) throw new CorpusStoresMissing(missing);
  return ends as CorpusEndpoints & Required<Pick<CorpusEndpoints, S>>;
}

export const refusal = (who: string, res: Response, said: string): Error => {
  const retryAfter = res.headers.get('retry-after');
  const shown = said.slice(0, 300);
  return Object.assign(new Error(`${who} refused: HTTP ${res.status}${shown ? ` ${shown}` : ''}`), { response: { status: res.status, headers: retryAfter ? { 'retry-after': retryAfter } : {} } });
};

export async function bothOf<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  const [first, second] = await Promise.allSettled([a, b]);
  if (first.status === 'rejected') throw first.reason;
  if (second.status === 'rejected') throw second.reason;
  return [first.value, second.value];
}

export async function answered(res: Response, who: string): Promise<unknown> {
  if (!res.ok) throw refusal(who, res, await res.text());
  const text = await res.text();
  return text ? JSON.parse(text) as unknown : {};
}
