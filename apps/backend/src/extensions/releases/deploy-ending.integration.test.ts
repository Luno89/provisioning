import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@temporalio/client';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import { fixtureWorker, type FixtureWorker } from '../testing/fixture-worker.js';
import { deploySettledOn } from './deploy-ending.js';

const QUEUE = `deploy-ending-${randomUUID().slice(0, 8)}`;
let fixture: FixtureWorker;

beforeAll(async () => {
  fixture = await fixtureWorker(QUEUE, resolve(__dirname, 'testing/deploy.fixture-workflow.ts'));
});

afterAll(async () => {
  await fixture?.stop();
});

const deploy = async (say: string): Promise<string> => {
  const workflowId = `${QUEUE}-${say}`;
  await fixture.env.client.workflow.start('DeployFixtureWorkflow', { workflowId, taskQueue: QUEUE, args: [say], ...startedFor('bo') });
  return workflowId;
};

const asked: string[] = [];
const followedOnly = async (): Promise<Pick<Client, 'workflow'>> => ({
  workflow: Object.assign(Object.create(fixture.env.client.workflow) as Client['workflow'], {
    getHandle: (workflowId: string) => {
      const handle = fixture.env.client.workflow.getHandle(workflowId);
      return { ...handle, result: () => handle.result(), describe: async () => { asked.push(workflowId); throw new Error(`${workflowId} was asked how it is going`); } };
    },
  }),
});

const settled = deploySettledOn(followedOnly);

describe('a release deploy followed to its end', () => {
  it('answers the moment the deploy workflow ends, never asking it how it is going', async () => {
    const workflowId = await deploy('held');
    const answer = settled(workflowId);
    await fixture.env.client.workflow.getHandle(workflowId).signal('deploy-ends');
    expect(await answer).toEqual({ ok: true });
    expect(asked).toEqual([]);
  });

  it('hands back why the app never became healthy, and why the deploy workflow itself failed', async () => {
    expect(await settled(await deploy('unhealthy'))).toEqual({ ok: false, reason: 'odoo-web is CrashLoopBackOff: the addons path is missing' });
    expect(await settled(await deploy('broken'))).toEqual({ ok: false, reason: 'the image registry.koala/odoo:17 could not be pulled' });
    expect(asked).toEqual([]);
  });
});
