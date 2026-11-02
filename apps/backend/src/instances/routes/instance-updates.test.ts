import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { callRouter, PERSON } from '../testing/call-router.js';
import { instanceUpdatesRouter } from './instance-updates.js';
import { UpdatesRefused, type InstanceUpdates } from '../services/InstanceUpdates.js';

type Updates = Pick<InstanceUpdates, 'view' | 'set' | 'findings'>;

const ownedBy = (id: string) => ({ role: 'instance' as const, instanceOwnerId: id });
const prefix = '/api/instance-updates';
const view = { auto: true, running: 'a1', current: 'b2', target: 'b2', releases: [] };

describe('an instance\'s updates route', () => {
  it('shows the updates root keeps for the instance', async () => {
    const updates = mock<Updates>();
    updates.view.mockResolvedValue({ ...view, checking: 'job-1' });
    expect((await callRouter(instanceUpdatesRouter({ updates }), prefix, { path: '/', claims: ownedBy(PERSON.id) })).body).toEqual({ ...view, checking: 'job-1' });
  });

  it('shows what the release it runs carries', async () => {
    const updates = mock<Updates>();
    updates.findings.mockResolvedValue({ release: 'v1', findings: [] });
    expect((await callRouter(instanceUpdatesRouter({ updates }), prefix, { path: '/findings', claims: ownedBy(PERSON.id) })).body).toEqual({ release: 'v1', findings: [] });
  });

  it('passes root\'s refusal on, turning its refusal of the instance\'s own credential into a bad gateway', async () => {
    const updates = mock<Updates>();
    updates.view.mockRejectedValueOnce(new UpdatesRefused(409, 'v1 is older than what this instance runs'));
    const refused = await callRouter(instanceUpdatesRouter({ updates }), prefix, { path: '/', claims: ownedBy(PERSON.id) });
    expect([refused.status, refused.body]).toEqual([409, { error: 'v1 is older than what this instance runs' }]);
    updates.findings.mockRejectedValueOnce(new UpdatesRefused(401, 'unknown instance or credential'));
    expect((await callRouter(instanceUpdatesRouter({ updates }), prefix, { path: '/findings', claims: ownedBy(PERSON.id) })).status).toBe(502);
  });

  it('fails the request, without a body from root, on an error that is not root\'s refusal', async () => {
    const updates = mock<Updates>();
    updates.view.mockRejectedValue(new Error('the database is gone'));
    updates.findings.mockRejectedValue(new Error('the database is gone'));
    expect((await callRouter(instanceUpdatesRouter({ updates }), prefix, { path: '/', claims: ownedBy(PERSON.id) })).status).toBe(500);
    expect((await callRouter(instanceUpdatesRouter({ updates }), prefix, { path: '/findings', claims: ownedBy(PERSON.id) })).status).toBe(500);
  });

  it('sets what the owner asks for, and only that', async () => {
    const updates = mock<Updates>();
    updates.set.mockResolvedValue(view);
    const router = instanceUpdatesRouter({ updates });
    await callRouter(router, prefix, { method: 'PUT', path: '/', body: { auto: false }, claims: ownedBy(PERSON.id) });
    await callRouter(router, prefix, { method: 'PUT', path: '/', body: { version: 'v2' }, claims: ownedBy(PERSON.id) });
    await callRouter(router, prefix, { method: 'PUT', path: '/', claims: ownedBy(PERSON.id) });
    expect(updates.set.mock.calls).toEqual([[{ auto: false }], [{ version: 'v2' }], [{}]]);
  });

  it('refuses a change that is not true or false, or a release name', async () => {
    const updates = mock<Updates>();
    const router = instanceUpdatesRouter({ updates });
    const badAuto = await callRouter(router, prefix, { method: 'PUT', path: '/', body: { auto: 'yes' }, claims: ownedBy(PERSON.id) });
    const badVersion = await callRouter(router, prefix, { method: 'PUT', path: '/', body: { version: 2 }, claims: ownedBy(PERSON.id) });
    expect([badAuto.status, badAuto.body]).toEqual([400, { error: 'send "auto" as true or false' }]);
    expect([badVersion.status, badVersion.body]).toEqual([400, { error: 'send "version" as the release to move to' }]);
    expect(updates.set).not.toHaveBeenCalled();
  });

  it('passes root\'s refusal of a change on', async () => {
    const updates = mock<Updates>();
    updates.set.mockRejectedValue(new UpdatesRefused(409, 'v1 is older than what this instance runs'));
    const answer = await callRouter(instanceUpdatesRouter({ updates }), prefix, { method: 'PUT', path: '/', body: { version: 'v1' }, claims: ownedBy(PERSON.id) });
    expect([answer.status, answer.body]).toEqual([409, { error: 'v1 is older than what this instance runs' }]);
  });

  it('lets only the owner change them', async () => {
    const updates = mock<Updates>();
    const answer = await callRouter(instanceUpdatesRouter({ updates }), prefix, { method: 'PUT', path: '/', body: { auto: true }, claims: ownedBy('the-owner') });
    expect(answer.status).toBe(403);
    expect(updates.set).not.toHaveBeenCalled();
  });

  it('says so on an instance that takes no updates from root', async () => {
    const router = instanceUpdatesRouter({ updates: undefined });
    for (const call of [{ path: '/' }, { path: '/findings' }, { method: 'PUT' as const, path: '/', body: { auto: true } }]) {
      const answer = await callRouter(router, prefix, { ...call, claims: ownedBy(PERSON.id) });
      expect([answer.status, answer.body]).toEqual([404, { error: 'this instance takes no updates from root: it was installed without a credential from root' }]);
    }
  });
});
