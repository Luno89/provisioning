import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { openedRecord, provisioningView, type ProvisioningRecord } from '../lib/provisioning.js';
import type { Provisioning } from '../services/Provisioning.js';
import { provisioningRouter } from './provisioning.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import type { HarnessUser } from '../../platform/routes/test-harness.js';

const OWNER: HarnessUser = PERSON;
const STRANGER: HarnessUser = { id: 'stranger-1', email: 'stranger@example.com' };

const on = (router: Router, user: HarnessUser = OWNER) =>
  routesInProcess({ prefix: '/api/infrastructure/provisioning', router: () => router, user, claims: { role: 'instance', instanceOwnerId: OWNER.id } });

const record = (ownerId: string, clusterId: string, stamp: string): ProvisioningRecord => ({
  ...openedRecord({ ownerId, target: { kind: 'koala', clusterId }, revision: 4, reason: 'revision', runId: `provision-${clusterId}~${stamp}`, at: '2026-11-18T10:00:00.000Z' }),
  workflowId: `provision-${clusterId}`,
});

describe('/api/infrastructure/provisioning', () => {
  it('shows the person the latest setup of each place that is theirs, as the card shows it, without the run\'s ids', async () => {
    const provisioning = mock<Provisioning>();
    const mine = record(OWNER.id, 'machine-desk', 'a');
    provisioning.latest.mockResolvedValue([mine, record('someone-else', 'machine-other', 'b')]);
    const answer = await (await on(provisioningRouter({ provisioning }))).get('/api/infrastructure/provisioning');
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ setups: [provisioningView(mine)], can: ['set-up-again'] });
  });

  it('says to anyone else that they cannot set it up again', async () => {
    const provisioning = mock<Provisioning>();
    provisioning.latest.mockResolvedValue([]);
    expect((await (await on(provisioningRouter({ provisioning }), STRANGER)).get('/api/infrastructure/provisioning')).data).toEqual({ setups: [], can: [] });
  });

  it('sets up again the cluster named, for whoever runs this Koala, answering the run started or joined', async () => {
    const provisioning = mock<Provisioning>();
    const started = { ...record(OWNER.id, 'machine-desk', 'c'), reason: 'asked' as const };
    provisioning.again.calledWith('machine-desk').mockResolvedValue(started);
    const answer = await (await on(provisioningRouter({ provisioning }))).post('/api/infrastructure/provisioning/again', { clusterId: 'machine-desk' });
    expect(answer.status).toBe(202);
    expect(answer.data).toEqual(provisioningView(started));
  });

  it('refuses anyone else with the table\'s sentence, starting nothing', async () => {
    const provisioning = mock<Provisioning>();
    const answer = await (await on(provisioningRouter({ provisioning }), STRANGER)).post('/api/infrastructure/provisioning/again', { clusterId: 'machine-desk' });
    expect(answer.status).toBe(403);
    expect(answer.data).toEqual({ error: 'Only whoever runs this Koala sets it up again.' });
    expect(provisioning.again).not.toHaveBeenCalled();
  });

  it('says which cluster to set up again when none is named, and that Koala set nothing up on one it does not know', async () => {
    const provisioning = mock<Provisioning>();
    provisioning.again.mockResolvedValue(undefined);
    const routes = await on(provisioningRouter({ provisioning }));
    expect(await routes.post('/api/infrastructure/provisioning/again', { clusterId: 3 })).toMatchObject({ status: 400, data: { error: 'name the cluster to set up again as "clusterId"' } });
    expect(await routes.post('/api/infrastructure/provisioning/again', { clusterId: 'machine-nowhere' })).toMatchObject({ status: 404, data: { error: 'Koala has set nothing up on machine-nowhere' } });
  });

  it('answers that setting up is off and why when this Koala has no cluster of its own, and refuses setting up again', async () => {
    const off = { off: 'this Koala runs on no cluster of its own, so it sets nothing up' };
    const routes = await on(provisioningRouter({ provisioning: off }));
    expect(await routes.get('/api/infrastructure/provisioning')).toMatchObject({ status: 200, data: { setups: [], can: [], off: off.off } });
    expect(await routes.post('/api/infrastructure/provisioning/again', { clusterId: 'machine-desk' })).toMatchObject({ status: 409, data: { error: off.off } });
  });
});
