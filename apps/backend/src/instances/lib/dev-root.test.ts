import { testIdentityKey, testKeyEnv } from '../../platform/testing/keys.js';
import { describe, expect, it } from 'vitest';
import { DEV, devKoalaValues, devRootPlan } from './dev-root.js';
import { backendSettingsFrom, hostWorkerSettingsFrom } from '../../platform/lib/settings.js';

const saying = (text: string): unknown => expect.stringContaining(text);

const input = { mongoUri: 'mongodb://localhost:27017/provisioning?replicaSet=rs0', setupCode: 'setup', temporalCa: '/repo/apps/backend/data/temporal-tls/ca.crt', dataDir: '/repo/apps/backend/data' };

describe('dev, run as production runs on this computer', () => {
  it('runs root as root, on its own database, with this computer\'s mesh and registry', () => {
    const plan = devRootPlan(input);
    expect(plan.rootUrl).toBe('http://koala.localhost:5175');
    expect(plan.instanceUrl).toBe('http://dev.localhost:5173');
    expect(plan.rootEnv).toMatchObject({
      ROLE: 'root', PORT: '3002', MONGO_URI: 'mongodb://localhost:27017/koala_dev_root?replicaSet=rs0', PUBLIC_URL: 'http://koala.localhost:5175',
      ADMIN_SETUP_CODE: 'setup', MESH_LOGIN_SERVER: 'http://127.0.0.1:8080', INSTANCE_REGISTRY: '127.0.0.1:5001', INSTANCE_IMAGE_TAG: 'dev',
      SIGN_IN_RETURN_URL: 'http://localhost:5175', KOALA_TELEMETRY_CLUSTER: 'root',
    });
    expect(Object.keys(plan.rootEnv)).not.toContain('GITEA_URL');
    expect(Object.keys(plan.rootEnv)).not.toContain('INSTANCE_ID');
  });

  it('puts the developer\'s Koala on this computer as anyone\'s, its pods running the checkout under a watcher and reaching root on this computer', () => {
    const values = devKoalaValues('/home/me/provisioning', 'http://dev.localhost:5173');
    expect(values).toContain('publicUrl: "http://dev.localhost:5173"');
    expect(values).toContain('  source: "/home/me/provisioning"');
    expect(values).toContain(`  - ip: "${DEV.podGateway}"`);
    expect(values).toContain('      - "koala.localhost"');
    expect(values).toContain('  pullPolicy: Always');
  });

  it('gives root and its host worker every setting their readers require, and each reader takes them', () => {
    const plan = devRootPlan(input);
    const keys = { ...testKeyEnv('dev-root'), ROOT_IDENTITY_KEY: testIdentityKey() };
    const root = backendSettingsFrom({ ...keys, ...plan.rootEnv });
    expect(root).toMatchObject({ port: 3002, publicUrl: 'http://koala.localhost:5175', trustProxy: 'loopback', temporal: { address: '127.0.0.1:7233', namespace: 'default', caPath: '/repo/apps/backend/data/temporal-tls/ca.crt' }, terraform: { kind: 'local' }, mesh: { loginServer: 'http://127.0.0.1:8080', headscaleUrl: 'http://127.0.0.1:8080' } });
    expect(root.root).toMatchObject({ imageTag: 'dev', registry: '127.0.0.1:5001', routing: { off: saying('INGRESS_DOMAIN') } });
    expect(hostWorkerSettingsFrom({ ...keys, ...plan.rootEnv })).toMatchObject({ healthPort: 0, temporalMetricsPort: 9465, publicUrl: 'http://koala.localhost:5175' });
  });
});
