import { describe, expect, it } from 'vitest';
import { DEV, devKoalaValues, devRootPlan } from './dev-root.js';
import { giteaSettingsFrom } from '../../projects/lib/gitea-settings.js';
import { generateKeyPairSync } from 'node:crypto';
import { backendSettingsFrom, hostWorkerSettingsFrom } from '../../platform/lib/settings.js';

const saying = (text: string): unknown => expect.stringContaining(text);
const ANY_TEXT: unknown = expect.any(String);

const input = { mongoUri: 'mongodb://localhost:27017/provisioning?replicaSet=rs0', setupCode: 'setup', hubCredential: 'hub-secret', hubCredentialHash: 'hash', rootPublicKeys: 'PEM', temporalCa: '/repo/apps/backend/data/temporal-tls/ca.crt' };

describe('dev, run as production runs on this computer', () => {
  it('runs root as root, on its own database, with this computer\'s mesh and registry, and the hub beside it', () => {
    const plan = devRootPlan(input);
    expect(plan.rootUrl).toBe('http://koala.localhost:5175');
    expect(plan.instanceUrl).toBe('http://dev.localhost:5173');
    expect(plan.rootEnv).toMatchObject({
      ROLE: 'root', PORT: '3002', MONGO_URI: 'mongodb://localhost:27017/koala_dev_root?replicaSet=rs0', PUBLIC_URL: 'http://koala.localhost:5175',
      ADMIN_SETUP_CODE: 'setup', MESH_LOGIN_SERVER: 'http://127.0.0.1:8080', INSTANCE_REGISTRY: '127.0.0.1:5001', INSTANCE_IMAGE_TAG: 'dev',
      HUB_URL: 'http://hub.localhost:5176', HUB_CREDENTIAL_HASH: 'hash', SIGN_IN_RETURN_URL: 'http://localhost:5175', KOALA_TELEMETRY_CLUSTER: 'root',
    });
    expect(plan.hubEnv).toMatchObject({ ROLE: 'hub', PORT: '3003', ROOT_URL: 'http://koala.localhost:5175', ROOT_PUBLIC_KEYS: Buffer.from('PEM').toString('base64'), HUB_CREDENTIAL: 'hub-secret', KOALA_TELEMETRY_CLUSTER: 'hub' });
    expect(Object.keys(plan.rootEnv)).not.toContain('GITEA_URL');
    expect(Object.keys(plan.rootEnv)).not.toContain('INSTANCE_ID');
  });

  it('names the Gitea the hub keeps shared projects\' repositories in, the instance\'s on this computer, and where it sends the hub pushes, the hub on the pod network', () => {
    const { hubEnv } = devRootPlan(input);
    expect(hubEnv).toMatchObject({ GITEA_URL: 'http://127.0.0.1:31737', GITEA_REACHES_KOALA_AT: `http://${DEV.podGateway}:3003` });
    expect(giteaSettingsFrom(hubEnv)).toEqual({ url: 'http://127.0.0.1:31737', reachesKoalaAt: 'http://10.42.0.1:3003' });
  });

  it('puts the developer\'s Koala on this computer as anyone\'s, its pods running the checkout under a watcher and reaching root on this computer', () => {
    const values = devKoalaValues('/home/me/provisioning', 'http://dev.localhost:5173');
    expect(values).toContain('publicUrl: "http://dev.localhost:5173"');
    expect(values).toContain('  source: "/home/me/provisioning"');
    expect(values).toContain(`  - ip: "${DEV.podGateway}"`);
    expect(values).toContain('      - "koala.localhost"');
    expect(values).toContain('  pullPolicy: Always');
  });

  it('gives root, its host worker and the hub every setting their readers require, and each reader takes them', () => {
    const rootKey = String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
    const plan = devRootPlan({ ...input, rootPublicKeys: rootKey });
    const keys = { JWT_SECRET: 'a-dev-secret-of-at-least-thirty-two-chars' };
    const root = backendSettingsFrom({ ...keys, ...plan.rootEnv });
    expect(root).toMatchObject({ port: 3002, publicUrl: 'http://koala.localhost:5175', temporal: { address: '127.0.0.1:7233', namespace: 'default', caPath: '/repo/apps/backend/data/temporal-tls/ca.crt' }, terraform: { kind: 'local' }, mesh: { loginServer: 'http://127.0.0.1:8080', headscaleUrl: 'http://127.0.0.1:8080' } });
    expect(root.root).toMatchObject({ imageTag: 'dev', registry: '127.0.0.1:5001', routing: { off: saying('INGRESS_DOMAIN') }, pool: { off: ANY_TEXT } });
    expect(hostWorkerSettingsFrom({ ...keys, ...plan.rootEnv })).toMatchObject({ healthPort: 0, temporalMetricsPort: 9465, publicUrl: 'http://koala.localhost:5175' });
    expect(backendSettingsFrom({ ...keys, ...plan.hubEnv })).toMatchObject({ port: 3003, hubDatabase: 'koala_dev_hub', hubGitea: { url: 'http://127.0.0.1:31737' } });
  });
});
