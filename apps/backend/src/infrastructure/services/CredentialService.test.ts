import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CredentialService } from './CredentialService.js';
import { decryptValue } from '../../platform/lib/crypto.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { FAKE_OVH_KEYS, fakeOvh } from './fake-ovh.js';
import { fakePorkbun } from './dns/fake-dns.js';

const TEST_KEY = 'test-master-key-for-credential-tests';

describe('CredentialService', () => {
  let db: MongoDB;
  let service: CredentialService;
  const testUser: UserMetadata = {
    id: 'user-1',
    email: 'test@example.com',
    twoFactorEnabled: false,
    emailVerified: true,
    createdAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    db = await testDatabase();
    await db.accounts.saveUser({ ...testUser });
    service = new CredentialService(db, TEST_KEY);
  });

  describe('saveCredentials + getCredentials', () => {
    it('saves AWS credentials and returns them masked', async () => {
      await service.saveCredentials('user-1', 'aws', {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
      });

      const result = await service.getCredentials('user-1', 'aws');
      expect(result).not.toBeNull();
      expect(result!.region).toBe('us-east-1');
      expect(result!.accessKeyId).toContain('****');
      expect(result!.secretAccessKey).toContain('****');
    });

    it('encrypts sensitive fields at rest', async () => {
      await service.saveCredentials('user-1', 'do', {
        token: 'dop_v1_secret_token_12345',
      });

      const user = (await db.accounts.getUsers()).find((u) => u.id === 'user-1');
      expect(user?.credentials?.do?.token).toBeDefined();
      expect(user?.credentials?.do?.token).not.toBe('dop_v1_secret_token_12345');
      const decrypted = decryptValue(user!.credentials!.do!.token, TEST_KEY);
      expect(decrypted).toBe('dop_v1_secret_token_12345');
    });

    it('saves GCP credentials with JSON blob', async () => {
      const saJson = JSON.stringify({ type: 'service_account', project_id: 'test' });
      await service.saveCredentials('user-1', 'gcp', {
        projectId: 'my-project',
        serviceAccountJson: saJson,
      });

      const result = await service.getCredentials('user-1', 'gcp');
      expect(result!.projectId).toBe('my-project');
      expect(result!.serviceAccountJson).toContain('****');
    });

    it('saves Azure credentials', async () => {
      await service.saveCredentials('user-1', 'azure', {
        clientId: 'client-123',
        clientSecret: 'secret-456',
        subscriptionId: 'sub-789',
        tenantId: 'tenant-abc',
      });

      const result = await service.getCredentials('user-1', 'azure');
      expect(result!.subscriptionId).toBe('sub-789');
      expect(result!.tenantId).toBe('tenant-abc');
      expect(result!.clientId).toContain('****');
      expect(result!.clientSecret).toContain('****');
    });
  });

  describe('deleteCredentials', () => {
    it('removes provider credentials', async () => {
      await service.saveCredentials('user-1', 'aws', {
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret',
        region: 'us-west-2',
      });

      await service.deleteCredentials('user-1', 'aws');
      const result = await service.getCredentials('user-1', 'aws');
      expect(result).toBeNull();
    });
  });

  describe('getConfiguredProviders', () => {
    it('lists all providers with their status', async () => {
      await service.saveCredentials('user-1', 'aws', {
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret',
        region: 'us-east-1',
      });

      const statuses = await service.getConfiguredProviders('user-1');
      expect(statuses.map((s) => s.provider).sort()).toEqual(
        [
          'aws', 'azure', 'do', 'gcp', 'github', 'hetzner', 'huggingface',
          'vultr', 'linode', 'scaleway', 'hostinger', 'contabo', 'ovh', 'cloudflare', 'porkbun',
          'artificialanalysis',
        ].sort(),
      );

      const aws = statuses.find((s) => s.provider === 'aws');
      expect(aws?.configured).toBe(true);
      expect(aws?.source).toBe('user');

      const gcp = statuses.find((s) => s.provider === 'gcp');
      expect(gcp?.configured).toBe(false);
    });
  });

  describe('hetzner', () => {
    it('encrypts the token at rest and masks it on read', async () => {
      await service.saveCredentials('user-1', 'hetzner', { token: 'hetzner-secret-token-value' });

      const stored = (await db.accounts.getUserById('user-1'))!.credentials!.hetzner!.token;
      expect(stored).not.toBe('hetzner-secret-token-value');
      expect(decryptValue(stored, TEST_KEY)).toBe('hetzner-secret-token-value');

      const masked = await service.getCredentials('user-1', 'hetzner');
      expect(masked!.token).toContain('****');
      expect(masked!.token).not.toContain('secret-token-value');
    });

    it('resolves to HCLOUD_TOKEN, the env var the hcloud Terraform provider reads', async () => {
      await service.saveCredentials('user-1', 'hetzner', { token: 'hetzner-secret-token-value' });

      const resolved = await service.resolveCredentials('user-1', 'hetzner');
      expect(resolved.mode).toBe('user');
      expect(resolved.env.HCLOUD_TOKEN).toBe('hetzner-secret-token-value');
    });

    it('rejects an empty token without calling the Hetzner API', async () => {
      const result = await service.validateCredentials('hetzner', {});
      expect(result.valid).toBe(false);
      expect(result.message).toMatch(/required/i);
    });

    it('reports an unauthorized token as invalid', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"error":{"code":"unauthorized"}}', { status: 401 }),
      );
      try {
        const result = await service.validateCredentials('hetzner', { token: 'bad' });
        expect(result.valid).toBe(false);
        expect(result.message).toContain('401');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('reports a working token as valid and surfaces the server count', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ servers: [], meta: { pagination: { total_entries: 3 } } }), { status: 200 }),
      );
      try {
        const result = await service.validateCredentials('hetzner', { token: 'good' });
        expect(result.valid).toBe(true);
        expect(result.message).toContain('3 existing servers');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('a DNS provider, from the registry', () => {
    it('stores Porkbun\'s keys sealed, validates them with Porkbun, and hands them back as fields and env', async () => {
      const porkbun = fakePorkbun(['koala.test']);
      const dnsService = new CredentialService(db, TEST_KEY, undefined, porkbun.fetch);
      expect(await dnsService.validateCredentials('porkbun', porkbun.good)).toMatchObject({ valid: true, message: expect.stringContaining('API Access') });
      expect(await dnsService.validateCredentials('porkbun', porkbun.bad)).toMatchObject({ valid: false, message: expect.stringContaining('Invalid API key') });
      await dnsService.saveCredentials('user-1', 'porkbun', porkbun.good);
      const raw = (await db.accounts.getUserById('user-1'))?.credentials?.porkbun;
      expect(raw?.apiKey).not.toBe(porkbun.good.apiKey);
      expect(decryptValue(raw!.apiKey!, TEST_KEY)).toBe(porkbun.good.apiKey);
      expect((await dnsService.getCredentials('user-1', 'porkbun'))?.secretApiKey).toContain('****');
      expect(await dnsService.dnsCredentialsOf('user-1', 'porkbun')).toEqual(porkbun.good);
      expect((await dnsService.resolveCredentials('user-1', 'porkbun')).env).toEqual({ PORKBUN_API_KEY: porkbun.good.apiKey, PORKBUN_API_SECRET_KEY: porkbun.good.secretApiKey });
      expect(await dnsService.dnsCredentialsOf('user-1', 'cloudflare')).toBeUndefined();
      expect(await dnsService.dnsCredentialsOf('user-1', 'aws')).toBeUndefined();
    });
  });

  describe('resolveCredentials', () => {
    it('resolves user credentials first', async () => {
      await service.saveCredentials('user-1', 'do', {
        token: 'dop_v1_user_token',
      });

      const resolved = await service.resolveCredentials('user-1', 'do');
      expect(resolved.mode).toBe('user');
      expect(resolved.env.DIGITALOCEAN_TOKEN).toBe('dop_v1_user_token');
    });

    it('falls back to mock mode when no credentials exist', async () => {
      const resolved = await service.resolveCredentials('user-1', 'aws');
      expect(resolved.mode).toBe('mock');
      expect(resolved.env).toEqual({});
    });
  });

  describe('error handling', () => {
    it('throws when user is not found', async () => {
      await expect(
        service.saveCredentials('nonexistent', 'aws', { accessKeyId: 'test', secretAccessKey: 'test' }),
      ).rejects.toThrow('User not found');
    });

    it('returns null for unconfigured provider', async () => {
      const result = await service.getCredentials('user-1', 'gcp');
      expect(result).toBeNull();
    });
  });

  describe('OVHcloud keys', () => {
    it('signs in with them, names the account, and refuses keys of another subsidiary or missing parts', async () => {
      const ovh = fakeOvh();
      const withOvh = new CredentialService(db, TEST_KEY, undefined, ovh.fetch);
      await expect(withOvh.validateCredentials('ovh', { ...FAKE_OVH_KEYS, subsidiary: 'au' })).resolves.toEqual({ valid: true, message: 'Signed in to OVHcloud as ab12345-ovh (AU, AUD).' });
      expect(ovh.state.calls).toEqual(['GET /me']);
      await expect(withOvh.validateCredentials('ovh', { ...FAKE_OVH_KEYS, subsidiary: 'FR' })).resolves.toMatchObject({ valid: false, message: expect.stringMatching(/belong to an OVHcloud AU account/) });
      await expect(withOvh.validateCredentials('ovh', { ...FAKE_OVH_KEYS, subsidiary: 'XX' })).resolves.toMatchObject({ valid: false, message: expect.stringMatching(/not an OVHcloud subsidiary/) });
      await expect(withOvh.validateCredentials('ovh', { applicationKey: 'AK-test', subsidiary: 'AU' })).resolves.toMatchObject({ valid: false });
      await expect(withOvh.validateCredentials('ovh', { ...FAKE_OVH_KEYS, applicationSecret: 'wrong', subsidiary: 'AU' })).resolves.toMatchObject({ valid: false, message: expect.stringMatching(/Invalid signature/) });
    });

    it('keeps the three keys sealed and the subsidiary plain', async () => {
      await service.saveCredentials('user-1', 'ovh', { ...FAKE_OVH_KEYS, subsidiary: 'AU' });
      const shown = await service.getCredentials('user-1', 'ovh');
      expect(shown?.subsidiary).toBe('AU');
      expect(shown?.applicationSecret).toContain('****');
      expect((await service.resolveCredentials('user-1', 'ovh')).env).toEqual({ OVH_APPLICATION_KEY: 'AK-test', OVH_APPLICATION_SECRET: 'AS-test', OVH_CONSUMER_KEY: 'CK-test', OVH_SUBSIDIARY: 'AU' });
    });
  });
});
