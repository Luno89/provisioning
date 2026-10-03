import { describe, it, expect, vi } from 'vitest';
import { createEngineToolHandlers, unimplemented, undeclaredHandlers } from './engine-tools.js';
import { createStoredAgentRegistry } from '../registries/registry.js';
import {
  BUILDER_TOOLS,
  type ProcedureSource,
} from '@koala/agent-engine';
import { BUILT_IN_GROUPS, EXAMPLE_PROCEDURE, TOOL_ROUNDS_V2, builtInCatalogue } from '@koala/agent-engine/procedure';
import { procedureBuilder } from '@koala/agent-engine/procedure-builder';
import type { ToolHandler, ToolHandlerContext } from '@koala/engine-core';

function wired(saved: ProcedureSource[] = []) {
  const registry = createStoredAgentRegistry({
    personas: { list: async () => [] },
    procedures: { list: async () => saved },
  });

  return {
    saved,
    registry,
    map: createEngineToolHandlers({
      registry,
      images: { ensure: async (plan) => plan.base, exists: async () => true, start: async (plan) => ({ state: 'ready' as const, reference: plan.base }), standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }) },
      catalogue: BUILDER_TOOLS,
      procedures: {
        get: async (ownerId, id) => saved.find((row) => row.id === id && row.ownerId === ownerId),
        save: async (row) => {
          const index = saved.findIndex((existing) => existing.id === row.id && existing.ownerId === row.ownerId);
          if (index >= 0) saved[index] = row;
          else saved.push(row);
        },
      },
      scope: {
        procedures: (ownerId) => registry.procedures(ownerId),
        personas: (ownerId) => registry.agents(ownerId),
        toolNames: async () => [...BUILDER_TOOLS.map((tool) => tool.name), 'list_tasks'],
      },
      tasks: { list: async () => [], save: vi.fn() },
      platform: {},
    }),
  };
}

const call = (
  map: Record<string, ToolHandler>,
  name: string,
  parsed: Record<string, unknown> = {},
  caller: Record<string, unknown> = { ownerId: 'user-1', agentSlug: 'agent-builder' },
) => map[name]!({ name, parsed, driver: undefined, caller } as ToolHandlerContext);

describe('the engine worker implements what it declares', () => {
  it('has a handler for every tool in the catalogue', () => {
    expect(unimplemented(wired().map, BUILDER_TOOLS)).toEqual([]);
  });

  it('reports handlers that no catalogue entry declares', () => {
    expect(undeclaredHandlers(wired().map, BUILDER_TOOLS)).toContain('propose_work');
  });
});

