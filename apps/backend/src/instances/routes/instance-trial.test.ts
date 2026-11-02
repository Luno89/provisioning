import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { callRouter, PERSON } from '../testing/call-router.js';
import { instanceTrialRouter } from './instance-trial.js';
import { RootRefused, type InstanceTrial } from '../services/InstanceTrial.js';

type Trial = Pick<InstanceTrial, 'read' | 'startMove' | 'moveState' | 'stopMove'>;

const ownedBy = (id: string) => ({ role: 'instance' as const, instanceOwnerId: id });
const prefix = '/api/instance-trial';

describe('an instance on Koala\'s servers and its trial', () => {
  it('shows when the trial ends, and nothing where there is none', async () => {
    const trial = mock<Trial>();
    trial.read.mockResolvedValue({ trialEndsAt: '2026-11-03T07:00:00.000Z' });
    expect((await callRouter(instanceTrialRouter({ trial }), prefix, { path: '/', claims: ownedBy(PERSON.id) })).body).toEqual({ trialEndsAt: '2026-11-03T07:00:00.000Z' });
    expect((await callRouter(instanceTrialRouter({ trial: undefined }), prefix, { path: '/', claims: ownedBy(PERSON.id) })).body).toEqual({});
  });

  it('shows how far a move has got, or none', async () => {
    const trial = mock<Trial>();
    trial.moveState.mockResolvedValue({ state: 'copying', startedAt: '2026-11-01T00:00:00.000Z' });
    expect((await callRouter(instanceTrialRouter({ trial }), prefix, { path: '/move', claims: ownedBy(PERSON.id) })).body).toEqual({ move: { state: 'copying', startedAt: '2026-11-01T00:00:00.000Z' } });
    expect((await callRouter(instanceTrialRouter({ trial: undefined }), prefix, { path: '/move', claims: ownedBy(PERSON.id) })).body).toEqual({ move: null });
  });

  it('passes root\'s refusal on with its status, and calls any other failure a bad gateway', async () => {
    const trial = mock<Trial>();
    trial.moveState.mockRejectedValueOnce(new RootRefused(409, 'a move is already under way'));
    const refused = await callRouter(instanceTrialRouter({ trial }), prefix, { path: '/move', claims: ownedBy(PERSON.id) });
    expect([refused.status, refused.body]).toEqual([409, { error: 'a move is already under way' }]);
    trial.moveState.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const down = await callRouter(instanceTrialRouter({ trial }), prefix, { path: '/move', claims: ownedBy(PERSON.id) });
    expect([down.status, down.body]).toEqual([502, { error: 'connect ECONNREFUSED' }]);
  });

  it('starts a move for the owner, giving the command to run on their machine', async () => {
    const trial = mock<Trial>();
    trial.startMove.mockResolvedValue({ command: 'curl ... | sudo sh', expiresAt: '2026-11-03T07:00:00.000Z' });
    const answer = await callRouter(instanceTrialRouter({ trial }), prefix, { method: 'POST', path: '/move', claims: ownedBy(PERSON.id) });
    expect(answer.body).toEqual({ command: 'curl ... | sudo sh', expiresAt: '2026-11-03T07:00:00.000Z' });
  });

  it('stops a move for the owner', async () => {
    const trial = mock<Trial>();
    trial.stopMove.mockResolvedValue(undefined);
    const answer = await callRouter(instanceTrialRouter({ trial }), prefix, { method: 'DELETE', path: '/move', claims: ownedBy(PERSON.id) });
    expect(answer.body).toEqual({ stopping: true });
  });

  it('says why root would not start or stop a move', async () => {
    const trial = mock<Trial>();
    trial.startMove.mockRejectedValue(new RootRefused(409, 'the instance is switching already'));
    trial.stopMove.mockRejectedValue(new RootRefused(404, 'nothing is moving'));
    expect((await callRouter(instanceTrialRouter({ trial }), prefix, { method: 'POST', path: '/move', claims: ownedBy(PERSON.id) })).status).toBe(409);
    expect((await callRouter(instanceTrialRouter({ trial }), prefix, { method: 'DELETE', path: '/move', claims: ownedBy(PERSON.id) })).status).toBe(404);
  });

  it('lets only the owner start or stop a move', async () => {
    const trial = mock<Trial>();
    const start = await callRouter(instanceTrialRouter({ trial }), prefix, { method: 'POST', path: '/move', claims: ownedBy('the-owner') });
    const stop = await callRouter(instanceTrialRouter({ trial }), prefix, { method: 'DELETE', path: '/move', claims: ownedBy('the-owner') });
    expect([start.status, stop.status]).toEqual([403, 403]);
    expect(trial.startMove).not.toHaveBeenCalled();
    expect(trial.stopMove).not.toHaveBeenCalled();
  });

  it('says only an instance on Koala\'s servers moves', async () => {
    const router = instanceTrialRouter({ trial: undefined });
    const start = await callRouter(router, prefix, { method: 'POST', path: '/move', claims: ownedBy(PERSON.id) });
    const stop = await callRouter(router, prefix, { method: 'DELETE', path: '/move', claims: ownedBy(PERSON.id) });
    expect([start.status, start.body]).toEqual([404, { error: 'only an instance on Koala\'s servers moves' }]);
    expect([stop.status, stop.body]).toEqual([404, { error: 'nothing is moving' }]);
  });
});
