import { describe, it, expect } from 'vitest';
import { JoinMeshActivity } from './JoinMeshActivity.js';

describe('JoinMeshActivity', () => {
  const base = {
    physicalName: 'test-cluster',
    host: '203.0.113.10',
    username: 'root',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----',
    preAuthKey: 'nodekey-test',
  };

  // The whole failure this work exists to fix is a host being told to reach a coordination server
  // it cannot route to. headscale/config/config.yaml shipped with server_url: http://localhost:8080
  // for months, so this is the realistic misconfiguration, and it would otherwise "succeed" by
  // pointing the VM at itself and then hand back a mesh IP nothing can reach.
  it('refuses a localhost login server rather than pointing the VM at itself', async () => {
    await expect(JoinMeshActivity({ ...base, loginServer: 'http://localhost:8080' }))
      .rejects.toThrow(/cannot reach that/);
  });

  it('refuses a 127.0.0.1 login server too', async () => {
    await expect(JoinMeshActivity({ ...base, loginServer: 'https://127.0.0.1:8080' }))
      .rejects.toThrow(/cannot reach that/);
  });

  it('rejects before doing anything over SSH', async () => {
    // The guard has to fire before we touch the host — an unreachable login server should not
    // leave a half-installed tailscale behind. An unroutable host would hang for the SSH timeout
    // if the guard were checked after connecting.
    const started = Date.now();
    await expect(JoinMeshActivity({ ...base, host: '192.0.2.1', loginServer: 'http://localhost:8080' }))
      .rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
