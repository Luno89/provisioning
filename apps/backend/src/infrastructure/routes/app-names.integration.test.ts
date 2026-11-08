import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mock } from 'vitest-mock-extended';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { deploymentsRouter } from './deployments.js';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { until } from '../../platform/testing/three-roles.js';
import { AppService } from '../services/AppService.js';
import { ClusterService } from '../services/ClusterService.js';
import { testClusterAccess } from '../testing/cluster-access.js';
import { TemporalBridge } from '../services/TemporalBridge.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { Database } from '../../platform/lib/db-interface.js';

const KEY = 'app-names-test-key-that-is-at-least-32-characters' as never;
const ANN = { id: 'ann', email: 'ann@app-names.test' };
const BOB = { id: 'bob', email: 'bob@app-names.test' };
const asked = (person: { id: string }) => ({ name: 'shop', clusterId: `machine-${person.id}`, appType: 'audiobookshelf', strategy: 'native' });
const QUIET = { validateStatus: () => true };

interface Deployment { id: string; name: string; namespace?: string; ownerId?: string; status: string }
interface Started { id: string; workflowId: string }

let env: TestWorkflowEnvironment;
let db: Database;
let h: Harness;
const workflows: string[] = [];

beforeAll(async () => {
  env = await temporalTestEnvironment();
  db = await testDatabase();
  const infra = mock<InfrastructureService>();
  for (const person of [ANN, BOB]) await db.infrastructure.saveCluster({ id: `machine-${person.id}`, name: person.id, provider: 'machine', machineId: person.id, status: 'stopped', ownerId: person.id });
  const clusters = new ClusterService(db, testClusterAccess(db, { dataKey: KEY }));
  const bridge = new TemporalBridge(db, undefined, KEY, clusters);
  Object.assign(bridge, { client: env.client });
  h = await mountRouter({
    prefix: '/api/deployments',
    db,
    router: () => deploymentsRouter({ appService: new AppService(db, infra, clusters, {} as never), clusterService: clusters, appExposureService: {} as never, access: clusters.access, temporalBridge: bridge, db, io: undefined as never }),
  });
}, 120_000);

afterAll(async () => {
  for (const id of workflows) await env.client.workflow.getHandle(id).terminate('the test is over').catch(() => undefined);
  await until(async () => ((await db.infrastructure.getDeployments()).every((dep) => dep.status === 'failed') ? true : undefined));
  await h?.close();
  await env?.teardown();
});

async function deployAs(person: typeof ANN): Promise<Started> {
  h.setUser(person);
  const made = await axios.post<Started>(h.url('/api/deployments'), asked(person), QUIET);
  expect(made.status, JSON.stringify(made.data)).toBe(202);
  workflows.push(made.data.workflowId);
  return made.data;
}

async function listedFor(person: typeof ANN): Promise<Deployment[]> {
  h.setUser(person);
  return (await axios.get<Deployment[]>(h.url('/api/deployments'))).data;
}

describe('two owners each deploy an app called shop on one backend', () => {
  let ann: Started;
  let bob: Started;

  it('each gets an app of their own, its id not its name, in a namespace of its own, its deploy started in Temporal', async () => {
    ann = await deployAs(ANN);
    bob = await deployAs(BOB);
    expect(ann.id).not.toBe('shop');
    expect(ann.id).not.toBe(bob.id);
    const stored = await db.infrastructure.getDeployments();
    const of = (id: string) => stored.find((dep) => dep.id === id)!;
    expect(of(ann.id)).toMatchObject({ name: 'shop', ownerId: 'ann', status: 'deploying' });
    expect(of(bob.id)).toMatchObject({ name: 'shop', ownerId: 'bob', status: 'deploying' });
    expect(of(ann.id).namespace).toMatch(/^shop-[a-f0-9]{6}$/);
    expect(of(bob.id).namespace).toMatch(/^shop-[a-f0-9]{6}$/);
    expect(of(ann.id).namespace).not.toBe(of(bob.id).namespace);
    for (const id of [ann.workflowId, bob.workflowId]) expect((await env.client.workflow.getHandle(id).describe()).status.name).toBe('RUNNING');
  });

  it('each owner sees only their own', async () => {
    expect((await listedFor(ANN)).filter((dep) => dep.name === 'shop').map((dep) => dep.id)).toEqual([ann.id]);
    expect((await listedFor(BOB)).filter((dep) => dep.name === 'shop').map((dep) => dep.id)).toEqual([bob.id]);
  });

  it('deploying it again as the same owner goes to the same app, not a second one, and a namespace or id in the request is not taken', async () => {
    const before = (await db.infrastructure.getDeployments()).find((dep) => dep.id === bob.id)!;
    h.setUser(BOB);
    const again = await axios.post<Started>(h.url('/api/deployments'), { ...asked(BOB), namespace: 'kube-system', id: ann.id }, QUIET);
    expect(again.status, JSON.stringify(again.data)).toBe(202);
    workflows.push(again.data.workflowId);
    expect(again.data.id).toBe(bob.id);
    const stored = await db.infrastructure.getDeployments();
    expect(stored.filter((dep) => dep.name === 'shop').map((dep) => [dep.ownerId, dep.id]).sort()).toEqual([['ann', ann.id], ['bob', bob.id]].sort());
    expect(stored.find((dep) => dep.id === bob.id)!.namespace).toBe(before.namespace);
    expect((await listedFor(BOB)).filter((dep) => dep.name === 'shop')).toHaveLength(1);
  });
});
