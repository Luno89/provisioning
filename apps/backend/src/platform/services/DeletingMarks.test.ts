import { describe, expect, it } from 'vitest';
import { MemoryProjectsStore } from '../../projects/testing/memory-store.js';
import { deletingMarksIn } from './DeletingMarks.js';

const projects = async () => {
  const store = new MemoryProjectsStore();
  await store.saveProject({ id: 'p1', name: 'one', appType: 'gitapp', createdAt: 't' });
  await store.saveProject({ id: 'p2', name: 'two', appType: 'gitapp', createdAt: 't' });
  await store.markDeleting('p1', { startedAt: 't', requestedBy: 'u1', mode: 'permanent' });
  return store;
};

const accounts = (removing: string[]) => ({
  getUserById: async (id: string) => ({ id, email: `${id}@example.com`, createdAt: 't', twoFactorEnabled: false, emailVerified: true, ...(removing.includes(id) ? { removal: { startedAt: 't', requestedBy: id } } : {}) }),
});

describe('which projects are being deleted and which accounts removed, read from their own records at each start', () => {
  it('reads the project the work names and the account it names', async () => {
    const marks = deletingMarksIn({ projects: await projects(), accounts: accounts(['u2']) });
    expect(await marks({ owner: 'u1', project: 'p1' })).toEqual({ owner: false, project: true });
    expect(await marks({ owner: 'u2', project: 'p2' })).toEqual({ owner: true, project: false });
    expect(await marks({ owner: 'u1' })).toEqual({ owner: false, project: false });
  });

  it('reads a project that is not here as not being deleted', async () => {
    const marks = deletingMarksIn({ projects: await projects(), accounts: accounts([]) });
    expect(await marks({ project: 'elsewhere' })).toEqual({ owner: false, project: false });
  });
});
