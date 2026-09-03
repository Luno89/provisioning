import type { ProjectRepoService } from '../services/ProjectRepoService.js';

export interface SecretSourceMintContext {
  userId: string;
  projects: ProjectRepoService;
}

export interface SecretSource {
  id: string;
  /** First-time guess only — once matched, the project records the mapping and this stops being consulted for that key. */
  matches(key: string): boolean;
  mint(ctx: SecretSourceMintContext): Promise<{ value: string; label: string }>;
}

function segments(key: string): string[] {
  return key.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

export const GITEA_READ_TOKEN_SOURCE: SecretSource = {
  id: 'gitea-read-token',
  matches: (key) => {
    const s = segments(key);
    return s.includes('GITEA') || s.includes('GIT');
  },
  mint: async (ctx) => {
    const { token, username } = await ctx.projects.mintReadToken(ctx.userId);
    return { value: token, label: `Auto-provisioned read-only Gitea token for ${username}` };
  },
};

export const SECRET_SOURCES: readonly SecretSource[] = [GITEA_READ_TOKEN_SOURCE];

export const findSecretSource = (id: string): SecretSource | undefined => SECRET_SOURCES.find((s) => s.id === id);
export const matchSecretSource = (key: string): SecretSource | undefined => SECRET_SOURCES.find((s) => s.matches(key));
