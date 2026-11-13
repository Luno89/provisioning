import { describe, expect, it, vi } from 'vitest';
import { matching } from '../../platform/lib/test-matchers.js';
import { canaryFor } from '@koala/agent-engine/procedure';
import type { AgentDefinition } from '@koala/agent-engine';
import type { ToolContract } from '@koala/engine-core';
import { testDatabase } from '../../platform/lib/test-database.js';
import { createAgentRegistry } from '../registries/registry.js';
import { PoisoningWatch } from './poisoning-watch.js';
import { createToolRuntime } from './tool-runtime.js';
import type { ToolCallArgs } from '../temporal/contracts.js';

const CATALOGUE: ToolContract[] = [{ name: 'store_file', description: 'Keep a file', binding: 'platform' }];

const KOALA: AgentDefinition = {
  slug: 'koala', name: 'Koala', description: 'Talks', version: '1', prompt: 'You talk.', procedure: 'tool-rounds', guidance: '', returns: '', failures: [],
  tools: ['store_file'], budget: { maxRounds: 4 }, environment: {}, interface: {},
};

const call = (argumentsText: string): ToolCallArgs => ({
  ticket: { runId: 'run-1', depth: 0, ownerId: 'owner', agentSlug: 'koala', trigger: 'user', grantId: 'grant-1' },
  nodeId: 'tools',
  name: 'store_file',
  arguments: argumentsText,
});

describe('a tool call whose arguments are not one JSON object, with the real poisoning watch on Mongo', () => {
  it('is refused before the watch or the tool sees it, so a canary hidden in it is neither stored nor taken as a clean call', async () => {
    const db = await testDatabase();
    const watch = new PoisoningWatch({ store: db.engine, personText: async () => '', seal: (text) => `sealed:${text.length}`, now: () => '2026-11-13T10:00:00.000Z', log: () => undefined });
    const store_file = vi.fn(async () => ({ ok: true, digest: 'kept' }));
    const tools = createToolRuntime({
      registry: createAgentRegistry({ agentStore: { list: async () => [KOALA] }, toolCatalogue: { list: async () => CATALOGUE } }),
      handlers: { store_file },
      watch,
    });
    const canary = canaryFor('grant-1');

    const refused = await tools.run(call(JSON.stringify(['a.txt', `ref ${canary}`])));

    expect(refused).toMatchObject({ ok: false, digest: matching(/arguments for "store_file" must be one JSON object, and these were an array/) });
    expect(store_file).not.toHaveBeenCalled();
    expect(await db.engine.getPoisoningSignals('owner')).toEqual([]);

    const kept = await tools.run(call(JSON.stringify({ path: 'a.txt', content: `ref ${canary}` })));

    expect(kept).toMatchObject({ ok: true, digest: 'kept' });
    expect((await db.engine.getPoisoningSignals('owner')).map((signal) => signal.kind)).toEqual(['canary']);
  });
});
