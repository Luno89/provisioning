import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CredentialService } from './CredentialService.js';
import { encryptValue, decryptValue } from '../lib/crypto.js';
import type { UserMetadata } from '../lib/types.js';

// Mock LocalDB
function createMockDB() {
  let users: UserMetadata[] = [];

  return {
    async getUserById(id: string) {
      return users.find((u) => u.id === id);
    },
    async saveUser(user: UserMetadata) {
      const idx = users.findIndex((u) => u.id === user.id);
      if (idx >= 0) users[idx] = user;
      else users.push(user);
    },
    _addUser(user: UserMetadata) {
      users.push(user);
    },
    _getUsers() {
      return users;
    },
  };
}

const TEST_KEY = 'test-master-key-for-credential-tests';

describe('CredentialService', () => {
  let db: ReturnType<typeof createMockDB>;
  let service: CredentialService;
  const testUser: UserMetadata = {
    id: 'user-1',
    email: 'test@example.com',
    twoFactorEnabled: false,
    emailVerified: true,
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    db = createMockDB();
    db._addUser({ ...testUser });
    service = new CredentialService(db as any, TEST_KEY);
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

      const user = db._getUsers().find((u) => u.id === 'user-1');
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
      expect(statuses).toHaveLength(4);

      const aws = statuses.find((s) => s.provider === 'aws');
      expect(aws?.configured).toBe(true);
      expect(aws?.source).toBe('user');

      const gcp = statuses.find((s) => s.provider === 'gcp');
      expect(gcp?.configured).toBe(false);
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
