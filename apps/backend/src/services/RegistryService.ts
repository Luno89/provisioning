import { BaseService } from './BaseService.js';
import axios from 'axios';
import type { Database } from '../lib/db-interface.js';

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
    'ghcr.io/open-webui/open-webui': ['main', 'latest', 'cuda', 'ollama']
  };

  async search(query: string) {
    const response = await axios.get(`https://hub.docker.com/v2/search/repositories/?query=${query}&page_size=10`);
    return response.data.results;
  }

  async getTags(repo: string) {
    try {
      if (repo.startsWith('bitnami/')) {
          const repoName = repo.split('/')[1];
          const response = await axios.get(`https://api.gallery.ecr.aws/v1/repository/public/tags?repositoryName=${repoName}&registryAlias=bitnami`);
          const tags = response.data.tags
            .map((t: any) => t.tagName)
            .filter((tag: string) => !tag.includes('sha256') && !tag.includes('latest'));

          if (tags.length > 0) return tags.slice(0, 30);
      }

      // ghcr.io (GitHub Container Registry) isn't Docker Hub — it needs its own anonymous
      // token exchange before the tags/list call will authenticate, per the OCI distribution
      // spec's standard token-auth flow (docs.github.com/en/packages, no credentials required
      // for public packages).
      if (repo.startsWith('ghcr.io/')) {
        const repoPath = repo.slice('ghcr.io/'.length);
        const tokenResp = await axios.get(`https://ghcr.io/token?scope=repository:${repoPath}:pull&service=ghcr.io`);
        const tagsResp = await axios.get(`https://ghcr.io/v2/${repoPath}/tags/list`, {
          headers: { Authorization: `Bearer ${tokenResp.data.token}` },
        });
        const tags = (tagsResp.data.tags || [])
          // GHCR image builds commonly push a per-commit "git-<sha>" tag alongside every real
          // release tag — without filtering, those drown out the tags a user actually wants.
          .filter((tag: string) => !tag.startsWith('git-') && !tag.includes('sha256'));
        if (tags.length > 0) return tags.slice(0, 30);
      }

      const response = await axios.get(`https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100`);
      const tags = response.data.results
        .map((t: any) => t.name)
        .filter((tag: string) => !tag.includes('sha256') && !tag.includes('metadata') && !tag.includes('sig') && tag !== 'latest');
      
      return tags.length > 0 ? tags : (this.FALLBACK_TAGS[repo] || []);
    } catch (err: any) {
      this.logger.warn(`Failed to fetch tags for ${repo}: ${err.message}`);
      return this.FALLBACK_TAGS[repo] || [];
    }
  }
}
