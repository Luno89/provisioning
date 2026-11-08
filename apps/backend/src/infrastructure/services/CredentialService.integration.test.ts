import { containing, matching } from '../../platform/lib/test-matchers.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { CredentialService } from './CredentialService.js';
import { decryptValue } from '../../platform/lib/crypto.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { FAKE_OVH_KEYS, fakeOvh } from './fake-ovh.js';
import { fakePorkbun } from './dns/fake-dns.js';

const fresh = await emptiedEachTime();

const TEST_KEY = 'test-master-key-for-credential-tests';

const server = interceptHttp();

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
    db = await fresh();
    await db.accounts.saveUser({ ...testUser });
    service = new CredentialService(db, TEST_KEY);
  });

  describe('saveCredentials + getCredentials', () => {
    it('saves Hugging Face credentials and returns them masked, the plain fields as they are', async () => {
      await service.saveCredentials('user-1', 'huggingface', {
        hfToken: 'hf_abcdefghijklmnopqrstuvwxyz0123',
        defaultModel: 'meta-llama/Llama-3.2-3B-Instruct',
      });

      const result = await service.getCredentials('user-1', 'huggingface');
      expect(result).not.toBeNull();
      expect(result!.defaultModel).toBe('meta-llama/Llama-3.2-3B-Instruct');
      expect(result!.hfToken).toContain('****');
    });

    it('encrypts sensitive fields at rest', async () => {
      await service.saveCredentials('user-1', 'huggingface', {
        hfToken: 'hf_secret_token_12345',
      });

      const user = (await db.accounts.getUsers()).find((u) => u.id === 'user-1');
      expect(user?.credentials?.huggingface?.hfToken).toBeDefined();
      expect(user?.credentials?.huggingface?.hfToken).not.toBe('hf_secret_token_12345');
      const decrypted = decryptValue(user!.credentials!.huggingface!.hfToken, TEST_KEY);
      expect(decrypted).toBe('hf_secret_token_12345');
    });
  });

  describe('deleteCredentials', () => {
    it('removes provider credentials', async () => {
      await service.saveCredentials('user-1', 'huggingface', {
        hfToken: 'hf_example',
        defaultModel: 'meta-llama/Llama-3.2-3B-Instruct',
      });

      await service.deleteCredentials('user-1', 'huggingface');
      const result = await service.getCredentials('user-1', 'huggingface');
      expect(result).toBeNull();
    });
  });

  describe('getConfiguredProviders', () => {
    it('lists all providers with their status', async () => {
      await service.saveCredentials('user-1', 'huggingface', {
        hfToken: 'hf_example_token',
      });

      const statuses = await service.getConfiguredProviders('user-1');
      expect(statuses.map((s) => s.provider).sort()).toEqual(
        ['huggingface', 'ovh', 'cloudflare', 'porkbun', 'artificialanalysis'].sort(),
      );

      const huggingface = statuses.find((s) => s.provider === 'huggingface');
      expect(huggingface?.configured).toBe(true);
      expect(huggingface?.source).toBe('user');
      expect(huggingface).not.toHaveProperty('clusters');

      const ovh = statuses.find((s) => s.provider === 'ovh');
      expect(ovh?.configured).toBe(false);
    });
  });

  describe('a DNS provider, from the registry', () => {
    it('stores Porkbun\'s keys sealed, validates them with Porkbun, and hands them back as fields and env', async () => {
      const porkbun = fakePorkbun(['koala.test']);
      const dnsService = new CredentialService(db, TEST_KEY, undefined, porkbun.fetch);
      expect(await dnsService.validateCredentials('porkbun', porkbun.good)).toMatchObject({ valid: true, message: containing('API Access') });
      expect(await dnsService.validateCredentials('porkbun', porkbun.bad)).toMatchObject({ valid: false, message: containing('Invalid API key') });
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
      await service.saveCredentials('user-1', 'huggingface', {
        hfToken: 'hf_user_token',
      });

      const resolved = await service.resolveCredentials('user-1', 'huggingface');
      expect(resolved.mode).toBe('user');
      expect(resolved.env.HF_TOKEN).toBe('hf_user_token');
    });

    it('says there are none when no credentials exist', async () => {
      const resolved = await service.resolveCredentials('user-1', 'huggingface');
      expect(resolved.mode).toBe('none');
      expect(resolved.env).toEqual({});
    });
  });

  describe('error handling', () => {
    it('throws when user is not found', async () => {
      await expect(
        service.saveCredentials('nonexistent', 'huggingface', { hfToken: 'test' }),
      ).rejects.toThrow('User not found');
    });

    it('returns null for unconfigured provider', async () => {
      const result = await service.getCredentials('user-1', 'ovh');
      expect(result).toBeNull();
    });
  });

  describe('OVHcloud keys', () => {
    it('signs in with them, names the account, and refuses keys of another subsidiary or missing parts', async () => {
      const ovh = fakeOvh();
      const withOvh = new CredentialService(db, TEST_KEY, undefined, ovh.fetch);
      await expect(withOvh.validateCredentials('ovh', { ...FAKE_OVH_KEYS, subsidiary: 'au' })).resolves.toEqual({ valid: true, message: 'Signed in to OVHcloud as ab12345-ovh (AU, AUD).' });
      expect(ovh.state.calls).toEqual(['GET /me']);
      await expect(withOvh.validateCredentials('ovh', { ...FAKE_OVH_KEYS, subsidiary: 'FR' })).resolves.toMatchObject({ valid: false, message: matching(/belong to an OVHcloud AU account/) });
      await expect(withOvh.validateCredentials('ovh', { ...FAKE_OVH_KEYS, subsidiary: 'XX' })).resolves.toMatchObject({ valid: false, message: matching(/not an OVHcloud subsidiary/) });
      await expect(withOvh.validateCredentials('ovh', { applicationKey: 'AK-test', subsidiary: 'AU' })).resolves.toMatchObject({ valid: false });
      await expect(withOvh.validateCredentials('ovh', { ...FAKE_OVH_KEYS, applicationSecret: 'wrong', subsidiary: 'AU' })).resolves.toMatchObject({ valid: false, message: matching(/Invalid signature/) });
    });

    it('keeps the three keys sealed and the subsidiary plain', async () => {
      await service.saveCredentials('user-1', 'ovh', { ...FAKE_OVH_KEYS, subsidiary: 'AU' });
      const shown = await service.getCredentials('user-1', 'ovh');
      expect(shown?.subsidiary).toBe('AU');
      expect(shown?.applicationSecret).toContain('****');
      expect((await service.resolveCredentials('user-1', 'ovh')).env).toEqual({ OVH_APPLICATION_KEY: 'AK-test', OVH_APPLICATION_SECRET: 'AS-test', OVH_CONSUMER_KEY: 'CK-test', OVH_SUBSIDIARY: 'AU' });
    });
  });
  describe('Google Drive', () => {
    it('tests the refresh token stored for the person against Google', async () => {
      const withDrive = new CredentialService(db, TEST_KEY, { claims: { role: 'instance' }, credentials: { env: {}, ovhSubsidiary: { off: 'OVH_SUBSIDIARY is not set' }, googleDrive: { clientId: 'id', clientSecret: 'secret' } } });
      expect((await withDrive.testGoogleDriveConnection('user-1')).message).toMatch(/Not connected/);
      await withDrive.saveCredentials('user-1', 'googledrive', { refreshToken: 'r-stored', email: 'me@example.com' });
      server.use(
        http.post('https://oauth2.googleapis.com/token', async ({ request }) => ((await request.text()).includes('refresh_token=r-stored') ? HttpResponse.json({ access_token: 'a1' }) : new HttpResponse(null, { status: 400 }))),
        http.get('https://www.googleapis.com/drive/v3/about', () => HttpResponse.json({ user: { emailAddress: 'me@example.com' } })),
      );
      expect(await withDrive.testGoogleDriveConnection('user-1')).toMatchObject({ valid: true, message: 'Connected to Google Drive as me@example.com' });
    });
  });
});
