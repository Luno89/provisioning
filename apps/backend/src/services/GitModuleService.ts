import { BaseService } from './BaseService.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../../');

export interface OdooModule {
  id: string;
  name: string;
  summary: string;
  // Optional because only modules parsed from a real manifest carry one (see the `data.description
  // || ''` fallback in listAvailableModules); the built-in catalogue below has summaries only. The
  // UI already treats it as a fallback — `mod.summary || mod.description` in App.tsx.
  description?: string;
  author: string;
  version: string;
  depends?: string[];
}

const MOCK_MODULES: Record<string, OdooModule[]> = {
  odoo: [
    { id: 'sale_delivery_split_date', name: 'Sales Order Delivery Split Date', summary: 'Allows splitting delivery dates on sales order lines.', author: 'Odoo Professional Services', version: '18.0.1.0.0', depends: ['sale'] },
    { id: 'partner_credit_limit', name: 'Partner Credit Limit Enforcer', summary: 'Restricts sales orders if partner exceeds credit limit.', author: 'Odoo Finance Core', version: '18.0.2.1.0', depends: ['account'] }
  ],
  wordpress: [
    { id: 'wp_super_cache', name: 'WP Super Cache Optimizer', summary: 'High-performance static caching plugin for WordPress.', author: 'WordPress Performance Team', version: '6.7.1' },
    { id: 'seo_optimizer', name: 'Rank SEO Optimizer', summary: 'Search Engine Optimization and XML Sitemap Generator.', author: 'SEO Plugins Inc', version: '2.4.5' }
  ],
  nextcloud: [
    { id: 'calendar', name: 'Nextcloud Calendar', summary: 'Personal and shared calendars for Nextcloud.', author: 'Nextcloud Community', version: '30.0.1' },
    { id: 'deck', name: 'Nextcloud Deck', summary: 'Kanban-style project organization tool.', author: 'Nextcloud Team', version: '1.12.0' }
  ],
  audiobookshelf: [
    { id: 'audible_scraper', name: 'Audible Metadata Scraper', summary: 'Scrapes metadata and chapters directly from Audible.', author: 'Audiobookshelf Plugins', version: '1.2.0' },
    { id: 'librivox_scraper', name: 'LibriVox Scraper', summary: 'Fetches metadata and audiobooks from LibriVox.', author: 'Free Audio Project', version: '1.0.1' }
  ],
  prometheus: [
    { id: 'node_exporter', name: 'Node Exporter Plugin', summary: 'Host level metrics exporter for Linux systems.', author: 'Prometheus Community', version: '1.8.1' },
    { id: 'alertmanager_discord', name: 'Discord Alerts Dispatcher', summary: 'Forwards Prometheus alerts to Discord webhooks.', author: 'CloudOps Tools', version: '1.3.0' }
  ],
  traefik: [
    { id: 'oauth2_forwarder', name: 'OAuth2 Forward Auth', summary: 'Secures routes behind Google or GitHub OAuth.', author: 'Traefik Middleware', version: '2.1.0' },
    { id: 'compression_gzip', name: 'Gzip Compression', summary: 'Enables gzip content encoding dynamically.', author: 'Core Traefik Team', version: '1.0.0' }
  ],
  jellyfin: [
    { id: 'opensubtitles', name: 'OpenSubtitles Auto-Downloader', summary: 'Automatically fetches subtitle files from OpenSubtitles.', author: 'Jellyfin Plugins', version: '10.9.0' },
    { id: 'anilist_metadata', name: 'AniList Metadata Provider', summary: 'Enhances anime libraries with AniList metadata & covers.', author: 'Anime Community', version: '2.1.4' },
    { id: 'ldap_auth', name: 'LDAP Authentication Provider', summary: 'Enables single sign-on via LDAP or Active Directory.', author: 'Jellyfin Core', version: '1.8.0' }
  ],
  plex: [
    { id: 'plex_meta_manager', name: 'Plex Meta Manager (PMM)', summary: 'Dynamic metadata, collections, and overlay manager.', author: 'PMM Team', version: '1.21.0' },
    { id: 'tautulli', name: 'Tautulli Monitoring & Analytics', summary: 'Detailed usage statistics and notifications engine.', author: 'Tautulli Team', version: '2.14.0' },
    { id: 'subzero', name: 'Sub-Zero Subtitles Engine', summary: 'Advanced subtitle search and auto-download plugin.', author: 'Plex Community', version: '2.6.5' }
  ],
  navidrome: [
    { id: 'lastfm_scrobbler', name: 'Last.fm Realtime Scrobbler', summary: 'Scrobbles tracks directly to Last.fm in real time.', author: 'Navidrome Core', version: '0.53.0' },
    { id: 'listenbrainz', name: 'ListenBrainz Sync Integration', summary: 'Syncs music listening history with ListenBrainz.', author: 'Open Music Initiative', version: '1.1.0' },
    { id: 'spotify_import', name: 'Spotify Playlist Importer', summary: 'Imports public Spotify playlists into your library.', author: 'Navidrome Community', version: '1.0.2' }
  ],
  kavita: [
    { id: 'anilist_comic_matcher', name: 'AniList & ComicVine Matcher', summary: 'Matches manga and comic issues with AniList/ComicVine.', author: 'Kavita Plugins', version: '0.8.0' },
    { id: 'opds_enhancer', name: 'Enhanced OPDS Feed Extension', summary: 'Adds rich metadata and cover thumbnails to OPDS feeds.', author: 'Reader Group', version: '1.4.0' },
    { id: 'cbr_cbz_converter', name: 'CBR/CBZ On-The-Fly Transcoder', summary: 'Converts archive formats dynamically for e-readers.', author: 'Kavita Core', version: '1.0.1' }
  ],
  immich: [
    { id: 'facial_recognition_pack', name: 'Facial Recognition ML Model Pack', summary: 'Enhanced face detection & clustering machine learning models.', author: 'Immich AI Team', version: '1.118.0' },
    { id: 'reverse_geocoding', name: 'Offline Reverse Geocoding Pack', summary: 'Resolves GPS coordinates into city/country names offline.', author: 'Immich Core', version: '1.5.0' },
    { id: 'auto_album_sync', name: 'Auto-Album Smart Grouping', summary: 'Groups photos automatically by event, date, and location.', author: 'Community Labs', version: '2.0.1' }
  ],
  papra: [
    { id: 'tesseract_ocr', name: 'Tesseract Multi-Language OCR Pack', summary: 'Optical character recognition model for scanned documents.', author: 'Papra HQ', version: '0.4.0' },
    { id: 'auto_tagging_pipeline', name: 'Smart AI Auto-Tagging Engine', summary: 'Tags and categorizes incoming documents based on content.', author: 'Papra Plugins', version: '1.2.0' },
    { id: 'email_import_bridge', name: 'IMAP Email Auto-Ingestion', summary: 'Monitors email inboxes and imports attachments automatically.', author: 'Papra Community', version: '1.0.0' }
  ],
  homeassistant: [
    { id: 'hacs', name: 'Home Assistant Community Store (HACS)', summary: 'Integration repository for custom components and cards.', author: 'HACS Team', version: '2.0.0' },
    { id: 'mosquitto_mqtt', name: 'Mosquitto MQTT Broker Integration', summary: 'Enables MQTT messaging between IoT devices and HA.', author: 'Home Assistant Core', version: '6.4.1' },
    { id: 'nodered', name: 'Node-RED Visual Automation Flow', summary: 'Visual flow editor for building complex automations.', author: 'Node-RED HA Team', version: '3.1.0' }
  ]
};

