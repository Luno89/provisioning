import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { checkMoveToken, generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { HUB_AUDIENCE } from '../lib/hub.js';
import type { HubService } from './HubService.js';
import { hubPersonPart, localHubPeople, RemoteHubPeople } from './HubPeople.js';

const signing = identityKeysFrom(generateIdentityKey());
const trusted = trustedKeys([publicKeyPem(signing.publicKey)]);
const HUB = 'https://hub.test';
const asked: { method: string; path: string; token: string }[] = [];
const server = interceptHttp();

const record = (request: Request) => {
  asked.push({ method: request.method, path: new URL(request.url).pathname, token: (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') });
};

describe('a person\'s part of the hub, read in the same process', () => {
  it('says what stops the person from going, and lets them go', async () => {
    const hub = mock<HubService>();
    hub.leaving.calledWith('ann').mockResolvedValue({ blockers: ['only owner of Shop'], deletes: [], leaves: [] });
    const people = localHubPeople(hub);
    expect(await people.blockers('ann')).toEqual(['only owner of Shop']);
    hub.letGo.mockResolvedValue({ deleted: [], left: [] });
    await people.letGo('ann');
    expect(hub.letGo).toHaveBeenCalledWith('ann');
  });
});

describe('a person\'s part of the hub, read through root\'s signed requests', () => {
  it('names the step in the signed part, per person', () => {
    expect(hubPersonPart('ann/x', 'leaving')).toBe('people/ann%2Fx/leaving');
    expect(hubPersonPart('ann', 'let-go')).not.toBe(hubPersonPart('ann', 'leaving'));
  });

  it('asks what a person is on with a token for that person and step, and reads their blockers', async () => {
    server.use(http.get(`${HUB}/api/hub-root/people/ann`, ({ request }) => { record(request); return HttpResponse.json({ blockers: ['a', 7] }); }));
    asked.length = 0;
    expect(await new RemoteHubPeople({ url: HUB, signing }).blockers('ann')).toEqual(['a', '7']);
    expect(asked[0]).toMatchObject({ method: 'GET', path: '/api/hub-root/people/ann' });
    expect(checkMoveToken(asked[0]!.token, trusted, HUB_AUDIENCE, hubPersonPart('ann', 'leaving'))).toMatchObject({ ok: true });
    expect(checkMoveToken(asked[0]!.token, trusted, HUB_AUDIENCE, hubPersonPart('ann', 'let-go'))).toMatchObject({ ok: false });
  });

  it('reads no blockers from an answer that names none', async () => {
    server.use(http.get(`${HUB}/api/hub-root/people/ann`, () => HttpResponse.json({})));
    expect(await new RemoteHubPeople({ url: HUB, signing }).blockers('ann')).toEqual([]);
  });

  it('lets a person go with a token for that step only', async () => {
    server.use(http.delete(`${HUB}/api/hub-root/people/ann`, ({ request }) => { record(request); return HttpResponse.json({ deleted: [], left: [] }); }));
    asked.length = 0;
    await new RemoteHubPeople({ url: HUB, signing }).letGo('ann');
    expect(asked[0]).toMatchObject({ method: 'DELETE', path: '/api/hub-root/people/ann' });
    expect(checkMoveToken(asked[0]!.token, trusted, HUB_AUDIENCE, hubPersonPart('ann', 'let-go'))).toMatchObject({ ok: true });
  });

  it('says what the hub refused and why', async () => {
    server.use(
      http.get(`${HUB}/api/hub-root/people/ann`, () => HttpResponse.json({ error: 'only root asks' }, { status: 401 })),
      http.delete(`${HUB}/api/hub-root/people/ann`, () => new HttpResponse('x', { status: 409 })),
    );
    const people = new RemoteHubPeople({ url: HUB, signing });
    await expect(people.blockers('ann')).rejects.toThrow('the hub would not say what this account is on (401): only root asks');
    await expect(people.letGo('ann')).rejects.toThrow('the hub would not let this account go (409): no reason given');
  });
});
