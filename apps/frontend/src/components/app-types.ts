/**
 * ── DUPLICATED, KNOWINGLY ──
 *
 * The authority is `APP_TYPES` in `apps/backend/src/lib/app-catalog.ts`. If this disagrees with it,
 * the backend is right — a type listed here that the backend does not know will fail at deploy
 * time, and one the backend knows that is missing here simply cannot be chosen.
 *
 * It cannot be imported: `@koala/harness-types` is types-only by design and carries the harness
 * vocabulary, not the app catalogue, which is a runtime list on the backend.
 *
 * Moved out of `App.tsx` so `wizard-defaults.ts` can use it without importing a component module —
 * a file that exports a component and a type cannot be hot-reloaded reliably (see the naming rule
 * in CLAUDE.md).
 */
export type AppType =
  | 'odoo' | 'wordpress' | 'nextcloud' | 'audiobookshelf' | 'prometheus' | 'traefik' | 'vllm'
  | 'tabbyapi' | 'openwebui' | 'hermes' | 'gitapp' | 'palworld' | 'jellyfin' | 'plex' | 'navidrome'
  | 'kavita' | 'immich' | 'papra' | 'homeassistant' | 'searxng' | 'crawl4ai' | 'qdrant' | 'minio'
  | 'quickwit' | 'tei' | 'verdaccio';
