import { describe, it, expect } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { ProjectRepoService } from './ProjectRepoService.js';

const KEY = 'a'.repeat(64);

describe('the Gitea user behind an account', () => {
  it('is made once when several runs need it at the same moment', async () => {
    const db = new MemoryDB();
    await db.init();
    let made = 0;
    const gitea = { createUserAccount: async (username: string) => { made += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { username, password: 'secret' }; } };
    const repos = new ProjectRepoService(db, gitea as never, KEY as never);

    const accounts = await Promise.all([repos.ensureAccountFor('space-1'), repos.ensureAccountFor('space-1'), repos.ensureAccountFor('space-1')]);

    expect(made).toBe(1);
    expect(new Set(accounts.map((account) => account.username)).size).toBe(1);
  });

  it('waits for the record when another process made the user first', async () => {
    const db = new MemoryDB();
    await db.init();
    const theirs = new ProjectRepoService(db, { createUserAccount: async (username: string) => ({ username, password: 'theirs' }) } as never, KEY as never);
    const gitea = { createUserAccount: async () => { throw new Error('HTTP 500 {"message":"pq: duplicate key value violates unique constraint \\"UQE_user_lower_name\\""}'); } };
    const ours = new ProjectRepoService(db, gitea as never, KEY as never);

    const waiting = ours.ensureAccountFor('space-2');
    await theirs.ensureAccountFor('space-2');

    expect((await waiting).username).toBe((await theirs.ensureAccountFor('space-2')).username);
  });
});
