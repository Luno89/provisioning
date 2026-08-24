/**
 * What each app type deploys by default, and which of them need a GPU.
 *
 * ── WHY IT IS NOT IN App.tsx ──
 * 150 lines of static image repositories and tags, sitting between the router setup and the
 * component. It is catalogue data: nothing about it changes at runtime, nothing reads React, and
 * only the deploy wizard uses it. It made `App.tsx` export non-components, which is what stops a
 * file hot-reloading (see the naming rule in CLAUDE.md).
 *
 * ── DUPLICATED, KNOWINGLY ──
 * The image defaults mirror what the CDKTF constructs use in `packages/cdktf-infra/constructs/`.
 * If they disagree the construct wins — it is what actually runs — and the wizard will have shown
 * a tag that is not what got deployed.
 */
export const APP_DEFAULTS: Record<string, {
  helm: { webRepo: string; webTag: string; dbRepo: string; dbTag: string };
  native: { webRepo: string; webTag: string; dbRepo: string; dbTag: string };
  hasDatabase: boolean;
  strategies: ('helm' | 'native')[];
}> = {
  odoo: {
    helm: { webRepo: 'bitnamilegacy/odoo', webTag: '18.0.20250805-debian-12-r8', dbRepo: 'bitnamilegacy/postgresql', dbTag: '17.5.0-debian-12-r20' },
    native: { webRepo: 'library/odoo', webTag: '18.0', dbRepo: 'library/postgres', dbTag: '16.4' },
    hasDatabase: true,
    strategies: ['native']
  },
  wordpress: {
    helm: { webRepo: 'bitnamilegacy/wordpress', webTag: '6.7.1-debian-12-r3', dbRepo: 'bitnamilegacy/mariadb', dbTag: '11.4.5-debian-12-r3' },
    native: { webRepo: 'library/wordpress', webTag: '6.7-apache', dbRepo: 'library/mariadb', dbTag: '11.4' },
    hasDatabase: true,
    strategies: ['helm', 'native']
  },
  nextcloud: {
    helm: { webRepo: 'bitnamilegacy/nextcloud', webTag: '30.0.5-debian-12-r1', dbRepo: 'bitnamilegacy/mariadb', dbTag: '11.4.5-debian-12-r3' },
    native: { webRepo: 'library/nextcloud', webTag: '30.0-apache', dbRepo: 'library/mariadb', dbTag: '11.4' },
    hasDatabase: true,
    strategies: ['helm', 'native']
  },
  audiobookshelf: {
    helm: { webRepo: 'advplyr/audiobookshelf', webTag: '2.19.0', dbRepo: '', dbTag: '' },
    native: { webRepo: 'advplyr/audiobookshelf', webTag: '2.19.0', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['helm', 'native']
  },
  palworld: {
    // Game server: native only. It has no Helm chart, and the wizard's Helm path would fall
    // through to Odoo (see the submit handler's strategy note below).
    helm: { webRepo: 'thijsvanloef/palworld-server-docker', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'thijsvanloef/palworld-server-docker', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  jellyfin: {
    helm: { webRepo: 'jellyfin/jellyfin', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'jellyfin/jellyfin', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  plex: {
    helm: { webRepo: 'plexinc/pms-docker', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'plexinc/pms-docker', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  navidrome: {
    helm: { webRepo: 'deluan/navidrome', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'deluan/navidrome', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  kavita: {
    helm: { webRepo: 'ghcr.io/kareadita/kavita', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/kareadita/kavita', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  immich: {
    helm: { webRepo: 'ghcr.io/immich-app/immich-server', webTag: 'release', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/immich-app/immich-server', webTag: 'release', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  searxng: {
    helm: { webRepo: 'searxng/searxng', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'searxng/searxng', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  crawl4ai: {
    helm: { webRepo: 'unclecode/crawl4ai', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'unclecode/crawl4ai', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  papra: {
    helm: { webRepo: 'ghcr.io/papra-hq/papra', webTag: 'latest', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/papra-hq/papra', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  homeassistant: {
    helm: { webRepo: 'ghcr.io/home-assistant/home-assistant', webTag: 'stable', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/home-assistant/home-assistant', webTag: 'stable', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  prometheus: {
    helm: { webRepo: 'prometheus/prometheus', webTag: 'v3.1.0', dbRepo: '', dbTag: '' },
    native: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['helm']
  },
  traefik: {
    helm: { webRepo: 'traefik', webTag: 'v3.6.0', dbRepo: '', dbTag: '' },
    native: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['helm']
  },
  vllm: {
    helm: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    native: { webRepo: 'vllm/vllm-openai', webTag: 'v0.7.2', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  tabbyapi: {
    helm: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/theroyallab/tabbyapi', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  openwebui: {
    helm: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    native: { webRepo: 'ghcr.io/open-webui/open-webui', webTag: 'main', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  },
  hermes: {
    helm: { webRepo: '', webTag: '', dbRepo: '', dbTag: '' },
    native: { webRepo: 'nousresearch/hermes-agent', webTag: 'latest', dbRepo: '', dbTag: '' },
    hasDatabase: false,
    strategies: ['native']
  }
};

// App types that require a GPU-enabled cluster (attached to the shared, GPU-capable
// management cluster — see backend ProvisionClusterActivity). Extend this as more GPU-backed
// LLM engines are added (e.g. future TGI/Ollama support).
export const GPU_ONLY_APP_TYPES = new Set(['vllm', 'tabbyapi']);
// App types with no HTTP surface at all. The whole exposure story here is Traefik +
// localtunnel over HTTP, so offering it for a UDP game server produces a working tunnel to
// nothing. Also suppresses the clickable app link, whose url is a meaningless placeholder.


/**
 * Colour for a deployment's status pill.
 *
 * Every status used to render in the same blue, so `failed` and `running` were distinguishable only
 * by reading the word — which defeats the point of a status pill in a list. `unhealthy` gets amber
 * rather than red on purpose: the deploy worked, and colouring it like a failed deploy sends people
 * to the wrong logs.
 */

// TabbyAPI's tool-call parsers (endpoints/OAI/utils/toolcall_formats/*.py) — 'harmony' is
// documented as equivalent to setting the separate `harmony: true` config flag, so it's passed
// through as a plain tool_format value rather than needing special-casing.
export const TABBY_TOOL_FORMATS = ['mistral', 'mistral_old', 'qwen3_coder', 'gemma4', 'glm4_5', 'minimax_m2', 'harmony'];
