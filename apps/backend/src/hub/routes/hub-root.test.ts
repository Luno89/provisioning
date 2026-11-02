import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, publicKeyPem, trustedKeys } from '../../instances/lib/identity-token.js';
import { hubPersonPart } from '../services/HubPeople.js';
import type { HubService } from '../services/HubService.js';
import { callRouter } from '../testing/call-router.js';
import { hubRootRouter } from './hub-root.js';

const root = identityKeysFrom(generateIdentityKey());
const stranger = identityKeysFrom(generateIdentityKey());

function hubOf() {
  const hub = mock<Pick<HubService, 'leaving' | 'letGo'>>();
  const forgotten: string[] = [];
  const used = new Set<string>();
  const router = hubRootRouter({
    hub,
    trusted: trustedKeys([publicKeyPem(root.publicKey)]),
    forget: async (id) => { forgotten.push(id); },
    claim: async (jti) => (used.has(jti) ? false : Boolean(used.add(jti))),
  });
  const call = (method: 'GET' | 'DELETE', token: string) => callRouter(router, '/api/hub-root', { method, path: '/people/bo', headers: { authorization: `Bearer ${token}` } });
  return { hub, forgotten, call };
}

const token = (what: 'leaving' | 'let-go', person = 'bo', audience = 'hub', keys = root) => issueMoveToken(keys, audience, hubPersonPart(person, what));

describe('/api/hub-root on the hub', () => {
  it('tells root what a person is on when root asks for that person and no other step', async () => {
    const { hub, call } = hubOf();
    hub.leaving.calledWith('bo').mockResolvedValue({ blockers: [], deletes: ['Alone'], leaves: ['Guest'] });
    const answer = await call('GET', token('leaving'));
    expect([answer.status, answer.body]).toEqual([200, { blockers: [], deletes: ['Alone'], leaves: ['Guest'] }]);
  });

  it('turns away a token that is not root\'s, is for another person, another step or another audience, or has been used', async () => {
    const { hub, call } = hubOf();
    hub.leaving.mockResolvedValue({ blockers: [], deletes: [], leaves: [] });
    for (const bad of ['', token('let-go'), token('leaving', 'ann'), token('leaving', 'bo', 'inst-1'), token('leaving', 'bo', 'hub', stranger)]) {
      expect((await call('GET', bad)).status).toBe(401);
    }
    const once = token('leaving');
    expect((await call('GET', once)).status).toBe(200);
    expect((await call('GET', once)).status).toBe(401);
  });

  it('refuses to let a person go while something stops it, saying what', async () => {
    const { hub, call, forgotten } = hubOf();
    hub.leaving.mockResolvedValue({ blockers: ['only owner of Shop', 'only owner of Guest'], deletes: [], leaves: [] });
    const answer = await call('DELETE', token('let-go'));
    expect([answer.status, answer.body]).toEqual([409, { error: 'only owner of Shop; only owner of Guest', blockers: ['only owner of Shop', 'only owner of Guest'] }]);
    expect(hub.letGo).not.toHaveBeenCalled();
    expect(forgotten).toEqual([]);
  });

  it('lets a person go when nothing stops it, and has root forget them', async () => {
    const { hub, call, forgotten } = hubOf();
    hub.leaving.mockResolvedValue({ blockers: [], deletes: [], leaves: [] });
    hub.letGo.mockResolvedValue({ deleted: ['a'], left: [] });
    const answer = await call('DELETE', token('let-go'));
    expect([answer.status, answer.body]).toEqual([200, { deleted: ['a'], left: [] }]);
    expect(forgotten).toEqual(['bo']);
  });

  it('turns away a token for the wrong step when asked to let a person go', async () => {
    const { hub, call } = hubOf();
    expect((await call('DELETE', token('leaving'))).status).toBe(401);
    expect(hub.letGo).not.toHaveBeenCalled();
  });
});
