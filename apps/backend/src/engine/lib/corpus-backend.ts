
export const CHUNK_CHARS = 800;
export const CHUNK_OVERLAP = 150;

export const VECTOR_SIZE = 384;

export const SEARCH_LIMIT = 12;

export interface CorpusDoc {
  url: string;
  host: string;
  owner_id: string;
  ingest_id: string;
  project_id: string;
  body: string;
  fetched_at: string;
}

export interface Chunk {
  id: string;
  url: string;
  text: string;
  ordinal: number;
}

export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const stride = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let at = 0; at < clean.length; at += stride) {
    const piece = clean.slice(at, at + size);
    if (piece.length < overlap && out.length) break;
    out.push(piece);
  }
  return out;
}

export function worthEmbedding(text: string): boolean {
  const links = (text.match(/\]\(/g) ?? []).length;
  const prose = text.replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (prose.length < 120) return false;
  return links === 0 || prose.length / links > 40;
}

export function chunksFor(url: string, text: string): Chunk[] {
  return chunkText(text)
    .map((piece, i) => ({
      id: `${url}#${i}`,
      url,
      text: piece,
      ordinal: i,
    }))
    .filter((c) => worthEmbedding(c.text));
}

export function pointId(chunkId: string): string {
  let h1 = 0x9e3779b9, h2 = 0x85ebca6b;
  for (let i = 0; i < chunkId.length; i++) {
    h1 = Math.imul(h1 ^ chunkId.charCodeAt(i), 0x85ebca6b) >>> 0;
    h2 = Math.imul(h2 ^ chunkId.charCodeAt(i), 0xc2b2ae35) >>> 0;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  const raw = `${hex(h1)}${hex(h2)}${hex(h1 ^ 0x5bf03635)}${hex(h2 ^ 0x27d4eb2f)}`;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

export function buildIndexQuery(
  phrase: string,
  scope: { ownerId: string; ingestId?: string | undefined; projectId?: string | undefined },
): string {
  const safe = phrase.replace(/["\\]/g, ' ').trim();
  const parts = [`owner_id:"${scope.ownerId}"`];
  if (scope.ingestId) parts.push(`ingest_id:"${scope.ingestId}"`);
  if (scope.projectId) parts.push(`project_id:"${scope.projectId}"`);
  if (safe) parts.push(`body:"${safe}"`);
  return parts.join(' AND ');
}

export function indexConfig(indexId: string): unknown {
  return {
    version: '0.8',
    index_id: indexId,
    doc_mapping: {
      field_mappings: [
        { name: 'url', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'host', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'owner_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'ingest_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'project_id', type: 'text', tokenizer: 'raw', stored: true },
        { name: 'body', type: 'text', tokenizer: 'default', record: 'position', stored: true },
        { name: 'fetched_at', type: 'datetime', fast: true, input_formats: ['rfc3339'], fast_precision: 'seconds' },
      ],
      timestamp_field: 'fetched_at',
    },
    search_settings: { default_search_fields: ['body'] },
    indexing_settings: { commit_timeout_secs: 10 },
  };
}

export function collectionConfig(): unknown {
  return {
    vectors: { size: VECTOR_SIZE, distance: 'Cosine', on_disk: true },
    quantization_config: { scalar: { type: 'int8', always_ram: true } },
  };
}

export interface CorpusHit {
  url: string;
  snippet: string;
  via: 'index' | 'vectors';
}

export function mergeHits(index: CorpusHit[], vectors: CorpusHit[], limit = SEARCH_LIMIT): CorpusHit[] {
  const seen = new Set<string>();
  const out: CorpusHit[] = [];
  for (const hit of [...index, ...vectors]) {
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}
