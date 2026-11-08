import { afterEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mock } from 'vitest-mock-extended';
import { CLOUD_PROVIDERS } from '../../platform/lib/types.js';
import { interceptHttp } from '../../platform/testing/http.js';
import type { CredentialService } from '../services/CredentialService.js';
import { credentialsRouter } from './credentials.js';
import type { HarnessUser } from '../../platform/routes/test-harness.js';
import { PERSON, routesInProcess, type RouteAnswer } from '../../platform/testing/routes.js';

type Service = Pick<CredentialService, 'getConfiguredProviders' | 'getCredentials' | 'saveCredentials' | 'deleteCredentials' | 'validateCredentials' | 'testGoogleDriveConnection'>;

const server = interceptHttp();

const service = (): ReturnType<typeof mock<Service>> => {
  const credentialService = mock<Service>();
  credentialService.getConfiguredProviders.mockResolvedValue([{ provider: 'ovh', configured: true }] as never);
  credentialService.getCredentials.mockResolvedValue({ applicationKey: 'APPK••••' } as never);
  credentialService.validateCredentials.mockResolvedValue({ valid: true } as never);
  credentialService.testGoogleDriveConnection.mockResolvedValue({ valid: true, message: 'ok' } as never);
  return credentialService;
};

const DRIVE_OFF = { off: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, so backups to Google Drive are off' };
const DRIVE = { clientId: 'drive-client', clientSecret: 'drive-secret' };
let drive: { clientId: string; clientSecret: string } | { off: string } = DRIVE_OFF;

const call = (credentialService: Service, path: string, init: { method?: 'GET' | 'PUT' | 'POST' | 'DELETE'; body?: unknown; user?: HarnessUser; headers?: Record<string, string> } = {}): Promise<RouteAnswer> =>
  routesInProcess({ prefix: '/api/credentials', router: () => credentialsRouter({ credentialService, publicUrl: 'https://api.example.com', appUrl: 'https://app.example.com', sessionKey: 'test-session-key', googleDrive: drive }), user: PERSON })
    .then((routes) => routes.request(init.method ?? 'GET', `/api/credentials${path}`, { ...(init.body !== undefined ? { body: init.body } : {}), ...(init.user ? { user: init.user } : {}), ...(init.headers ? { headers: init.headers } : {}) }));

afterEach(() => {
  drive = DRIVE_OFF;
});

describe('listing configured providers', () => {
  it('returns them under `providers`, which is the shape the UI reads', async () => {
    const credentialService = service();
    const answer = await call(credentialService, '');
    expect(answer.data).toEqual({ providers: [{ provider: 'ovh', configured: true }] });
    expect(credentialService.getConfiguredProviders).toHaveBeenCalledWith(PERSON.id);
  });

  it('answers 500 with the reason when the service fails', async () => {
    const credentialService = service();
    credentialService.getConfiguredProviders.mockRejectedValue(new Error('vault unreachable'));
    const answer = await call(credentialService, '');
    expect(answer.status).toBe(500);
    expect(answer.data).toEqual({ error: 'vault unreachable' });
  });
});

describe('provider validation', () => {
  it.each([
    ['GET /:provider', '/not-a-cloud', 'GET'],
    ['PUT /:provider', '/not-a-cloud', 'PUT'],
    ['DELETE /:provider', '/not-a-cloud', 'DELETE'],
    ['POST /validate/:provider', '/validate/not-a-cloud', 'POST'],
  ] as const)('rejects an unknown provider on %s', async (_label, path, method) => {
    const answer = await call(service(), path, { method, body: {} });
    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ error: 'Invalid provider: not-a-cloud' });
  });

  it.each(['aws', 'gcp', 'azure', 'do', 'hetzner', 'vultr'])('refuses %s, whose keys Koala no longer keeps', async (provider) => {
    const answer = await call(service(), `/${provider}`);
    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ error: `Invalid provider: ${provider}` });
  });

  it('accepts every provider the platform actually supports', async () => {
    for (const provider of CLOUD_PROVIDERS) {
      const answer = await call(service(), `/${provider}`);
      expect(answer.status, provider).toBe(200);
      expect((answer.data as { provider: string }).provider, provider).toBe(provider);
    }
  });
});

describe('reading and writing one provider', () => {
  it('saves, then reads back rather than echoing the request', async () => {
    const credentialService = service();
    const answer = await call(credentialService, '/ovh', { method: 'PUT', body: { applicationKey: 'APPKREAL', secret: 's' } });
    expect(credentialService.saveCredentials).toHaveBeenCalledWith(PERSON.id, 'ovh', { applicationKey: 'APPKREAL', secret: 's' });
    expect((answer.data as { credentials: unknown }).credentials).toEqual({ applicationKey: 'APPK••••' });
    expect(JSON.stringify(answer.data)).not.toContain('APPKREAL');
  });

  it('refuses values that are not text', async () => {
    const credentialService = service();
    const answer = await call(credentialService, '/ovh', { method: 'PUT', body: { applicationKey: 5 } });
    expect(answer.status).toBe(400);
    expect(credentialService.saveCredentials).not.toHaveBeenCalled();
  });

  it('deletes for the calling user only', async () => {
    const credentialService = service();
    const answer = await call(credentialService, '/github', { method: 'DELETE' });
    expect(answer.data).toEqual({ success: true, provider: 'github' });
    expect(credentialService.deleteCredentials).toHaveBeenCalledWith(PERSON.id, 'github');
  });

  it('never lets one tenant read another', async () => {
    const credentialService = service();
    await call(credentialService, '/ovh', { user: { id: 'someone-else', email: 'other@example.com' } });
    expect(credentialService.getCredentials).toHaveBeenCalledWith('someone-else', 'ovh');
  });
});

