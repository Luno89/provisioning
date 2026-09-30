import type { RegistryImageTag } from './prune-images.js';

export const WORKSPACE_REPOSITORY = 'workspace';

/** How many pages of the registry's package list to read before assuming that is plenty. */
const MAX_PAGES = 20;

export interface RegistryAccount {
  owner: string;
  username: string;
  password: string;
}

export interface RegistryPackagesOptions {
  /** The address the registry is reached at, which is also the address Gitea's API is served on. */
  registry(): Promise<string>;
  account(): Promise<RegistryAccount>;
  repository?: string;
  fetchImpl?: typeof fetch;
  pageSize?: number;
}

export interface RegistryPackages {
  list(): Promise<RegistryImageTag[]>;
  remove(fingerprint: string): Promise<void>;
}

/**
 * The workspace images the registry holds, through Gitea's package API.
 *
 * Every owner's images land in one repository, under the registry account rather than under them, so
 * a fingerprint two people end up needing is built once and kept once — and a sweep has to ask what
 * everyone wants, not what one person does.
 */
export function createRegistryPackages(options: RegistryPackagesOptions): RegistryPackages {
  const repository = options.repository ?? WORKSPACE_REPOSITORY;
  const pageSize = options.pageSize ?? 50;
  const take = options.fetchImpl ?? fetch;

  const address = async () => {
    const account = await options.account();
    return {
      account,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString('base64')}`,
      },
      url: `http://${await options.registry()}/api/v1/packages/${account.owner}`,
    };
  };

  return {
    async list(): Promise<RegistryImageTag[]> {
      const { url, headers } = await address();
      const tags: RegistryImageTag[] = [];
      const seen = new Set<string>();

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await take(
          `${url}?type=container&q=${encodeURIComponent(repository)}&limit=${pageSize}&page=${page}`,
          { headers },
        );

        if (!response.ok) {
          throw new Error(`Could not list the workspace images: ${response.status} ${response.statusText}`);
        }

        const rows = await response.json() as { name?: string; version?: string; created_at?: string }[];
        for (const row of rows) {
          if (row.name !== repository || !row.version || seen.has(row.version)) continue;
          seen.add(row.version);
          tags.push({ fingerprint: row.version, createdAt: row.created_at ?? '' });
        }

        if (rows.length < pageSize) break;
      }

      return tags;
    },

    async remove(fingerprint: string): Promise<void> {
      const { url, headers } = await address();
      const response = await take(
        `${url}/container/${encodeURIComponent(repository)}/${encodeURIComponent(fingerprint)}`,
        { method: 'DELETE', headers },
      );

      // Already gone is what a delete was for.
      if (response.ok || response.status === 404) return;

      throw new Error(`Could not delete the workspace image ${fingerprint.slice(0, 12)}: ${response.status} ${response.statusText}`);
    },
  };
}
