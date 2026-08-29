import { describe, it, expect } from 'vitest';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';
import { buildOutboundMessages } from './leaf-context.js';
import { PLAN_SYSTEM_PROMPT } from './plan-mode.js';

describe('every type says what finished means', () => {
  it('leaves none unsaid', () => {
    for (const t of TREE_TYPE_SEEDS) {
      expect(t.doneMeans, t.id).toBeTruthy();
    }
  });

  it('says the deployable ones must actually respond', () => {
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
    expect(JSON.stringify(compose())).not.toContain('This project is a');
  });

  it('is only reachable through a real type', () => {
    expect(TREE_TYPE_SEEDS.some((t) => t.id === 'api-service')).toBe(true);
    expect(TREE_TYPE_SEEDS.some((t) => t.id === 'whatever-i-typed')).toBe(false);
  });
});

describe('the plan rules that came out of the failed run', () => {
  it('asks for checks as an ordered sequence', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/install dependencies, then build or test, then run/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/fails on a missing package and/);
  });

  it('asks for a final leaf that exercises the finished thing', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/End the plan with a leaf that exercises the FINISHED thing/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/Name what it must produce in\s*\n?\s*`expects`/);
  });
});

describe('verifying something that depends on a service', () => {
  it('says a sandbox cannot verify a binding', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/sandbox CANNOT verify the connection/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/bindings exist only in the deployed service/);
  });

  it('names the mechanism that makes the call possible', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/name the service in its `mcp`/);
  });

  it('ties it to the declaration, not to a feeling', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/anything you declared with add_project_dependency/);
  });

  it('still lets the planner escalate on judgement', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/fail in ways the individual pieces cannot/);
  });
});
