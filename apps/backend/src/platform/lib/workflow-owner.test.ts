import { describe, it, expect } from 'vitest';
import { mayTouch, ownedQuery, ownerIn, startedFor, withinQuery, workflowScope } from './workflow-owner.js';
import { principalOf } from './permissions.js';

describe('whose a workflow is', () => {
  it('is stamped on the start, and read back from its search attributes', () => {
    expect(ownerIn(startedFor('bo').typedSearchAttributes)).toBe('bo');
    expect(ownerIn([])).toBeUndefined();
    expect(ownerIn(undefined)).toBeUndefined();
  });

  it('builds a query Temporal can filter on, which no id can break out of', () => {
    expect(ownedQuery('bo')).toBe('KoalaOwner = "bo"');
    expect(ownedQuery('bo" OR KoalaOwner != "x')).toBe('KoalaOwner = "bo OR KoalaOwner != x"');
    expect(withinQuery(ownedQuery('bo'), 'ExecutionStatus="Running"')).toBe('(KoalaOwner = "bo") AND (ExecutionStatus="Running")');
    expect(withinQuery(undefined, '')).toBeUndefined();
    expect(withinQuery(ownedQuery('bo'), undefined)).toBe('KoalaOwner = "bo"');
  });
});

describe('what a person sees on the Temporal page', () => {
  const combined = (user: { id: string; isAdmin?: boolean }) => principalOf(user, { role: 'combined' });
  const onInstanceOf = (owner: string) => (user: { id: string }) => principalOf(user, { role: 'instance', instanceOwnerId: owner });
  const bo = combined({ id: 'bo' });
  const admin = combined({ id: 'ada', isAdmin: true });

  it('shows anyone only their own, even when they ask for everything', () => {
    expect(workflowScope(bo, undefined)).toEqual({ all: false, query: 'KoalaOwner = "bo"' });
    expect(workflowScope(bo, 'all')).toEqual({ all: false, query: 'KoalaOwner = "bo"' });
  });

  it('shows an admin their own until they switch to the platform view', () => {
    expect(workflowScope(admin, undefined).all).toBe(false);
    expect(workflowScope(admin, 'all')).toEqual({ all: true, query: undefined });
  });

  it('shows the owner of an instance everything on it, unless they ask for their own', () => {
    const owner = onInstanceOf('bo')({ id: 'bo' });
    expect(workflowScope(owner, undefined)).toEqual({ all: true, query: undefined });
    expect(workflowScope(owner, 'mine').all).toBe(false);
    expect(workflowScope(onInstanceOf('bo')({ id: 'cy' }), 'all').all).toBe(false);
  });

  it('lets someone touch their own workflow, and an admin or instance owner any', () => {
    expect(mayTouch(bo, 'bo')).toBe(true);
    expect(mayTouch(bo, 'cy')).toBe(false);
    expect(mayTouch(bo, undefined)).toBe(false);
    expect(mayTouch(admin, 'cy')).toBe(true);
    expect(mayTouch(onInstanceOf('bo')({ id: 'bo' }), 'platform')).toBe(true);
  });

  it('ignores a stamped isAdmin on an instance, where only its owner is the operator', () => {
    expect(mayTouch(principalOf({ id: 'cy', isAdmin: true }, { role: 'instance', instanceOwnerId: 'bo' }), 'platform')).toBe(false);
  });
});
