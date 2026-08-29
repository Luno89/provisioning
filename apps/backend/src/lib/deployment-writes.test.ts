import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from './memory-db.js';
import type { DeploymentMetadata } from './types.js';

const dep = (id: string, over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({
  id,
  name: id,
  clusterId: 'c1',
  strategy: 'helm',
  status: 'running',
  ...over,
});

let db: MemoryDB;
beforeEach(async () => { db = new MemoryDB(); await db.init(); });

describe('deleteDeployment', () => {
  it('removes one row and leaves the rest alone', async () => {
    await db.saveDeployment(dep('Tabbyapi-Production'));
    await db.saveDeployment(dep('other-app'));

    await db.deleteDeployment('Tabbyapi-Production');

    expect((await db.getDeployments()).map((d) => d.id)).toEqual(['other-app']);
  });

  it('is silent about a row that is already gone', async () => {
    await db.saveDeployment(dep('gone'));
    await db.deleteDeployment('gone');
    await expect(db.deleteDeployment('gone')).resolves.toBeUndefined();
  });
});

describe('redeploying a name that was destroyed', () => {
  it('re-creates the record rather than colliding with it', async () => {
    await db.saveDeployment(dep('Tabbyapi-Production', { status: 'running' }));
    await db.deleteDeployment('Tabbyapi-Production');
    await db.saveDeployment(dep('Tabbyapi-Production', { status: 'deploying' }));

    const all = await db.getDeployments();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('deploying');
  });

  it('overwrites rather than duplicating when a record survived the destroy', async () => {
    await db.saveDeployment(dep('Tabbyapi-Production', { status: 'destroying' }));
    await db.saveDeployment(dep('Tabbyapi-Production', { status: 'deploying' }));

    const all = await db.getDeployments();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('deploying');
  });
});

describe('saveDeploymentList', () => {
  it('reconciles to the list given', async () => {
    await db.saveDeployment(dep('a'));
    await db.saveDeployment(dep('b'));

    await db.saveDeploymentList([dep('b', { status: 'failed' }), dep('c')]);

    const all = await db.getDeployments();
    expect(all.map((d) => d.id).sort()).toEqual(['b', 'c']);
    expect(all.find((d) => d.id === 'b')!.status).toBe('failed');
  });

  it('empties the collection only when explicitly given an empty list', async () => {
    await db.saveDeployment(dep('a'));
    await db.saveDeploymentList([]);
    expect(await db.getDeployments()).toEqual([]);
  });
});
