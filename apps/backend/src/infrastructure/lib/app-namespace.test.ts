import { describe, expect, it } from 'vitest';
import { namespaceOf, newAppNamespace, sameOwner, deployRequestFrom, MADE_BY_KOALA_APP_TYPES, platformNamespaceProblem, podLogTarget } from './app-namespace.js';
import { ODOO_PROJECT_APP } from '../../releases/lib/odoo-release.js';

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

describe('a deploy someone asks for', () => {
  it('never names its own namespace or id, since destroying it would delete what those name', () => {
    expect(deployRequestFrom({ name: 'shop', appType: 'odoo', clusterId: 'c1', namespace: 'gitea', id: 'someone-elses' })).toEqual({ request: { name: 'shop', appType: 'odoo', clusterId: 'c1' } });
  });

  it('is never an app Koala makes from a project', () => {
    expect(deployRequestFrom({ name: 'x', appType: 'odoo-project' })).toEqual({ problem: 'a odoo-project app is made by Koala from its project, never deployed by hand' });
    expect(deployRequestFrom({ name: 'x', appType: 'gitapp' })).toMatchObject({ problem: expect.stringContaining('gitapp') });
    expect(MADE_BY_KOALA_APP_TYPES.has(ODOO_PROJECT_APP)).toBe(true);
  });
});

describe('destroying an app', () => {
  it('never deletes a namespace of the platform\'s, whatever its record says', () => {
    const platform = new Set(['gitea', 'monitoring']);
    for (const namespace of ['gitea', 'monitoring', 'default', 'kube-system']) expect(platformNamespaceProblem(namespace, platform)).toMatch(/platform's own namespace/);
    expect(platformNamespaceProblem('shop-1a2b3c', platform)).toBeUndefined();
  });
});

describe('a model server someone deploys', () => {
  it('keeps its cache in a folder of its own, never a path on the host', () => {
    expect(deployRequestFrom({ name: 'llm', appType: 'vllm', vllmCachePvc: '/' })).toMatchObject({ problem: expect.stringMatching(/folder name/) });
    expect(deployRequestFrom({ name: 'llm', appType: 'tabbyapi', tabbyCachePvc: '/etc' })).toMatchObject({ problem: expect.stringMatching(/folder name/) });
    expect(deployRequestFrom({ name: 'llm', appType: 'tabbyapi', tabbyCachePvc: 'my-models' })).toEqual({ request: { name: 'llm', appType: 'tabbyapi', tabbyCachePvc: 'my-models' } });
  });
});

describe('following a pod\'s logs', () => {
  const shop = { name: 'shop', namespace: 'shop-1a2b3c' };
  it('reads only the app\'s own namespace, and only a pod by its name', () => {
    expect(podLogTarget(shop, { podName: 'shop-web-5d8f9-abcde' })).toEqual({ namespace: 'shop-1a2b3c', podName: 'shop-web-5d8f9-abcde' });
    expect(podLogTarget(shop, { podName: 'shop-web', namespace: 'shop-1a2b3c' })).toEqual({ namespace: 'shop-1a2b3c', podName: 'shop-web' });
    expect(podLogTarget(shop, { podName: 'gitea-0', namespace: 'gitea' })).toBeUndefined();
    for (const podName of ['--selector=app=gitea', '-n', 'a b', '', undefined, 'UPPER']) expect(podLogTarget(shop, { podName }), String(podName)).toBeUndefined();
  });
});
