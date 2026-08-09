/**
 * Two of the six interventions a person had to make during a real end-to-end run were about the
 * plan itself, and both are mechanically detectable — which is the argument for detecting them
 * rather than relying on somebody knowing that `dependsOn` exists.
 */
import { describe, it, expect } from 'vitest';
import { reviewPlan, planNotice, rewireDependents } from './plan-review.js';
import type { Leaf } from './leaves.js';

/** Titles default to the id, so a fixture never trips the duplicate-title check by accident. */
const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l', ownerId: 'u1', branchId: 'b', body: '', column: 'todo',
  status: 'proposed', depth: 0, blocking: true, expects: ['a.js'],
  createdAt: '', updatedAt: '',
  title: over.id ? `Leaf ${over.id}` : 'Leaf l',
  ...over,
} as Leaf);

describe('a plan with no ordering', () => {
  it('warns when several leaves depend on nothing', () => {
    // The first intervention: five leaves, no dependsOn, and the leaf that assembled the others
    // would have found nothing to import.
    const w = reviewPlan([leaf({ id: 'a' }), leaf({ id: 'b' }), leaf({ id: 'c' })], 1);
    expect(w.map((x) => x.code)).toContain('no-ordering');
  });

  it('says nothing about a single leaf', () => {
    // It cannot depend on anything.
    expect(reviewPlan([leaf()], 1).map((w) => w.code)).not.toContain('no-ordering');
  });

  it('says nothing when SOME ordering exists', () => {
    // A genuine fan-out is a normal shape; flagging it would train everyone to ignore this.
    const w = reviewPlan([leaf({ id: 'a' }), leaf({ id: 'b' }), leaf({ id: 'c', dependsOn: ['a'] })], 1);
    expect(w.map((x) => x.code)).not.toContain('no-ordering');
  });
});

describe('nothing that runs the finished thing', () => {
  it('warns when a request declares no acceptance checks', () => {
    /**
     * The per-leaf checks each prove a piece. With none of these, nobody is responsible for the
     * whole — which is how a five-leaf plan delivered a CLI that printed its own name and exited
     * with every leaf green.
     */
    expect(reviewPlan([leaf({ id: 'a' })], 0).map((w) => w.code)).toContain('no-acceptance');
  });

  it('says nothing once some are declared', () => {
    expect(reviewPlan([leaf({ id: 'a' })], 2).map((w) => w.code)).not.toContain('no-acceptance');
  });
});

describe('a plan nothing will check', () => {
  it('warns about leaves with neither expects nor a verify command', () => {
    const w = reviewPlan([leaf({ id: 'a', expects: [] }), leaf({ id: 'b', dependsOn: ['a'] })], 1);
    expect(w.map((x) => x.code)).toContain('unchecked');
  });

  it('names the leaves rather than just counting them', () => {
    const w = reviewPlan([leaf({ id: 'a', title: 'Write the docs', expects: [] }), leaf({ id: 'b', dependsOn: ['a'] })], 1);
    expect(w.find((x) => x.code === 'unchecked')?.text).toContain('Write the docs');
  });

  it('is satisfied by a verify command alone', () => {
    const ok = [leaf({ id: 'a', expects: [], verifyCommand: 'npm test' }), leaf({ id: 'b', dependsOn: ['a'] })];
    expect(reviewPlan(ok, 1).map((w) => w.code)).not.toContain('unchecked');
  });
});

describe('a dependency on something that is gone', () => {
  it('warns, because the runtime deliberately will not', () => {
    /**
     * `dependenciesMet` treats a missing id as MET — the right call, since stranding the dependent
     * forever is worse. It also means a withdrawn dependency silently becomes no dependency, the
     * ordering is lost, and nothing at runtime ever mentions it.
     */
    const w = reviewPlan([leaf({ id: 'b', dependsOn: ['deleted'] })], 1);
    expect(w.map((x) => x.code)).toContain('dangling-dependency');
  });

  it('does not warn about a dependency that exists but has finished', () => {
    const done = leaf({ id: 'a', status: 'succeeded' });
    const w = reviewPlan([done, leaf({ id: 'b', dependsOn: ['a'] })], 1);
    expect(w.map((x) => x.code)).not.toContain('dangling-dependency');
  });
});

describe('two leaves with the same name', () => {
  it('warns, because dependencies are declared by title', () => {
    // The resolver keeps the last match, so which one a dependency means is decided by database
    // order rather than by anything anyone intended.
    const w = reviewPlan([leaf({ id: 'a', title: 'Write the mapper' }), leaf({ id: 'b', title: 'write the MAPPER' })], 1);
    expect(w.map((x) => x.code)).toContain('duplicate-title');
  });

  it('ignores a duplicate whose twin has already finished', () => {
    const w = reviewPlan([
      leaf({ id: 'a', title: 'Write the mapper', status: 'failed' }),
      leaf({ id: 'b', title: 'Write the mapper' }),
    ], 1);
    expect(w.map((x) => x.code)).not.toContain('duplicate-title');
  });
});

describe('what the conversation sees', () => {
  it('says nothing at all about a sound plan', () => {
    const sound = [leaf({ id: 'a' }), leaf({ id: 'b', dependsOn: ['a'] })];
    expect(planNotice(reviewPlan(sound, 1))).toBeUndefined();
  });

  it('renders the warnings as a list', () => {
    const text = planNotice(reviewPlan([leaf({ id: 'a' }), leaf({ id: 'b' })], 1))!;
    expect(text).toMatch(/before accepting/i);
    expect(text).toContain('- ');
  });
});

describe('carrying dependents across a replacement', () => {
  it('moves every dependency onto the new leaf', () => {
    // The second intervention: a leaf was replaced and its dependent kept pointing at the dead one.
    const moved = rewireDependents([leaf({ id: 'b', dependsOn: ['old'] })], 'old', 'new');
    expect(moved[0]?.dependsOn).toEqual(['new']);
  });

  it('leaves other dependencies alone', () => {
    const moved = rewireDependents([leaf({ id: 'b', dependsOn: ['old', 'other'] })], 'old', 'new');
    expect(moved[0]?.dependsOn).toEqual(['new', 'other']);
  });

  it('does not name the replacement twice', () => {
    // A leaf that depended on both would otherwise look like it waits on two things that are one.
    const moved = rewireDependents([leaf({ id: 'b', dependsOn: ['old', 'new'] })], 'old', 'new');
    expect(moved[0]?.dependsOn).toEqual(['new']);
  });

  it('returns only the rows that changed', () => {
    const all = [leaf({ id: 'b', dependsOn: ['old'] }), leaf({ id: 'c' })];
    expect(rewireDependents(all, 'old', 'new').map((l) => l.id)).toEqual(['b']);
  });
});
