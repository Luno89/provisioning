import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { callRouter, PERSON } from '../testing/call-router.js';
import { instanceWatchRouter } from './instance-watch.js';
import { RootRefused } from '../services/InstanceTrial.js';
import type { InstanceWatchSetting } from '../services/InstanceWatchSetting.js';

type Setting = Pick<InstanceWatchSetting, 'read' | 'set'>;

const ownedBy = (id: string) => ({ role: 'instance' as const, instanceOwnerId: id });
const prefix = '/api/instance-watch';

describe('whether root emails the instance\'s owner when it cannot be reached', () => {
  it('is read from root and switched only by the instance\'s owner', async () => {
    const setting = mock<Setting>();
    setting.read.mockResolvedValue({ notifyWhenUnreachable: true, alwaysTold: false });
    setting.set.calledWith(false).mockResolvedValue({ notifyWhenUnreachable: false, alwaysTold: false });
    const router = instanceWatchRouter({ setting });
    expect((await callRouter(router, prefix, { path: '/', claims: ownedBy(PERSON.id) })).body).toEqual({ notifyWhenUnreachable: true, alwaysTold: false });
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/', body: { notifyWhenUnreachable: false }, claims: ownedBy(PERSON.id) })).body).toEqual({ notifyWhenUnreachable: false, alwaysTold: false });
    const bad = await callRouter(router, prefix, { method: 'PUT', path: '/', body: { notifyWhenUnreachable: 'no' }, claims: ownedBy(PERSON.id) });
    expect([bad.status, bad.body]).toEqual([400, { error: 'send notifyWhenUnreachable as true or false' }]);
    const stranger = await callRouter(router, prefix, { method: 'PUT', path: '/', body: { notifyWhenUnreachable: true }, claims: ownedBy('someone-else') });
    expect(stranger.status).toBe(403);
    expect(setting.set).toHaveBeenCalledTimes(1);
  });

  it('refuses a change that sends nothing', async () => {
    const setting = mock<Setting>();
    const answer = await callRouter(instanceWatchRouter({ setting }), prefix, { method: 'PUT', path: '/', claims: ownedBy(PERSON.id) });
    expect(answer.status).toBe(400);
  });

  it('passes root\'s refusal on with its status, and calls any other failure a bad gateway', async () => {
    const setting = mock<Setting>();
    setting.read.mockRejectedValueOnce(new RootRefused(409, 'an instance on Koala\'s servers always tells its owner when it cannot be reached'));
    const refused = await callRouter(instanceWatchRouter({ setting }), prefix, { path: '/', claims: ownedBy(PERSON.id) });
    expect([refused.status, refused.body]).toEqual([409, { error: 'an instance on Koala\'s servers always tells its owner when it cannot be reached' }]);
    setting.set.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const down = await callRouter(instanceWatchRouter({ setting }), prefix, { method: 'PUT', path: '/', body: { notifyWhenUnreachable: true }, claims: ownedBy(PERSON.id) });
    expect([down.status, down.body]).toEqual([502, { error: 'connect ECONNREFUSED' }]);
  });

  it('says so where nothing is watched', async () => {
    const router = instanceWatchRouter({ setting: undefined });
    expect((await callRouter(router, prefix, { path: '/' })).status).toBe(404);
    expect((await callRouter(router, prefix, { method: 'PUT', path: '/', body: { notifyWhenUnreachable: true } })).status).toBe(404);
  });
});
