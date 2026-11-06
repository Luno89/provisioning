import { containing, matching } from '../../platform/lib/test-matchers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      server.use(http.get('https://api.hetzner.cloud/v1/servers', () => HttpResponse.json({ error: { code: 'unauthorized' } }, { status: 401 })));
      const result = await service.validateCredentials('hetzner', { token: 'bad' });
      expect(result.valid).toBe(false);
      expect(result.message).toContain('401');
    });

    it('reports a working token as valid and surfaces the server count', async () => {
      server.use(http.get('https://api.hetzner.cloud/v1/servers', ({ request }) => (request.headers.get('authorization') === 'Bearer good' ? HttpResponse.json({ servers: [], meta: { pagination: { total_entries: 3 } } }) : new HttpResponse(null, { status: 401 }))));
      const result = await service.validateCredentials('hetzner', { token: 'good' });
      expect(result.valid).toBe(true);
      expect(result.message).toContain('3 existing servers');
    });

    it('says the Hetzner API failed rather than the token being wrong when it answers an error', async () => {
      server.use(http.get('https://api.hetzner.cloud/v1/servers', () => new HttpResponse(null, { status: 503 })));
      expect(await service.validateCredentials('hetzner', { token: 'good' })).toEqual({ valid: false, message: 'Hetzner Cloud API returned HTTP 503.' });
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
  const googleKeys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;
  const savedGoogle = Object.fromEntries(googleKeys.map((key) => [key, process.env[key]]));
  afterEach(() => { for (const key of googleKeys) { if (savedGoogle[key] === undefined) delete process.env[key]; else process.env[key] = savedGoogle[key]; } });

  it('asks for the token a provider needs before it asks the provider anything', async () => {
    for (const [provider, wanted] of [['huggingface', /Hugging Face Access Token is required/], ['github', /GitHub Personal Access Token is required/], ['do', /DigitalOcean API Token is required/], ['vultr', /Vultr Personal Access Token is required/], ['linode', /Linode Personal Access Token is required/], ['scaleway', /Scaleway Secret Key is required/], ['hostinger', /Hostinger API token is required/], ['contabo', /Contabo needs Client ID/], ['googledrive', /Not connected/]] as const) {
      const result = await service.validateCredentials(provider, {});
      expect(result.valid, provider).toBe(false);
      expect(result.message, provider).toMatch(wanted);
    }
  });

  it('names the Hugging Face and GitHub accounts a token signs in as, and refuses one they reject', async () => {
    ok('https://huggingface.co/api/whoami-v2', { name: 'koala' });
    ok('https://api.github.com/user', { login: 'octo' });
    expect(await service.validateCredentials('huggingface', { hfToken: 'hf' })).toMatchObject({ valid: true, message: 'Authenticated as Hugging Face user @koala' });
    expect(await service.validateCredentials('github', { token: 'gh' })).toMatchObject({ valid: true, message: 'Authenticated as GitHub user @octo' });
    server.use(http.get('https://api.github.com/user', () => new HttpResponse(null, { status: 401 })));
    expect(await service.validateCredentials('github', { token: 'bad' })).toEqual({ valid: false, message: 'Invalid token or unauthorized (HTTP 401).' });
  });

  it('checks the shape of AWS, GCP and Azure keys without calling them', async () => {
    expect((await service.validateCredentials('aws', { accessKeyId: 'AKIAX', secretAccessKey: 's' })).valid).toBe(true);
    expect((await service.validateCredentials('aws', { accessKeyId: 'nope', secretAccessKey: 's' })).message).toBe('AWS Access Key ID format appears invalid.');
    expect((await service.validateCredentials('aws', {})).message).toMatch(/required/);
    expect((await service.validateCredentials('gcp', { serviceAccountJson: JSON.stringify({ type: 'service_account', project_id: 'p1' }) })).message).toBe('Validated GCP Service Account for project "p1"');
    expect((await service.validateCredentials('gcp', { serviceAccountJson: '{}' })).message).toBe('Invalid GCP Service Account JSON structure.');
    expect((await service.validateCredentials('gcp', { serviceAccountJson: 'nope' })).message).toBe('Service Account JSON is not valid JSON.');
    expect((await service.validateCredentials('gcp', {})).message).toMatch(/required/);
    expect((await service.validateCredentials('azure', { clientId: 'c', clientSecret: 's' })).valid).toBe(true);
    expect((await service.validateCredentials('azure', {})).valid).toBe(false);
  });

  it('names the account a DigitalOcean, Vultr or Linode token belongs to', async () => {
    ok('https://api.digitalocean.com/v2/account', { account: { email: 'do@example.com' } });
    ok('https://api.vultr.com/v2/account', { account: { email: 'vultr@example.com' } });
    ok('https://api.linode.com/v4/account', { email: 'linode@example.com' });
    expect((await service.validateCredentials('do', { token: 't' })).message).toBe('Authenticated as DigitalOcean account (do@example.com)');
    expect((await service.validateCredentials('vultr', { token: 't' })).message).toBe('Authenticated as Vultr account (vultr@example.com).');
    expect((await service.validateCredentials('linode', { token: 't' })).message).toBe('Authenticated as Linode account (linode@example.com).');
    server.use(http.get('https://api.digitalocean.com/v2/account', () => new HttpResponse(null, { status: 401 })));
    expect((await service.validateCredentials('do', { token: 't' })).valid).toBe(false);
  });

  it('counts Scaleway\'s projects and checks Hostinger and Contabo against their APIs', async () => {
    ok('https://api.scaleway.com/account/v3/projects', { projects: [{}, {}] });
    ok('https://developers.hostinger.com/api/vps/v1/data-centers', []);
    ok('https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token', { access_token: 'x' });
    expect((await service.validateCredentials('scaleway', { secretKey: 'k' })).message).toBe('Authenticated against Scaleway (2 projects).');
    expect((await service.validateCredentials('hostinger', { token: 't' })).message).toBe('Authenticated against the Hostinger API.');
    expect((await service.validateCredentials('contabo', { clientId: 'a', clientSecret: 'b', apiUser: 'c', apiPassword: 'd' })).message).toMatch(/Authenticated against Contabo/);
    server.use(http.post('https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token', () => HttpResponse.json({})));
    expect((await service.validateCredentials('contabo', { clientId: 'a', clientSecret: 'b', apiUser: 'c', apiPassword: 'd' })).message).toBe('Contabo returned no access token.');
    server.use(http.post('https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token', () => new HttpResponse(null, { status: 401 })));
    expect((await service.validateCredentials('contabo', { clientId: 'a', clientSecret: 'b', apiUser: 'c', apiPassword: 'd' })).message).toBe('Contabo rejected these credentials (HTTP 401).');
  });

  it('checks a Google Drive refresh token against Google', async () => {
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    server.use(
      http.post('https://oauth2.googleapis.com/token', () => HttpResponse.json({ access_token: 'a1' })),
      http.get('https://www.googleapis.com/drive/v3/about', () => HttpResponse.json({ user: { emailAddress: 'me@example.com' } })),
    );
    expect(await service.validateCredentials('googledrive', { refreshToken: 'r' })).toMatchObject({ valid: true, message: 'Connected to Google Drive as me@example.com' });
    server.use(http.get('https://www.googleapis.com/drive/v3/about', () => new HttpResponse(null, { status: 403 })));
    expect((await service.validateCredentials('googledrive', { refreshToken: 'r' })).message).toBe('Drive API check failed (HTTP 403).');
    server.use(http.post('https://oauth2.googleapis.com/token', () => new HttpResponse(null, { status: 400 })));
    expect((await service.validateCredentials('googledrive', { refreshToken: 'r' })).message).toMatch(/no longer valid \(HTTP 400\)/);
    delete process.env.GOOGLE_CLIENT_ID;
    expect((await service.validateCredentials('googledrive', { refreshToken: 'r' })).message).toBe('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set on the server.');
  });

  it('tests Google Drive with the refresh token stored for the person', async () => {
    const db = memoryDatabase();
    await db.accounts.saveUser({ id: 'user-1', email: 'a@b.c', twoFactorEnabled: false, emailVerified: true, createdAt: 'x' });
    const stored = new CredentialService(db, TEST_KEY);
    expect((await stored.testGoogleDriveConnection('user-1')).message).toMatch(/Not connected/);
    await stored.saveCredentials('user-1', 'googledrive', { refreshToken: 'r-stored', email: 'me@example.com' });
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    server.use(
      http.post('https://oauth2.googleapis.com/token', async ({ request }) => ((await request.text()).includes('refresh_token=r-stored') ? HttpResponse.json({ access_token: 'a1' }) : new HttpResponse(null, { status: 400 }))),
      http.get('https://www.googleapis.com/drive/v3/about', () => HttpResponse.json({ user: { emailAddress: 'me@example.com' } })),
    );
    expect(await stored.testGoogleDriveConnection('user-1')).toMatchObject({ valid: true });
  });

  it('accepts a provider it has no check for, and says a network failure is one', async () => {
    expect(await service.validateCredentials('artificialanalysis', { apiKey: 'k' })).toEqual({ valid: true, message: 'Credentials formatted.' });
    server.use(http.get('https://api.github.com/user', () => HttpResponse.error()));
    expect((await service.validateCredentials('github', { token: 't' })).message).toMatch(/^Validation failed: /);
  });
});
