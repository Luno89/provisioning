import { describe, expect, it } from 'vitest';
import type { DeploymentMetadata } from '../../platform/index.js';
import { appSignIns, secretValues, signsIn } from './app-sign-in.js';

const dep = (over: Partial<DeploymentMetadata>): DeploymentMetadata => ({ id: 'd1', name: 'app', clusterId: 'c1', ownerId: 'u1', ...over } as DeploymentMetadata);

describe('an app\'s sign-in', () => {
  it('is the generated password of each app that has one, with the login it is for', () => {
    expect(appSignIns(dep({ appType: 'hermes', hermesDashboardPassword: 'h' }))).toEqual([{ describe: 'The Hermes dashboard', login: 'admin', password: 'h' }]);
    expect(appSignIns(dep({ appType: 'nextcloud', nextcloudAdminPassword: 'n' }))).toEqual([{ describe: 'Nextcloud\'s admin', login: 'admin', password: 'n' }]);
    expect(appSignIns(dep({ appType: 'minio', minioRootPassword: 'm' }))).toEqual([{ describe: 'MinIO\'s console, as its root user', login: 'koala', password: 'm' }]);
    expect(appSignIns(dep({ appType: 'minio', minioRootUser: 'root', minioRootPassword: 'm' }))[0]?.login).toBe('root');
  });

  it('reads Palworld\'s from the Secret its deploy made, saying what each is for', () => {
    const palworld = secretValues(JSON.stringify({ ADMIN_PASSWORD: Buffer.from('a').toString('base64'), SERVER_PASSWORD: Buffer.from('s').toString('base64'), RCON_PASSWORD: Buffer.from('r').toString('base64') }));
    expect(appSignIns(dep({ appType: 'palworld' }), palworld)).toEqual([
      { describe: 'The in-game admin password (/AdminPassword)', password: 'a' },
      { describe: 'The password players join with', password: 's' },
      { describe: 'RCON', password: 'r' },
    ]);
    expect(appSignIns(dep({ appType: 'palworld' }), secretValues(''))).toEqual([]);
  });

  it('is nothing for an app with no sign-in, or one whose password was never made', () => {
    expect(appSignIns(dep({ appType: 'odoo' }))).toEqual([]);
    expect(appSignIns(dep({ appType: 'hermes' }))).toEqual([]);
    expect(['hermes', 'nextcloud', 'minio', 'palworld', 'odoo'].map(signsIn)).toEqual([true, true, true, true, false]);
  });
});
