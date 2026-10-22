import { describe, it, expect } from 'vitest';
import { testDatabase } from './test-database.js';
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
    const db = await testDatabase();
    await db.infrastructure.saveDeploymentInfo({
      id: 'd1', name: 'crawler', clusterId: 'c1', strategy: 'native', status: 'deploying',
      crawl4aiApiToken: 'the-token', crawl4aiMemoryLimit: '3Gi',
    } as any);

    await db.infrastructure.saveDeploymentInfo({ id: 'd1', status: 'running' } as any);

    const [saved] = await db.infrastructure.getDeployments();
    expect(saved?.crawl4aiApiToken).toBe('the-token');
    expect(saved?.crawl4aiMemoryLimit).toBe('3Gi');
    expect(saved?.status).toBe('running');
    expect(saved?.name).toBe('crawler');
  });

  it('keeps a project\'s owner', async () => {
    const db = await testDatabase();
    await db.projects.saveProjectInfo({ id: 'p1', name: 'x', giteaOwner: 'o', giteaRepo: 'r', ownerId: 'u1' } as any);
    await db.projects.saveProjectInfo({ id: 'p1', lastBuildStatus: 'succeeded' } as any);

    const [saved] = await db.projects.getProjects();
    expect(saved?.ownerId).toBe('u1');
    expect(saved?.giteaRepo).toBe('r');
  });

  it('keeps a cluster field across a progress update', async () => {
    const db = await testDatabase();
    await db.infrastructure.saveClusterInfo({ id: 'c1', name: 'c1', provider: 'k3d', status: 'provisioning', ownerId: 'u1' } as any);
    await db.infrastructure.saveClusterInfo({ id: 'c1', status: 'healthy' } as any);

    const [saved] = await db.infrastructure.getClusters();
    expect(saved?.ownerId).toBe('u1');
    expect(saved?.status).toBe('healthy');
  });

  it('still creates a record that did not exist', async () => {
    const db = await testDatabase();
    const made = await db.projects.saveProjectInfo({ name: 'fresh', giteaOwner: 'o', giteaRepo: 'r' } as any);
    expect(made.id).toBeTruthy();
    expect((await db.projects.getProjects())).toHaveLength(1);
  });
});
