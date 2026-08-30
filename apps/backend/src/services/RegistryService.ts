import { BaseService } from './BaseService.js';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Database } from '../lib/db-interface.js';
import { normalizeTags, nextPageUrl, pageOf, type TagPage, type TagPageRequest } from '../lib/registry-tags.js';

const execAsync = promisify(exec);

const GHCR_MAX_PAGES = 10;
const HUB_MAX_PAGES = 10;
const HUB_PAGE_SIZE = 100;
const TAG_CACHE_TTL_MS = 5 * 60 * 1000;

export class RegistryService extends BaseService {
  constructor(db: Database) {
    super(db);
  }

  private tagCache = new Map<string, { tags: string[]; expiresAt: number }>();

  private FALLBACK_TAGS: Record<string, string[]> = {
    'bitnami/odoo': ['latest'],
    'bitnamilegacy/odoo': ['latest'],
    'bitnami/postgresql': ['latest'],
    'bitnamilegacy/postgresql': ['latest'],
    'bitnami/nginx': ['latest'],
    'ghcr.io/open-webui/open-webui': ['main', 'latest', 'cuda', 'ollama'],
    'jellyfin/jellyfin': ['latest'],
    'plexinc/pms-docker': ['latest'],
    'deluan/navidrome': ['latest'],
    'jvmorgan/kavita': ['latest'],
    'ghcr.io/immich-app/immich-server': ['release', 'main'],
    'papra/papra': ['latest'],
    'ghcr.io/home-assistant/home-assistant': ['stable', 'latest', 'beta', 'dev'],
    'ghcr.io/advplyr/audiobookshelf': ['latest'],
  };

  async search(query: string) {
    const response = await axios.get(`https://hub.docker.com/v2/search/repositories/?query=${query}&page_size=10`);
    return response.data.results;
  }

  private async fetchGhcrTags(repoPath: string): Promise<string[]> {
    const tokenResp = await axios.get(`https://ghcr.io/token?scope=repository:${repoPath}:pull&service=ghcr.io`);
    const headers = { Authorization: `Bearer ${tokenResp.data.token}` };

    const collected: string[] = [];
    let url: string | undefined = `https://ghcr.io/v2/${repoPath}/tags/list?n=1000`;
    for (let page = 0; url && page < GHCR_MAX_PAGES; page++) {
      const resp: any = await axios.get(url, { headers });
      collected.push(...(resp.data?.tags ?? []));
      url = nextPageUrl(resp.headers?.link, 'https://ghcr.io');
    }
    return collected;
  }

  private async fetchHubTags(hubRepo: string): Promise<string[]> {
    const collected: string[] = [];
    let url: string | undefined =
      `https://hub.docker.com/v2/repositories/${hubRepo}/tags?page_size=${HUB_PAGE_SIZE}`;
    for (let page = 0; url && page < HUB_MAX_PAGES; page++) {
      const resp: any = await axios.get(url);
      collected.push(...(resp.data?.results ?? []).map((t: any) => t.name));
      url = resp.data?.next ?? undefined;
    }
    return collected;
  }

  private async fetchEcrTags(repoName: string): Promise<string[]> {
    const response = await axios.get(
      `https://api.gallery.ecr.aws/v1/repository/public/tags?repositoryName=${repoName}&registryAlias=bitnami`,
    );
    return (response.data?.tags ?? []).map((t: any) => t.tagName);
  }

  async getTags(repo: string): Promise<string[]> {
    if (!repo) return ['latest'];

    const cached = this.tagCache.get(repo);
    if (cached && cached.expiresAt > Date.now()) return cached.tags;

    const tags = await this.resolveTags(repo);
    this.tagCache.set(repo, { tags, expiresAt: Date.now() + TAG_CACHE_TTL_MS });
    return tags;
  }

  private async resolveTags(repo: string): Promise<string[]> {
    try {
      if (repo.startsWith('bitnami/')) {
        const repoName = repo.split('/')[1];
        if (repoName) {
          const tags = normalizeTags(await this.fetchEcrTags(repoName), 'newest-first');
          if (tags.length > 0) return tags;
        }
      }

      if (repo.startsWith('ghcr.io/')) {
        const tags = normalizeTags(await this.fetchGhcrTags(repo.slice('ghcr.io/'.length)), 'oldest-first');
        if (tags.length > 0) return tags;
      }

      const hubRepo = repo.includes('/') ? repo : `library/${repo}`;
      const tags = normalizeTags(await this.fetchHubTags(hubRepo), 'newest-first');
      if (tags.length > 0) return tags;

      return this.FALLBACK_TAGS[repo] ?? ['latest'];
    } catch (err: any) {
      this.logger.warn(`Failed to fetch tags for ${repo}: ${err.message}`);
      return this.FALLBACK_TAGS[repo] ?? ['latest'];
    }
  }

  async getTagPage(repo: string, request: TagPageRequest = {}): Promise<TagPage> {
    return pageOf(await this.getTags(repo), request);
  }

  async getLocalTags(repo: string): Promise<string[]> {
    try {
      const safeRepo = repo.replace(/(["'$`\\])/g, '\\$1');
      const { stdout } = await execAsync(`docker images --format "{{.Tag}}" "${safeRepo}"`);
      return [...new Set(stdout.split('\n').map(t => t.trim()).filter(t => t && t !== '<none>'))];
    } catch (err: any) {
      this.logger.warn(`Failed to list local image tags for ${repo}: ${err.message}`);
      return [];
    }
  }
}
