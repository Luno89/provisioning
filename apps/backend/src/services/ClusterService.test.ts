import { describe, it, expect, vi } from 'vitest';
import { ClusterService } from './ClusterService.js';
import { decryptValue } from '../lib/crypto.js';

const MASTER = 'test-master-key';

function createService() {
  const saved: any[] = [];
  const db = {
    saveClusterInfo: vi.fn(async (c: any) => { saved.push(c); return c; }),
    getClusters: vi.fn(async () => saved),
  } as any;
  const infra = {} as any;
  return { svc: new ClusterService(db, infra, MASTER), saved, db };
}

describe('createAwaitingKey', () => {
  const args = {
    name: 'gpu-box',
    ownerId: 'user-1',
    host: '100.64.0.9',
    username: 'root',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-material\n-----END OPENSSH PRIVATE KEY-----',
  };

  it('never stores the private key in plaintext', async () => {
    const { svc, saved } = createService();
    await svc.createAwaitingKey(args);

    const record = saved[0];
    expect(JSON.stringify(record)).not.toContain('secret-material');
    expect(record.remoteSshPrivateKeyEnc).toBeDefined();
    expect(decryptValue(record.remoteSshPrivateKeyEnc, MASTER)).toBe(args.privateKey);
  });

  it('parks the cluster in awaiting-key rather than provisioning', async () => {
    const { svc, saved } = createService();
    await svc.createAwaitingKey(args);
    expect(saved[0].status).toBe('awaiting-key');
  });

  it('records the connection details the start route will need', async () => {
    const { svc, saved } = createService();
    await svc.createAwaitingKey({ ...args, port: 2222 });
    expect(saved[0]).toMatchObject({
      provider: 'remote',
      ownerId: 'user-1',
      remoteHost: '100.64.0.9',
      remoteUsername: 'root',
      remoteSshPort: 2222,
    });
    expect(saved[0].id).toBeTruthy();
  });

  it('omits the port entirely when not given, rather than writing undefined', async () => {
    const { svc, saved } = createService();
    await svc.createAwaitingKey(args);
    expect('remoteSshPort' in saved[0]).toBe(false);
  });
});