describe('the wired procedure tools actually run', () => {
  it('lists what a procedure may reference, so nothing has to be guessed', async () => {
    const out = await call(wired().map, 'list_references');

    expect(out.ok).toBe(true);
    expect(out.content).toContain('TOOLS a Call Tool node can call');
    expect(out.content).toContain('PERSONAS a Delegate or Fan Out node can hand work to');
    expect(out.content).toContain('koala: Talks things through');
    expect(out.content).toContain('- call-model: Call Model');
    expect(out.content).toContain('- model-turn: Model Turn');
  });

  it('lists the procedures when read_procedure is given nothing to read', async () => {
    const out = await call(wired().map, 'read_procedure');

    expect(out.ok).toBe(true);
    expect(out.content).toContain('- interactive-chat v4: Interactive chat');
  });

  it('reads a built-in procedure as the same JSON save_procedure takes', async () => {
    const out = await call(wired().map, 'read_procedure', { procedure: 'tool-rounds' });

    expect(out.ok).toBe(true);
    expect(JSON.parse(out.content ?? '')).toEqual(TOOL_ROUNDS_V2);
  });

  it('refuses a procedure in the old format, saying what format it needs', async () => {
    const out = await call(wired().map, 'check_procedure', {
      source: JSON.stringify({ id: 'old', version: '1', initialStep: 'go', nodes: [{ id: 'go', kind: 'terminal', outcome: 'ok' }] }),
    });

    expect(out.ok).toBe(false);
    expect(out.digest).toContain('needs "schema": 2');
  });

  it('refuses a procedure that calls a tool nobody declares, naming the node', async () => {
    const source = {
      ...EXAMPLE_PROCEDURE,
      id: 'sketchy',
      nodes: [...(EXAMPLE_PROCEDURE.nodes as object[]), { id: 'ghost', kind: 'call-tool', settings: { tool: 'ghost_tool' } }],
    };

    const out = await call(wired().map, 'check_procedure', { source });

    expect(out.ok).toBe(false);
    expect(out.digest).toContain('node "ghost": calls "ghost_tool", which is not a tool');
  });

  it('saves a procedure that checks clean as the caller\'s own copy, bumping the version each time', async () => {
    const harness = wired();

    const first = await call(harness.map, 'save_procedure', { source: EXAMPLE_PROCEDURE });
    const second = await call(harness.map, 'save_procedure', { source: JSON.stringify(EXAMPLE_PROCEDURE) });

    expect(first).toMatchObject({ ok: true, digest: 'saved as your own copy: quick-answer v1' });
    expect(second).toMatchObject({ ok: true, digest: 'saved as your own copy: quick-answer v2' });
    expect(harness.saved.map((row) => [row.id, row.ownerId, row.version])).toEqual([['quick-answer', 'user-1', '2']]);
    expect((await harness.registry.procedure('user-1', 'quick-answer'))?.version).toBe('2');
    expect(await harness.registry.procedure('user-2', 'quick-answer')).toBeUndefined();
  });

  it('refuses a procedure that would run code, from either tool, and saves nothing', async () => {
    const harness = wired();
    const withCode = procedureBuilder({ catalogue: builtInCatalogue(), groups: BUILT_IN_GROUPS })({
      id: 'runs-code', version: '1', name: 'Runs code', describe: 'Runs a piece of code.', budget: {},
    }, (p) => {
      const provision = p.provisionSandbox('provision');
      const shape = p.code('shape', { environment: provision.environment }, {
        body: 'return { out: 1 }',
        inputs: [],
        outputs: [{ name: 'out', type: 'json' }],
      });
      const done = p.finish('done', { result: shape.out! }, { outcome: 'ok' });
      const nowhere = p.finish('nowhere', { reason: provision.reason }, { outcome: 'failed' });

      p.start(provision);
      provision.on('ready', done);
      provision.on('unavailable', nowhere);
      p.layout({ provision: [0, 0], shape: [260, 0], done: [520, 0], nowhere: [520, 140] });
    }).procedure;

    const checked = await call(harness.map, 'check_procedure', { source: withCode });
    const saved = await call(harness.map, 'save_procedure', { source: withCode });

    expect(checked.ok).toBe(false);
    expect(checked.digest).toContain('may not run code a person has not read');
    expect(saved.ok).toBe(false);
    expect(harness.saved).toEqual([]);
  });

  it('refuses a Run Code step, and code tucked inside one of the procedure\'s own groups, just the same', async () => {
    const harness = wired();
    const build = procedureBuilder({ catalogue: builtInCatalogue(), groups: BUILT_IN_GROUPS });
    const runsOnce = build({ id: 'runs-once', version: '1', name: 'Runs once', describe: 'Runs code once.', budget: {} }, (p) => {
      const provision = p.provisionSandbox('provision');
      const write = p.runCode('write', { environment: provision.environment }, { body: 'return {}', inputs: [], outputs: [] });
      const done = p.finish('done', {}, { outcome: 'ok' });
      const broke = p.finish('broke', { reason: write.error }, { outcome: 'failed' });
      const nowhere = p.finish('nowhere', { reason: provision.reason }, { outcome: 'failed' });
      p.start(provision);
      provision.on('ready', write);
      provision.on('unavailable', nowhere);
      write.on('ok', done);
      write.on('failed', broke);
      p.layout({ provision: [0, 0], write: [260, 0], done: [520, 0], broke: [520, 140], nowhere: [260, 140] });
    }).procedure;
    const tucked = {
      schema: runsOnce.schema, id: 'tucked', version: '1', name: 'Tucked', describe: 'Hides code in a group.', budget: {}, start: 'provision',
      nodes: [
        { id: 'provision', kind: 'provision-sandbox', settings: {}, position: { x: 0, y: 0 } },
        { id: 'hidden', kind: 'group', group: 'hide', settings: {}, position: { x: 260, y: 0 } },
        { id: 'done', kind: 'finish', settings: { outcome: 'ok' }, position: { x: 520, y: 0 } },
        { id: 'nowhere', kind: 'finish', settings: { outcome: 'failed' }, position: { x: 260, y: 140 } },
      ],
      wires: [
        { from: { node: 'provision', socket: 'environment' }, to: { node: 'hidden', socket: 'environment' } },
        { from: { node: 'provision', socket: 'reason' }, to: { node: 'nowhere', socket: 'reason' } },
      ],
      flow: [
        { from: 'provision', exit: 'ready', to: 'hidden' },
        { from: 'provision', exit: 'unavailable', to: 'nowhere' },
        { from: 'hidden', exit: 'done', to: 'done' },
        { from: 'hidden', exit: 'quiet', to: 'done' },
      ],
      groups: [{
        id: 'hide', title: 'Hide', describe: 'hides code',
        inputs: [{ name: 'environment', type: 'environment', describe: 'where', required: true, to: [{ node: 'sneak', socket: 'environment' }] }],
        outputs: [],
        exits: [{ name: 'done', describe: 'done', from: { node: 'said', exit: 'true' } }, { name: 'quiet', describe: 'quiet', from: { node: 'said', exit: 'false' } }],
        start: 'said',
        nodes: [
          { id: 'sneak', kind: 'code', settings: { body: 'return { out: 1 }', inputs: [], outputs: [{ name: 'out', type: 'json' }] }, position: { x: 0, y: 0 } },
          { id: 'said', kind: 'condition', settings: { expression: 'true' }, position: { x: 260, y: 0 } },
        ],
        wires: [{ from: { node: 'sneak', socket: 'out' }, to: { node: 'said', socket: 'value' } }],
        flow: [],
      }],
    };

    const once = await call(harness.map, 'check_procedure', { source: runsOnce });
    const hidden = await call(harness.map, 'check_procedure', { source: tucked });

    expect(once.ok).toBe(false);
    expect(once.digest).toContain('may not run code a person has not read');
    expect(hidden.ok).toBe(false);
    expect(hidden.digest).toMatch(/group "hide", node "sneak"[^\n]*may not run code a person has not read/);
    expect(harness.saved).toEqual([]);
  });

  it('refuses to save what does not check clean, and saves nothing', async () => {
    const harness = wired();
    const out = await call(harness.map, 'save_procedure', { source: { ...EXAMPLE_PROCEDURE, flow: [] } });

    expect(out.ok).toBe(false);
    expect(out.digest).toMatch(/^not saved — it does not check clean:/);
    expect(harness.saved).toEqual([]);
  });
});
