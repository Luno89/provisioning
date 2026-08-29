
export const APP_TYPES = [
  'odoo', 'wordpress', 'nextcloud', 'audiobookshelf', 'prometheus', 'traefik', 'vllm', 'tabbyapi',
  'openwebui', 'hermes', 'gitapp', 'palworld', 'jellyfin', 'plex', 'navidrome', 'kavita', 'immich',
  'papra', 'homeassistant', 'searxng', 'crawl4ai', 'qdrant', 'minio', 'quickwit', 'tei', 'verdaccio',
] as const;

export type AppType = typeof APP_TYPES[number];

export interface AppFacts {
  is: string;
  provides: string[];
}

export const APP_FACTS: Record<AppType, AppFacts> = {
  odoo: { is: 'an ERP and business suite', provides: ['crm', 'accounting', 'inventory'] },
  wordpress: { is: 'a website and blog platform', provides: ['website', 'cms'] },
  nextcloud: { is: 'a file sync and share server', provides: ['file-storage', 'sharing'] },
  audiobookshelf: { is: 'an audiobook and podcast server', provides: ['media'] },
  prometheus: { is: 'a metrics database and alerting system', provides: ['metrics', 'monitoring'] },
  traefik: { is: 'an ingress controller and reverse proxy', provides: ['ingress', 'routing'] },
  vllm: { is: 'a GPU inference server for large language models', provides: ['llm-inference'] },
  tabbyapi: { is: 'a GPU inference server with an OpenAI-compatible API', provides: ['llm-inference'] },
  openwebui: { is: 'a chat interface for language models', provides: ['chat-ui'] },
  hermes: { is: 'an agent runtime', provides: ['agent'] },
  gitapp: { is: 'a service built from one of your own repositories', provides: ['custom-service'] },
  palworld: { is: 'a game server', provides: ['game-server'] },
  jellyfin: { is: 'a media server for video and music', provides: ['media'] },
  plex: { is: 'a media server for video and music', provides: ['media'] },
  navidrome: { is: 'a music streaming server', provides: ['media'] },
  kavita: { is: 'a comic and ebook reader', provides: ['media'] },
  immich: { is: 'a photo and video library', provides: ['media', 'photos'] },
  papra: { is: 'a document archive', provides: ['documents'] },
  homeassistant: { is: 'a home automation hub', provides: ['home-automation'] },
  searxng: { is: 'a metasearch engine', provides: ['web-search'] },
  crawl4ai: { is: 'a web crawler that returns clean page text', provides: ['web-crawl', 'scraping'] },
  qdrant: { is: 'a vector database', provides: ['vector-search', 'similarity-search', 'embeddings-storage'] },
  minio: { is: 'S3-compatible object storage', provides: ['object-storage', 'blob-storage', 'file-storage'] },
  quickwit: { is: 'a full-text search engine', provides: ['full-text-search', 'log-search'] },
  tei: { is: 'a text-embedding server', provides: ['embeddings'] },
  verdaccio: { is: 'a private npm registry', provides: ['package-registry'] },
};

export function providing(capability: string): AppType[] {
  const want = capability.trim().toLowerCase();
  return (APP_TYPES as readonly AppType[])
    .filter((t) => APP_FACTS[t].provides.some((p) => p === want));
}

export function isAppType(value: unknown): value is AppType {
  return typeof value === 'string' && (APP_TYPES as readonly string[]).includes(value);
}

const BY_LENGTH = [...APP_TYPES].sort((a, b) => b.length - a.length);

export function appTypeFromName(name: string): AppType | undefined {
  const segments = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return BY_LENGTH.find((a) => segments.has(a));
}

export const SEARCH_APP_TYPES = ['minio', 'quickwit', 'qdrant', 'tei'] as const satisfies readonly AppType[];

export type SearchAppType = typeof SEARCH_APP_TYPES[number];
