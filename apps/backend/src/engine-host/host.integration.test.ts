import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { KoalasCluster } from './sandboxes/kube.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { INSTALLED_EXTENSIONS } from '../extensions/installed.js';
import { createEngineHost, storesFromDatabase } from './host.js';
import { ENGINE_TOOL_SEEDS } from './tools/engine-tool-seeds.js';
import { createEnvironmentNodes } from './nodes/environment-nodes.js';
import type { NodeImplementation } from '@koala/agent-engine/procedure';
import { hostGrants } from '../engine/testing/run-grants.js';
import { NO_MEMORY_INDEX } from './testing/host-fixtures.js';

const noMemoryIndex = NO_MEMORY_INDEX;

describe('the engine host', () => {
  it('has a handler for every tool grove and workspace offer through their runtimes, so none is granted with nothing behind it', async () => {
    const db = await testDatabase();
    const host = createEngineHost({
    runGrants: hostGrants(),
      models: {} as never,
      cluster: mock<KoalasCluster>(),
      registry: { none: 'this test builds no workspace images' },
      revokeRegistryPushToken: async () => undefined,
      stores: storesFromDatabase(db, noMemoryIndex),
      publishedWorkspaces: { get: async () => undefined, save: async () => undefined },
      readRepoFile: async () => undefined,
      writeRepoFile: async () => ({ changed: false }),
      workspaceBuild: async () => ({ started: false, reason: 'running' }),
    });
    const offered = INSTALLED_EXTENSIONS.filter((extension) => extension.id !== 'platform').flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
    expect(offered).toEqual(expect.arrayContaining(['change_workspace', 'mark_waiting', 'propose_plan']));
    expect(offered.filter((name) => !host.implemented.has(name))).toEqual([]);
  });
});

describe('a run whose workspace image cannot be had yet', () => {
  const hostFor = async () => {
    const db = await testDatabase();
    const seed = ENGINE_TOOL_SEEDS.find((tool) => tool.name === 'run_command')!;
    await db.engine.saveEngineTool({ ...seed, name: 'count_lines', ownerId: 'bo', needs: ['jq'] });
    await db.engine.saveToolGrant({ ownerId: 'bo', agent: 'executor', tool: 'count_lines' });
    return createEngineHost({
    runGrants: hostGrants(),
      models: {} as never,
      cluster: mock<KoalasCluster>(),
      registry: { none: 'this Koala has no registry to build workspace images in' },
      revokeRegistryPushToken: async () => undefined,
      stores: storesFromDatabase(db, noMemoryIndex),
      mcpHostedUrl: async () => undefined,
    });
  };

  it('is told why, from the person\'s own agent, tools and dependencies, and an agent with nothing to build is told nothing', async () => {
    const host = await hostFor();
    expect(await host.services.images!.waiting('bo', 'executor')).toBe('The workspace image for executor did not build: this Koala has no registry to build workspace images in');
    expect(await host.services.images!.waiting('bo', 'research')).toBeUndefined();
  });

  it('hears it as a notice from its environment step, before the step says whether an environment could be had', async () => {
    const host = await hostFor();
    const provision = createEnvironmentNodes(host.services).find((node) => node.kind === 'provision-sandbox') as Extract<NodeImplementation, { role: 'step' }>;
    const notices: string[] = [];
    const run = {
      launch: { ownerId: 'bo' },
      identity: { agentId: 'executor', runId: 'run-1', depth: 0, trigger: 'user' },
      budget: { maxWallClockMs: 1_000 },
      emit: (event: { type: string; message?: string }) => { if (event.type === 'notice' && event.message) notices.push(event.message); },
    };
    await provision.run({ node: { id: 'provision', kind: 'provision-sandbox', settings: {} }, run, inputs: {} } as never);
    expect(notices).toEqual(['The workspace image for executor did not build: this Koala has no registry to build workspace images in']);
  });
});