describe('validating credentials', () => {
  it('checks the STORED token for googledrive, not the request body', async () => {
    const credentialService = service();
    await call(credentialService, '/validate/googledrive', { method: 'POST', body: {} });
    expect(credentialService.testGoogleDriveConnection).toHaveBeenCalledWith(PERSON.id);
    expect(credentialService.validateCredentials).not.toHaveBeenCalled();
  });

  it('checks the submitted values for every other provider', async () => {
    const credentialService = service();
    await call(credentialService, '/validate/ovh', { method: 'POST', body: { applicationKey: 'k' } });
    expect(credentialService.validateCredentials).toHaveBeenCalledWith('ovh', { applicationKey: 'k' });
    expect(credentialService.testGoogleDriveConnection).not.toHaveBeenCalled();
  });

  it('refuses submitted values that are not text', async () => {
    const answer = await call(service(), '/validate/ovh', { method: 'POST', body: { applicationKey: {} } });
    expect(answer.status).toBe(400);
  });
});

describe('connecting Google Drive', () => {
  const connect = async (credentialService: Service, user?: HarnessUser) => {
    const started = await call(credentialService, '/googledrive/connect', user ? { user } : {});
    const state = new URL(String(started.headers.location)).searchParams.get('state');
    const cookie = String(started.headers['set-cookie']).split(';')[0] ?? '';
    return { started, state, cookie };
  };

  it('sends the person back to Settings saying the client id is missing when none is configured', async () => {
    drive = DRIVE_OFF;
    const answer = await call(service(), '/googledrive/connect');
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('https://app.example.com/?driveError=missing_client_id#/settings');
  });

  it('is not mistaken for a provider id, and sends the person to Google with a state kept in a cookie', async () => {
    drive = DRIVE;
    const { started, state } = await connect(service());
    expect(started.status).toBe(302);
    expect(String(started.headers.location)).toContain('https://accounts.google.com/o/oauth2/v2/auth?client_id=drive-client');
    expect(state).toMatch(/^[\w-]{32}$/);
    expect(String(started.headers['set-cookie'])).toContain('oauth_state=');
  });

  it('connects Google Drive only to the person who started connecting it', async () => {
    drive = DRIVE;
    const credentialService = service();
    const { state, cookie } = await connect(credentialService);
    const forged = await call(credentialService, `/googledrive/callback?code=theirs&state=${state}`, { user: { id: 'someone-else', email: 'o@example.com' }, headers: { cookie } });
    expect(forged.headers.location).toBe('https://app.example.com/?driveError=not_started_here#/settings');
    const stranger = await call(credentialService, `/googledrive/callback?code=theirs&state=${state}`);
    expect(stranger.headers.location).toBe('https://app.example.com/?driveError=not_started_here#/settings');
    expect(credentialService.saveCredentials).toHaveBeenCalledTimes(0);
  });

  it('trades the code for a refresh token and keeps it with the account\'s address', async () => {
    drive = DRIVE;
    server.use(
      http.post('https://oauth2.googleapis.com/token', () => HttpResponse.json({ refresh_token: 'refresh-1', access_token: 'access-1' })),
      http.get('https://www.googleapis.com/drive/v3/about', ({ request }) => (request.headers.get('authorization') === 'Bearer access-1' ? HttpResponse.json({ user: { emailAddress: 'me@example.com' } }) : new HttpResponse(null, { status: 401 }))),
    );
    const credentialService = service();
    const { state, cookie } = await connect(credentialService);
    const done = await call(credentialService, `/googledrive/callback?code=good&state=${state}`, { headers: { cookie } });
    expect(done.headers.location).toBe('https://app.example.com/?driveConnected=1#/settings');
    expect(credentialService.saveCredentials).toHaveBeenCalledWith(PERSON.id, 'googledrive', { refreshToken: 'refresh-1', email: 'me@example.com' });
  });

  it('says so when Google gave no refresh token or the client is not configured', async () => {
    drive = DRIVE;
    server.use(http.post('https://oauth2.googleapis.com/token', () => HttpResponse.json({ access_token: 'access-1' })));
    const credentialService = service();
    const first = await connect(credentialService);
    const noToken = await call(credentialService, `/googledrive/callback?code=good&state=${first.state}`, { headers: { cookie: first.cookie } });
    expect(noToken.headers.location).toBe('https://app.example.com/?driveError=no_refresh_token#/settings');
    const second = await connect(credentialService);
    drive = DRIVE_OFF;
    const noSecret = await call(credentialService, `/googledrive/callback?code=good&state=${second.state}`, { headers: { cookie: second.cookie } });
    expect(noSecret.headers.location).toBe('https://app.example.com/?driveError=missing_client_id#/settings');
    expect(credentialService.saveCredentials).not.toHaveBeenCalled();
  });

  it('sends the person back to Settings with the reason when Google refuses the code', async () => {
    drive = DRIVE;
    server.use(http.post('https://oauth2.googleapis.com/token', () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 })));
    const credentialService = service();
    const { state, cookie } = await connect(credentialService);
    const refused = await call(credentialService, `/googledrive/callback?code=bad&state=${state}`, { headers: { cookie } });
    expect(String(refused.headers.location)).toMatch(/^https:\/\/app\.example\.com\/\?driveError=.+#\/settings$/);
    expect(credentialService.saveCredentials).not.toHaveBeenCalled();
  });
});
