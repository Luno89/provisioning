
export const MEMORY_INDEX = 'koala-memory';
export const MEMORY_COLLECTION = 'koala-memory';

export const MEMORY_SEARCH_LIMIT = 20;

export const RRF_K = 60;

export interface FusedHit {
  id: string;
  score: number;
  via: string[];
}

export function fuseRRF(lists: Record<string, readonly string[]>, k = RRF_K): FusedHit[] {
  const scores = new Map<string, FusedHit>();
  const order: string[] = [];

  for (const [via, ids] of Object.entries(lists)) {
    ids.forEach((id, rank) => {
      let hit = scores.get(id);
      if (!hit) {
        hit = { id, score: 0, via: [] };
        scores.set(id, hit);
        order.push(id);
      }
      hit.score += 1 / (k + rank);
      if (!hit.via.includes(via)) hit.via.push(via);
    });
  }

  return order
    .map((id) => scores.get(id)!)
    .sort((a, b) => b.score - a.score);
}

export function buildMemoryQuery(phrase: string, scope: { ownerId: string }): string {
  const terms = memoryTerms(phrase);
  const owner = `owner_id:"${scope.ownerId.replace(/["\\]/g, '')}"`;
  if (!terms.length) return owner;
  return `${owner} AND (${terms.map((t) => `body:${t}`).join(' OR ')})`;
}

export const MAX_QUERY_TERMS = 24;

export function memoryTerms(phrase: string): string[] {
  const seen = new Set<string>();
  for (const word of phrase.toLowerCase().split(/[^a-z0-9]+/i)) {
    if (word.length < 3) continue;
    seen.add(word);
    if (seen.size >= MAX_QUERY_TERMS) break;
  }
  return [...seen];
}

export function memoryIndexConfig(indexId = MEMORY_INDEX): unknown {
  return {
    version: '0.8',
    index_id: indexId,
    doc_mapping: {
      field_mappings: [
        { name: 'memory_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'owner_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'project_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'category', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'scope', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'body', type: 'text', tokenizer: 'default', record: 'position', stored: true },
        { name: 'created_at', type: 'datetime', fast: true, input_formats: ['rfc3339'], fast_precision: 'seconds' },
      ],
      timestamp_field: 'created_at',
    },
    search_settings: { default_search_fields: ['body'] },
    indexing_settings: { commit_timeout_secs: 10 },
  };
}

export interface MemoryDoc {
  memory_id: string;
  owner_id: string;
  project_id: string;
  category: string;
  scope: string;
  body: string;
  created_at: string;
}
