import { createHash } from 'node:crypto';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import { search, type CorpusPage, type IngestReceipt } from '../../lib/corpus.js';

export interface CorpusAccess {
  crawlerReady(ownerId: string): Promise<boolean>;
  start(workflowId: string, args: { ownerId: string; projectId?: string | undefined; url: string; maxDepth?: number | undefined; maxPages?: number | undefined; domains?: string[] | undefined; keywords?: string[] | undefined }): Promise<void>;
  status(workflowId: string): Promise<{ state: 'running' | 'completed' | 'failed' | 'unknown'; receipt?: IngestReceipt | undefined; error?: string | undefined }>;
  pages(filter: { ownerId: string; ingestId?: string | undefined }): Promise<CorpusPage[]>;
}

export const ingestPrefix = (ownerId: string): string =>
  `ingest-${createHash('sha256').update(ownerId).digest('hex').slice(0, 12)}-`;

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const strings = (value: unknown): string[] | undefined => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : undefined;
  const clean = list?.map((entry) => String(entry).trim()).filter(Boolean);
  return clean?.length ? clean : undefined;
};

const whole = (value: unknown, least: number, most: number): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= least && n <= most ? n : Number.NaN;
};

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });

export function createCorpusTools(options: { access: CorpusAccess; now?: (() => number) | undefined }): Record<string, ToolHandler> {
  const { access } = options;
  const now = options.now ?? Date.now;

  return {
    async start_ingest({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to crawl for');
      const url = asString(parsed, 'url');
      if (!url || !/^https?:\/\/[^\s/]+/i.test(url)) return refuse('url has to be the http(s) address to start crawling from');
      const maxDepth = whole(parsed.maxDepth, 0, 5);
      const maxPages = whole(parsed.maxPages, 1, 10_000);
      if (Number.isNaN(maxDepth)) return refuse('maxDepth is a whole number from 0 to 5');
      if (Number.isNaN(maxPages)) return refuse('maxPages is a whole number from 1 to 10000');

      if (!(await access.crawlerReady(caller.ownerId))) {
        return refuse('crawling needs a Crawl4AI of this person\'s running, and there is none — propose_deploy_app with appType crawl4ai first, then start the crawl once it runs');
      }
      const id = `${ingestPrefix(caller.ownerId)}${now().toString(36)}`;
      await access.start(id, {
        ownerId: caller.ownerId,
        url,
        ...(caller.projectId ? { projectId: caller.projectId } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxPages !== undefined ? { maxPages } : {}),
        ...(strings(parsed.domains) ? { domains: strings(parsed.domains) } : {}),
        ...(strings(parsed.keywords) ? { keywords: strings(parsed.keywords) } : {}),
      });
      return {
        ok: true,
        digest: `crawl ${id} started`,
        content: `Started crawling ${url} as ${id}. It runs in the background and its pages never come back here — check ingest_status with that id, then search_corpus.`,
      };
    },

    async ingest_status({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose crawls to check');
      const id = asString(parsed, 'id');
      if (!id) return refuse('give the id start_ingest returned');
      if (!id.startsWith(ingestPrefix(caller.ownerId))) return refuse(`there is no crawl of yours called ${id}`);
      const status = await access.status(id);
      if (status.state === 'running') return { ok: true, digest: `${id}: running`, content: `${id} is still crawling.` };
      if (status.state === 'completed' && status.receipt) {
        const r = status.receipt;
        return {
          ok: true,
          digest: `${id}: ${r.pages} pages`,
          content: `${id} finished: ${r.pages} pages (${Math.round(r.bytes / 1024)} KB) from ${r.hosts.join(', ') || 'no hosts'}, ${r.failed} failed. Search it with search_corpus, ingestId ${r.ingestId}.`,
        };
      }
      return refuse(`${id} ${status.state === 'unknown' ? 'is not known' : status.state}${status.error ? `: ${status.error}` : ''}`);
    },

    async search_corpus({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose corpus to search');
      const query = asString(parsed, 'query');
      if (!query) return refuse('give the phrase to look for');
      const ingestId = asString(parsed, 'ingestId');
      const hits = search(await access.pages({ ownerId: caller.ownerId, ...(ingestId ? { ingestId } : {}) }), query);
      if (hits.length === 0) return { ok: true, digest: `nothing for "${query}"`, content: `Nothing in the corpus matches "${query}".` };
      const text = hits.map((hit, index) => `${index + 1}. ${hit.url}\n   ${hit.snippet}`).join('\n');
      return { ok: true, digest: `${hits.length} hits for "${query}"`, content: text };
    },
  };
}
