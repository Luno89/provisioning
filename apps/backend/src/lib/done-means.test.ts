import { describe, it, expect } from 'vitest';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';
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
    for (const t of TREE_TYPE_SEEDS) {
      expect(t.doneMeans, t.id).toBeTruthy();
    }
  });

  it('says the deployable ones must actually respond', () => {
    // The distinction that matters: a service is not finished when its tests pass.
    expect(TREE_TYPE_SEEDS.find((t) => t.id === 'api-service')!.doneMeans).toMatch(/endpoint responds/);
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
    /**
     * Validity moved to the store: types are owned records, so "is this a type" is a question about
     * an owner's data rather than about a compile-time union. Covered by `tree-types.test.ts`'s
     * resolution cases; what stays here is that the SEEDS are self-consistent.
     */
    expect(TREE_TYPE_SEEDS.some((t) => t.id === 'api-service')).toBe(true);
    expect(TREE_TYPE_SEEDS.some((t) => t.id === 'whatever-i-typed')).toBe(false);
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


describe('verifying something that depends on a service', () => {
  /**
   * ── WHY THE TRIGGER IS A FACT, NOT A JUDGEMENT ──
   * "Test it harder when it looks risky" is an assessment a model re-makes every run and answers
   * differently — the same failure mode as "check first", which a model obeys while still designing
   * around whatever it found missing. Whether a project has DEPENDENCIES is observable.
   *
   * It is also exactly the case nothing else can cover: a leaf's sandbox has no binding, so code
   * reading $SERVICE_BINDING_ROOT can only be exercised where the binding exists — the deployed
   * service.
   */
  it('says a sandbox cannot verify a binding', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/sandbox CANNOT verify the connection/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/bindings exist only in the deployed service/);
  });

  it('names the mechanism that makes the call possible', () => {
    // `mcp` on the leaf is what hands it the deployed service's tools; without it the leaf can only
    // guess at raw HTTP.
    expect(PLAN_SYSTEM_PROMPT).toMatch(/name the service in its `mcp`/);
  });

  it('ties it to the declaration, not to a feeling', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/anything you declared with add_project_dependency/);
  });

  it('still lets the planner escalate on judgement', () => {
    // The observable trigger is the floor, not the ceiling — some assembled results fail in ways
    // their pieces cannot, and no field predicts that.
    expect(PLAN_SYSTEM_PROMPT).toMatch(/fail in ways the individual pieces cannot/);
  });
});
