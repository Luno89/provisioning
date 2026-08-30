import { describe, it, expect } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { WorkspaceImageService } from './WorkspaceImageService.js';
import { seedWorkspaceImages } from '../lib/workspace-image-seeds.js';

const seeded = async () => {
  const db = new MemoryDB();
  await db.init();
  await seedWorkspaceImages(db);
  return db;
};

describe('the workspace images a pack can choose from', () => {
  it('serves the shipped catalogue to every user', async () => {
    const svc = new WorkspaceImageService(await seeded() as never);

    expect((await svc.list('u1')).map((i) => i.id).sort()).toEqual(['base', 'go', 'node', 'python']);
    expect((await svc.list('u2')).map((i) => i.id).sort()).toEqual(['base', 'go', 'node', 'python']);
  });

  it('resolves a language to the image it runs', async () => {
    const svc = new WorkspaceImageService(await seeded() as never);

    expect(await svc.imageFor('u1', 'python')).toBe('registry.access.redhat.com/ubi9/python-312');
  });

  it('lets a user point a language at their OWN image without touching anyone else', async () => {
    const db = await seeded();
    const svc = new WorkspaceImageService(db as never);
    const shipped = (await svc.list('u1')).find((i) => i.id === 'node')!;
    await db.saveWorkspaceImage({ ...shipped, ownerId: 'u1', image: 'ghcr.io/mine/node:24' });

    expect(await svc.imageFor('u1', 'node')).toBe('ghcr.io/mine/node:24');
    expect(await svc.imageFor('u2', 'node')).toBe('registry.access.redhat.com/ubi9/nodejs-22');
  });

  it('picks an image that HAS what the work requires, over the one asked for', async () => {
    const svc = new WorkspaceImageService(await seeded() as never);

    expect(await svc.capableImage('u1', 'base', ['git'])).not.toContain('ubi9/ubi');
  });
});
