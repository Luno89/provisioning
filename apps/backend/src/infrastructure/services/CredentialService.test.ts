import { containing, matching } from '../../platform/lib/test-matchers.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { CredentialService, UnreadableCredential } from './CredentialService.js';
import { decryptValue } from '../../platform/lib/crypto.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { interceptHttp } from '../../platform/testing/http.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { UserMetadata } from '../../platform/lib/types.js';
import { FAKE_OVH_KEYS, fakeOvh } from './fake-ovh.js';
import { fakePorkbun } from './dns/fake-dns.js';

const TEST_KEY = 'test-master-key-for-credential-tests';

const server = interceptHttp();

describe('CredentialService', () => {
  let db: Database;
  let service: CredentialService;
  const testUser: UserMetadata = {
    id: 'user-1',
    email: 'test@example.com',
    twoFactorEnabled: false,
    emailVerified: true,
    createdAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    db = memoryDatabase();
    await db.accounts.saveUser({ ...testUser });
    service = new CredentialService(db, TEST_KEY);
  });

  describe('a secret saved under a key this Koala no longer holds', () => {
    it('is never shown masked, used as missing or taken from the environment: it says which one to enter again', async () => {
      await new CredentialService(db, 'a-key-since-rotated-away').saveCredentials('user-1', 'huggingface', { hfToken: 'hf_abcdefghijklmnopqrstuvwxyz' });
      const said = 'your huggingface hfToken was saved under a key this Koala no longer holds; enter it again under Cloud providers';
      await expect(service.getCredentials('user-1', 'huggingface')).rejects.toThrow(new UnreadableCredential('huggingface', 'hfToken'));
      await expect(service.resolveCredentials('user-1', 'huggingface')).rejects.toThrow(said);
      const listed = (await service.getConfiguredProviders('user-1')).find((status) => status.provider === 'huggingface');
      expect(listed).toEqual({ provider: 'huggingface', label: 'Hugging Face', configured: false, unreadable: said });
    });
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
});

describe('CredentialService.validateCredentials for each provider', () => {
  let service: CredentialService;
  beforeEach(() => { service = new CredentialService(memoryDatabase(), TEST_KEY); });
  const ok = (url: string, body: unknown, status = 200) => server.use(http.all(url, () => HttpResponse.json(body as never, { status })));
  const drive = { claims: { role: 'instance' as const }, credentials: { env: {}, ovhSubsidiary: { off: 'OVH_SUBSIDIARY is not set' }, googleDrive: { clientId: 'id', clientSecret: 'secret' } } };

  it('asks for the token a provider needs before it asks the provider anything', async () => {
    for (const [provider, wanted] of [['huggingface', /Hugging Face Access Token is required/], ['ovh', /OVHcloud needs the application key/], ['googledrive', /Not connected/]] as const) {
      const result = await service.validateCredentials(provider, {});
      expect(result.valid, provider).toBe(false);
      expect(result.message, provider).toMatch(wanted);
    }
  });

  it('names the Hugging Face account a token signs in as, and refuses one it rejects', async () => {
    ok('https://huggingface.co/api/whoami-v2', { name: 'koala' });
    expect(await service.validateCredentials('huggingface', { hfToken: 'hf' })).toMatchObject({ valid: true, message: 'Authenticated as Hugging Face user @koala' });
    server.use(http.get('https://huggingface.co/api/whoami-v2', () => new HttpResponse(null, { status: 401 })));
    expect(await service.validateCredentials('huggingface', { hfToken: 'bad' })).toEqual({ valid: false, message: 'Invalid token or unauthorized (HTTP 401).' });
  });

  it('checks a Google Drive refresh token against Google', async () => {
    const withDrive = new CredentialService(memoryDatabase(), TEST_KEY, drive);
    server.use(
      http.post('https://oauth2.googleapis.com/token', () => HttpResponse.json({ access_token: 'a1' })),
      http.get('https://www.googleapis.com/drive/v3/about', () => HttpResponse.json({ user: { emailAddress: 'me@example.com' } })),
    );
    expect(await withDrive.validateCredentials('googledrive', { refreshToken: 'r' })).toMatchObject({ valid: true, message: 'Connected to Google Drive as me@example.com' });
    server.use(http.get('https://www.googleapis.com/drive/v3/about', () => new HttpResponse(null, { status: 403 })));
    expect((await withDrive.validateCredentials('googledrive', { refreshToken: 'r' })).message).toBe('Drive API check failed (HTTP 403).');
    server.use(http.post('https://oauth2.googleapis.com/token', () => new HttpResponse(null, { status: 400 })));
    expect((await withDrive.validateCredentials('googledrive', { refreshToken: 'r' })).message).toMatch(/no longer valid \(HTTP 400\)/);
    expect((await service.validateCredentials('googledrive', { refreshToken: 'r' })).message).toBe('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set on the server.');
  });

  it('tests Google Drive with the refresh token stored for the person', async () => {
    const db = memoryDatabase();
    await db.accounts.saveUser({ id: 'user-1', email: 'a@b.c', twoFactorEnabled: false, emailVerified: true, createdAt: 'x' });
    const stored = new CredentialService(db, TEST_KEY, drive);
    expect((await stored.testGoogleDriveConnection('user-1')).message).toMatch(/Not connected/);
    await stored.saveCredentials('user-1', 'googledrive', { refreshToken: 'r-stored', email: 'me@example.com' });
    server.use(
      http.post('https://oauth2.googleapis.com/token', async ({ request }) => ((await request.text()).includes('refresh_token=r-stored') ? HttpResponse.json({ access_token: 'a1' }) : new HttpResponse(null, { status: 400 }))),
      http.get('https://www.googleapis.com/drive/v3/about', () => HttpResponse.json({ user: { emailAddress: 'me@example.com' } })),
    );
    expect(await stored.testGoogleDriveConnection('user-1')).toMatchObject({ valid: true });
  });

  it('accepts a provider it has no check for, and fails a check the network stopped with why, never calling the credentials wrong', async () => {
    expect(await service.validateCredentials('artificialanalysis', { apiKey: 'k' })).toEqual({ valid: true, message: 'Credentials formatted.' });
    server.use(http.get('https://huggingface.co/api/whoami-v2', () => HttpResponse.error()));
    await expect(service.validateCredentials('huggingface', { hfToken: 't' })).rejects.toMatchObject({ status: 502, message: matching(/^Hugging Face could not check these credentials just now: /) });
  });
});
