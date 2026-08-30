import { describe, it, expect } from 'vitest';
import { gate, ALL_EFFECTS, READ_ONLY, type ToolEffect } from './action-gate.js';
import { KOALA_TOOLS, KOALA_TOOL_HANDLERS } from './koala-tools.js';
import { LEAF_TOOLS } from './leaf-tools.js';
import { effectOf } from './tool-schemas.js';

describe('the action gate', () => {
  it('refuses a tool that declares no effect', () => {
    expect(gate('mystery_tool', undefined, ALL_EFFECTS).allowed).toBe(false);
  });

  it('says why, in a sentence the model can act on', () => {
    const refusal = gate('mystery_tool', undefined, ALL_EFFECTS);
    if (refusal.allowed) throw new Error('expected a refusal');
    expect(refusal.reason).toMatch(/mystery_tool/);
    expect(refusal.reason).toMatch(/effect/i);
  });

  it('allows a declared effect the caller permits', () => {
    expect(gate('get_logs', 'read', ALL_EFFECTS).allowed).toBe(true);
  });

  it('refuses a declared effect the caller does not permit', () => {
    const refusal = gate('create_project', 'write', READ_ONLY);
    if (refusal.allowed) throw new Error('expected a refusal');
    expect(refusal.reason).toMatch(/read/);
  });

  it('refuses an effect that is not one of the three', () => {
    expect(gate('odd', 'admin' as ToolEffect, ALL_EFFECTS).allowed).toBe(false);
  });
});

describe('every tool declares what it does', () => {
  const registries: [string, readonly { function: { name: string } }[]][] = [
    ['Koala', KOALA_TOOLS],
    ['leaf', LEAF_TOOLS],
  ];

  for (const [label, tools] of registries) {
    it(`gives every ${label} tool an effect in the registry`, () => {
      for (const tool of tools) {
        const name = tool.function.name;
        const effect = effectOf(name);
        expect(effect, `${name} has no effect row`).toBeDefined();
        expect(ALL_EFFECTS, `${name} declares "${effect}"`).toContain(effect);
      }
    });

    it(`lets every ${label} tool through a gate that permits everything`, () => {
      for (const tool of tools) {
        const name = tool.function.name;
        expect(gate(name, effectOf(name), ALL_EFFECTS).allowed, name).toBe(true);
      }
    });
  }

  it('gives every dispatchable handler an effect, so none can run ungated', () => {
    for (const name of Object.keys(KOALA_TOOL_HANDLERS)) {
      expect(effectOf(name), `${name} is dispatchable with no effect`).toBeDefined();
    }
  });

  it('calls the reading tools read, and the mutating ones not-read', () => {
    expect(effectOf('get_logs')).toBe('read');
    expect(effectOf('create_project')).toBe('write');
    expect(effectOf('propose_tree')).toBe('propose');
  });
});

describe('the runners consult the gate', () => {
  const ctx = (): Record<string, unknown> => ({
    db: { getConversations: async () => [], getTrees: async () => [] },
    userId: 'u1',
    conversationId: 'c1',
    servers: [],
    webSearch: async () => ({ hits: [], unavailable: false }),
    fetchWebPage: async () => '',
  });

  it('refuses a Koala tool whose effect is not declared', async () => {
    const { runKoalaTool } = await import('./koala-tool-runner.js');
    // A name with no registry row has no effect, which is the case the gate refuses.
    const out = await runKoalaTool(ctx() as never, { name: 'not_a_tool', arguments: '{}' });
    expect(out.content).toMatch(/No tool named/);
  });

  it('refuses a write when the conversation permits only reads', async () => {
    const { runKoalaTool } = await import('./koala-tool-runner.js');
    const out = await runKoalaTool(
      { ...ctx(), permitted: READ_ONLY } as never,
      { name: 'add_project_dependency', arguments: '{}' },
    );
    expect(out.content).toMatch(/limited to read/);
  });

  it('still runs a read in that same conversation', async () => {
    const { runKoalaTool } = await import('./koala-tool-runner.js');
    const out = await runKoalaTool(
      { ...ctx(), permitted: READ_ONLY } as never,
      { name: 'list_trees', arguments: '{}' },
    );
    expect(out.content).not.toMatch(/limited to/);
  });

  it('refuses an undeclared leaf tool too', async () => {
    const { runLeafTool } = await import('./leaf-tool-runner.js');
    const out = await runLeafTool(
      { db: { getLeaves: async () => [], getBranches: async () => [] }, userId: 'u1', branchId: 'b1' } as never,
      { name: 'not_a_leaf_tool', arguments: '{}' },
    );
    expect(out).toMatch(/Unknown tool|declares no effect/);
  });
});
