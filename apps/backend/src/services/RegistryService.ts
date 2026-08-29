import { BaseService } from './BaseService.js';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Database } from '../lib/db-interface.js';

const execAsync = promisify(exec);

export class RegistryService extends BaseService {
  constructor(db: Database) {
    super(db);
  }
  private FALLBACK_TAGS: Record<string, string[]> = {
    'bitnami/odoo': ['18.0.20250805-debian-12-r8', '17.0.20240805-debian-12-r0', '16.0.20240805-debian-12-r0'],
    'bitnamilegacy/odoo': ['18.0.20250805-debian-12-r8', '17.0.20240805-debian-12-r0', '16.0.20240805-debian-12-r0'],
    'bitnami/postgresql': ['17.5.0-debian-12-r20', '16.4.0-debian-12-r0', '15.8.0-debian-12-r0'],
    'bitnamilegacy/postgresql': ['17.5.0-debian-12-r20', '16.4.0-debian-12-r0', '15.8.0-debian-12-r0'],
    'bitnami/nginx': ['1.27.1-debian-12-r2', '1.26.2-debian-12-r0'],
    'ghcr.io/open-webui/open-webui': ['main', 'latest', 'cuda', 'ollama'],
    'jellyfin/jellyfin': ['latest', '10.9.11', '10.9.10'],
    'plexinc/pms-docker': ['latest', '1.41.0.8994-1b1e95662', '1.40.5.8921-836b04859'],
    'deluan/navidrome': ['latest', '0.53.3', '0.53.2', '0.52.5'],
    'jvmorgan/kavita': ['latest', '0.8.2', '0.8.1', '0.8.0'],
    'ghcr.io/immich-app/immich-server': ['release', 'v1.118.0', 'v1.117.0', 'v1.116.0'],
    'papra/papra': ['latest', '0.4.0', '0.3.0'],
    'ghcr.io/home-assistant/home-assistant': ['stable', '2025.1.0', '2024.12.5', 'latest'],
    'ghcr.io/advplyr/audiobookshelf': ['2.19.0', '2.18.0', 'latest']
  };

  async search(query: string) {
    const response = await axios.get(`https://hub.docker.com/v2/search/repositories/?query=${query}&page_size=10`);
    return response.data.results;
  }

  async getTags(repo: string) {
    if (!repo) return ['latest'];
    try {
      if (repo.startsWith('bitnami/')) {
          const repoName = repo.split('/')[1];
          const response = await axios.get(`https://api.gallery.ecr.aws/v1/repository/public/tags?repositoryName=${repoName}&registryAlias=bitnami`);
          const tags = response.data.tags
            .map((t: any) => t.tagName)
            .filter((tag: string) => !tag.includes('sha256'));

          if (tags.length > 0) return tags.slice(0, 30);
      }

      if (repo.startsWith('ghcr.io/')) {
        const repoPath = repo.slice('ghcr.io/'.length);
        const tokenResp = await axios.get(`https://ghcr.io/token?scope=repository:${repoPath}:pull&service=ghcr.io`);
        const tagsResp = await axios.get(`https://ghcr.io/v2/${repoPath}/tags/list`, {
          headers: { Authorization: `Bearer ${tokenResp.data.token}` },
        });
        const tags = (tagsResp.data.tags || [])
          .filter((tag: string) => !tag.startsWith('git-') && !tag.startsWith('buildcache-') && !tag.includes('sha256'));
        if (tags.length > 0) return tags.slice(0, 30);
      }

      const hubRepo = repo.includes('/') ? repo : `library/${repo}`;
      const response = await axios.get(`https://hub.docker.com/v2/repositories/${hubRepo}/tags?page_size=100`);
      const tags = response.data.results
        .map((t: any) => t.name)
        .filter((tag: string) => !tag.includes('sha256') && !tag.includes('metadata') && !tag.includes('sig'));
      
      const defaultTagList = this.FALLBACK_TAGS[repo] || ['latest'];
      return tags.length > 0 ? tags.slice(0, 30) : defaultTagList;
    } catch (err: any) {
      this.logger.warn(`Failed to fetch tags for ${repo}: ${err.message}`);
      return this.FALLBACK_TAGS[repo] || ['latest'];
    }
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
