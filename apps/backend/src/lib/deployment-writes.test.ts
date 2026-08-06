import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from './memory-db.js';
import type { DeploymentMetadata } from './types.js';

/**
 * The destroy → abandon → deploy cycle, at the storage layer.
 *
 * The bug these cover was reported as `E11000 duplicate key ... index: _id_` on deploying an app
 * whose name it had used before. The cause was `saveDeploymentList` doing `deleteMany({})` followed
 * by `insertMany(...)`: not atomic, so a concurrent write between the two steps produced a document
 * that the insert then collided with — and, worse, a failed insert left the collection EMPTY, since
 * the delete had already committed.
 *
 * MemoryDB cannot reproduce a Mongo race, so these pin the CONTRACT both backends must honour:
 * removing one deployment never touches another, and a list write is a reconciliation rather than
 * a wipe-and-rebuild.
 */
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
    // The callers all used to express this as "read everything, filter one out, rewrite the world",
    // which is what raced.
    await db.saveDeployment(dep('Tabbyapi-Production'));
    await db.saveDeployment(dep('other-app'));

    await db.deleteDeployment('Tabbyapi-Production');

    expect((await db.getDeployments()).map((d) => d.id)).toEqual(['other-app']);
  });

  it('is silent about a row that is already gone', async () => {
    // Destroy can land twice — from the workflow tracker and from the reconcile loop — and the
    // second one must not be an error.
    await db.saveDeployment(dep('gone'));
    await db.deleteDeployment('gone');
    await expect(db.deleteDeployment('gone')).resolves.toBeUndefined();
  });
});

describe('redeploying a name that was destroyed', () => {
  it('re-creates the record rather than colliding with it', async () => {
    // The reported failure: deploy an app, destroy it, deploy it again under the same name.
    await db.saveDeployment(dep('Tabbyapi-Production', { status: 'running' }));
    await db.deleteDeployment('Tabbyapi-Production');
    await db.saveDeployment(dep('Tabbyapi-Production', { status: 'deploying' }));

    const all = await db.getDeployments();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('deploying');
  });

  it('overwrites rather than duplicating when a record survived the destroy', async () => {
    // The state the cycle actually leaves behind when a destroy is abandoned partway.
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
    // Not by accident, and not as a step on the way to rebuilding it.
    await db.saveDeployment(dep('a'));
    await db.saveDeploymentList([]);
    expect(await db.getDeployments()).toEqual([]);
  });
});
