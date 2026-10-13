import { describe, it, expect } from 'vitest';
import { releaseNamespace } from './OdooReleaseActivities.js';

describe('the namespace a release is installed in', () => {
  it('carries its owner and project, so removing either finds it', () => {
    expect(releaseNamespace({ namespace: 'shop-1a2b3c', owner: { ownerId: 'BO_1', projectId: 'project-p1' } })).toEqual({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'shop-1a2b3c', labels: { 'koala.dev/owner': 'bo_1', 'koala.dev/project': 'project-p1' } },
    });
  });

  it('is still named for a release started before releases said whose they are', () => {
    expect(releaseNamespace({ namespace: 'shop' })).toEqual({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } });
  });
});
