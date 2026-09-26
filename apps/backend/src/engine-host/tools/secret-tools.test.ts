import { describe, it, expect } from 'vitest';
import { createSecretTools, type SecretVault } from './secret-tools.js';
import type { SecretRequest } from '../../lib/secret-requests.js';
import type { ProjectMetadata } from '../../lib/types.js';
import type { Tree } from '../../lib/trees.js';

function world(vault?: SecretVault) {
  const requests: SecretRequest[] = [];
  const projects: ProjectMetadata[] = [
    { id: 'p1', name: 'billing', ownerId: 'u1', appType: 'gitapp', createdAt: 'now' },
    { id: 'p2', name: 'theirs', ownerId: 'u2', appType: 'gitapp', createdAt: 'now' },
  ];
  const trees: Tree[] = [{ id: 't1', ownerId: 'u1', name: 'Billing', type: 'application', goal: 'Pay', projectIds: ['p1'], createdAt: 'now', updatedAt: 'now' }];
  let n = 0;
  const handlers = createSecretTools({
    ...(vault ? { vault } : {}),
    newId: () => `r${++n}`,
    now: () => '2026-09-26T00:00:00Z',
    stores: {
      requests: {
        list: async (ownerId, filter) => requests.filter((r) => r.ownerId === ownerId && (!filter?.projectId || r.projectId === filter.projectId)),
        save: async (request) => {
          const at = requests.findIndex((r) => r.id === request.id);
          if (at >= 0) requests[at] = request; else requests.push(request);
        },
      },
      projects: {
        list: async () => projects,
        save: async (project) => { projects[projects.findIndex((p) => p.id === project.id)] = project; },
      },
      trees: { list: async () => trees },
      binding: async (_ownerId, conversationId) => (conversationId === 'c-tree' ? { treeId: 't1' } : undefined),
    },
  });
  const ask = (parsed: Record<string, unknown>, caller: Record<string, string> = { ownerId: 'u1', conversationId: 'c-tree' }) =>
    handlers.request_secret!({ name: 'request_secret', parsed, driver: undefined, caller });
  return { ask, requests, projects };
}

describe('request_secret', () => {
  it('asks the person through a stored request, finding the project from the conversation\'s tree', async () => {
    const { ask, requests } = world();
    const out = await ask({ key: 'STRIPE_API_KEY', description: 'The live key' });

    expect(out.ok).toBe(true);
    expect(out.content).toContain('reference: secret://p1/STRIPE_API_KEY');
    expect(out.content).toContain('status: requested');
    expect(requests).toMatchObject([{ projectId: 'p1', key: 'STRIPE_API_KEY', status: 'requested', treeId: 't1', conversationId: 'c-tree' }]);
  });

  it('files a request from a run with no conversation under the tree that owns the project', async () => {
    const { ask, requests } = world();
    await ask({ key: 'STRIPE_API_KEY', description: 'The live key' }, { ownerId: 'u1', projectId: 'p1' });
    expect(requests[0]).toMatchObject({ projectId: 'p1', treeId: 't1' });
    expect(requests[0]!.conversationId).toBeUndefined();
  });

  it('does not ask twice for a key that is already waiting', async () => {
    const { ask, requests } = world();
    await ask({ key: 'STRIPE_API_KEY', description: 'The live key' });
    const again = await ask({ key: 'STRIPE_API_KEY', description: 'Again' });
    expect(again.content).toContain('already waiting');
    expect(requests).toHaveLength(1);
  });

  it('reports a key the vault already holds without creating a request', async () => {
    const { ask, requests } = world({ has: async () => true, mint: async () => undefined });
    const out = await ask({ key: 'STRIPE_API_KEY', description: 'The live key' });
    expect(out.content).toContain('status: provided');
    expect(requests).toHaveLength(0);
  });

  it('provisions a key a source can mint, records where it came from, and returns no value', async () => {
    const minted: string[] = [];
    const { ask, requests, projects } = world({ has: async () => false, mint: async (_o, projectId, key, source) => { minted.push(`${projectId}/${key}/${source}`); } });
    const out = await ask({ key: 'GITEA_TOKEN', description: 'Clone at run time' });

    expect(minted).toEqual(['p1/GITEA_TOKEN/gitea-read-token']);
    expect(out.content).toContain('status: provisioned');
    expect(requests[0]).toMatchObject({ status: 'provisioned', source: 'gitea-read-token' });
    expect(projects[0]!.requiredSecrets).toEqual([{ key: 'GITEA_TOKEN', source: 'gitea-read-token' }]);
  });

  it('falls back to asking the person when minting fails', async () => {
    const { ask, requests } = world({ has: async () => false, mint: async () => { throw new Error('gitea down'); } });
    const out = await ask({ key: 'GITEA_TOKEN', description: 'Clone at run time' });
    expect(out.content).toContain('status: requested');
    expect(requests[0]!.status).toBe('requested');
  });

  it('refuses a value, a bad name, a missing description, no project, and someone else\'s project', async () => {
    const { ask, requests } = world();
    expect((await ask({ key: 'X', description: 'd', value: 'hunter2' })).digest).toContain('never send a secret value');
    expect((await ask({ key: 'stripe-key', description: 'd' })).digest).toContain('not an environment variable name');
    expect((await ask({ key: 'STRIPE_KEY' })).digest).toContain('say what the secret is for');
    expect((await ask({ key: 'STRIPE_KEY', description: 'd' }, { ownerId: 'u1' })).digest).toContain('about none');
    expect((await ask({ key: 'STRIPE_KEY', description: 'd', projectId: 'p2' })).digest).toContain('no such project');
    expect(requests).toHaveLength(0);
  });
});
