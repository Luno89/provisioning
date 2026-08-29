import { describe, it, expect } from 'vitest';
import { gate, ALL_EFFECTS, READ_ONLY, type ToolEffect } from './action-gate.js';
import { KOALA_TOOLS, KOALA_TOOL_EFFECTS, KOALA_TOOL_HANDLERS } from './koala-tools.js';
import { LEAF_TOOLS, LEAF_TOOL_EFFECTS } from './leaf-tools.js';

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
  const registries: [string, readonly { function: { name: string } }[], Record<string, ToolEffect>][] = [
    ['Koala', KOALA_TOOLS, KOALA_TOOL_EFFECTS],
    ['leaf', LEAF_TOOLS, LEAF_TOOL_EFFECTS],
  ];

  for (const [label, tools, effects] of registries) {
    it(`covers every ${label} tool, and declares nothing that is not one`, () => {
      const names = tools.map((t) => t.function.name).sort();
      expect(Object.keys(effects).sort()).toEqual(names);
      for (const [name, effect] of Object.entries(effects)) {
        expect(ALL_EFFECTS, `${name} declares "${effect}"`).toContain(effect);
      }
    });

    it(`lets every ${label} tool through a gate that permits everything`, () => {
      for (const tool of tools) {
        const name = tool.function.name;
        expect(gate(name, effects[name], ALL_EFFECTS).allowed, name).toBe(true);
      }
    });
  }

  it('agrees with the handler table, so a tool cannot be dispatched ungated', () => {
    expect(Object.keys(KOALA_TOOL_EFFECTS).sort()).toEqual(Object.keys(KOALA_TOOL_HANDLERS).sort());
  });

  it('calls the reading tools read, and the mutating ones not-read', () => {
    expect(KOALA_TOOL_EFFECTS.get_logs).toBe('read');
    expect(LEAF_TOOL_EFFECTS.create_project).toBe('write');
    expect(KOALA_TOOL_EFFECTS.propose_tree).toBe('propose');
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
    const { KOALA_TOOL_EFFECTS } = await import('./koala-tools.js');
    const saved = (KOALA_TOOL_EFFECTS as Record<string, unknown>).list_trees;
    delete (KOALA_TOOL_EFFECTS as Record<string, unknown>).list_trees;
    try {
      const out = await runKoalaTool(ctx() as never, { name: 'list_trees', arguments: '{}' });
      expect(out.content).toMatch(/declares no effect/);
    } finally {
      (KOALA_TOOL_EFFECTS as Record<string, unknown>).list_trees = saved;
    }
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
    const { LEAF_TOOL_EFFECTS } = await import('./leaf-tools.js');
    const saved = (LEAF_TOOL_EFFECTS as Record<string, unknown>).list_leaves;
    delete (LEAF_TOOL_EFFECTS as Record<string, unknown>).list_leaves;
    try {
      const out = await runLeafTool({ db: { getLeaves: async () => [] }, branchId: 'b1', ownerId: 'u1' } as never,
        { name: 'list_leaves', arguments: '{}' });
      expect(out).toMatch(/declares no effect/);
    } finally {
      (LEAF_TOOL_EFFECTS as Record<string, unknown>).list_leaves = saved;
    }
  });
});
