import { describe, expect, it } from 'vitest';
import { DEV, devKoalaValues, devRootPlan } from './dev-root.js';

const input = { mongoUri: 'mongodb://localhost:27017/provisioning?replicaSet=rs0', setupCode: 'setup', hubCredential: 'hub-secret', hubCredentialHash: 'hash', rootPublicKeys: 'PEM' };

describe('dev, run as production runs on this computer', () => {
  it('runs root as root, on its own database, with this computer\'s mesh and registry, and the hub beside it', () => {
    const plan = devRootPlan(input);
    expect(plan.rootUrl).toBe('http://koala.localhost:5175');
    expect(plan.instanceUrl).toBe('http://dev.localhost:5173');
    expect(plan.rootEnv).toMatchObject({
      ROLE: 'root', PORT: '3002', MONGO_URI: 'mongodb://localhost:27017/koala_root?replicaSet=rs0', PUBLIC_URL: 'http://koala.localhost:5175',
      ADMIN_SETUP_CODE: 'setup', MESH_LOGIN_SERVER: 'http://127.0.0.1:8080', INSTANCE_REGISTRY: '127.0.0.1:5001', INSTANCE_IMAGE_TAG: 'dev',
      HUB_URL: 'http://hub.localhost:5176', HUB_CREDENTIAL_HASH: 'hash',
    });
    expect(plan.hubEnv).toMatchObject({ ROLE: 'hub', PORT: '3003', ROOT_URL: 'http://koala.localhost:5175', ROOT_PUBLIC_KEYS: Buffer.from('PEM').toString('base64'), HUB_CREDENTIAL: 'hub-secret' });
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
});
