export interface GiteaListedUser {
  login: string;
  login_name?: string | undefined;
  source_id?: number | undefined;
  visibility?: string | undefined;
}

export interface VisibilityPatch {
  username: string;
  body: { login_name: string; source_id: number; visibility: 'private' };
}

export function privatePatches(users: readonly GiteaListedUser[]): VisibilityPatch[] {
  return users
    .filter((user) => user.login && user.visibility !== 'private')
    .map((user) => ({
      username: user.login,
      body: { login_name: user.login_name || user.login, source_id: user.source_id ?? 0, visibility: 'private' },
    }));
}
