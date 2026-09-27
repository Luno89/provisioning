import type { ToolDefinition } from '@koala/agent-engine';

export const CORPUS_TOOLS: ToolDefinition[] = [
  {
    name: 'start_ingest',
    summary: 'Crawl a website into the person\'s searchable corpus in the background — documentation, a knowledge base, anything too large to read page by page',
    guidance: 'Use this when a question needs more of a site than a couple of pages. The pages never come back to you; search them with search_corpus once ingest_status says the crawl finished.',
    binding: 'platform',
    effect: 'write',
    idempotent: false,
    openWorld: true,
    status: 'draft',
    returns: 'the id of the crawl, to check with ingest_status',
    failures: [{ when: 'the url is not an http(s) address', says: 'so' }, { when: 'a limit is out of range', says: 'the allowed range' }],
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Where to start crawling.' },
        maxDepth: { type: 'number', description: 'How many links deep to follow, 0 to 5. Defaults to 1.' },
        maxPages: { type: 'number', description: 'Hard ceiling on pages. Defaults to 50.' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Hosts the crawl may follow links to. Defaults to the start page\'s host.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'What makes a page worth reaching first.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'ingest_status',
    summary: 'Check whether a crawl started with start_ingest has finished, and what it fetched',
    guidance: 'Use this with the id start_ingest gave you before searching what it crawled.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    status: 'draft',
    returns: 'running, or the page count, size, hosts and failures and the ingestId to search',
    failures: [{ when: 'the id is not one of the person\'s crawls', says: 'so' }],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The id start_ingest returned.' } },
      required: ['id'],
    },
  },
  {
    name: 'search_corpus',
    summary: 'Find a phrase in everything the person has crawled, returning short snippets with their source URLs',
    guidance: 'Use this to answer from crawled material. Matching is plain text. Quote only what a snippet says word for word; anything else is your summary.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    status: 'draft',
    returns: 'numbered hits, each a URL and a snippet, or that nothing matched',
    failures: [{ when: 'no query is given', says: 'to give one' }],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The phrase to look for.' },
        ingestId: { type: 'string', description: 'Search only one crawl, by the ingestId ingest_status reported.' },
      },
      required: ['query'],
    },
  },
];
