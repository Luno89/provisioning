import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'express';
import type { ClaimSettings } from '../../platform/lib/permissions.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import { instanceWatchRouter } from './instance-watch.js';
import { RootRefused } from '../services/InstanceTrial.js';
import type { InstanceWatchSetting } from '../services/InstanceWatchSetting.js';

type Setting = Pick<InstanceWatchSetting, 'read' | 'set'>;

const ownedBy = (id: string) => ({ role: 'instance' as const, instanceOwnerId: id });
const prefix = '/api/instance-watch';
const on = (router: Router, claims?: ClaimSettings) => routesInProcess({ prefix, router: () => router, user: PERSON, ...(claims ? { claims } : {}) });

describe('whether root emails the instance\'s owner when it cannot be reached', () => {
  it('is read from root and switched only by the instance\'s owner', async () => {
    const setting = mock<Setting>();
    setting.read.mockResolvedValue({ notifyWhenUnreachable: true, alwaysTold: false });
    setting.set.calledWith(false).mockResolvedValue({ notifyWhenUnreachable: false, alwaysTold: false });
    const router = instanceWatchRouter({ setting });
    expect((await (await on(router, ownedBy(PERSON.id))).get(prefix)).data).toEqual({ notifyWhenUnreachable: true, alwaysTold: false });
    expect((await (await on(router, ownedBy(PERSON.id))).put(prefix, { notifyWhenUnreachable: false })).data).toEqual({ notifyWhenUnreachable: false, alwaysTold: false });
    const bad = await (await on(router, ownedBy(PERSON.id))).put(prefix, { notifyWhenUnreachable: 'no' });
    expect([bad.status, bad.data]).toEqual([400, { error: 'send notifyWhenUnreachable as true or false' }]);
    const stranger = await (await on(router, ownedBy('someone-else'))).put(prefix, { notifyWhenUnreachable: true });
    expect(stranger.status).toBe(403);
    expect(setting.set).toHaveBeenCalledTimes(1);
  });

  it('refuses a change that sends nothing', async () => {
    const setting = mock<Setting>();
    const answer = await (await on(instanceWatchRouter({ setting }), ownedBy(PERSON.id))).put(prefix);
    expect(answer.status).toBe(400);
  });

  it('passes root\'s refusal on with its status, and calls any other failure a bad gateway', async () => {
    const setting = mock<Setting>();
    setting.read.mockRejectedValueOnce(new RootRefused(409, 'an instance on Koala\'s servers always tells its owner when it cannot be reached'));
    const refused = await (await on(instanceWatchRouter({ setting }), ownedBy(PERSON.id))).get(prefix);
    expect([refused.status, refused.data]).toEqual([409, { error: 'an instance on Koala\'s servers always tells its owner when it cannot be reached' }]);
    setting.set.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const down = await (await on(instanceWatchRouter({ setting }), ownedBy(PERSON.id))).put(prefix, { notifyWhenUnreachable: true });
    expect([down.status, down.data]).toEqual([502, { error: 'connect ECONNREFUSED' }]);
  });

  it('says so where nothing is watched', async () => {
    const router = instanceWatchRouter({ setting: undefined });
    expect((await (await on(router)).get(prefix)).status).toBe(404);
    expect((await (await on(router)).put(prefix, { notifyWhenUnreachable: true })).status).toBe(404);
  });
});
