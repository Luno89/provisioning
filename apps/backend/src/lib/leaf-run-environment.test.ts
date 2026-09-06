import { describe, it, expect, vi } from 'vitest';
import { resolveLeafRepo, resolveLeafBindings } from './leaf-run-environment.js';
import type { Leaf } from './leaves.js';
import type { ProjectMetadata } from './types.js';
import { MINIO_SPEC } from './app-spec.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'branch-abc-123', title: 't', body: '',
  column: 'todo', status: 'pending', depth: 0, blocking: true,
  createdAt: '', updatedAt: '', ...over,
} as Leaf);

const project: ProjectMetadata = {
  id: 'p1', ownerId: 'u1', giteaOwner: 'koala-u1', giteaRepo: 'koala-request-brancha', name: 'n',
  appType: 'gitapp', createdAt: '',
};

const repoDeps = (over: Record<string, unknown> = {}) => ({
  db: {
    getProjects: vi.fn(async () => [project]),
    saveProject: vi.fn(async () => undefined),
    getTrees: vi.fn(async () => []),
    saveTree: vi.fn(async () => undefined),
  },
  gitea: {
    internalBaseUrl: 'http://gitea-internal',
    getRepo: vi.fn(async () => ({})),
    createRepoForUser: vi.fn(async () => ({})),
    seedTemplate: vi.fn(async () => []),
  },
  infra: {
    runKubectl: vi.fn(async () => '10.0.0.1'),
  },
  projectRepos: {
    ensureAccountFor: vi.fn(async () => ({ username: 'koala-u1' })),
    checkoutCredential: vi.fn(async () => ({ cloneUrl: 'https://x@gitea/koala-u1/repo.git', tokenName: 'tok', username: 'koala-u1' })),
    ensureShippable: vi.fn(async () => ({ problems: [] })),
  },
  newId: () => 'new-id',
  ...over,
} as any);

describe('resolveLeafRepo', () => {
  it('skips checkout entirely when the leaf writes no files', async () => {
    const deps = repoDeps();
    const out = await resolveLeafRepo(deps, leaf(), undefined, undefined, false, false);

    expect(out).toEqual({ project: undefined, checkout: undefined, giteaBaseUrl: '' });
    expect(deps.projectRepos.checkoutCredential).not.toHaveBeenCalled();
  });

  it('resolves a project and a checkout credential when the leaf wants a repo', async () => {
    const deps = repoDeps();
    const out = await resolveLeafRepo(deps, leaf(), undefined, undefined, false, true);

    expect(out.project?.id).toBe('p1');
    expect(out.checkout?.tokenName).toBe('tok');
    expect(out.giteaBaseUrl).toBe('http://gitea-internal');
  });

  it('wires the project for builds only when it produces code', async () => {
    const deps = repoDeps();
    await resolveLeafRepo(deps, leaf(), undefined, undefined, true, true);
    expect(deps.projectRepos.ensureShippable).toHaveBeenCalled();

    deps.projectRepos.ensureShippable.mockClear();
    await resolveLeafRepo(deps, leaf(), undefined, undefined, false, true);
    expect(deps.projectRepos.ensureShippable).not.toHaveBeenCalled();
  });

  it('returns nothing, rather than throwing, when checkout fails — a leaf with no repo does not fail the run', async () => {
    const deps = repoDeps({
      projectRepos: {
        ensureAccountFor: vi.fn(async () => ({ username: 'koala-u1' })),
        checkoutCredential: vi.fn(async () => { throw new Error('gitea unreachable'); }),
        ensureShippable: vi.fn(async () => ({ problems: [] })),
      },
    });

    const out = await resolveLeafRepo(deps, leaf(), undefined, undefined, true, true);
    expect(out).toEqual({ project: undefined, checkout: undefined, giteaBaseUrl: '' });
  });

  it('seeds the tree type\'s starter files into a fresh repo', async () => {
    const deps = repoDeps();
    const treeType = { id: 'x', label: 'X', files: [{ path: 'package.json', content: '{}' }] } as any;
    deps.gitea.seedTemplate.mockResolvedValue(['package.json']);

    await resolveLeafRepo(deps, leaf(), undefined, treeType, false, true);
    expect(deps.gitea.seedTemplate).toHaveBeenCalledWith('koala-u1', 'koala-request-brancha', [{ path: 'package.json', content: '{}' }]);
  });
});

describe('resolveLeafBindings', () => {
  it('returns nothing when the leaf needs nothing', async () => {
    const deps = { db: { getBindingTypes: vi.fn(), getDeployments: vi.fn(), getAppSpecs: vi.fn() } } as any;
    const out = await resolveLeafBindings(deps, 'l1', [], 'u1');
    expect(out).toEqual({ bindings: [] });
    expect(deps.db.getDeployments).not.toHaveBeenCalled();
  });

  it('resolves a binding against a matching deployment', async () => {
    const deps = {
      db: {
        getBindingTypes: vi.fn(async () => []),
        getDeployments: vi.fn(async () => [
          { name: 'my-minio', appType: 'minio', status: 'running', ownerId: 'u1' },
        ]),
        getAppSpecs: vi.fn(async () => [{ id: 'minio', spec: MINIO_SPEC }]),
      },
    } as any;

    const out = await resolveLeafBindings(deps, 'l1', [{ service: 'my-minio' }], 'u1');
    expect(out.bindings.length).toBe(1);
    expect(out.bindings[0]?.host).toBe('minio.my-minio.svc.cluster.local');
  });

  it('returns nothing, not a throw, when resolution itself errors', async () => {
    const deps = {
      db: {
        getBindingTypes: vi.fn(async () => { throw new Error('db down'); }),
        getDeployments: vi.fn(async () => { throw new Error('db down'); }),
        getAppSpecs: vi.fn(async () => []),
      },
    } as any;

    const out = await resolveLeafBindings(deps, 'l1', [{ service: 'mongo' }], 'u1');
    expect(out).toEqual({ bindings: [] });
  });
});
