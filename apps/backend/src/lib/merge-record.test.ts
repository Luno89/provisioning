import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { mergeRecord } from './merge-record.js';

describe('merging a partial update', () => {
  it('keeps what the patch did not mention', () => {
    expect(mergeRecord({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it('treats an explicit undefined as "nothing to say", not "erase it"', () => {
    expect(mergeRecord({ a: 1 }, { a: undefined } as any)).toEqual({ a: 1 });
  });

  it('works when there is nothing stored yet', () => {
    expect(mergeRecord(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

describe('the save*Info functions', () => {
  it('does not lose a deployment field on a status-only update', async () => {
    const db = new MemoryDB();
    await db.saveDeploymentInfo({
      id: 'd1', name: 'crawler', clusterId: 'c1', strategy: 'native', status: 'deploying',
      crawl4aiApiToken: 'the-token', crawl4aiMemoryLimit: '3Gi',
    } as any);

    await db.saveDeploymentInfo({ id: 'd1', status: 'running' } as any);

    const [saved] = await db.getDeployments();
    expect(saved?.crawl4aiApiToken).toBe('the-token');
    expect(saved?.crawl4aiMemoryLimit).toBe('3Gi');
    expect(saved?.status).toBe('running');
    expect(saved?.name).toBe('crawler');
  });

  it('keeps a project\'s owner', async () => {
    const db = new MemoryDB();
    await db.saveProjectInfo({ id: 'p1', name: 'x', giteaOwner: 'o', giteaRepo: 'r', ownerId: 'u1' } as any);
    await db.saveProjectInfo({ id: 'p1', lastBuildStatus: 'succeeded' } as any);

    const [saved] = await db.getProjects();
    expect(saved?.ownerId).toBe('u1');
    expect(saved?.giteaRepo).toBe('r');
  });

  it('keeps a cluster field across a progress update', async () => {
    const db = new MemoryDB();
    await db.saveClusterInfo({ id: 'c1', name: 'c1', provider: 'k3d', status: 'provisioning', ownerId: 'u1' } as any);
    await db.saveClusterInfo({ id: 'c1', status: 'healthy' } as any);

    const [saved] = await db.getClusters();
    expect(saved?.ownerId).toBe('u1');
    expect(saved?.status).toBe('healthy');
  });

  it('still creates a record that did not exist', async () => {
    const db = new MemoryDB();
    const made = await db.saveProjectInfo({ name: 'fresh', giteaOwner: 'o', giteaRepo: 'r' } as any);
    expect(made.id).toBeTruthy();
    expect((await db.getProjects())).toHaveLength(1);
  });
});
