import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { rootWithAnInstance, type RootWithAnInstance } from '../testing/root-with-an-instance.js';
import { InstanceTrial } from '../services/InstanceTrial.js';
import { instanceTrialRouter } from './instance-trial.js';

const prefix = '/api/instance-trial';
const quiet = { validateStatus: () => true };

const opened: Array<Harness | RootWithAnInstance> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((entry) => entry.close())); });

async function instanceOn(root: RootWithAnInstance, owner = TEST_USER.id): Promise<Harness> {
  opened.push(root);
  const harness = await mountRouter({ prefix, claims: { role: 'instance', instanceOwnerId: owner }, router: () => instanceTrialRouter({ trial: new InstanceTrial(root.instance) }) });
  opened.push(harness);
  return harness;
}

describe('an instance on Koala\'s servers and its trial, asking root over HTTP', () => {
  it('shows when the trial ends, and how a move stands, as root keeps them', async () => {
    const instance = await instanceOn(await rootWithAnInstance({ pool: true }));
    expect((await axios.get(instance.url(prefix))).data).toEqual({ trialEndsAt: '2026-11-30T00:00:00Z' });
    expect((await axios.get(instance.url(`${prefix}/move`))).data).toEqual({ move: null });
  });

  it('starts a move for the owner, gives the command for their machine, shows it under way and stops it', async () => {
    const root = await rootWithAnInstance({ pool: true });
    const instance = await instanceOn(root);
    const started = await axios.post<{ command: string; expiresAt: string }>(instance.url(`${prefix}/move`), {});
    expect(started.data.command).toMatch(/machine\.sh \| sh -s -- \S+$/);
    expect((await axios.get<{ move: { state: string } }>(instance.url(`${prefix}/move`))).data.move.state).toBe('waiting');
    expect((await axios.delete(instance.url(`${prefix}/move`))).data).toEqual({ stopping: true });
    expect(root.poolAsked).toEqual([`move ${root.instance.instanceId}`, `stop ${root.instance.instanceId}: you stopped the move`]);
  });

  it('passes root\'s refusal on with its status and words', async () => {
    const instance = await instanceOn(await rootWithAnInstance());
    const refused = await axios.post(instance.url(`${prefix}/move`), {}, quiet);
    expect([refused.status, refused.data]).toEqual([409, { error: 'only an instance on Koala\'s servers moves to a machine of its own' }]);
    const nothing = await axios.delete(instance.url(`${prefix}/move`), quiet);
    expect([nothing.status, nothing.data]).toEqual([404, { error: 'nothing is moving' }]);
  });

  it('calls a failure that is not root\'s refusal a bad gateway', async () => {
    const root = await rootWithAnInstance();
    opened.push(root);
    const instance = await mountRouter({ prefix, claims: { role: 'instance', instanceOwnerId: TEST_USER.id }, router: () => instanceTrialRouter({ trial: new InstanceTrial({ ...root.instance, rootUrl: 'http://127.0.0.1:1' }) }) });
    opened.push(instance);
    const down = await axios.get<{ error: string }>(instance.url(`${prefix}/move`), quiet);
    expect(down.status).toBe(502);
    expect(down.data.error).toBeTruthy();
  });

  it('lets only the instance\'s owner start or stop a move', async () => {
    const root = await rootWithAnInstance({ pool: true });
    const instance = await instanceOn(root, 'the-owner');
    const refused = await axios.post<{ error: string }>(instance.url(`${prefix}/move`), {}, quiet);
    expect([refused.status, refused.data.error]).toEqual([403, 'Only the owner of this instance changes its settings.']);
    expect((await axios.delete(instance.url(`${prefix}/move`), quiet)).status).toBe(403);
    expect(root.poolAsked).toEqual([]);
  });
});
