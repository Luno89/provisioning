import { describe, it, expect } from 'vitest';
import { gate, ALL_EFFECTS, READ_ONLY, type ToolEffect } from './action-gate.js';
import { KOALA_TOOLS, KOALA_TOOL_EFFECTS, KOALA_TOOL_HANDLERS } from './koala-tools.js';
import { LEAF_TOOLS, LEAF_TOOL_EFFECTS } from './leaf-tools.js';

/**
 * Layer 2 of the four safety layers: the Action Gate.
 *
 * The research's rule is a question, not a list: *"should this specific agent be allowed to execute
 * this exact action right now?"* Layer 3 (the sandbox — read-only root, no service-account token,
 * default-deny egress) answers it for anything running INSIDE a workspace. This answers it for the
 * in-process tools, which run with the backend's own credentials and never touch that boundary.
 *
 * ── WHY DEFAULT DENY, SPECIFICALLY ──
 * The abandoned harness-v2 branch had a gate that fell through to ALLOW on an unrecognised action,
 * which made it decoration: it stopped exactly the calls someone had already thought to list. The
 * failure it did not stop was `call_platform_api`, a tool that issued any method at any path with
 * the caller's own session cookie — added because a dispatch table makes adding one feel natural.
 *
 * Here an undeclared tool is REFUSED. That inverts who has to be thorough: not the reviewer
 * noticing a new entry, but the author, who cannot ship without answering what their tool does.
 */
describe('the action gate', () => {
  it('refuses a tool that declares no effect', () => {
    // The whole design in one assertion. Everything below is a consequence of this.
    expect(gate('mystery_tool', undefined, ALL_EFFECTS).allowed).toBe(false);
  });

  it('says why, in a sentence the model can act on', () => {
    // A bare `false` makes a model retry the same call. Handlers already return structured
    // refusals for this reason — see `renderSearchOutcome`'s unavailable-versus-empty.
    const refusal = gate('mystery_tool', undefined, ALL_EFFECTS);
    if (refusal.allowed) throw new Error('expected a refusal');
    expect(refusal.reason).toMatch(/mystery_tool/);
    expect(refusal.reason).toMatch(/effect/i);
  });

  it('allows a declared effect the caller permits', () => {
    expect(gate('get_logs', 'read', ALL_EFFECTS).allowed).toBe(true);
  });

  it('refuses a declared effect the caller does not permit', () => {
    // A read-only context is the point of having effects at all.
    const refusal = gate('create_project', 'write', READ_ONLY);
    if (refusal.allowed) throw new Error('expected a refusal');
    expect(refusal.reason).toMatch(/read/);
  });

  it('refuses an effect that is not one of the three', () => {
    // A typo in a declaration must fail closed, not widen the gate by inventing a category.
    expect(gate('odd', 'admin' as ToolEffect, ALL_EFFECTS).allowed).toBe(false);
  });
});

/**
 * ── THE PROPERTY THAT CANNOT BE BYPASSED BY ADDING A TOOL ──
 *
 * These iterate the registries rather than naming tools, so a tool added tomorrow is covered by a
 * test written today. That is the same shape as the registry↔schema bijection in koala-chat.test.ts,
 * and it exists for the same reason: the gap that bit us was a tool nobody remembered to list.
 */
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
      // Otherwise the gate is a list of things that happen to be broken.
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
    /**
     * Pins the classification of the two that decide whether this is worth anything. `get_logs`
     * reads a cluster and must stay usable in a read-only context; `create_project` writes a record
     * and must not. Anchored by name on purpose — a property test over the whole registry would be
     * satisfied by declaring everything `read`.
     */
    expect(KOALA_TOOL_EFFECTS.get_logs).toBe('read');
    expect(LEAF_TOOL_EFFECTS.create_project).toBe('write');
    expect(KOALA_TOOL_EFFECTS.propose_tree).toBe('propose');
  });
});

/**
 * ── THE GATE AT THE DISPATCH POINT ──
 *
 * Above proves the gate decides correctly. These prove it is CONSULTED — which is the part that
 * actually holds, and the part a refactor can quietly remove. Both runners are the single dispatch
 * point for their side, so a tool that reaches a handler without passing here has bypassed Layer 2
 * entirely.
 */
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
    // Simulates the real mistake: a handler wired up, a schema written, the table forgotten.
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
    // A gate that refuses everything is indistinguishable from a broken tool loop.
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
