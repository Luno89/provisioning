import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'express';
import type { ClaimSettings } from '../../platform/lib/permissions.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import { instanceUpdatesRouter } from './instance-updates.js';
import { UpdatesRefused, type InstanceUpdates } from '../services/InstanceUpdates.js';

type Updates = Pick<InstanceUpdates, 'view' | 'set' | 'findings'>;

const ownedBy = (id: string) => ({ role: 'instance' as const, instanceOwnerId: id });
const prefix = '/api/instance-updates';
const on = (router: Router, claims?: ClaimSettings) => routesInProcess({ prefix, router: () => router, user: PERSON, ...(claims ? { claims } : {}) });
const view = { auto: true, running: 'a1', current: 'b2', target: 'b2', releases: [] };

describe('an instance\'s updates route', () => {
  it('shows the updates root keeps for the instance', async () => {
    const updates = mock<Updates>();
    updates.view.mockResolvedValue({ ...view, checking: 'job-1' });
    expect((await (await on(instanceUpdatesRouter({ updates }), ownedBy(PERSON.id))).get(prefix)).data).toEqual({ ...view, checking: 'job-1' });
  });

  it('shows what the release it runs carries', async () => {
    const updates = mock<Updates>();
    updates.findings.mockResolvedValue({ release: 'v1', findings: [] });
    expect((await (await on(instanceUpdatesRouter({ updates }), ownedBy(PERSON.id))).get(`${prefix}/findings`)).data).toEqual({ release: 'v1', findings: [] });
  });

  it('passes root\'s refusal on, turning its refusal of the instance\'s own credential into a bad gateway', async () => {
    const updates = mock<Updates>();
    updates.view.mockRejectedValueOnce(new UpdatesRefused(409, 'v1 is older than what this instance runs'));
    const refused = await (await on(instanceUpdatesRouter({ updates }), ownedBy(PERSON.id))).get(prefix);
    expect([refused.status, refused.data]).toEqual([409, { error: 'v1 is older than what this instance runs' }]);
    updates.findings.mockRejectedValueOnce(new UpdatesRefused(401, 'unknown instance or credential'));
    expect((await (await on(instanceUpdatesRouter({ updates }), ownedBy(PERSON.id))).get(`${prefix}/findings`)).status).toBe(502);
  });

  it('fails the request, without a body from root, on an error that is not root\'s refusal', async () => {
    const updates = mock<Updates>();
    updates.view.mockRejectedValue(new Error('the database is gone'));
    updates.findings.mockRejectedValue(new Error('the database is gone'));
    expect((await (await on(instanceUpdatesRouter({ updates }), ownedBy(PERSON.id))).get(prefix)).status).toBe(500);
    expect((await (await on(instanceUpdatesRouter({ updates }), ownedBy(PERSON.id))).get(`${prefix}/findings`)).status).toBe(500);
  });

  it('sets what the owner asks for, and only that', async () => {
    const updates = mock<Updates>();
    updates.set.mockResolvedValue(view);
    const router = instanceUpdatesRouter({ updates });
    await (await on(router, ownedBy(PERSON.id))).put(prefix, { auto: false });
    await (await on(router, ownedBy(PERSON.id))).put(prefix, { version: 'v2' });
    await (await on(router, ownedBy(PERSON.id))).put(prefix);
    expect(updates.set.mock.calls).toEqual([[{ auto: false }], [{ version: 'v2' }], [{}]]);
  });

  it('refuses a change that is not true or false, or a release name', async () => {
    const updates = mock<Updates>();
    const router = instanceUpdatesRouter({ updates });
    const badAuto = await (await on(router, ownedBy(PERSON.id))).put(prefix, { auto: 'yes' });
    const badVersion = await (await on(router, ownedBy(PERSON.id))).put(prefix, { version: 2 });
    expect([badAuto.status, badAuto.data]).toEqual([400, { error: 'send "auto" as true or false' }]);
    expect([badVersion.status, badVersion.data]).toEqual([400, { error: 'send "version" as the release to move to' }]);
    expect(updates.set).not.toHaveBeenCalled();
  });

  it('passes root\'s refusal of a change on', async () => {
    const updates = mock<Updates>();
    updates.set.mockRejectedValue(new UpdatesRefused(409, 'v1 is older than what this instance runs'));
    const answer = await (await on(instanceUpdatesRouter({ updates }), ownedBy(PERSON.id))).put(prefix, { version: 'v1' });
    expect([answer.status, answer.data]).toEqual([409, { error: 'v1 is older than what this instance runs' }]);
  });

  it('lets only the owner change them', async () => {
    const updates = mock<Updates>();
    const answer = await (await on(instanceUpdatesRouter({ updates }), ownedBy('the-owner'))).put(prefix, { auto: true });
    expect(answer.status).toBe(403);
    expect(updates.set).not.toHaveBeenCalled();
  });

  it('says so on an instance that takes no updates from root', async () => {
    const router = instanceUpdatesRouter({ updates: undefined });
    for (const call of [{ path: '/' }, { path: '/findings' }, { method: 'PUT' as const, path: '/', body: { auto: true } }]) {
      const answer = await (await on(router, ownedBy(PERSON.id))).request(call.method ?? 'GET', `${prefix}${call.path}`, { body: call.body });
      expect([answer.status, answer.data]).toEqual([404, { error: 'this instance takes no updates from root: it was installed without a credential from root' }]);
    }
  });
});
