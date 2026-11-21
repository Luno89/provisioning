import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VECTOR_SIZE } from '../lib/corpus-backend.js';
import type { MemoryIndex, MemoryIndexReach } from '../../platform/index.js';
import { unreportedReach } from '../../platform/testing/memory-index.js';

type Doc = Record<string, unknown>;

export interface CorpusStandIn {
  base: string;
  endpoints: MemoryIndex;
  reach: MemoryIndexReach;
  documents(index: string): Doc[];
  points(collection: string): Doc[];
  crawled: string[][];
  refuse(path: RegExp, status: number, said: string): void;
  page(url: string, markdown: string): void;
  stop(): Promise<void>;
}

const bodyOf = async (req: IncomingMessage): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts).toString('utf8');
};

const termsIn = (query: string): [string, string][] =>
  [...query.matchAll(/(\w+):"([^"]*)"/g)].map((match) => [match[1]!, match[2]!]);

const matchesFilter = (payload: Doc, filter: unknown): boolean => {
  const must = (filter as { must?: { key: string; match: { value: unknown } }[] } | undefined)?.must ?? [];
  return must.every((clause) => payload[clause.key] === clause.match.value);
};

export async function startCorpusStandIn(token = 'crawl-token'): Promise<CorpusStandIn> {
  const indexes = new Map<string, Doc[]>();
  const collections = new Map<string, Map<string, Doc>>();
  const refusals: { path: RegExp; status: number; said: string }[] = [];
  const pages = new Map<string, string>();
  const crawled: string[][] = [];

  const collection = (name: string): Map<string, Doc> => {
    const found = collections.get(name) ?? new Map<string, Doc>();
    collections.set(name, found);
    return found;
  };

  const answer = async (req: IncomingMessage): Promise<{ status: number; body: unknown }> => {
    const url = new URL(req.url ?? '/', 'http://stand-in');
    const path = url.pathname;
    const refusal = refusals.find((entry) => entry.path.test(`${req.method} ${path}`));
    if (refusal) return { status: refusal.status, body: refusal.said };
    const text = await bodyOf(req);
    const json = (): Record<string, unknown> => (text ? JSON.parse(text) as Record<string, unknown> : {});

    if (req.method === 'POST' && path === '/embed') {
      const inputs = json().inputs as string[];
      return { status: 200, body: inputs.map(() => Array.from({ length: VECTOR_SIZE }, () => 0.1)) };
    }
    if (req.method === 'POST' && path === '/crawl') {
      if (req.headers.authorization !== `Bearer ${token}`) return { status: 401, body: 'no token' };
      const urls = json().urls as string[];
      crawled.push(urls);
      return { status: 200, body: { results: urls.map((at) => ({ url: at, success: true, markdown: pages.get(at) ?? '', links: { internal: [], external: [] } })) } };
    }
    if (req.method === 'POST' && path === '/api/v1/indexes') return { status: 200, body: {} };
    const quickwit = /^\/api\/v1\/([^/]+)\/(ingest|delete-tasks|search)$/.exec(path);
    if (quickwit) {
      const [, index, action] = quickwit;
      const docs = indexes.get(index!) ?? [];
      indexes.set(index!, docs);
      if (action === 'ingest') {
        docs.push(...text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Doc));
        return { status: 200, body: { num_docs_for_processing: docs.length } };
      }
      if (action === 'delete-tasks') {
        const terms = termsIn(String(json().query ?? ''));
        indexes.set(index!, docs.filter((doc) => !terms.some(([field, value]) => doc[field] === value)));
        return { status: 200, body: { opstamp: 1 } };
      }
      const terms = termsIn(url.searchParams.get('query') ?? '').filter(([field]) => field !== 'body');
      return { status: 200, body: { hits: docs.filter((doc) => terms.every(([field, value]) => doc[field] === value)) } };
    }
    const qdrant = /^\/collections\/([^/]+)(\/points(?:\/(delete|search|recommend))?)?$/.exec(path);
    if (qdrant) {
      const [, name, points, action] = qdrant;
      const held = collection(name!);
      if (!points) return { status: 200, body: { result: true } };
      const body = json();
      if (!action) {
        for (const point of body.points as { id: string; payload: Doc }[]) held.set(point.id, point.payload);
        return { status: 200, body: { result: { status: 'completed' } } };
      }
      if (action === 'delete') {
        if (Array.isArray(body.points)) for (const id of body.points as string[]) held.delete(id);
        else for (const [id, payload] of held) if (matchesFilter(payload, body.filter)) held.delete(id);
        return { status: 200, body: { result: { status: 'completed' } } };
      }
      return { status: 200, body: { result: [...held.values()].filter((payload) => matchesFilter(payload, body.filter)).map((payload) => ({ payload, score: 1 })) } };
    }
    return { status: 404, body: `the stand-in serves no ${req.method} ${path}` };
  };

  const server: Server = createServer((req, res) => {
    void answer(req).then(({ status, body }) => {
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    }, (err: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints: MemoryIndex = { index: { base }, vectors: { base, apiKey: 'standInKey' }, embeddings: { base } };

  return {
    base,
    endpoints,
    reach: unreportedReach(endpoints),
    documents: (index) => [...(indexes.get(index) ?? [])],
    points: (name) => [...collection(name).values()],
    crawled,
    refuse: (path, status, said) => { refusals.push({ path, status, said }); },
    page: (at, markdown) => { pages.set(at, markdown); },
    stop: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

export async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return `http://127.0.0.1:${port}`;
}
