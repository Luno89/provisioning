import { interceptorsOf, pollersOf, REFUSING_DELETING_WORK, untilPolling, watchedRun } from '@koala/engine-core/testing/temporal';
import { afterAll, describe, expect, it } from 'vitest';
import { startCorpusStandIn } from './engine/testing/corpus-stand-in.js';
import { engineWorkerSettingsFrom, QUEUES } from './platform/index.js';
import { testIdentityKey } from './platform/testing/keys.js';
import { workerWorld } from './platform/testing/worker-world.js';
import { MockActivityEnvironment } from '@temporalio/testing';
import { testMinioEnv } from './files/testing/real-minio.js';
import { createEngineWorker, engineWorkerSetup } from './worker-engine.js';
import type { ToolCallArgs, ToolCallOutcome } from './engine-host/temporal/contracts.js';
import { seedEngineTools } from './engine/index.js';
import { anyOf } from './platform/lib/test-matchers.js';
import { grantsOver } from './engine/testing/run-grants.js';
import { asPerson } from './platform/lib/permissions.js';

const { env, rootKey, placed, db } = await workerWorld();
const away = 'http://127.0.0.1:1';
const memoryIndex = await startCorpusStandIn();
afterAll(async () => { await memoryIndex.stop(); });

const placeFor = (role: 'root' | 'instance'): Record<string, string> => ({
  ...placed(`engine-${role}`, role),
  HEALTH_PORT: '0', TEMPORAL_ENGINE_METRICS_PORT: '0', PUBLIC_URL: away, TERRAFORM_STATE: 'local',
  ...(role === 'root'
    ? { ROOT_IDENTITY_KEY: testIdentityKey() }
    : {
      INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: away, ROOT_PUBLIC_KEYS: rootKey, INSTANCE_CLIENT_KEY: testIdentityKey(), INSTANCE_REGISTRATION_TOKEN: 'code', POD_NAME: 'luno-worker-engine-7d9f-abcde',
      GITEA_URL: away, GITEA_REACHES_KOALA_AT: away, INFISICAL_URL: away, ...testMinioEnv(),
      KOALA_REGISTRY: '127.0.0.1:1', KOALA_REGISTRY_PUSH: '127.0.0.1:1', REGISTRY_PULL_HOST: '127.0.0.1:1',
      SEARXNG_URL: away, CRAWL4AI_URL: away, CRAWL4AI_API_TOKEN: 'crawl-token', QUICKWIT_URL: memoryIndex.base, QDRANT_URL: memoryIndex.base, QDRANT_API_KEY: memoryIndex.endpoints.vectors.apiKey, TEI_URL: memoryIndex.base, CHECKS_API_URL: `${away}/api`,
    }),
});

const runningOnAnInstance = async () => {
  const settings = engineWorkerSettingsFrom(placeFor('instance'));
  const { dependencies } = await engineWorkerSetup(settings);
  const { worker, activities } = await createEngineWorker(settings, dependencies);
  return { worker, activities, dependencies, ...watchedRun(worker) };
};

describe('the engine worker, started the way its entry starts it', () => {
  it('on an instance builds its activities, polls the engine queue with them, the shared interceptors and the refusal of work being deleted, and stops when told', async () => {
    const { worker, activities, running, ended } = await runningOnAnInstance();
    const polling = { namespace: env.namespace, queue: QUEUES.engine, identity: 'luno-worker-engine-7d9f-abcde', ended };
    await untilPolling(env.client, polling);
    const registered = [...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort();
    expect(registered).toEqual(Object.keys(activities).sort());
    expect(registered).toEqual(expect.arrayContaining(['EngineNodeActivity', 'EngineToolActivity', 'CheckRunScenarioActivity', 'StoredFilesCommitActivity', 'StopProjectWorkActivity', 'SweepProjectActivity']));
    expect(interceptorsOf(worker), 'the shared interceptors and the refusal of work being deleted').toEqual(REFUSING_DELETING_WORK);
    expect(worker.options.identity, 'Temporal knows the worker by its own pod').toBe('luno-worker-engine-7d9f-abcde');
    const at = '2026-11-13T10:00:00.000Z';
    await db.projects.saveTree({ id: 'tree-shop', ownerId: 'owner-1', name: 'Shop', projectIds: ['project-shop'], createdAt: at, updatedAt: at } as never);
    await db.projects.savePlanProposal({ id: 'plan-shop', ownerId: 'owner-1', conversationId: 'c1', status: 'adopting', plan: { treeId: 'tree-shop', planDoc: '', branches: [] }, createdAt: at, updatedAt: at } as never);
    const adoption = activities as unknown as { PlanAdoptProjectActivity(args: { ownerId: string; proposalId: string }): Promise<string | null> };
    expect(await new MockActivityEnvironment().run(adoption.PlanAdoptProjectActivity, { ownerId: 'owner-1', proposalId: 'plan-shop' }), 'adopting a plan into a tree works for the tree\'s project').toBe('project-shop');
    expect(await pollersOf(env.client, polling), 'the worker is up, polling as its pod').toContain('luno-worker-engine-7d9f-abcde');
    worker.shutdown();
    await running;
  });

  it('on an instance answers a person\'s tool calls with their own memory, as Mongo holds them', async () => {
    const { worker, activities, dependencies, running } = await runningOnAnInstance();
    const tools = activities as unknown as { EngineToolActivity(args: ToolCallArgs): Promise<ToolCallOutcome> };
    const grantId = (await grantsOver(db.engine).issue({ ownerId: 'owner-tools', runId: 'run-tools', principal: asPerson('owner-tools'), startedBy: 'person' })).id;
    const call = (agentSlug: string, name: string, args: Record<string, unknown>) => new MockActivityEnvironment().run(tools.EngineToolActivity, {
      ticket: { runId: `run-${name}`, depth: 0, ownerId: 'owner-tools', grantId, agentSlug, trigger: 'user' as const }, nodeId: 'tools', name, arguments: JSON.stringify(args),
    });
    await seedEngineTools(db.engine);
    const at = new Date().toISOString();
    await db.memory.saveMemory({ id: 'mem-dns', ownerId: 'owner-tools', category: 'environment_facts', scope: 'global', status: 'active', title: 'DNS lives at Cloudflare', text: 'The person manages DNS at Cloudflare.', createdAt: at, updatedAt: at });

    expect(await call('memory-keeper', 'forget_memory', { id: 'mem-dns', why: 'they moved to Porkbun' }), 'a memory is retired and taken out of the memory index').toMatchObject({ ok: true, content: 'Retired mem-dns.' });
    expect((await db.memory.getMemories('owner-tools')).find((item) => item.id === 'mem-dns')).toMatchObject({ invalidAt: anyOf(String) });
    expect(dependencies.down().map((down) => down.dependency), 'the index that answered is not shown down').not.toEqual(expect.arrayContaining(['quickwit']));

    worker.shutdown();
    await running;
  });

  it('is refused by its settings on root, which runs no engine worker', () => {
    expect(() => engineWorkerSettingsFrom(placeFor('root'))).toThrow(/the engine worker runs only in an instance, and ROLE is root/);
  });
});
