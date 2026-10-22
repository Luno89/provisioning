import { describe, it, expect, beforeEach } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { DeploymentMetadata } from '../../platform/lib/types.js';

const dep = (id: string, over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({
  id,
  name: id,
  clusterId: 'c1',
  strategy: 'helm',
  status: 'running',
  ...over,
});

let db: MongoDB;
beforeEach(async () => { db = await testDatabase(); });

describe('deleteDeployment', () => {
  it('removes one row and leaves the rest alone', async () => {
    await db.infrastructure.saveDeployment(dep('Tabbyapi-Production'));
    await db.infrastructure.saveDeployment(dep('other-app'));

    await db.infrastructure.deleteDeployment('Tabbyapi-Production');

    expect((await db.infrastructure.getDeployments()).map((d) => d.id)).toEqual(['other-app']);
  });

  it('is silent about a row that is already gone', async () => {
    await db.infrastructure.saveDeployment(dep('gone'));
    await db.infrastructure.deleteDeployment('gone');
    await expect(db.infrastructure.deleteDeployment('gone')).resolves.toBeUndefined();
  });
});

describe('redeploying a name that was destroyed', () => {
  it('re-creates the record rather than colliding with it', async () => {
    await db.infrastructure.saveDeployment(dep('Tabbyapi-Production', { status: 'running' }));
    await db.infrastructure.deleteDeployment('Tabbyapi-Production');
    await db.infrastructure.saveDeployment(dep('Tabbyapi-Production', { status: 'deploying' }));

    const all = await db.infrastructure.getDeployments();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('deploying');
  });

  it('overwrites rather than duplicating when a record survived the destroy', async () => {
    await db.infrastructure.saveDeployment(dep('Tabbyapi-Production', { status: 'destroying' }));
    await db.infrastructure.saveDeployment(dep('Tabbyapi-Production', { status: 'deploying' }));

    const all = await db.infrastructure.getDeployments();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('deploying');
  });
});

describe('saveDeploymentList', () => {
  it('reconciles to the list given', async () => {
    await db.infrastructure.saveDeployment(dep('a'));
    await db.infrastructure.saveDeployment(dep('b'));

    await db.infrastructure.saveDeploymentList([dep('b', { status: 'failed' }), dep('c')]);

    const all = await db.infrastructure.getDeployments();
    expect(all.map((d) => d.id).sort()).toEqual(['b', 'c']);
    expect(all.find((d) => d.id === 'b')!.status).toBe('failed');
  });

  it('empties the collection only when explicitly given an empty list', async () => {
    await db.infrastructure.saveDeployment(dep('a'));
    await db.infrastructure.saveDeploymentList([]);
    expect(await db.infrastructure.getDeployments()).toEqual([]);
  });
});
