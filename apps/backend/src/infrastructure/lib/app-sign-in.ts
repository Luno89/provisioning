import type { DeploymentMetadata } from '../../platform/index.js';

export interface AppSignIn {
  describe: string;
  login?: string;
  password: string;
}

export const PALWORLD_SECRET = 'palworld-secrets';
export const SIGN_IN_APPS = ['hermes', 'nextcloud', 'minio', 'palworld'] as const;

export const signsIn = (appType: string | undefined): boolean => (SIGN_IN_APPS as readonly string[]).includes(appType ?? '');

const one = (describe: string, password: string | undefined, login?: string): AppSignIn[] =>
  (password ? [{ describe, ...(login ? { login } : {}), password }] : []);

export function appSignIns(dep: DeploymentMetadata, palworld: Readonly<Record<string, string>> = {}): AppSignIn[] {
  switch (dep.appType) {
    case 'hermes': return one('The Hermes dashboard', dep.hermesDashboardPassword, 'admin');
    case 'nextcloud': return one('Nextcloud\'s admin', dep.nextcloudAdminPassword, 'admin');
    case 'minio': return one('MinIO\'s console, as its root user', dep.minioRootPassword, dep.minioRootUser || 'koala');
    case 'palworld': return [
      ...one('The in-game admin password (/AdminPassword)', palworld.ADMIN_PASSWORD),
      ...one('The password players join with', palworld.SERVER_PASSWORD),
      ...one('RCON', palworld.RCON_PASSWORD),
    ];
    default: return [];
  }
}

export function secretValues(raw: string): Record<string, string> {
  const data = (raw.trim() ? JSON.parse(raw) : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => [key, Buffer.from(value, 'base64').toString('utf8')]));
}
