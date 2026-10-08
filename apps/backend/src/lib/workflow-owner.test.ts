import { describe, it, expect } from 'vitest';
import { mayTouch, ownedQuery, ownerIn, startedFor, withinQuery, workflowScope } from './workflow-owner.js';

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
  const bo = { id: 'bo' };
  const admin = { id: 'ada', isAdmin: true };

  it('shows anyone only their own, even when they ask for everything', () => {
    expect(workflowScope(bo, undefined, undefined)).toEqual({ all: false, query: 'KoalaOwner = "bo"' });
    expect(workflowScope(bo, 'all', undefined)).toEqual({ all: false, query: 'KoalaOwner = "bo"' });
  });

  it('shows an admin their own until they switch to the platform view', () => {
    expect(workflowScope(admin, undefined, undefined).all).toBe(false);
    expect(workflowScope(admin, 'all', undefined)).toEqual({ all: true, query: undefined });
  });

  it('shows the owner of an instance everything on it, unless they ask for their own', () => {
    expect(workflowScope(bo, undefined, 'bo')).toEqual({ all: true, query: undefined });
    expect(workflowScope(bo, 'mine', 'bo').all).toBe(false);
    expect(workflowScope({ id: 'cy' }, 'all', 'bo').all).toBe(false);
  });

  it('lets someone touch their own workflow, and an admin or instance owner any', () => {
    expect(mayTouch(bo, 'bo', undefined)).toBe(true);
    expect(mayTouch(bo, 'cy', undefined)).toBe(false);
    expect(mayTouch(bo, undefined, undefined)).toBe(false);
    expect(mayTouch(admin, 'cy', undefined)).toBe(true);
    expect(mayTouch(bo, 'platform', 'bo')).toBe(true);
  });
});
