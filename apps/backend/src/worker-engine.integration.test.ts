import { temporal } from '@temporalio/proto';
import { describe, expect, it } from 'vitest';
import { engineWorkerSettingsFrom, QUEUES } from './platform/index.js';
import { testIdentityKey } from './platform/testing/keys.js';
import { workerWorld } from './platform/testing/worker-world.js';
import { MockActivityEnvironment } from '@temporalio/testing';
import { testMinioEnv } from './files/testing/real-minio.js';
import { createEngineWorker, engineWorkerSetup } from './worker-engine.js';
import { runThenLetGo } from './platform/wiring/fences.js';
import type { ToolCallArgs, ToolCallOutcome } from './engine-host/temporal/contracts.js';
import { seedEngineTools } from './engine/index.js';
import { anyOf } from './platform/lib/test-matchers.js';
import { RunGrantService } from './engine/index.js';
import { asPerson } from './platform/lib/permissions.js';

const { env, rootKey, live, placed, db } = await workerWorld();
const away = 'http://127.0.0.1:1';

const placeFor = (role: 'root' | 'instance'): Record<string, string> => ({
  ...placed(`engine-${role}`, role),
  HEALTH_PORT: '0', TEMPORAL_ENGINE_METRICS_PORT: '0', PUBLIC_URL: away, TERRAFORM_STATE: 'local',
  ...(role === 'root'
    ? { ROOT_IDENTITY_KEY: testIdentityKey() }
    : {
      INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: away, ROOT_PUBLIC_KEYS: rootKey, INSTANCE_CREDENTIAL: 'cred',
      GITEA_URL: away, GITEA_REACHES_KOALA_AT: away, INFISICAL_URL: away, ...testMinioEnv(),
      KOALA_REGISTRY: '127.0.0.1:1', KOALA_REGISTRY_PUSH: '127.0.0.1:1', REGISTRY_PULL_HOST: '127.0.0.1:1',
      SEARXNG_URL: away, CRAWL4AI_URL: away, CRAWL4AI_API_TOKEN: 'crawl-token', CHECKS_API_URL: `${away}/api`,
    }),
});

describe('the engine worker, started the way its entry starts it', () => {
  it('on an instance builds its activities, polls the engine queue with them and the shared interceptors, and stops when told', async () => {
    const settings = engineWorkerSettingsFrom(placeFor('instance'));
    const { dependencies, fences } = await engineWorkerSetup(settings);
    const { worker, activities } = await createEngineWorker(settings, dependencies);
    const running = runThenLetGo(worker, fences);
    const pollers = async () => (await env.client.workflowService.describeTaskQueue({
      namespace: env.namespace ?? 'default', taskQueue: { name: QUEUES.engine }, taskQueueType: temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,
    })).pollers ?? [];
    while ((await pollers()).length === 0) await new Promise((done) => setTimeout(done, 100));
    const registered = [...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort();
    expect(registered).toEqual(Object.keys(activities).sort());
    expect(registered).toEqual(expect.arrayContaining(['EngineNodeActivity', 'EngineToolActivity', 'CheckRunScenarioActivity', 'StoredFilesCommitActivity']));
    expect(worker.options.interceptors.activity).toHaveLength(4);
    const at = '2026-11-13T10:00:00.000Z';
    await db.projects.saveTree({ id: 'tree-shop', ownerId: 'owner-1', name: 'Shop', projectIds: ['project-shop'], createdAt: at, updatedAt: at } as never);
    await db.projects.savePlanProposal({ id: 'plan-shop', ownerId: 'owner-1', conversationId: 'c1', status: 'adopting', plan: { treeId: 'tree-shop', planDoc: '', branches: [] }, createdAt: at, updatedAt: at } as never);
    const adoption = activities as unknown as { PlanAdoptProjectActivity(args: { ownerId: string; proposalId: string }): Promise<string | null> };
    expect(await new MockActivityEnvironment().run(adoption.PlanAdoptProjectActivity, { ownerId: 'owner-1', proposalId: 'plan-shop' }), 'adopting a plan into a tree works for the tree\'s project').toBe('project-shop');
    expect((await live()).map((process) => process.name)).toEqual(['worker-engine']);
    worker.shutdown();
    await running;
    expect(await live(), 'a worker that stopped cleanly is no longer live, so a fence waits on it no more').toEqual([]);
  });

  it('on an instance answers a person\'s tool calls with their own corpus and memory, as Mongo holds them', async () => {
    const settings = engineWorkerSettingsFrom(placeFor('instance'));
    const { dependencies, fences } = await engineWorkerSetup(settings);
    const { worker, activities } = await createEngineWorker(settings, dependencies);
    const running = runThenLetGo(worker, fences);
    const tools = activities as unknown as { EngineToolActivity(args: ToolCallArgs): Promise<ToolCallOutcome> };
    const grantId = (await new RunGrantService({ store: db.engine }).issue({ ownerId: 'owner-tools', runId: 'run-tools', principal: asPerson('owner-tools'), startedBy: 'person' })).id;
    const call = (agentSlug: string, name: string, args: Record<string, unknown>) => new MockActivityEnvironment().run(tools.EngineToolActivity, {
      ticket: { runId: `run-${name}`, depth: 0, ownerId: 'owner-tools', grantId, agentSlug, trigger: 'user' as const }, nodeId: 'tools', name, arguments: JSON.stringify(args),
    });
    await seedEngineTools(db.engine);
    const at = new Date().toISOString();
    await db.memory.saveMemory({ id: 'mem-dns', ownerId: 'owner-tools', category: 'environment_facts', scope: 'global', status: 'active', title: 'DNS lives at Cloudflare', text: 'The person manages DNS at Cloudflare.', createdAt: at, updatedAt: at });

    expect(await call('koala', 'start_ingest', { url: 'https://93.184.215.14/' }), 'a crawl is refused, naming the stores the person has not deployed').toMatchObject({
      ok: false, digest: 'crawling a site into your corpus needs your own Quickwit, Qdrant and TEI running, and you have no running Quickwit, Qdrant and TEI: deploy it as an app first. Propose each with propose_deploy_app, then start the crawl once they run',
    });
    expect(await call('memory-keeper', 'forget_memory', { id: 'mem-dns', why: 'they moved to Porkbun' }), 'a memory of a person with no index of their own is retired').toMatchObject({ ok: true, content: 'Retired mem-dns.' });
    expect((await db.memory.getMemories('owner-tools')).find((item) => item.id === 'mem-dns')).toMatchObject({ invalidAt: anyOf(String) });

    worker.shutdown();
    await running;
  });

  it('is refused by its settings on root, which runs no engine worker', () => {
    expect(() => engineWorkerSettingsFrom(placeFor('root'))).toThrow(/the engine worker runs only in an instance, and ROLE is root/);
  });
});