export class GitModuleService extends BaseService {
  private getRepoPath(appType: string): string {
    const folderName = appType === 'odoo' ? 'odoo-custom-modules' : `${appType}-custom-plugins`;
    return path.join(PROJECT_ROOT, '..', folderName);
  }

  async listAvailableModules(appType: string = 'odoo'): Promise<OdooModule[]> {
    const sanitizedAppType = appType ? appType.toLowerCase() : 'odoo';
    const repoPath = this.getRepoPath(sanitizedAppType);

    try {
      // 1. Try reading the actual directory if it exists
      await fs.access(repoPath);
      const items = await fs.readdir(repoPath, { withFileTypes: true });
      const modules: OdooModule[] = [];

      for (const item of items) {
        if (item.isDirectory() && !item.name.startsWith('.')) {
          // If Odoo, parse standard manifest
          if (sanitizedAppType === 'odoo') {
            const manifestPath = path.join(repoPath, item.name, '__manifest__.py');
            try {
              const content = await fs.readFile(manifestPath, 'utf-8');
              modules.push({
                id: item.name,
                name: this.extractManifestValue(content, 'name') || item.name,
                summary: this.extractManifestValue(content, 'summary') || '',
                description: this.extractManifestValue(content, 'description') || '',
                author: this.extractManifestValue(content, 'author') || 'Unknown',
                version: this.extractManifestValue(content, 'version') || '1.0',
                depends: this.extractManifestList(content, 'depends') || []
              });
            } catch {
              // Ignore invalid module folders
            }
          } else {
            // For other apps, check for a simple manifest or metadata file, or default metadata
            const metaPath = path.join(repoPath, item.name, 'manifest.json');
            try {
              const content = await fs.readFile(metaPath, 'utf-8');
              const data = JSON.parse(content);
              modules.push({
                id: item.name,
                name: data.name || item.name,
                summary: data.summary || '',
                description: data.description || '',
                author: data.author || 'Unknown',
                version: data.version || '1.0'
              });
            } catch {
              // Fallback: use directory name and look up mock defaults
              const matchedMock = MOCK_MODULES[sanitizedAppType]?.find(m => m.id === item.name);
              modules.push(matchedMock || {
                id: item.name,
                name: item.name,
                summary: 'Custom Extension',
                description: 'Custom Extension plugin found in local repository.',
                author: 'Developer',
                version: '1.0'
              });
            }
          }
        }
      }

      if (modules.length > 0) return modules;
      return MOCK_MODULES[sanitizedAppType] || [];
    } catch (err: any) {
      // 2. Directory missing or unreadable - fall back to mock data
      return MOCK_MODULES[sanitizedAppType] || [];
    }
  }

  private extractManifestValue(content: string, key: string): string | null {
    const regex = new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]+)['"]`, 'i');
    const match = content.match(regex);
    // `?? null` rather than `match ? match[1] : null`: under noUncheckedIndexedAccess a capture
    // group is `string | undefined` even when the match succeeded, and the caller's contract is
    // `string | null`.
    return match?.[1] ?? null;
  }

  private extractManifestList(content: string, key: string): string[] | null {
    const regex = new RegExp(`['"]${key}['"]\\s*:\\s*\\[([^\\]]+)\\]`, 'i');
    const match = content.match(regex);
    const body = match?.[1];
    if (!body) return null;
    return body.split(',').map(s => s.trim().replace(/['"]/g, '')).filter(s => s);
  }
}
