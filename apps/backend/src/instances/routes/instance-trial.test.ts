import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'express';
import type { ClaimSettings } from '../../platform/lib/permissions.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import { instanceTrialRouter } from './instance-trial.js';
import { RootRefused, type InstanceTrial } from '../services/InstanceTrial.js';

type Trial = Pick<InstanceTrial, 'read' | 'startMove' | 'moveState' | 'stopMove'>;

const ownedBy = (id: string) => ({ role: 'instance' as const, instanceOwnerId: id });
const prefix = '/api/instance-trial';
const on = (router: Router, claims?: ClaimSettings) => routesInProcess({ prefix, router: () => router, user: PERSON, ...(claims ? { claims } : {}) });

describe('an instance on Koala\'s servers and its trial', () => {
  it('shows when the trial ends, and nothing where there is none', async () => {
    const trial = mock<Trial>();
    trial.read.mockResolvedValue({ trialEndsAt: '2026-11-03T07:00:00.000Z' });
    expect((await (await on(instanceTrialRouter({ trial }), ownedBy(PERSON.id))).get(prefix)).data).toEqual({ trialEndsAt: '2026-11-03T07:00:00.000Z' });
    expect((await (await on(instanceTrialRouter({ trial: undefined }), ownedBy(PERSON.id))).get(prefix)).data).toEqual({});
  });

  it('shows how far a move has got, or none', async () => {
    const trial = mock<Trial>();
    trial.moveState.mockResolvedValue({ state: 'copying', startedAt: '2026-11-01T00:00:00.000Z' });
    expect((await (await on(instanceTrialRouter({ trial }), ownedBy(PERSON.id))).get(`${prefix}/move`)).data).toEqual({ move: { state: 'copying', startedAt: '2026-11-01T00:00:00.000Z' } });
    expect((await (await on(instanceTrialRouter({ trial: undefined }), ownedBy(PERSON.id))).get(`${prefix}/move`)).data).toEqual({ move: null });
  });

  it('passes root\'s refusal on with its status, and calls any other failure a bad gateway', async () => {
    const trial = mock<Trial>();
    trial.moveState.mockRejectedValueOnce(new RootRefused(409, 'a move is already under way'));
    const refused = await (await on(instanceTrialRouter({ trial }), ownedBy(PERSON.id))).get(`${prefix}/move`);
    expect([refused.status, refused.data]).toEqual([409, { error: 'a move is already under way' }]);
    trial.moveState.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const down = await (await on(instanceTrialRouter({ trial }), ownedBy(PERSON.id))).get(`${prefix}/move`);
    expect([down.status, down.data]).toEqual([502, { error: 'connect ECONNREFUSED' }]);
  });

  it('starts a move for the owner, giving the command to run on their machine', async () => {
    const trial = mock<Trial>();
    trial.startMove.mockResolvedValue({ command: 'curl ... | sudo sh', expiresAt: '2026-11-03T07:00:00.000Z' });
    const answer = await (await on(instanceTrialRouter({ trial }), ownedBy(PERSON.id))).post(`${prefix}/move`);
    expect(answer.data).toEqual({ command: 'curl ... | sudo sh', expiresAt: '2026-11-03T07:00:00.000Z' });
  });

  it('stops a move for the owner', async () => {
    const trial = mock<Trial>();
    trial.stopMove.mockResolvedValue(undefined);
    const answer = await (await on(instanceTrialRouter({ trial }), ownedBy(PERSON.id))).delete(`${prefix}/move`);
    expect(answer.data).toEqual({ stopping: true });
  });

  it('says why root would not start or stop a move', async () => {
    const trial = mock<Trial>();
    trial.startMove.mockRejectedValue(new RootRefused(409, 'the instance is switching already'));
    trial.stopMove.mockRejectedValue(new RootRefused(404, 'nothing is moving'));
    expect((await (await on(instanceTrialRouter({ trial }), ownedBy(PERSON.id))).post(`${prefix}/move`)).status).toBe(409);
    expect((await (await on(instanceTrialRouter({ trial }), ownedBy(PERSON.id))).delete(`${prefix}/move`)).status).toBe(404);
  });

  it('lets only the owner start or stop a move', async () => {
    const trial = mock<Trial>();
    const start = await (await on(instanceTrialRouter({ trial }), ownedBy('the-owner'))).post(`${prefix}/move`);
    const stop = await (await on(instanceTrialRouter({ trial }), ownedBy('the-owner'))).delete(`${prefix}/move`);
    expect([start.status, stop.status]).toEqual([403, 403]);
    expect(trial.startMove).not.toHaveBeenCalled();
    expect(trial.stopMove).not.toHaveBeenCalled();
  });

  it('says only an instance on Koala\'s servers moves', async () => {
    const router = instanceTrialRouter({ trial: undefined });
    const start = await (await on(router, ownedBy(PERSON.id))).post(`${prefix}/move`);
    const stop = await (await on(router, ownedBy(PERSON.id))).delete(`${prefix}/move`);
    expect([start.status, start.data]).toEqual([404, { error: 'only an instance on Koala\'s servers moves' }]);
    expect([stop.status, stop.data]).toEqual([404, { error: 'nothing is moving' }]);
  });
});
