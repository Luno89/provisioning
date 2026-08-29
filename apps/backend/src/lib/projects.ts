
export interface GiteaAccount {
  ownerId: string;
  username: string;
  passwordEnc: string;
  createdAt: string;
}

export const MAX_GITEA_USERNAME = 40;

export function giteaUsernameFor(ownerId: string): string {
  const slug = ownerId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (!slug) throw new Error('Cannot derive a Gitea username from an empty owner id');
  return `koala-${slug}`.slice(0, MAX_GITEA_USERNAME);
}

export function sanitiseRepoName(name: string): string {
  const cleaned = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 100);
  if (!cleaned) throw new Error(`"${name}" contains nothing usable as a repository name`);
  return cleaned;
}

export const MAX_PROJECTS_PER_USER = 50;
