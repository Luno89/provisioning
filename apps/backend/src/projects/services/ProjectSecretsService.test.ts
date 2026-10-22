import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../../platform/lib/memory-db.js';
import { ProjectSecretsService } from './ProjectSecretsService.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';

const at = 'then';
let db: MemoryDB;
let stored: Map<string, string>;
let minted: string[];

const shop: TreeTypeSpec = {
  id: 'shop-type', ownerId: 'bo', label: 'Shop', summary: 's', language: 'odoo', produces: 'service', doneMeans: 'd', files: [],
  secrets: [
    { key: 'POSTGRES_PASSWORD', source: 'generated', describe: 'The database password.' },
    { key: 'ODOO_ADMIN_PASSWORD', source: 'generated', describe: 'The admin password.', signInAs: 'admin' },
    { key: 'STRIPE_KEY', source: 'person', describe: 'Your Stripe secret key, from the Stripe dashboard.' },
  ],
};

const project: ProjectMetadata = { id: 'p1', name: 'Shop', ownerId: 'bo', appType: 'gitapp', createdAt: at };

const service = () => new ProjectSecretsService({
  vault: {
    has: async (projectId, key) => stored.has(`${projectId}/${key}`),
    read: async (projectId, key) => stored.get(`${projectId}/${key}`) ?? null,
    put: async (projectId, key, value) => { stored.set(`${projectId}/${key}`, value); },
    mint: async (_ownerId, projectId, key, sourceId) => { minted.push(`${key} from ${sourceId}`); stored.set(`${projectId}/${key}`, `minted-${key}`); },
  },
  treeTypes: async () => [shop],
  trees: () => db.getTrees(),
  requests: { list: (ownerId, filter) => db.getSecretRequests(ownerId, filter), save: (request) => db.saveSecretRequest(request) },
  saveProjectInfo: (entry) => db.saveProjectInfo(entry),
  newId: () => 'req-1',
  now: () => at,
});

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
  stored = new Map();
  minted = [];
  await db.saveProject(project);
  await db.saveTree({ id: 't1', ownerId: 'bo', name: 'Shop', type: 'shop-type', projectIds: ['p1'], createdAt: at, updatedAt: at } as never);
});

describe('the secrets a tree type declares for its project', () => {
  it('mints what the platform makes, asks the person once for the rest on the tree, and records what the project needs', async () => {
    const first = await service().ensure(project);
    expect(minted).toEqual(['POSTGRES_PASSWORD from generated', 'ODOO_ADMIN_PASSWORD from generated']);
    expect(first.waiting).toEqual(['STRIPE_KEY']);
    expect(await db.getSecretRequests('bo', { projectId: 'p1' })).toEqual([expect.objectContaining({ key: 'STRIPE_KEY', status: 'requested', treeId: 't1', secretReference: 'secret://p1/STRIPE_KEY' })]);
    expect((await db.getProjects()).find((entry) => entry.id === 'p1')?.requiredSecrets).toEqual([
      { key: 'POSTGRES_PASSWORD', source: 'generated' }, { key: 'ODOO_ADMIN_PASSWORD', source: 'generated' }, { key: 'STRIPE_KEY', source: 'person' },
    ]);

    await service().ensure(project);
    expect(minted).toHaveLength(2);
    expect(await db.getSecretRequests('bo', { projectId: 'p1' })).toHaveLength(1);
  });

  it('carries over a value the running app already has instead of making a new one', async () => {
    await service().ensure(project, { seed: async (key) => (key === 'POSTGRES_PASSWORD' ? 'the-running-one' : undefined) });
    expect(stored.get('p1/POSTGRES_PASSWORD')).toBe('the-running-one');
    expect(minted).toEqual(['ODOO_ADMIN_PASSWORD from generated']);
  });

  it('keeps the vault in step with the running app', async () => {
    stored.set('p1/POSTGRES_PASSWORD', 'old');
    await service().keep('p1', 'POSTGRES_PASSWORD', 'running');
    expect(stored.get('p1/POSTGRES_PASSWORD')).toBe('running');
  });

  it('shows the sign-in the type names, from the vault', async () => {
    await service().ensure(project);
    expect(await service().signIns(project)).toEqual([{ login: 'admin', password: 'minted-ODOO_ADMIN_PASSWORD', describe: 'The admin password.' }]);
  });

  it('uses what the release itself needs for a project no tree is the home of, and shows its sign-in once that is in the vault', async () => {
    const own = [{ key: 'ODOO_ADMIN_PASSWORD', source: 'generated' as const, describe: 'The admin password.', signInAs: 'admin' }];
    const loose = { ...project, id: 'p9' };
    await db.saveProject(loose);
    expect((await service().ensure(loose, { fallback: own })).declared).toEqual(own);
    const saved = (await db.getProjects()).find((entry) => entry.id === 'p9')!;
    expect(await service().signIns(saved, own)).toEqual([{ login: 'admin', password: 'minted-ODOO_ADMIN_PASSWORD', describe: 'The admin password.' }]);
    expect(await service().signIns(loose, own)).toEqual([]);
  });

  it('declares nothing for a project no tree is the home of', async () => {
    expect(await service().ensure({ ...project, id: 'p9' })).toEqual({ declared: [], waiting: [] });
    expect(await service().signIns({ ...project, id: 'p9' })).toEqual([]);
  });
});
