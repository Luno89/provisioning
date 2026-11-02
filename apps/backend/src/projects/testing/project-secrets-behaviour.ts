import { describe, expect, it } from 'vitest';
import type { Database } from '../../platform/lib/db-interface.js';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { SecretRequest } from '../lib/secret-requests.js';
import type { TreeTypeSpec } from '../lib/tree-types.js';
import { projectSecretsFor } from '../services/ProjectSecretsService.js';

const at = 'then';

const shop: TreeTypeSpec = {
  id: 'shop-type', ownerId: 'bo', label: 'Shop', summary: 's', language: 'odoo', produces: 'service', doneMeans: 'd', files: [],
  secrets: [
    { key: 'POSTGRES_PASSWORD', source: 'generated', describe: 'The database password.' },
    { key: 'ODOO_ADMIN_PASSWORD', source: 'generated', describe: 'The admin password.', signInAs: 'admin' },
    { key: 'STRIPE_KEY', source: 'person', describe: 'Your Stripe secret key, from the Stripe dashboard.' },
  ],
};

const project: ProjectMetadata = { id: 'p1', name: 'Shop', ownerId: 'bo', appType: 'gitapp', createdAt: at };

async function stored(make: () => Promise<Database>): Promise<Database> {
  const db = await make();
  await db.projects.saveProject(project);
  await db.projects.saveTree({ id: 't1', ownerId: 'bo', name: 'Shop', type: 'shop-type', projectIds: ['p1'], createdAt: at, updatedAt: at });
  await db.projects.saveTreeType(shop);
  return db;
}

export function secretsFromTheDatabaseBehaviour(make: () => Promise<Database>): void {
  describe('the secrets service built from the database and the vault backend', () => {
    it('mints, reads and keeps through the backend, and asks the person through the store', async () => {
      const db = await stored(make);
      const asked: SecretRequest[] = [];
      const held = new Map<string, string>();
      const backendCalls: string[] = [];
      const secrets = projectSecretsFor({
        db: db.projects,
        backend: {
          hasSecret: async (projectId, key) => held.has(`${projectId}/${key}`),
          getSecret: async (projectId, key) => held.get(`${projectId}/${key}`) ?? null,
          listSecrets: async () => [],
          setSecret: async (projectId, key, value, comment) => { backendCalls.push(`${key}: ${comment ?? ''}`); held.set(`${projectId}/${key}`, value); return { secretReference: `secret://${projectId}/${key}` }; },
        },
        readToken: async () => 'tok',
        asked: (request) => { asked.push(request); },
      });
      const ensured = await secrets.ensure(project);
      expect(ensured.waiting).toEqual(['STRIPE_KEY']);
      expect(held.get('p1/POSTGRES_PASSWORD')).toMatch(/^[A-Za-z0-9]{32}$/);
      expect(backendCalls).toEqual(['POSTGRES_PASSWORD: Provisioned automatically: a random value the platform made', 'ODOO_ADMIN_PASSWORD: Provisioned automatically: a random value the platform made']);
      expect(asked.map((request) => request.key)).toEqual(['STRIPE_KEY']);
      expect((await db.projects.getSecretRequests('bo', { projectId: 'p1' })).map((request) => request.key)).toEqual(['STRIPE_KEY']);
      expect((await db.projects.getProjects()).find((entry) => entry.id === 'p1')?.requiredSecrets).toEqual([
        { key: 'POSTGRES_PASSWORD', source: 'generated' }, { key: 'ODOO_ADMIN_PASSWORD', source: 'generated' }, { key: 'STRIPE_KEY', source: 'person' },
      ]);

      await secrets.keep('p1', 'POSTGRES_PASSWORD', 'running');
      expect(held.get('p1/POSTGRES_PASSWORD')).toBe('running');
      expect(await secrets.signIns(project)).toEqual([{ login: 'admin', password: held.get('p1/ODOO_ADMIN_PASSWORD'), describe: 'The admin password.' }]);
    });

    it('works without anyone to tell when a secret is asked for', async () => {
      const db = await stored(make);
      const secrets = projectSecretsFor({
        db: db.projects,
        backend: { hasSecret: async () => false, getSecret: async () => null, listSecrets: async () => [], setSecret: async (projectId, key) => ({ secretReference: `secret://${projectId}/${key}` }) },
        readToken: async () => 'tok',
      });
      expect((await secrets.ensure(project)).waiting).toEqual(['STRIPE_KEY']);
    });
  });
}
