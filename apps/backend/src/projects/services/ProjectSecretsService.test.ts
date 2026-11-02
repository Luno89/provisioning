import { beforeEach, describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { SecretRequest } from '../lib/secret-requests.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';
import { secretsFromTheDatabaseBehaviour } from '../testing/project-secrets-behaviour.js';
import { ProjectSecretsService, type DeclaredSecretVault } from './ProjectSecretsService.js';

const at = 'then';
let db: Database;
let stored: Map<string, string>;
let minted: string[];
let asked: SecretRequest[];

const shop: TreeTypeSpec = {
  id: 'shop-type', ownerId: 'bo', label: 'Shop', summary: 's', language: 'odoo', produces: 'service', doneMeans: 'd', files: [],
  secrets: [
    { key: 'POSTGRES_PASSWORD', source: 'generated', describe: 'The database password.' },
    { key: 'ODOO_ADMIN_PASSWORD', source: 'generated', describe: 'The admin password.', signInAs: 'admin' },
    { key: 'STRIPE_KEY', source: 'person', describe: 'Your Stripe secret key, from the Stripe dashboard.' },
  ],
};

const project: ProjectMetadata = { id: 'p1', name: 'Shop', ownerId: 'bo', appType: 'gitapp', createdAt: at };

const vault: DeclaredSecretVault = {
  has: async (projectId, key) => stored.has(`${projectId}/${key}`),
  read: async (projectId, key) => stored.get(`${projectId}/${key}`) ?? null,
  put: async (projectId, key, value) => { stored.set(`${projectId}/${key}`, value); },
  mint: async (_ownerId, projectId, key, sourceId) => { minted.push(`${key} from ${sourceId}`); stored.set(`${projectId}/${key}`, `minted-${key}`); },
};

const service = (types: TreeTypeSpec[] = [shop]) => new ProjectSecretsService({
  vault,
  treeTypes: async () => types,
  trees: () => db.projects.getTrees(),
  requests: { list: (ownerId, filter) => db.projects.getSecretRequests(ownerId, filter), save: (request) => db.projects.saveSecretRequest(request) },
  saveProjectInfo: (entry) => db.projects.saveProjectInfo(entry),
  newId: () => 'req-1',
  now: () => at,
  asked: (request) => { asked.push(request); },
});

beforeEach(async () => {
  db = memoryDatabase();
  stored = new Map();
  minted = [];
  asked = [];
  await db.projects.saveProject(project);
  await db.projects.saveTree({ id: 't1', ownerId: 'bo', name: 'Shop', type: 'shop-type', projectIds: ['p1'], createdAt: at, updatedAt: at });
});

describe('the secrets a tree type declares for its project', () => {
  it('mints what the platform makes, asks the person once for the rest on the tree, and records what the project needs', async () => {
    const first = await service().ensure(project);
    expect(minted).toEqual(['POSTGRES_PASSWORD from generated', 'ODOO_ADMIN_PASSWORD from generated']);
    expect(first.waiting).toEqual(['STRIPE_KEY']);
    expect(await db.projects.getSecretRequests('bo', { projectId: 'p1' })).toEqual([{
      id: 'req-1', ownerId: 'bo', projectId: 'p1', key: 'STRIPE_KEY', description: 'Your Stripe secret key, from the Stripe dashboard.',
      secretReference: 'secret://p1/STRIPE_KEY', status: 'requested', treeId: 't1', createdAt: at, updatedAt: at,
    }]);
    expect(asked.map((request) => request.key)).toEqual(['STRIPE_KEY']);
    expect((await db.projects.getProjects()).find((entry) => entry.id === 'p1')?.requiredSecrets).toEqual([
      { key: 'POSTGRES_PASSWORD', source: 'generated' }, { key: 'ODOO_ADMIN_PASSWORD', source: 'generated' }, { key: 'STRIPE_KEY', source: 'person' },
    ]);

    await service().ensure(project);
    expect(minted).toHaveLength(2);
    expect(await db.projects.getSecretRequests('bo', { projectId: 'p1' })).toHaveLength(1);
    expect(asked).toHaveLength(1);
  });

  it('asks nothing for a key the vault already holds', async () => {
    stored.set('p1/STRIPE_KEY', 'sk_live');
    const ensured = await service().ensure(project);
    expect(ensured.waiting).toEqual([]);
    expect(await db.projects.getSecretRequests('bo', { projectId: 'p1' })).toEqual([]);
  });

  it('carries over a value the running app already has instead of making a new one', async () => {
    await service().ensure(project, { seed: async (key) => (key === 'POSTGRES_PASSWORD' ? 'the-running-one' : undefined) });
    expect(stored.get('p1/POSTGRES_PASSWORD')).toBe('the-running-one');
    expect(minted).toEqual(['ODOO_ADMIN_PASSWORD from generated']);
  });

  it('declares what the type given names, whether or not a tree is the project\'s home', async () => {
    const loose: ProjectMetadata = { ...project, id: 'p9', giteaRepo: 'loose' };
    await db.projects.saveProject(loose);
    expect((await service().declared(loose, shop)).map((secret) => secret.key)).toEqual(['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD', 'STRIPE_KEY']);
    expect((await service().declared(project)).map((secret) => secret.key)).toEqual(['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD', 'STRIPE_KEY']);
    expect(await service().declared(loose)).toEqual([]);
    expect(await service().declared({ id: 'p1' })).toEqual([]);
  });

  it('declares nothing for a project with no owner', async () => {
    expect(await service().ensure({ id: 'p9' })).toEqual({ declared: [], waiting: [] });
  });

  it('declares nothing for a project no tree is the home of', async () => {
    expect(await service().ensure({ ...project, id: 'p9' })).toEqual({ declared: [], waiting: [] });
    expect(await service().signIns({ ...project, id: 'p9' })).toEqual([]);
  });

  it('declares nothing when the tree\'s type has no secrets', async () => {
    expect(await service([{ ...shop, secrets: undefined }]).ensure(project)).toEqual({ declared: [], waiting: [] });
    expect(minted).toEqual([]);
  });
});

describe('keeping the vault in step with the running app', () => {
  it('writes a value the vault does not hold as the app has it', async () => {
    stored.set('p1/POSTGRES_PASSWORD', 'old');
    await service().keep('p1', 'POSTGRES_PASSWORD', 'running');
    expect(stored.get('p1/POSTGRES_PASSWORD')).toBe('running');
  });

  it('writes nothing when the vault already has it', async () => {
    const puts: string[] = [];
    stored.set('p1/POSTGRES_PASSWORD', 'running');
    await new ProjectSecretsService({ vault: { ...vault, put: async (_p, key) => { puts.push(key); } }, treeTypes: async () => [], trees: async () => [], requests: { list: async () => [], save: async () => undefined }, saveProjectInfo: async (entry) => ({ ...project, ...entry }) }).keep('p1', 'POSTGRES_PASSWORD', 'running');
    expect(puts).toEqual([]);
  });
});

describe('the sign-ins of a project', () => {
  it('shows the sign-in the type names, from the vault', async () => {
    await service().ensure(project);
    expect(await service().signIns(project)).toEqual([{ login: 'admin', password: 'minted-ODOO_ADMIN_PASSWORD', describe: 'The admin password.' }]);
  });

  it('leaves out a sign-in whose password the vault does not hold', async () => {
    expect(await service().signIns(project)).toEqual([]);
  });

  it('uses what the release itself needs for a project no tree is the home of, and shows its sign-in once that is in the vault', async () => {
    const own = [{ key: 'ODOO_ADMIN_PASSWORD', source: 'generated' as const, describe: 'The admin password.', signInAs: 'admin' }];
    const loose = { ...project, id: 'p9', giteaRepo: 'loose' };
    await db.projects.saveProject(loose);
    expect((await service().ensure(loose, { fallback: own })).declared).toEqual(own);
    const saved = (await db.projects.getProjects()).find((entry) => entry.id === 'p9')!;
    expect(await service().signIns(saved, own)).toEqual([{ login: 'admin', password: 'minted-ODOO_ADMIN_PASSWORD', describe: 'The admin password.' }]);
    expect(await service().signIns(loose, own)).toEqual([]);
  });
});

secretsFromTheDatabaseBehaviour(async () => memoryDatabase());
