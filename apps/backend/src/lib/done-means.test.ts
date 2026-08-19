import { describe, it, expect } from 'vitest';
import { TREE_TYPES, treeTypeSpec, isTreeType } from './trees.js';
import { buildOutboundMessages } from './leaf-context.js';
import { PLAN_SYSTEM_PROMPT } from './plan-mode.js';

/**
 * A project type's definition of finished, made load-bearing.
 *
 * ── WHY THIS WAS WORTH FINDING ──
 * Eleven types have carried a `doneMeans` since trees were introduced and NOTHING read one.
 * `api-service` has said "its tests pass, it builds, it deploys, and the endpoint responds" the
 * whole time, while planners wrote whatever acceptance occurred to them — which is how one run
 * ended with `echo` as its only check, and another with a check that died on ERR_MODULE_NOT_FOUND
 * because nothing installed dependencies first.
 *
 * The standard was already written down. It just was not being applied.
 */

describe('every type says what finished means', () => {
  it('leaves none unsaid', () => {
    for (const t of TREE_TYPES) {
      expect(treeTypeSpec(t.id).doneMeans, t.id).toBeTruthy();
    }
  });

  it('says the deployable ones must actually respond', () => {
    // The distinction that matters: a service is not finished when its tests pass.
    expect(treeTypeSpec('api-service').doneMeans).toMatch(/endpoint responds/);
  });
});

describe('it reaches the planning turn', () => {
  const compose = (doneMeans?: string) => buildOutboundMessages({
    messages: [{ role: 'user', content: 'plan it' }],
    lastIndex: 0,
    prompt: 'PLAN',
    leaves: [],
    siblingLeaves: [],
    siblingBranches: [],
    ...(doneMeans ? { doneMeans } : {}),
  } as any);

  it('is in the system message when the tree has a type', () => {
    const sent = compose('service whose endpoint responds');
    expect(JSON.stringify(sent)).toContain('service whose endpoint responds');
  });

  it('changes nothing when there is none', () => {
    // An untyped tree, or a branch outside one, must plan exactly as before.
    expect(JSON.stringify(compose())).not.toContain('This project is a');
  });

  it('is only reachable through a real type', () => {
    // The type arrives as untrusted JSON; an invented one must not look up.
    expect(isTreeType('api-service')).toBe(true);
    expect(isTreeType('whatever-i-typed')).toBe(false);
  });
});

describe('the plan rules that came out of the failed run', () => {
  it('asks for checks as an ordered sequence', () => {
    /**
     * The observed failure: `node verify-cache.js` as the only check, dying on
     * ERR_MODULE_NOT_FOUND because nothing installed dependencies. It tested nothing.
     */
    expect(PLAN_SYSTEM_PROMPT).toMatch(/install dependencies, then build or test, then run/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/fails on a missing package and/);
  });

  it('asks for a final leaf that exercises the finished thing', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/End the plan with a leaf that exercises the FINISHED thing/);
    // With `expects`, so its success is a file rather than a claim.
    expect(PLAN_SYSTEM_PROMPT).toMatch(/Name what it must produce in\s*\n?\s*`expects`/);
  });
});
