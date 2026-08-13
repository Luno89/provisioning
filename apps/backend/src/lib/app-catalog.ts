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
  'papra', 'homeassistant', 'searxng', 'crawl4ai', 'qdrant', 'minio', 'quickwit', 'tei',
] as const;

export type AppType = typeof APP_TYPES[number];

export function isAppType(value: unknown): value is AppType {
  return typeof value === 'string' && (APP_TYPES as readonly string[]).includes(value);
}

/**
 * The app type a Helm release or pod name belongs to.
 *
 * Substring matching, because the caller has a release name like `odoo-1` or a pod name prefix.
 * Longest name first: `openwebui` contains no shorter type today, but `tei` is three characters and
 * would otherwise claim anything containing them.
 */
const BY_LENGTH = [...APP_TYPES].sort((a, b) => b.length - a.length);

export function appTypeFromName(name: string): AppType | undefined {
  const lower = name.toLowerCase();
  return BY_LENGTH.find((a) => lower.includes(a));
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
