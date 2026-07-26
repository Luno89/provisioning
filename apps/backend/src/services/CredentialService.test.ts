import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CredentialService } from './CredentialService.js';
import { encryptValue, decryptValue } from '../lib/crypto.js';
import { MemoryDB } from '../lib/memory-db.js';
import type { UserMetadata } from '../lib/types.js';

const TEST_KEY = 'test-master-key-for-credential-tests';

describe('CredentialService', () => {
  let db: MemoryDB;
  let service: CredentialService;
  const testUser: UserMetadata = {
    id: 'user-1',
    email: 'test@example.com',
    twoFactorEnabled: false,
    emailVerified: true,
    createdAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    db = new MemoryDB();
    await db.init();
    await db.saveUser({ ...testUser });
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
      expect(result!.region).toBe('us-east-1'); // plaintext field
      expect(result!.accessKeyId).toContain('****'); // masked
      expect(result!.secretAccessKey).toContain('****'); // masked
    });

    it('encrypts sensitive fields at rest', async () => {
      await service.saveCredentials('user-1', 'do', {
        token: 'dop_v1_secret_token_12345',
      });

      const user = (await db.getUsers()).find((u) => u.id === 'user-1');
      expect(user?.credentials?.do?.token).toBeDefined();
      // The stored value should NOT be the plaintext
      expect(user?.credentials?.do?.token).not.toBe('dop_v1_secret_token_12345');
      // But it should decrypt back to the original
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
      // Assert the actual set rather than a count — a bare length check says nothing about which
      // provider went missing when it fails, and silently needs editing every time one is added.
      expect(statuses.map((s) => s.provider).sort()).toEqual(
        ['aws', 'azure', 'do', 'gcp', 'github', 'hetzner', 'huggingface'].sort(),
      );

      const aws = statuses.find((s) => s.provider === 'aws');
      expect(aws?.configured).toBe(true);
      expect(aws?.source).toBe('user');

      const gcp = statuses.find((s) => s.provider === 'gcp');
      expect(gcp?.configured).toBe(false);
    });
  });

  // Hetzner is the first provider that actually creates real, billable infrastructure (see the
  // distributed-systems plan's Phase 3), so its credential path gets explicit coverage rather
  // than being assumed to work because the shape matches DigitalOcean's.
  describe('hetzner', () => {
    it('encrypts the token at rest and masks it on read', async () => {
      await service.saveCredentials('user-1', 'hetzner', { token: 'hetzner-secret-token-value' });

      const stored = (await db.getUserById('user-1'))!.credentials!.hetzner!.token;
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
});
