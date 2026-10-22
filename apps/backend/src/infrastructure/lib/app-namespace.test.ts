import { describe, expect, it } from 'vitest';
import { namespaceOf, newAppNamespace, sameOwner } from './app-namespace.js';

describe('an app\'s namespace', () => {
  it('is the stored one, or the sanitized name for an app deployed before namespaces were stored', () => {
    expect(namespaceOf({ name: 'My Shop', namespace: 'my-shop-1a2b3c' })).toBe('my-shop-1a2b3c');
    expect(namespaceOf({ name: 'My Shop' })).toBe('my-shop');
  });

  it('is made from the name and the deployment\'s id, so two owners\' apps of one name never share one', () => {
    const a = newAppNamespace('shop', '1a2b3c4d-0000-4000-8000-000000000000');
    const b = newAppNamespace('shop', 'ffeedd00-0000-4000-8000-000000000000');
    expect(a).toBe('shop-1a2b3c');
    expect(b).toBe('shop-ffeedd');
    expect(a).not.toBe(b);
  });

  it('stays a valid namespace name for a long or odd name', () => {
    const made = newAppNamespace('My Very Long Application Name That Goes On And On For Longer Than Kubernetes Allows', 'abcdef123456');
    expect(made.length).toBeLessThanOrEqual(63);
    expect(made).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(made.endsWith('-abcdef')).toBe(true);
    expect(newAppNamespace('???', 'abcdef123456')).toBe('app-abcdef');
  });

  it('tells whether a record is the same owner\'s, counting no owner as one owner', () => {
    expect(sameOwner({ ownerId: 'ann' }, 'ann')).toBe(true);
    expect(sameOwner({ ownerId: 'ann' }, 'bob')).toBe(false);
    expect(sameOwner({}, undefined)).toBe(true);
    expect(sameOwner({ ownerId: 'ann' }, undefined)).toBe(false);
  });
});
