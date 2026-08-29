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

export const GPU_ONLY_APP_TYPES = new Set(['vllm', 'tabbyapi']);

export const TABBY_TOOL_FORMATS = ['mistral', 'mistral_old', 'qwen3_coder', 'gemma4', 'glm4_5', 'minimax_m2', 'harmony'];

export function defaultsFor(appType: string): (typeof APP_DEFAULTS)[string] {
  return APP_DEFAULTS[appType] ?? APP_DEFAULTS.odoo!;
}
