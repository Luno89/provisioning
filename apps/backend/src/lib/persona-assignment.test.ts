import { describe, it, expect } from 'vitest';
import {
  unassignedLeaves, buildAssignmentPrompt, buildUnassignedNotice, MAX_ASSIGNMENT_ROUNDS,
} from './persona-assignment.js';
import type { Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'do a thing', column: 'todo',
  status: 'proposed', depth: 0, blocking: true, createdAt: '', updatedAt: '', ...over,
} as Leaf);

describe('finding work with nobody assigned to it', () => {
  it('finds proposed leaves on this branch with no persona', () => {
    const found = unassignedLeaves([
      leaf({ id: 'a' }),
      leaf({ id: 'b', personaId: 'someone' }),
    ], 'b1');
    expect(found.map((l) => l.id)).toEqual(['a']);
  });

  it('ignores other branches', () => {
    expect(unassignedLeaves([leaf({ branchId: 'other' })], 'b1')).toEqual([]);
  });

  it('ignores work that is already under way', () => {
    /**
     * Only proposals are worth re-asking about. A leaf that has been accepted and started cannot
     * have its environment changed underneath it, and one that already failed is not fixed by
     * assigning someone to it now.
     */
    for (const status of ['pending', 'running', 'succeeded', 'failed'] as const) {
      expect(unassignedLeaves([leaf({ status })], 'b1')).toEqual([]);
    }
  });
});

describe('asking the planner again', () => {
  const personas = [
    { name: 'Researcher', description: 'Answers one narrow question from sources.' },
    { name: 'Builder', description: undefined },
  ];

  it('names the leaves and lists the personas to choose from', () => {
    // The failure being corrected is almost always that the model did not have the names to hand.
    // Asking it to try again without them would be asking it to guess.
    const text = buildAssignmentPrompt([{ title: 'Write the client' }], personas);
    expect(text).toContain('Write the client');
    expect(text).toContain('Researcher — Answers one narrow question from sources.');
    expect(text).toContain('Builder');
    expect(text).toContain('do not invent a name');
  });

  it('says what a persona actually decides, so the ask is not arbitrary', () => {
    const text = buildAssignmentPrompt([{ title: 'x' }], personas);
    expect(text).toMatch(/network/);
    expect(text).toMatch(/cannot run/);
  });

  it('gives the planner a bounded number of chances', () => {
    // A model that has ignored the instruction twice will not be persuaded by a third identical
    // request; it will spend another inference pass saying so.
    expect(MAX_ASSIGNMENT_ROUNDS).toBe(2);
  });
});

describe('handing it to the user', () => {
  it('says what is stuck and what to do, not that a retry budget ran out', () => {
    const { text } = buildUnassignedNotice([{ title: 'Write the client' }, { title: 'Add the tests' }]);
    expect(text).toContain('2 pieces of work need a persona');
    expect(text).toContain('Write the client');
    expect(text).toContain('assign a persona');
    // Explains the refusal to guess, since that is the part a reader would otherwise find unhelpful.
    expect(text).toMatch(/toolchain|network|budget/);
  });

  it('reads properly for a single leaf', () => {
    const { text } = buildUnassignedNotice([{ title: 'Write the client' }]);
    expect(text).toContain('One piece of work needs a persona');
    expect(text).not.toContain('1 pieces');
  });
});
