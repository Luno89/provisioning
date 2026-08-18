/**
 * The one list of what this platform can deploy.
 *
 * ── WHY IT IS A LIST AND NOT FIVE ──
 * It was five: a union type in types.ts, two identical `knownApps` arrays eleven lines apart in
 * AppService, and two more unions inline in App.tsx. Adding an app meant finding all five, and the
 * copies had already drifted — `gitapp` is in the union and in neither `knownApps`, so a namespace
 * running one could never be recognised by discovery.
 *
 * Derived from here, that class of drift is a type error instead of a silence.
 */

/**
 * Every deployable app type.
 *
 * Order is the order the UI offers them, so the common ones come first rather than in the order
 * they happened to be written.
 */
export const APP_TYPES = [
  'odoo', 'wordpress', 'nextcloud', 'audiobookshelf', 'prometheus', 'traefik', 'vllm', 'tabbyapi',
  'openwebui', 'hermes', 'gitapp', 'palworld', 'jellyfin', 'plex', 'navidrome', 'kavita', 'immich',
  'papra', 'homeassistant', 'searxng', 'crawl4ai', 'qdrant', 'minio', 'quickwit', 'tei', 'verdaccio',
] as const;

export type AppType = typeof APP_TYPES[number];

/**
 * What each app IS, for anything that has to reason about infrastructure rather than list it.
 *
 * ── WHY THIS EXISTS ──
 * `APP_TYPES` is twenty-six bare ids. Asked to add MongoDB caching to an MCP server, Koala planned
 * it — there is no MongoDB here, and nothing in the catalogue would have told it so. Worse, it could
 * not have found the alternative either: nothing says `qdrant` is a vector database or `minio` is
 * object storage, and `tei` and `quickwit` are unguessable from their names.
 *
 * A model reading a list of ids can only pattern-match on what those words mean elsewhere. This is
 * the difference between listing infrastructure and knowing what any of it is FOR.
 *
 * `provides` is the part that answers a question like "where do I put this": it is what the thing
 * offers, not what it is called. Several apps can provide the same capability, and a request for one
 * nothing provides is a request this platform cannot satisfy — which is the answer that was missing.
 */
export interface AppFacts {
  /** One line, in plain words. */
  is: string;
  /** Capabilities, for matching a need to a service. */
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
  /**
   * The three that matter most for wiring up a data architecture, and the three least guessable
   * from their names.
   */
  qdrant: { is: 'a vector database', provides: ['vector-search', 'similarity-search', 'embeddings-storage'] },
  minio: { is: 'S3-compatible object storage', provides: ['object-storage', 'blob-storage', 'file-storage'] },
  quickwit: { is: 'a full-text search engine', provides: ['full-text-search', 'log-search'] },
  tei: { is: 'a text-embedding server', provides: ['embeddings'] },
  verdaccio: { is: 'a private npm registry', provides: ['package-registry'] },
};

/**
 * The app types offering a capability, for "where do I put this" rather than "what is deployed".
 *
 * An empty result is a real answer and the useful one: nothing here provides it, so the request
 * cannot be satisfied — say so instead of designing around it.
 */
export function providing(capability: string): AppType[] {
  const want = capability.trim().toLowerCase();
  return (APP_TYPES as readonly AppType[])
    .filter((t) => APP_FACTS[t].provides.some((p) => p === want));
}

export function isAppType(value: unknown): value is AppType {
  return typeof value === 'string' && (APP_TYPES as readonly string[]).includes(value);
}

/**
 * The app type a Helm release or pod name belongs to.
 *
 * ── WHY SEGMENTS AND NOT `includes` ──
 * The code this replaces did a raw substring test, which worked only because every app type was
 * long enough to be unambiguous by luck. `tei` is three characters, and `protein-service` contains
 * them — so discovery would have labelled an unrelated namespace as an embedding server. A test
 * caught it, but the rule was already fragile: `plex` is inside `duplex`, `immich` inside
 * `immichelin`.
 *
 * Release and pod names are hyphen-separated (`crawl4ai-59c75f5947-8dstq`, `odoo-1`,
 * `my-odoo-prod`), so a type has to be a whole segment. Longest first, so a name that somehow
 * contains two answers with the more specific one.
 */
const BY_LENGTH = [...APP_TYPES].sort((a, b) => b.length - a.length);

export function appTypeFromName(name: string): AppType | undefined {
  const segments = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return BY_LENGTH.find((a) => segments.has(a));
}

/**
 * The services that make a corpus searchable, as opposed to the apps a user asks for by name.
 *
 * Grouped because they are provisioned together and are useless apart: text in object storage with
 * nothing indexing it cannot be found, and an index pointing at storage that is not there resolves
 * to nothing. See lib/corpus-backend.ts.
 */
export const SEARCH_APP_TYPES = ['minio', 'quickwit', 'qdrant', 'tei'] as const satisfies readonly AppType[];

export type SearchAppType = typeof SEARCH_APP_TYPES[number];
